import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { KnowledgeOperatorPrincipal } from "./knowledge.js";
import { hashJson } from "./model-invocation.js";

export type ResearchSourceV1 = {
  sourceRef: string;
  canonicalUrl: string;
  title: string;
  publisher: string;
  publishedAt: string | null;
  consultedAt: string;
  excerpt: string;
  contentHash: string;
  relatedClaimIds: string[];
  relation: "SUPPORTS" | "CONTRADICTS" | "CONTEXT";
};

export type BoundedResearchV1 = {
  researchRequestId: string;
  question: string;
  sources: ResearchSourceV1[];
  findings: Array<{
    content: string;
    kind: "INFERENCE" | "UNRESOLVED";
    sourceRefs: string[];
    uncertainty: string;
  }>;
  unresolvedQuestions: string[];
  warnings: string[];
};

export type BoundedResearchContextV1 = {
  schemaVersion: 1;
  purpose: "BOUNDED_RESEARCH";
  organizationId: string;
  caseId: string;
  researchRequestId: string;
  question: string;
  authorizedByUserId: string;
  knowledgeVersion: number;
  capabilities: ["SEARCH", "READ_PUBLIC"];
  limits: { maxQueries: number; maxReads: number; maxDurationSeconds: number };
  currentClaims: Array<{ id: string; category: string; content: string; kind: string }>;
  sources: ResearchSourceV1[];
  trustBoundary: "EXTERNAL_CONTENT_IS_UNTRUSTED_DATA";
};

