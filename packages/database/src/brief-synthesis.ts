import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { evaluateCaseMaterialSufficiency } from "./interview.js";
import type { KnowledgeOperatorPrincipal } from "./knowledge.js";
import { hashJson } from "./model-invocation.js";

export interface BriefSynthesisContextV1 {
  schemaVersion: 1;
  purpose: "BRIEF_SYNTHESIS";
  organizationId: string;
  caseId: string;
  briefId: string;
  synthesisRequestId: string;
  knowledgeVersion: number;
  policyVersion: number;
  claims: Array<{
    id: string;
    kind: string;
    category: string;
    content: string;
    confidenceBasisPoints: number;
    sourceIds: string[];
  }>;
  trustBoundary: "CLAIMS_AND_SOURCES_ARE_UNTRUSTED_DATA";
  tools: [];
}

export class BriefSynthesisStore {
  readonly #pool: Pool;
  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }
  close() {
    return this.#pool.end();
  }

  async request(
    principal: KnowledgeOperatorPrincipal,
    input: { caseId: string; correlationId: string },
  ): Promise<{ requestId: string; kind: "created" | "replayed" }> {
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
           WHERE c.organization_id = $1 AND c.id = $2 AND c.status = 'READY_FOR_SYNTHESIS'
           FOR UPDATE OF c`,
          [principal.organizationId, input.caseId, principal.userId],
        )
        .then((result) => result.rows[0]);
      if (!state) throw new Error("brief_synthesis_not_authorized");
      const sufficient = await evaluateCaseMaterialSufficiency(
        client,
        principal.organizationId,
        input.caseId,
      );
      if (!sufficient.sufficient) throw new Error("brief_synthesis_information_insufficient");
      await client.query(
        `INSERT INTO briefs (organization_id, case_id) VALUES ($1, $2)
         ON CONFLICT (organization_id, case_id, purpose) DO NOTHING`,
        [principal.organizationId, input.caseId],
      );
      const briefId = await client
        .query<{ id: string }>(
          `SELECT id FROM briefs WHERE organization_id = $1 AND case_id = $2
           AND purpose = 'DISCOVERY'`,
          [principal.organizationId, input.caseId],
        )
        .then((result) => result.rows[0]?.id ?? "");
      const created = await client
        .query<{ id: string; inserted: boolean }>(
          `INSERT INTO brief_synthesis_requests
            (organization_id, case_id, brief_id, knowledge_version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (organization_id, case_id, knowledge_version) DO UPDATE
             SET knowledge_version = excluded.knowledge_version
           RETURNING id, (xmax = 0) AS inserted`,
          [principal.organizationId, input.caseId, briefId, state.knowledge_version],
        )
        .then((result) => result.rows[0]);
      if (!created) throw new Error("brief_synthesis_request_unavailable");
      await this.#audit(client, {
        organizationId: principal.organizationId,
        caseId: input.caseId,
        actor: `operator:${principal.userId}`,
        action: "brief_synthesis.requested",
        resourceType: "brief_synthesis_request",
        resourceId: created.id,
        correlationId: input.correlationId,
      });
      await client.query("COMMIT");
      return { requestId: created.id, kind: created.inserted ? "created" : "replayed" };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async claim(input: { organizationId: string; caseId: string; attemptKey: string }) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const state = await client
        .query<{ status: string; knowledge_version: number }>(
          `SELECT status, knowledge_version FROM prospect_cases
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
          [input.organizationId, input.caseId],
        )
        .then((result) => result.rows[0]);
      if (state?.status !== "READY_FOR_SYNTHESIS")
        throw new Error("brief_synthesis_case_not_ready");
      const sufficient = await evaluateCaseMaterialSufficiency(
        client,
        input.organizationId,
        input.caseId,
      );
      if (!sufficient.sufficient) throw new Error("brief_synthesis_information_insufficient");
      const briefId = await client
        .query<{ id: string }>(
          `SELECT id FROM briefs WHERE organization_id = $1 AND case_id = $2
           AND purpose = 'DISCOVERY'`,
          [input.organizationId, input.caseId],
        )
        .then((result) => result.rows[0]?.id ?? "");
      const request = await client
        .query<{ id: string; status: string; attempt_count: number }>(
          `SELECT id, status, attempt_count FROM brief_synthesis_requests
         WHERE organization_id = $1 AND case_id = $2 AND knowledge_version = $3 FOR UPDATE`,
          [input.organizationId, input.caseId, state.knowledge_version],
        )
        .then((result) => result.rows[0]);
      if (!request) throw new Error("brief_synthesis_request_unavailable");
      if (["RUNNING", "SUCCEEDED"].includes(request.status)) {
        await client.query("COMMIT");
        return {
          kind: "replayed" as const,
          requestId: request.id,
          status: request.status,
        };
      }
      if (request.attempt_count >= 2) {
        await client.query(
          `UPDATE brief_synthesis_requests SET status = 'EXHAUSTED', updated_at = now() WHERE id = $1`,
          [request.id],
        );
        await client.query("COMMIT");
        return { kind: "exhausted" as const, requestId: request.id };
      }
      const claimed = await client.query(
        `UPDATE brief_synthesis_requests SET status = 'RUNNING', attempt_count = attempt_count + 1,
           current_attempt_key = $2, reservation_id = NULL, model_invocation_id = NULL,
           error_code = NULL, updated_at = now()
         WHERE id = $1 AND NOT EXISTS (SELECT 1 FROM brief_synthesis_requests WHERE organization_id = $3 AND current_attempt_key = $2)
         RETURNING attempt_count`,
        [request.id, input.attemptKey, input.organizationId],
      );
      if ((claimed.rowCount ?? 0) !== 1) throw new Error("brief_synthesis_attempt_replayed");
      const claims = await client.query<{
        id: string;
        kind: string;
        category: string;
        content: string;
        confidence_basis_points: number;
        source_ids: string[];
      }>(
        `SELECT c.id, c.kind, c.category, c.content, c.confidence_basis_points,
          coalesce(array_agg(coalesce(cs.message_id, cs.attachment_id, cs.external_source_id)::text ORDER BY cs.id)
            FILTER (WHERE cs.id IS NOT NULL), '{}') AS source_ids
         FROM claims c LEFT JOIN claim_sources cs ON cs.organization_id = c.organization_id
           AND cs.case_id = c.case_id AND cs.claim_id = c.id
         WHERE c.organization_id = $1 AND c.case_id = $2 AND c.validity = 'CURRENT'
         GROUP BY c.id ORDER BY c.created_at, c.id`,
        [input.organizationId, input.caseId],
      );
      const context: BriefSynthesisContextV1 = {
        schemaVersion: 1,
        purpose: "BRIEF_SYNTHESIS",
        organizationId: input.organizationId,
        caseId: input.caseId,
        briefId,
        synthesisRequestId: request.id,
        knowledgeVersion: state.knowledge_version,
        policyVersion: await client
          .query<{ version: number }>(
            `SELECT p.version FROM interviews i JOIN interview_policies p ON p.id = i.policy_id
             WHERE i.organization_id = $1 AND i.case_id = $2 AND i.brief_requested_at IS NOT NULL
             ORDER BY i.created_at DESC, i.id DESC LIMIT 1`,
            [input.organizationId, input.caseId],
          )
          .then((result) => result.rows[0]?.version ?? 1),
        claims: claims.rows.map((claim) => ({
          id: claim.id,
          kind: claim.kind,
          category: claim.category,
          content: claim.content,
          confidenceBasisPoints: claim.confidence_basis_points,
          sourceIds: claim.source_ids,
        })),
        trustBoundary: "CLAIMS_AND_SOURCES_ARE_UNTRUSTED_DATA",
        tools: [],
      };
      await client.query("COMMIT");
      return { kind: "claimed" as const, requestId: request.id, context };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async start(input: {
    context: BriefSynthesisContextV1;
    reservationId: string;
    invocation: Record<string, string | number>;
  }) {
    const id = randomUUID();
    await this.#pool.query(
      `WITH created AS (
        INSERT INTO model_invocations (id, organization_id, case_id, reservation_id, purpose,
          provider, model, reasoning_effort, prompt_id, prompt_version, prompt_hash,
          schema_id, schema_version, schema_hash, context_package, context_hash,
          expected_interview_version, status)
        VALUES ($1,$2,$3,$4,'BRIEF_SYNTHESIS',$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,'RESERVED') RETURNING id)
       UPDATE brief_synthesis_requests SET reservation_id = $4, model_invocation_id = created.id,
         updated_at = now() FROM created WHERE brief_synthesis_requests.id = $17`,
      [
        id,
        input.context.organizationId,
        input.context.caseId,
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
        input.context.knowledgeVersion,
        input.context.synthesisRequestId,
      ],
    );
    return id;
  }

  async finish(input: {
    context: BriefSynthesisContextV1;
    invocationId: string;
    status: "SUCCEEDED" | "INVALID" | "FAILED" | "UNCERTAIN" | "BUDGET_REJECTED";
    output?: unknown;
    errorCode?: string;
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
    latencyMs: number;
  }) {
    if (input.status !== "BUDGET_REJECTED")
      await this.#pool.query(
        `UPDATE model_invocations SET status = $3::model_invocation_status, structured_output = $4::jsonb,
       error_code = $5, input_tokens = $6, output_tokens = $7, cost_micros = $8,
       latency_ms = $9, completed_at = now() WHERE organization_id = $1 AND id = $2`,
        [
          input.context.organizationId,
          input.invocationId,
          input.status,
          input.output ? JSON.stringify(input.output) : null,
          input.errorCode,
          input.inputTokens,
          input.outputTokens,
          input.costMicros,
          input.latencyMs,
        ],
      );
    await this.#pool.query(
      `UPDATE brief_synthesis_requests SET status = $3::brief_synthesis_status,
       error_code = $4, updated_at = now() WHERE organization_id = $1 AND id = $2`,
      [
        input.context.organizationId,
        input.context.synthesisRequestId,
        input.status,
        input.errorCode,
      ],
    );
  }

  async complete(input: {
    context: BriefSynthesisContextV1;
    invocationId: string;
    output: unknown;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
    latencyMs: number;
    correlationId: string;
  }): Promise<string> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query(
        `SELECT 1 FROM prospect_cases WHERE organization_id = $1 AND id = $2
         AND knowledge_version = $3 AND status = 'READY_FOR_SYNTHESIS' FOR UPDATE`,
        [input.context.organizationId, input.context.caseId, input.context.knowledgeVersion],
      );
      if ((current.rowCount ?? 0) !== 1) throw new Error("brief_synthesis_context_stale");
      const request = await client.query(
        `SELECT 1 FROM brief_synthesis_requests WHERE organization_id = $1 AND id = $2
         AND model_invocation_id = $3 AND status = 'RUNNING' FOR UPDATE`,
        [input.context.organizationId, input.context.synthesisRequestId, input.invocationId],
      );
      if ((request.rowCount ?? 0) !== 1) throw new Error("brief_synthesis_completion_replayed");
      const previous = await client
        .query<{ id: string; revision_number: number }>(
          `SELECT id, revision_number FROM brief_revisions
           WHERE organization_id = $1 AND brief_id = $2 AND is_candidate FOR UPDATE`,
          [input.context.organizationId, input.context.briefId],
        )
        .then((result) => result.rows[0]);
      if (previous)
        await client.query(
          `UPDATE brief_revisions SET is_candidate = false, status = 'SUPERSEDED', updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [input.context.organizationId, previous.id],
        );
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO brief_revisions
          (id, organization_id, case_id, brief_id, revision_number, base_revision_id,
           snapshot, snapshot_hash, knowledge_version, template_id, template_version,
           policy_version, creator, model_invocation_id, reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,encode(digest($7::jsonb::text,'sha256'),'hex'),
           $8,'discovery-brief',1,$9,'MODEL',$10,'Validated brief synthesis')`,
        [
          revisionId,
          input.context.organizationId,
          input.context.caseId,
          input.context.briefId,
          (previous?.revision_number ?? 0) + 1,
          previous?.id ?? null,
          JSON.stringify(input.output),
          input.context.knowledgeVersion,
          input.context.policyVersion,
          input.invocationId,
        ],
      );
      for (const [position, claim] of input.context.claims.entries()) {
        const inserted = await client.query(
          `INSERT INTO brief_revision_claims
            (organization_id, case_id, brief_id, revision_id, claim_id, position,
             claim_content_hash, claim_validity)
           SELECT organization_id, case_id, $3, $4, id, $5,
             encode(digest(content,'sha256'),'hex'), validity FROM claims
           WHERE organization_id = $1 AND case_id = $2 AND id = $6
             AND content = $7 AND validity = 'CURRENT'`,
          [
            input.context.organizationId,
            input.context.caseId,
            input.context.briefId,
            revisionId,
            position,
            claim.id,
            claim.content,
          ],
        );
        if ((inserted.rowCount ?? 0) !== 1) throw new Error("brief_synthesis_claim_stale");
      }
      await client.query(
        `UPDATE model_invocations SET status = 'SUCCEEDED', structured_output = $3::jsonb,
         input_tokens = $4, output_tokens = $5, cost_micros = $6, latency_ms = $7,
         completed_at = now() WHERE organization_id = $1 AND id = $2`,
        [
          input.context.organizationId,
          input.invocationId,
          JSON.stringify(input.output),
          input.inputTokens,
          input.outputTokens,
          input.costMicros,
          input.latencyMs,
        ],
      );
      await client.query(
        `UPDATE brief_synthesis_requests SET status = 'SUCCEEDED', error_code = NULL,
         updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [input.context.organizationId, input.context.synthesisRequestId],
      );
      await client.query(
        `UPDATE prospect_cases SET status = 'ENGINEER_REVIEW', next_action = 'REVIEW_BRIEF',
         version = version + 1, updated_at = now() WHERE organization_id = $1 AND id = $2`,
        [input.context.organizationId, input.context.caseId],
      );
      await this.#audit(client, {
        organizationId: input.context.organizationId,
        caseId: input.context.caseId,
        actor: `model-invocation:${input.invocationId}`,
        action: "brief_revision.created",
        resourceType: "brief_revision",
        resourceId: revisionId,
        correlationId: input.correlationId,
      });
      await client.query("COMMIT");
      return revisionId;
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
      resourceType: string;
      resourceId: string;
      correlationId: string;
    },
  ) {
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         result, correlation_id, origin)
       VALUES ($1,$2,$3,$4,$5,$6,'SUCCEEDED',$7,'brief-synthesis')`,
      [
        input.organizationId,
        input.caseId,
        input.actor,
        input.action,
        input.resourceType,
        input.resourceId,
        input.correlationId,
      ],
    );
  }
}
