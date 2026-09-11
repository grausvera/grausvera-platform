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

export type ClaimSourceRelation = "SUPPORTS" | "CONTRADICTS" | "CONTEXT";

export type KnowledgeOperatorPrincipal = {
  userId: string;
  organizationId: string;
  twoFactorVerified: boolean;
};

export type ExistingClaimSource =
  | { kind: "MESSAGE"; id: string; relation: ClaimSourceRelation }
  | { kind: "ATTACHMENT"; id: string; relation: ClaimSourceRelation }
  | { kind: "EXTERNAL"; id: string; relation: ClaimSourceRelation };

export type ClaimTrace = {
  claim: { id: string; kind: string; content: string; validity: string };
  sources: Array<{
    id: string;
    kind: "MESSAGE" | "ATTACHMENT" | "EXTERNAL";
    referenceId: string;
    relation: ClaimSourceRelation;
    label: string | null;
    href: string | null;
  }>;
  relations: Array<{
    direction: "OUTGOING" | "INCOMING";
    relation: string;
    claimId: string;
    content: string;
  }>;
};

export class KnowledgeStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async recordExternalSource(input: {
    organizationId: string;
    caseId: string;
    claimId: string;
    canonicalUrl: string;
    title: string;
    publisher: string;
    accessedAt: Date;
    excerpt: string;
    contentHash?: string;
    sourceVersion?: string;
    purpose: string;
    confidenceBasisPoints: number;
    relation: ClaimSourceRelation;
  }): Promise<string> {
    const id = randomUUID();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query(
        `INSERT INTO external_sources
          (id, organization_id, case_id, canonical_url, title, publisher, accessed_at,
           excerpt, content_hash, source_version, purpose, confidence_basis_points)
         SELECT $4, c.organization_id, c.case_id, $5, $6, $7, $8, $9, $10, $11, $12, $13
         FROM claims c
         WHERE c.organization_id = $1 AND c.case_id = $2 AND c.id = $3`,
        [
          input.organizationId,
          input.caseId,
          input.claimId,
          id,
          input.canonicalUrl.trim(),
          input.title.trim(),
          input.publisher.trim(),
          input.accessedAt,
          input.excerpt.trim(),
          input.contentHash,
          input.sourceVersion?.trim(),
          input.purpose.trim(),
          input.confidenceBasisPoints,
        ],
      );
      if ((inserted.rowCount ?? 0) !== 1) throw new Error("claim_source_not_authorized");
      await client.query(
        `INSERT INTO claim_sources
          (organization_id, case_id, claim_id, external_source_id, relation)
         VALUES ($1, $2, $3, $4, $5::claim_source_relation)`,
        [input.organizationId, input.caseId, input.claimId, id, input.relation],
      );
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async linkReviewedAttachment(input: {
    organizationId: string;
    caseId: string;
    claimId: string;
    attachmentId: string;
    relation: ClaimSourceRelation;
  }): Promise<void> {
    const result = await this.#pool.query(
      `INSERT INTO claim_sources
        (organization_id, case_id, claim_id, attachment_id, relation)
       SELECT c.organization_id, c.case_id, c.id, a.id, $5::claim_source_relation
       FROM claims c JOIN attachments a
         ON a.organization_id = c.organization_id AND a.case_id = c.case_id
       WHERE c.organization_id = $1 AND c.case_id = $2 AND c.id = $3
         AND a.id = $4 AND a.status = 'REVIEWED'
       ON CONFLICT DO NOTHING`,
      [input.organizationId, input.caseId, input.claimId, input.attachmentId, input.relation],
    );
    if ((result.rowCount ?? 0) === 0) {
      const existing = await this.#pool.query(
        `SELECT 1 FROM claim_sources WHERE organization_id = $1 AND case_id = $2
           AND claim_id = $3 AND attachment_id = $4 AND relation = $5::claim_source_relation`,
        [input.organizationId, input.caseId, input.claimId, input.attachmentId, input.relation],
      );
      if ((existing.rowCount ?? 0) === 0) throw new Error("claim_attachment_source_not_allowed");
    }
  }

  async correctClaim(
    principal: KnowledgeOperatorPrincipal,
    input: {
      caseId: string;
      targetClaimId: string;
      replacement: string;
      confidenceBasisPoints: number;
      source: ExistingClaimSource;
      correlationId: string;
    },
  ): Promise<{ claimId: string }> {
    const replacement = input.replacement.trim();
    if (
      !replacement ||
      !Number.isInteger(input.confidenceBasisPoints) ||
      input.confidenceBasisPoints < 0 ||
      input.confidenceBasisPoints > 10_000
    )
      throw new Error("claim_correction_invalid");
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client
        .query<{
          kind: string;
          category: string;
          sensitivity: string;
          audience: string;
        }>(
          `SELECT c.kind, c.category, c.sensitivity, c.audience
           FROM claims c
           JOIN operator_memberships m ON m.organization_id = c.organization_id
             AND m.user_id = $4 AND m.role = 'ENGINEER' AND m.active
           JOIN operator_case_assignments a ON a.organization_id = c.organization_id
             AND a.case_id = c.case_id AND a.user_id = m.user_id AND a.active
           WHERE c.organization_id = $1 AND c.case_id = $2 AND c.id = $3
             AND c.validity = 'CURRENT'
           FOR UPDATE OF c`,
          [principal.organizationId, input.caseId, input.targetClaimId, principal.userId],
        )
        .then((result) => result.rows[0]);
      if (!target) throw new Error("claim_correction_not_authorized");

      await this.#assertExistingSource(client, {
        organizationId: principal.organizationId,
        caseId: input.caseId,
        source: input.source,
      });
      const claimId = randomUUID();
      await client.query(
        `INSERT INTO claims
          (id, organization_id, case_id, kind, category, content,
           confidence_basis_points, confirmed, sensitivity, audience, creator)
         VALUES ($1, $2, $3, $4::claim_kind, $5, $6, $7, true,
           $8::claim_sensitivity, $9::claim_audience, 'HUMAN')`,
        [
          claimId,
          principal.organizationId,
          input.caseId,
          target.kind,
          target.category,
          replacement,
          input.confidenceBasisPoints,
          target.sensitivity,
          target.audience,
        ],
      );
      const sourceColumn = {
        MESSAGE: "message_id",
        ATTACHMENT: "attachment_id",
        EXTERNAL: "external_source_id",
      }[input.source.kind];
      await client.query(
        `INSERT INTO claim_sources
          (organization_id, case_id, claim_id, ${sourceColumn}, relation)
         VALUES ($1, $2, $3, $4, $5::claim_source_relation)`,
        [principal.organizationId, input.caseId, claimId, input.source.id, input.source.relation],
      );
      await client.query(
        `UPDATE claims SET validity = 'REPLACED', updated_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
        [principal.organizationId, input.caseId, input.targetClaimId],
      );
      await this.#insertRelation(
        client,
        principal.organizationId,
        input.caseId,
        claimId,
        input.targetClaimId,
        "REPLACES",
      );
      await client.query(
        `UPDATE prospect_cases SET knowledge_version = knowledge_version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [principal.organizationId, input.caseId],
      );
      await client.query(
        `INSERT INTO audit_events
          (organization_id, case_id, actor, action, resource_type, resource_id,
           result, correlation_id, origin, metadata)
         VALUES ($1, $2, $3, 'claim.corrected', 'claim', $4, 'SUCCEEDED', $5,
           'knowledge-store', $6::jsonb)`,
        [
          principal.organizationId,
          input.caseId,
          `operator:${principal.userId}`,
          claimId,
          input.correlationId,
          JSON.stringify({
            targetClaimId: input.targetClaimId,
            sourceKind: input.source.kind,
            sourceId: input.source.id,
          }),
        ],
      );
      await client.query("COMMIT");
      return { claimId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getClaimTrace(
    organizationId: string,
    caseId: string,
    claimId: string,
  ): Promise<ClaimTrace> {
    const claim = await this.#pool
      .query<{ id: string; kind: string; content: string; validity: string }>(
        `SELECT id, kind, content, validity FROM claims
         WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
        [organizationId, caseId, claimId],
      )
      .then((result) => result.rows[0]);
    if (!claim) throw new Error("claim_not_found");
    const sources = await this.#pool.query<ClaimTrace["sources"][number]>(
      `SELECT cs.id, CASE
           WHEN cs.message_id IS NOT NULL THEN 'MESSAGE'
           WHEN cs.attachment_id IS NOT NULL THEN 'ATTACHMENT'
           ELSE 'EXTERNAL'
         END AS kind,
         COALESCE(cs.message_id, cs.attachment_id, cs.external_source_id)::text AS "referenceId",
         cs.relation,
         CASE WHEN cs.attachment_id IS NOT NULL THEN a.object_key
              WHEN cs.external_source_id IS NOT NULL THEN e.title
              WHEN cs.message_id IS NOT NULL THEN 'Message' END AS label,
         CASE WHEN cs.message_id IS NOT NULL THEN '#message-' || cs.message_id::text
              WHEN cs.external_source_id IS NOT NULL THEN e.canonical_url END AS href
       FROM claim_sources cs
       LEFT JOIN attachments a ON a.organization_id = cs.organization_id
         AND a.case_id = cs.case_id AND a.id = cs.attachment_id
       LEFT JOIN external_sources e ON e.organization_id = cs.organization_id
         AND e.case_id = cs.case_id AND e.id = cs.external_source_id
       WHERE cs.organization_id = $1 AND cs.case_id = $2 AND cs.claim_id = $3
       ORDER BY cs.created_at, cs.id`,
      [organizationId, caseId, claimId],
    );
    const relations = await this.#pool.query<ClaimTrace["relations"][number]>(
      `SELECT 'OUTGOING' AS direction, r.relation, target.id AS "claimId",
              target.content
       FROM claim_relations r JOIN claims target
         ON target.organization_id = r.organization_id AND target.case_id = r.case_id
           AND target.id = r.target_claim_id
       WHERE r.organization_id = $1 AND r.case_id = $2 AND r.source_claim_id = $3
       UNION ALL
       SELECT 'INCOMING' AS direction, r.relation, source.id AS "claimId",
              source.content
       FROM claim_relations r JOIN claims source
         ON source.organization_id = r.organization_id AND source.case_id = r.case_id
           AND source.id = r.source_claim_id
       WHERE r.organization_id = $1 AND r.case_id = $2 AND r.target_claim_id = $3
       ORDER BY direction, "claimId"`,
      [organizationId, caseId, claimId],
    );
    return { claim, sources: sources.rows, relations: relations.rows };
  }

  async listCaseClaims(
    principal: KnowledgeOperatorPrincipal,
    caseId: string,
  ): Promise<ClaimTrace[]> {
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const authorized = await this.#pool.query(
      `SELECT 1 FROM prospect_cases c JOIN operator_memberships m
         ON m.organization_id = c.organization_id AND m.user_id = $3
           AND m.role = 'ENGINEER' AND m.active
       WHERE c.organization_id = $1 AND c.id = $2`,
      [principal.organizationId, caseId, principal.userId],
    );
    if ((authorized.rowCount ?? 0) !== 1) throw new Error("knowledge_case_not_authorized");
    const claimIds = await this.#pool
      .query<{ id: string }>(
        `SELECT id FROM claims WHERE organization_id = $1 AND case_id = $2
         ORDER BY created_at, id`,
        [principal.organizationId, caseId],
      )
      .then((result) => result.rows.map((row) => row.id));
    return Promise.all(
      claimIds.map((claimId) => this.getClaimTrace(principal.organizationId, caseId, claimId)),
    );
  }

  async listContradictions(organizationId: string, caseId: string) {
    return this.#pool
      .query<{
        contradictionClaimId: string;
        contradiction: string;
        targetClaimId: string;
        target: string;
      }>(
        `SELECT source.id AS "contradictionClaimId", source.content AS contradiction,
                target.id AS "targetClaimId", target.content AS target
         FROM claim_relations r
         JOIN claims source ON source.organization_id = r.organization_id
           AND source.case_id = r.case_id AND source.id = r.source_claim_id
         JOIN claims target ON target.organization_id = r.organization_id
           AND target.case_id = r.case_id AND target.id = r.target_claim_id
         WHERE r.organization_id = $1 AND r.case_id = $2 AND r.relation = 'CONTRADICTS'
         ORDER BY r.created_at, r.id`,
        [organizationId, caseId],
      )
      .then((result) => result.rows);
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
      if (claimIds.length > 0)
        await client.query(
          `UPDATE prospect_cases SET knowledge_version = knowledge_version + 1, updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [input.organizationId, batch.case_id],
        );
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

  async #assertExistingSource(
    client: PoolClient,
    input: {
      organizationId: string;
      caseId: string;
      source: ExistingClaimSource;
    },
  ): Promise<void> {
    const query = {
      MESSAGE: `SELECT 1 FROM messages
        WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
      ATTACHMENT: `SELECT 1 FROM attachments
        WHERE organization_id = $1 AND case_id = $2 AND id = $3 AND status = 'REVIEWED'`,
      EXTERNAL: `SELECT 1 FROM external_sources
        WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
    }[input.source.kind];
    const source = await client.query(query, [input.organizationId, input.caseId, input.source.id]);
    if ((source.rowCount ?? 0) !== 1) throw new Error("claim_correction_source_not_allowed");
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
