import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

type CandidateFact = {
  category: string;
  value: string;
  confidence: number;
  sensitivity: "PUBLIC" | "CONTACT" | "CONFIDENTIAL" | "SENSITIVE";
  sourceMessageIds: string[];
};
type CandidateCorrection = {
  targetClaimId: string;
  replacement: string;
  sourceMessageIds: string[];
};
type CandidateContradiction = {
  claimIds: string[];
  explanation: string;
  sourceMessageIds: string[];
};
type CandidateOutput = {
  facts: CandidateFact[];
  corrections: CandidateCorrection[];
  contradictions: CandidateContradiction[];
  candidateTopics: string[];
};

export class KnowledgeStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async applyCandidateBatch(input: {
    organizationId: string;
    batchId: string;
    correlationId: string;
  }): Promise<{ applied: boolean; claimIds: string[] }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const batchResult = await client.query<{
        status: string;
        output: CandidateOutput;
        invocation_id: string;
        case_id: string;
        expected_interview_version: number;
        interview_id: string;
      }>(
        `SELECT b.status, b.output, b.invocation_id, b.case_id,
                i.expected_interview_version, i.interview_id
         FROM model_candidate_batches b
         JOIN model_invocations i ON i.id = b.invocation_id
         WHERE b.organization_id = $1 AND b.id = $2 FOR UPDATE OF b`,
        [input.organizationId, input.batchId],
      );
      const batch = batchResult.rows[0];
      if (!batch) throw new Error("candidate_batch_not_found");
      if (batch.status === "APPLIED") {
        const claimIds = await this.#invocationClaimIds(
          client,
          input.organizationId,
          batch.invocation_id,
        );
        await client.query("COMMIT");
        return { applied: false, claimIds };
      }
      if (batch.status !== "PENDING") throw new Error("candidate_batch_not_pending");
      const interview = await client.query<{ version: number }>(
        `SELECT version FROM interviews
         WHERE organization_id = $1 AND case_id = $2 AND id = $3 FOR UPDATE`,
        [input.organizationId, batch.case_id, batch.interview_id],
      );
      if (interview.rows[0]?.version !== batch.expected_interview_version)
        throw new Error("candidate_batch_stale");

      const allowedMessages = new Set(
        (
          await client.query<{ message_id: string }>(
            `SELECT message_id FROM model_invocation_messages
             WHERE organization_id = $1 AND invocation_id = $2`,
            [input.organizationId, batch.invocation_id],
          )
        ).rows.map((row) => row.message_id),
      );
      const allowedCategories = new Set(
        (
          await client.query<{ topic_key: string }>(
            `SELECT topic_key FROM interview_topics
             WHERE organization_id = $1 AND interview_id = $2`,
            [input.organizationId, batch.interview_id],
          )
        ).rows.map((row) => row.topic_key),
      );
      const output = batch.output;
      if (
        !output ||
        !Array.isArray(output.facts) ||
        !Array.isArray(output.corrections) ||
        !Array.isArray(output.contradictions) ||
        !Array.isArray(output.candidateTopics)
      )
        throw new Error("candidate_batch_invalid");
      const referencedClaimIds = new Set([
        ...output.corrections.map((candidate) => candidate.targetClaimId),
        ...output.contradictions.flatMap((candidate) => candidate.claimIds),
      ]);
      if (
        new Set(output.candidateTopics).size !== output.candidateTopics.length ||
        output.candidateTopics.some((topic) => !allowedCategories.has(topic))
      )
        throw new Error("candidate_topic_invalid");
      const existingClaims = new Map(
        (
          await client.query<{
            id: string;
            kind: string;
            category: string;
            sensitivity: string;
            audience: string;
          }>(
            `SELECT id, kind, category, sensitivity, audience FROM claims
             WHERE organization_id = $1 AND case_id = $2
               AND id = ANY($3::uuid[]) AND validity = 'CURRENT' FOR UPDATE`,
            [input.organizationId, batch.case_id, [...referencedClaimIds]],
          )
        ).rows.map((claim) => [claim.id, claim]),
      );
      if ([...referencedClaimIds].some((id) => !existingClaims.has(id)))
        throw new Error("candidate_claim_reference_invalid");
      const claimBackedTopics = new Set([
        ...output.facts.map((candidate) => candidate.category),
        ...output.corrections.flatMap((candidate) => {
          const target = existingClaims.get(candidate.targetClaimId);
          return target ? [target.category] : [];
        }),
      ]);
      if (output.candidateTopics.some((topic) => !claimBackedTopics.has(topic)))
        throw new Error("candidate_topic_unsubstantiated");

      const claimIds: string[] = [];
      const assertSources = (ids: string[]) => {
        if (
          ids.length === 0 ||
          new Set(ids).size !== ids.length ||
          ids.some((id) => !allowedMessages.has(id))
        )
          throw new Error("candidate_source_invalid");
      };
      for (const fact of output.facts) {
        assertSources(fact.sourceMessageIds);
        if (
          !allowedCategories.has(fact.category) ||
          !fact.value?.trim() ||
          !Number.isFinite(fact.confidence) ||
          fact.confidence < 0 ||
          fact.confidence > 1 ||
          !["PUBLIC", "CONTACT", "CONFIDENTIAL", "SENSITIVE"].includes(fact.sensitivity)
        )
          throw new Error("candidate_fact_invalid");
        const id = await this.#insertClaim(client, {
          organizationId: input.organizationId,
          caseId: batch.case_id,
          invocationId: batch.invocation_id,
          kind: "FACT",
          category: fact.category,
          content: fact.value.trim(),
          confidenceBasisPoints: Math.round(fact.confidence * 10_000),
          sensitivity: fact.sensitivity,
          audience: fact.sensitivity === "PUBLIC" ? "PROSPECT" : "INTERNAL",
        });
        await this.#insertSources(
          client,
          input.organizationId,
          batch.case_id,
          id,
          fact.sourceMessageIds,
        );
        claimIds.push(id);
      }
      for (const correction of output.corrections) {
        assertSources(correction.sourceMessageIds);
        const target = existingClaims.get(correction.targetClaimId);
        if (!target || !correction.replacement?.trim())
          throw new Error("candidate_correction_invalid");
        const id = await this.#insertClaim(client, {
          organizationId: input.organizationId,
          caseId: batch.case_id,
          invocationId: batch.invocation_id,
          kind: target.kind,
          category: target.category,
          content: correction.replacement.trim(),
          confidenceBasisPoints: 5_000,
          sensitivity: target.sensitivity,
          audience: target.audience,
        });
        await this.#insertSources(
          client,
          input.organizationId,
          batch.case_id,
          id,
          correction.sourceMessageIds,
        );
        await client.query(
          `UPDATE claims SET validity = 'REPLACED', updated_at = now()
           WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
          [input.organizationId, batch.case_id, correction.targetClaimId],
        );
        await this.#insertRelation(
          client,
          input.organizationId,
          batch.case_id,
          id,
          correction.targetClaimId,
          "REPLACES",
        );
        claimIds.push(id);
      }
      for (const contradiction of output.contradictions) {
        assertSources(contradiction.sourceMessageIds);
        if (!contradiction.explanation?.trim() || contradiction.claimIds.length === 0)
          throw new Error("candidate_contradiction_invalid");
        const id = await this.#insertClaim(client, {
          organizationId: input.organizationId,
          caseId: batch.case_id,
          invocationId: batch.invocation_id,
          kind: "CONTRADICTION",
          category: "CONTRADICTION",
          content: contradiction.explanation.trim(),
          confidenceBasisPoints: 5_000,
          sensitivity: "CONFIDENTIAL",
          audience: "INTERNAL",
        });
        await this.#insertSources(
          client,
          input.organizationId,
          batch.case_id,
          id,
          contradiction.sourceMessageIds,
        );
        for (const targetId of contradiction.claimIds)
          await this.#insertRelation(
            client,
            input.organizationId,
            batch.case_id,
            id,
            targetId,
            "CONTRADICTS",
          );
        claimIds.push(id);
      }
      if (output.candidateTopics.length > 0) {
        await client.query(
          `UPDATE interview_topics SET status = 'CAPTURED', updated_at = now()
           WHERE organization_id = $1 AND interview_id = $2
             AND topic_key = ANY($3::text[])`,
          [input.organizationId, batch.interview_id, output.candidateTopics],
        );
      }
      const missingRequired = await client
        .query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM interview_topics
           WHERE organization_id = $1 AND interview_id = $2
             AND required AND status = 'MISSING'`,
          [input.organizationId, batch.interview_id],
        )
        .then((result) => result.rows[0]?.count ?? 0);
      await client.query(
        `UPDATE interviews SET status = $4::interview_status, version = version + 1,
           updated_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
        [
          input.organizationId,
          batch.case_id,
          batch.interview_id,
          missingRequired === 0 ? "SUFFICIENT" : "ACTIVE",
        ],
      );
      await client.query(
        `UPDATE model_candidate_batches SET status = 'APPLIED'
         WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.batchId],
      );
      await client.query(
        `INSERT INTO audit_events
          (organization_id, case_id, actor, action, resource_type, resource_id,
           result, correlation_id, origin, metadata)
         VALUES ($1, $2, 'system', 'candidate_batch.applied', 'model_candidate_batch',
           $3, 'SUCCEEDED', $4, 'knowledge-store', $5::jsonb)`,
        [
          input.organizationId,
          batch.case_id,
          input.batchId,
          input.correlationId,
          JSON.stringify({ claimIds }),
        ],
      );
      await client.query("COMMIT");
      return { applied: true, claimIds };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #insertClaim(
    client: PoolClient,
    input: {
      organizationId: string;
      caseId: string;
      invocationId: string;
      kind: string;
      category: string;
      content: string;
      confidenceBasisPoints: number;
      sensitivity: string;
      audience: string;
    },
  ) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO claims
        (id, organization_id, case_id, kind, category, content,
         confidence_basis_points, sensitivity, audience, creator, model_invocation_id)
       VALUES ($1, $2, $3, $4::claim_kind, $5, $6, $7,
         $8::claim_sensitivity, $9::claim_audience, 'MODEL', $10)`,
      [
        id,
        input.organizationId,
        input.caseId,
        input.kind,
        input.category,
        input.content,
        input.confidenceBasisPoints,
        input.sensitivity,
        input.audience,
        input.invocationId,
      ],
    );
    return id;
  }

  async #insertSources(
    client: PoolClient,
    organizationId: string,
    caseId: string,
    claimId: string,
    messageIds: string[],
  ) {
    for (const messageId of messageIds)
      await client.query(
        `INSERT INTO claim_sources
          (organization_id, case_id, claim_id, message_id, relation)
         VALUES ($1, $2, $3, $4, 'SUPPORTS')`,
        [organizationId, caseId, claimId, messageId],
      );
  }

  async #insertRelation(
    client: PoolClient,
    organizationId: string,
    caseId: string,
    sourceClaimId: string,
    targetClaimId: string,
    relation: string,
  ) {
    await client.query(
      `INSERT INTO claim_relations
        (organization_id, case_id, source_claim_id, target_claim_id, relation)
       VALUES ($1, $2, $3, $4, $5::claim_relation_kind)`,
      [organizationId, caseId, sourceClaimId, targetClaimId, relation],
    );
  }

  async #invocationClaimIds(client: PoolClient, organizationId: string, invocationId: string) {
    return client
      .query<{ id: string }>(
        `SELECT id FROM claims WHERE organization_id = $1 AND model_invocation_id = $2
         ORDER BY created_at, id`,
        [organizationId, invocationId],
      )
      .then((result) => result.rows.map((row) => row.id));
  }
}