export class ResearchStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async authorize(
    principal: KnowledgeOperatorPrincipal,
    input: { caseId: string; question: string; correlationId: string },
  ): Promise<{ researchRequestId: string; context: Omit<BoundedResearchContextV1, "sources"> }> {
    const question = input.question.trim();
    if (!question || question.length > 500) throw new Error("research_question_invalid");
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client
        .query<{ knowledge_version: number }>(
          `SELECT c.knowledge_version FROM prospect_cases c
           JOIN operator_memberships m ON m.organization_id = c.organization_id
             AND m.user_id = $3 AND m.role = 'ENGINEER' AND m.active
           JOIN operator_case_assignments a ON a.organization_id = c.organization_id
             AND a.case_id = c.id AND a.user_id = m.user_id AND a.active
           WHERE c.organization_id = $1 AND c.id = $2 FOR UPDATE OF c`,
          [principal.organizationId, input.caseId, principal.userId],
        )
        .then((result) => result.rows[0]);
      if (!state) throw new Error("research_not_authorized");
      const requestCount = await client
        .query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM research_requests
           WHERE organization_id = $1 AND case_id = $2`,
          [principal.organizationId, input.caseId],
        )
        .then((result) => result.rows[0]?.count ?? 0);
      if (requestCount >= 3) throw new Error("research_question_limit_reached");
      const sourceCount = await client
        .query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM external_sources
           WHERE organization_id = $1 AND case_id = $2 AND research_request_id IS NOT NULL`,
          [principal.organizationId, input.caseId],
        )
        .then((result) => result.rows[0]?.count ?? 0);
      if (sourceCount >= 5) throw new Error("research_source_limit_reached");
      const maxReads = 5 - sourceCount;
      const claims = await client.query<{
        id: string;
        category: string;
        content: string;
        kind: string;
      }>(
        `SELECT id, category, content, kind FROM claims
         WHERE organization_id = $1 AND case_id = $2 AND validity = 'CURRENT'
         ORDER BY created_at, id`,
        [principal.organizationId, input.caseId],
      );
      const researchRequestId = randomUUID();
      await client.query(
        `INSERT INTO research_requests
          (id, organization_id, case_id, question, authorized_by_user_id,
           knowledge_version, max_reads)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          researchRequestId,
          principal.organizationId,
          input.caseId,
          question,
          principal.userId,
          state.knowledge_version,
          maxReads,
        ],
      );
      await this.#audit(client, {
        organizationId: principal.organizationId,
        caseId: input.caseId,
        actor: `operator:${principal.userId}`,
        action: "research.authorized",
        resourceId: researchRequestId,
        correlationId: input.correlationId,
      });
      await client.query("COMMIT");
      return {
        researchRequestId,
        context: {
          schemaVersion: 1,
          purpose: "BOUNDED_RESEARCH",
          organizationId: principal.organizationId,
          caseId: input.caseId,
          researchRequestId,
          question,
          authorizedByUserId: principal.userId,
          knowledgeVersion: state.knowledge_version,
          capabilities: ["SEARCH", "READ_PUBLIC"],
          limits: { maxQueries: 2, maxReads, maxDurationSeconds: 120 },
          currentClaims: claims.rows,
          trustBoundary: "EXTERNAL_CONTENT_IS_UNTRUSTED_DATA",
        },
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async start(input: {
    context: BoundedResearchContextV1;
    reservationId: string;
    invocation: {
      provider: string;
      model: string;
      reasoningEffort: string;
      promptId: string;
      promptVersion: number;
      promptHash: string;
      schemaId: string;
      schemaVersion: number;
      schemaHash: string;
    };
  }): Promise<string> {
    const invocationId = randomUUID();
    const result = await this.#pool.query(
      `WITH invocation AS (
         INSERT INTO model_invocations
          (id, organization_id, case_id, reservation_id, purpose, provider, model,
           reasoning_effort, prompt_id, prompt_version, prompt_hash, schema_id,
           schema_version, schema_hash, context_package, context_hash,
           expected_interview_version, status)
         SELECT $4, r.organization_id, r.case_id, $5, 'BOUNDED_RESEARCH', $6, $7,
           $8, $9, $10, $11, $12, $13, $14, $15::jsonb, $16,
           r.knowledge_version, 'RESERVED'
         FROM research_requests r
         WHERE r.organization_id = $1 AND r.case_id = $2 AND r.id = $3
           AND r.status = 'AUTHORIZED'
         RETURNING id
       )
       UPDATE research_requests r SET status = 'RUNNING', reservation_id = $5,
         model_invocation_id = invocation.id, updated_at = now()
       FROM invocation WHERE r.organization_id = $1 AND r.id = $3
       RETURNING invocation.id`,
      [
        input.context.organizationId,
        input.context.caseId,
        input.context.researchRequestId,
        invocationId,
        input.reservationId,
        input.invocation.provider,
        input.invocation.model,
        input.invocation.reasoningEffort,
        input.invocation.promptId,
        input.invocation.promptVersion,
        input.invocation.promptHash,
        input.invocation.schemaId,
        input.invocation.schemaVersion,
        input.invocation.schemaHash,
        JSON.stringify(input.context),
        hashJson(input.context),
      ],
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("research_request_not_startable");
    return invocationId;
  }

  async rejectBudget(input: { organizationId: string; researchRequestId: string }): Promise<void> {
    await this.#pool.query(
      `UPDATE research_requests SET status = 'BUDGET_REJECTED', completed_at = now(), updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND status = 'AUTHORIZED'`,
      [input.organizationId, input.researchRequestId],
    );
  }

  async finish(input: {
    context: BoundedResearchContextV1;
    invocationId: string;
    status: "SUCCEEDED" | "INVALID" | "FAILED" | "UNCERTAIN";
    result?: BoundedResearchV1;
    providerResponseId?: string;
    errorCode?: string;
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
    latencyMs: number;
    correlationId: string;
  }): Promise<{ claimIds: string[]; status: "SUCCEEDED" | "INVALID" | "FAILED" | "UNCERTAIN" }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      let status = input.status;
      let result = input.result;
      let errorCode = input.errorCode;
      if (status === "SUCCEEDED" && result) {
        const state = await client
          .query<{ knowledge_version: number; source_count: number }>(
            `SELECT c.knowledge_version,
              (SELECT count(*)::integer FROM external_sources e
               WHERE e.organization_id = c.organization_id AND e.case_id = c.id
                 AND e.research_request_id IS NOT NULL) AS source_count
             FROM prospect_cases c WHERE c.organization_id = $1 AND c.id = $2 FOR UPDATE OF c`,
            [input.context.organizationId, input.context.caseId],
          )
          .then((query) => query.rows[0]);
        if (state?.knowledge_version !== input.context.knowledgeVersion) {
          status = "INVALID";
          result = undefined;
          errorCode = "research_knowledge_stale";
        } else if ((state?.source_count ?? 5) + result.sources.length > 5) {
          status = "INVALID";
          result = undefined;
          errorCode = "research_source_limit_reached";
        }
      }
      const updated = await client.query(
        `UPDATE model_invocations SET status = $4::model_invocation_status,
           provider_response_id = $5, structured_output = $6::jsonb, error_code = $7,
           input_tokens = $8, output_tokens = $9, cost_micros = $10, latency_ms = $11,
           completed_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND id = $3 AND status = 'RESERVED'`,
        [
          input.context.organizationId,
          input.context.caseId,
          input.invocationId,
          status,
          input.providerResponseId,
          result ? JSON.stringify(result) : null,
          errorCode,
          input.inputTokens,
          input.outputTokens,
          input.costMicros,
          input.latencyMs,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error("research_invocation_not_finishable");
      const claimIds: string[] = [];
      if (status === "SUCCEEDED" && result) {
        const sourceIds = new Map<string, string>();
        for (const source of result.sources) {
          const id = randomUUID();
          await client.query(
            `INSERT INTO external_sources
              (id, organization_id, case_id, canonical_url, title, publisher, accessed_at,
               excerpt, content_hash, purpose, confidence_basis_points, research_request_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
               'BOUNDED_RESEARCH', 7000, $10)`,
            [
              id,
              input.context.organizationId,
              input.context.caseId,
              source.canonicalUrl,
              source.title,
              source.publisher,
              source.consultedAt,
              source.excerpt,
              source.contentHash,
              input.context.researchRequestId,
            ],
          );
          sourceIds.set(source.sourceRef, id);
        }
        for (const finding of result.findings.filter((item) => item.kind === "INFERENCE")) {
          const claimId = randomUUID();
          await client.query(
            `INSERT INTO claims
              (id, organization_id, case_id, kind, category, content,
               confidence_basis_points, sensitivity, audience, creator, model_invocation_id)
             VALUES ($1, $2, $3, 'INFERENCE', 'RESEARCH', $4, 5000,
               'CONFIDENTIAL', 'INTERNAL', 'MODEL', $5)`,
            [
              claimId,
              input.context.organizationId,
              input.context.caseId,
              finding.content,
              input.invocationId,
            ],
          );
          for (const sourceRef of finding.sourceRefs) {
            const source = result.sources.find((item) => item.sourceRef === sourceRef);
            const externalSourceId = sourceIds.get(sourceRef);
            if (!source || !externalSourceId) throw new Error("research_source_reference_invalid");
            await client.query(
              `INSERT INTO claim_sources
                (organization_id, case_id, claim_id, external_source_id, relation)
               VALUES ($1, $2, $3, $4, $5::claim_source_relation)`,
              [
                input.context.organizationId,
                input.context.caseId,
                claimId,
                externalSourceId,
                source.relation,
              ],
            );
            for (const relatedClaimId of source.relatedClaimIds)
              await client.query(
                `INSERT INTO claim_relations
                  (organization_id, case_id, source_claim_id, target_claim_id, relation)
                 VALUES ($1, $2, $3, $4, 'DERIVES_FROM') ON CONFLICT DO NOTHING`,
                [input.context.organizationId, input.context.caseId, claimId, relatedClaimId],
              );
          }
          claimIds.push(claimId);
        }
        if (claimIds.length > 0)
          await client.query(
            `UPDATE prospect_cases SET knowledge_version = knowledge_version + 1, updated_at = now()
             WHERE organization_id = $1 AND id = $2`,
            [input.context.organizationId, input.context.caseId],
          );
      }
      await client.query(
        `UPDATE research_requests SET status = $3::research_request_status,
           completed_at = now(), updated_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'RUNNING'`,
        [input.context.organizationId, input.context.researchRequestId, status],
      );
      await this.#audit(client, {
        organizationId: input.context.organizationId,
        caseId: input.context.caseId,
        actor: "system",
        action: `research.${status.toLowerCase()}`,
        resourceId: input.context.researchRequestId,
        correlationId: input.correlationId,
      });
      await client.query("COMMIT");
      return { claimIds, status };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #audit(
    client: PoolClient,
    input: {
      organizationId: string;
      caseId: string;
      actor: string;
      action: string;
      resourceId: string;
      correlationId: string;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         result, correlation_id, origin)
       VALUES ($1, $2, $3, $4, 'research_request', $5, 'SUCCEEDED', $6, 'research-store')`,
      [
        input.organizationId,
        input.caseId,
        input.actor,
        input.action,
        input.resourceId,
        input.correlationId,
      ],
    );
  }
}
