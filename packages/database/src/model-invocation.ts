import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { evaluateCaseMaterialSufficiency } from "./interview.js";

export interface ContextPackageV1 {
  schemaVersion: 1;
  organizationId: string;
  caseId: string;
  purpose: "INTERVIEW_EXTRACT" | "NEXT_QUESTION";
  locale: string;
  expectedInterviewVersion: number;
  interviewPolicyVersion: number;
  topics: Array<{ key: string; status: string; required: boolean }>;
  sufficiency: { sufficient: boolean; missing: string[] };
  currentClaims: Array<{ id: string; category: string; content: string; kind: string }>;
  messages: Array<{ id: string; content: string; occurredAt: string }>;
  trustBoundary: "PROSPECT_CONTENT_IS_UNTRUSTED_DATA";
  tools: [];
}

export function hashJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export class ModelInvocationStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async buildExtractionContext(input: {
    organizationId: string;
    caseId: string;
    messageIds: string[];
    purpose?: ContextPackageV1["purpose"];
  }): Promise<{ interviewId: string; context: ContextPackageV1 }> {
    if (
      input.messageIds.length === 0 ||
      input.messageIds.length > 5 ||
      new Set(input.messageIds).size !== input.messageIds.length
    )
      throw new Error("model_context_messages_invalid");
    const interview = await this.#pool.query<{
      id: string;
      version: number;
      policy_version: number;
      locale: string;
    }>(
      `SELECT i.id, i.version, p.version AS policy_version, p.locale
       FROM interviews i JOIN interview_policies p ON p.id = i.policy_id
       WHERE i.organization_id = $1 AND i.case_id = $2`,
      [input.organizationId, input.caseId],
    );
    const state = interview.rows[0];
    if (!state) throw new Error("model_context_interview_not_found");
    const messages = await this.#pool.query<{
      id: string;
      content: Buffer;
      provider_occurred_at: Date;
    }>(
      `SELECT id, content_bytes AS content, provider_occurred_at
       FROM messages
       WHERE organization_id = $1 AND case_id = $2 AND id = ANY($3::uuid[])
         AND direction = 'INBOUND' AND message_type = 'text'
         AND content_bytes IS NOT NULL AND octet_length(content_bytes) <= 8192
       ORDER BY array_position($3::uuid[], id)`,
      [input.organizationId, input.caseId, input.messageIds],
    );
    if (messages.rows.length !== input.messageIds.length)
      throw new Error("model_context_message_not_authorized");
    const topics = await this.#pool.query<{
      topic_key: string;
      status: string;
      required: boolean;
    }>(
      `SELECT topic_key, status, required FROM interview_topics
       WHERE organization_id = $1 AND interview_id = $2 ORDER BY position`,
      [input.organizationId, state.id],
    );
    const claims = await this.#pool.query<{
      id: string;
      category: string;
      content: string;
      kind: string;
    }>(
      `SELECT id, category, content, kind FROM claims
       WHERE organization_id = $1 AND case_id = $2 AND validity = 'CURRENT'
       ORDER BY created_at, id`,
      [input.organizationId, input.caseId],
    );
    const material = await evaluateCaseMaterialSufficiency(
      this.#pool,
      input.organizationId,
      input.caseId,
    );
    const resolutionTargets = [...material.missing, ...material.blockers];
    return {
      interviewId: state.id,
      context: {
        schemaVersion: 1,
        organizationId: input.organizationId,
        caseId: input.caseId,
        purpose: input.purpose ?? "INTERVIEW_EXTRACT",
        locale: state.locale,
        expectedInterviewVersion: state.version,
        interviewPolicyVersion: state.policy_version,
        topics: topics.rows.map((topic) => ({
          key: topic.topic_key,
          status: topic.status,
          required: topic.required,
        })),
        sufficiency: { sufficient: material.sufficient, missing: resolutionTargets },
        currentClaims: claims.rows,
        messages: messages.rows.map((message) => ({
          id: message.id,
          content: new TextDecoder("utf-8", { fatal: true }).decode(message.content),
          occurredAt: message.provider_occurred_at.toISOString(),
        })),
        trustBoundary: "PROSPECT_CONTENT_IS_UNTRUSTED_DATA",
        tools: [],
      },
    };
  }

  async create(input: {
    organizationId: string;
    caseId: string;
    interviewId: string;
    reservationId: string;
    provider: string;
    model: string;
    reasoningEffort: string;
    promptId: string;
    promptVersion: number;
    promptHash: string;
    schemaId: string;
    schemaVersion: number;
    schemaHash: string;
    context: ContextPackageV1;
    purpose?: ContextPackageV1["purpose"];
    initialStatus?: "RESERVED" | "BUDGET_REJECTED";
  }): Promise<{ id: string; created: boolean }> {
    const id = randomUUID();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO model_invocations
          (id, organization_id, case_id, interview_id, reservation_id, purpose,
           provider, model, reasoning_effort, prompt_id, prompt_version, prompt_hash,
           schema_id, schema_version, schema_hash, context_package, context_hash,
           expected_interview_version, status)
         VALUES ($1, $2, $3, $4, $5, $19, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15::jsonb, $16, $17, $18::model_invocation_status)
         ON CONFLICT (organization_id, reservation_id) DO NOTHING RETURNING id`,
        [
          id,
          input.organizationId,
          input.caseId,
          input.interviewId,
          input.reservationId,
          input.provider,
          input.model,
          input.reasoningEffort,
          input.promptId,
          input.promptVersion,
          input.promptHash,
          input.schemaId,
          input.schemaVersion,
          input.schemaHash,
          JSON.stringify(input.context),
          hashJson(input.context),
          input.context.expectedInterviewVersion,
          input.initialStatus ?? "RESERVED",
          input.purpose ?? input.context.purpose,
        ],
      );
      const created = (inserted.rowCount ?? 0) > 0;
      let invocationId = inserted.rows[0]?.id;
      if (created) {
        for (const [position, message] of input.context.messages.entries()) {
          await client.query(
            `INSERT INTO model_invocation_messages
              (organization_id, case_id, invocation_id, message_id, position)
             VALUES ($1, $2, $3, $4, $5)`,
            [input.organizationId, input.caseId, id, message.id, position],
          );
        }
      } else {
        invocationId = await client
          .query<{ id: string }>(
            `SELECT id FROM model_invocations
             WHERE organization_id = $1 AND reservation_id = $2`,
            [input.organizationId, input.reservationId],
          )
          .then((result) => result.rows[0]?.id);
      }
      if (!invocationId) throw new Error("model_invocation_unavailable");
      await client.query("COMMIT");
      return { id: invocationId, created };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finish(input: {
    organizationId: string;
    invocationId: string;
    status: "SUCCEEDED" | "INVALID" | "FAILED" | "UNCERTAIN";
    providerResponseId?: string;
    output?: unknown;
    errorCode?: string;
    inputTokens?: number;
    outputTokens?: number;
    costMicros?: number;
    latencyMs: number;
    nextActionProposal?: {
      action: "ASK" | "SUMMARIZE" | "PAUSE" | "ESCALATE" | "READY";
      question?: string;
      summary?: string;
      reasonCode: string;
      targetTopic?: string;
      referencedClaimIds: string[];
    };
  }): Promise<{ proposalId?: string }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ case_id: string; purpose: string }>(
        `UPDATE model_invocations SET status = $3::model_invocation_status,
           provider_response_id = $4, structured_output = $5::jsonb, error_code = $6,
           input_tokens = $7, output_tokens = $8, cost_micros = $9,
           latency_ms = $10, completed_at = now()
         WHERE organization_id = $1 AND id = $2 AND status = 'RESERVED'
         RETURNING case_id, purpose`,
        [
          input.organizationId,
          input.invocationId,
          input.status,
          input.providerResponseId,
          input.output === undefined ? null : JSON.stringify(input.output),
          input.errorCode,
          input.inputTokens,
          input.outputTokens,
          input.costMicros,
          input.latencyMs,
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("model_invocation_not_reservable");
      if (input.status === "SUCCEEDED" && row.purpose === "INTERVIEW_EXTRACT") {
        await client.query(
          `INSERT INTO model_candidate_batches
            (organization_id, case_id, invocation_id, output)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [input.organizationId, row.case_id, input.invocationId, JSON.stringify(input.output)],
        );
      }
      let proposalId: string | undefined;
      if (input.status === "SUCCEEDED" && row.purpose === "NEXT_QUESTION") {
        const proposal = input.nextActionProposal;
        if (!proposal) throw new Error("next_action_proposal_required");
        proposalId = randomUUID();
        await client.query(
          `INSERT INTO next_action_proposals
            (id, organization_id, case_id, interview_id, model_invocation_id, action,
             question, summary, reason_code, target_topic, referenced_claim_ids)
           SELECT $3, organization_id, case_id, interview_id, id,
             $4::next_action_kind, $5, $6, $7, $8, $9::jsonb
           FROM model_invocations WHERE organization_id = $1 AND id = $2`,
          [
            input.organizationId,
            input.invocationId,
            proposalId,
            proposal.action,
            proposal.question,
            proposal.summary,
            proposal.reasonCode,
            proposal.targetTopic,
            JSON.stringify(proposal.referencedClaimIds),
          ],
        );
      }
      await client.query("COMMIT");
      return { proposalId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
