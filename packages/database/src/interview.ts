import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type InterviewStatus = "NOT_STARTED" | "ACTIVE" | "SUFFICIENT";
export type InterviewTopicStatus = "MISSING" | "CAPTURED" | "NOT_APPLICABLE" | "DECLARED_UNKNOWN";

export interface InterviewPolicyTopic {
  key: string;
  required: boolean;
}

export interface InterviewPolicy {
  version: number;
  topics: InterviewPolicyTopic[];
}

export interface InterviewState {
  id: string;
  organizationId: string;
  caseId: string;
  policyId: string;
  policyVersion: number;
  status: InterviewStatus;
  pendingQuestion: string | null;
  briefRequestedAt: Date | null;
  briefRequestMessageId: string | null;
  activeSeconds: number;
  activeStartedAt: Date | null;
  pausedAt: Date | null;
  pauseReason: string | null;
  version: number;
  topics: Array<InterviewPolicyTopic & { position: number; status: InterviewTopicStatus }>;
}

export const DEFAULT_INTERVIEW_POLICY: InterviewPolicy = {
  version: 1,
  topics: [
    { key: "PROJECT_INTENT", required: true },
    { key: "AUDIENCE", required: true },
    { key: "DESIRED_OUTCOME", required: true },
    { key: "CONTEXT", required: true },
    { key: "CONSTRAINTS", required: true },
  ],
};

export function evaluateInterviewPolicy(
  policy: InterviewPolicy,
  states: Readonly<Record<string, InterviewTopicStatus>>,
): { sufficient: boolean; missing: string[] } {
  if (
    !Number.isSafeInteger(policy.version) ||
    policy.version <= 0 ||
    policy.topics.length === 0 ||
    new Set(policy.topics.map((topic) => topic.key)).size !== policy.topics.length ||
    policy.topics.some((topic) => !topic.key.trim())
  )
    throw new Error("interview_policy_invalid");
  const missing = policy.topics
    .filter((topic) => {
      const status = states[topic.key] ?? "MISSING";
      return (
        topic.required &&
        (status === "MISSING" || (status === "DECLARED_UNKNOWN" && topic.key !== "CONSTRAINTS"))
      );
    })
    .map((topic) => topic.key);
  return { sufficient: missing.length === 0, missing };
}

export function isExplicitBriefRequest(text: string): boolean {
  return /\b(quiero|quisiera|deseo|necesito|puedes|podr[ií]as|prepara|genera|env[ií]a(?:me)?)\b[\s\S]{0,80}\b(brief|resumen)\b/iu.test(
    text.normalize("NFC"),
  );
}

export interface MaterialSufficiencyInput {
  policy: InterviewPolicy;
  states: Readonly<Record<string, InterviewTopicStatus>>;
  briefRequested: boolean;
  unresolvedContradictionIds: readonly string[];
  unbackedClaimIds: readonly string[];
}

export interface MaterialSufficiencyResult {
  sufficient: boolean;
  missing: string[];
  blockers: string[];
}

export function evaluateMaterialSufficiency(
  input: MaterialSufficiencyInput,
): MaterialSufficiencyResult {
  const basic = evaluateInterviewPolicy(input.policy, input.states);
  const missing = [...basic.missing];
  if (!input.briefRequested) missing.push("BRIEF_REQUEST");
  const blockers = [
    ...input.unresolvedContradictionIds.map((id) => `CONTRADICTION:${id}`),
    ...input.unbackedClaimIds.map((id) => `UNBACKED_CLAIM:${id}`),
  ];
  return { sufficient: missing.length === 0 && blockers.length === 0, missing, blockers };
}

export async function evaluateCaseMaterialSufficiency(
  client: Pool | PoolClient,
  organizationId: string,
  caseId: string,
): Promise<MaterialSufficiencyResult> {
  const interview = await client.query<{
    policy_version: number;
    brief_request_message_id: string | null;
  }>(
    `SELECT p.version AS policy_version, i.brief_request_message_id
     FROM interviews i JOIN interview_policies p ON p.id = i.policy_id
     WHERE i.organization_id = $1 AND i.case_id = $2`,
    [organizationId, caseId],
  );
  const current = interview.rows[0];
  if (!current) throw new Error("interview_not_found");
  const topics = await client.query<{
    topic_key: string;
    required: boolean;
    status: InterviewTopicStatus;
  }>(
    `SELECT topic_key, required, status FROM interview_topics
     WHERE organization_id = $1 AND case_id = $2 ORDER BY position`,
    [organizationId, caseId],
  );
  const contradictions = await client.query<{ id: string }>(
    `SELECT DISTINCT source.id
     FROM claim_relations r
     JOIN claims source ON source.organization_id = r.organization_id
       AND source.case_id = r.case_id AND source.id = r.source_claim_id
     JOIN claims target ON target.organization_id = r.organization_id
       AND target.case_id = r.case_id AND target.id = r.target_claim_id
     WHERE r.organization_id = $1 AND r.case_id = $2 AND r.relation = 'CONTRADICTS'
       AND source.validity = 'CURRENT' AND target.validity = 'CURRENT'
     ORDER BY source.id`,
    [organizationId, caseId],
  );
  const unbacked = await client.query<{ id: string }>(
    `SELECT c.id FROM claims c
     WHERE c.organization_id = $1 AND c.case_id = $2 AND c.validity = 'CURRENT'
       AND c.kind NOT IN ('QUESTION', 'CONTRADICTION')
       AND NOT EXISTS (
         SELECT 1 FROM claim_sources cs
         WHERE cs.organization_id = c.organization_id AND cs.case_id = c.case_id
           AND cs.claim_id = c.id
       )
     ORDER BY c.id`,
    [organizationId, caseId],
  );
  const policy = {
    version: current.policy_version,
    topics: topics.rows.map((topic) => ({ key: topic.topic_key, required: topic.required })),
  };
  return evaluateMaterialSufficiency({
    policy,
    states: Object.fromEntries(topics.rows.map((topic) => [topic.topic_key, topic.status])),
    briefRequested: current.brief_request_message_id !== null,
    unresolvedContradictionIds: contradictions.rows.map((row) => row.id),
    unbackedClaimIds: unbacked.rows.map((row) => row.id),
  });
}

export class InterviewStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async create(input: {
    organizationId: string;
    caseId: string;
    correlationId: string;
  }): Promise<{ created: boolean; interview: InterviewState }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const caseResult = await client.query<{ status: string }>(
        `SELECT status FROM prospect_cases
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [input.organizationId, input.caseId],
      );
      if (!caseResult.rows[0]) throw new Error("interview_case_not_found");
      if (caseResult.rows[0].status !== "INTERVIEWING")
        throw new Error("interview_case_not_available");
      const consent = await client.query<{ action: string; valid_until: Date | null }>(
        `SELECT action, valid_until FROM consent_records
         WHERE organization_id = $1 AND case_id = $2 AND purpose = 'DISCOVERY'
         ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
        [input.organizationId, input.caseId],
      );
      const currentConsent = consent.rows[0];
      if (
        currentConsent?.action !== "ACCEPTED" ||
        (currentConsent.valid_until && currentConsent.valid_until.getTime() <= Date.now())
      )
        throw new Error("interview_consent_required");

      await client.query(
        `INSERT INTO interview_policies (organization_id, version, topics)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (organization_id, version) DO NOTHING`,
        [
          input.organizationId,
          DEFAULT_INTERVIEW_POLICY.version,
          JSON.stringify(DEFAULT_INTERVIEW_POLICY.topics),
        ],
      );
      const policyResult = await client.query<{
        id: string;
        version: number;
        topics: InterviewPolicyTopic[];
      }>(
        `SELECT id, version, topics FROM interview_policies
         WHERE organization_id = $1 AND effective_at <= now()
         ORDER BY version DESC LIMIT 1`,
        [input.organizationId],
      );
      const policy = policyResult.rows[0];
      if (!policy) throw new Error("interview_policy_unavailable");
      evaluateInterviewPolicy({ version: policy.version, topics: policy.topics }, {});

      const id = randomUUID();
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO interviews (id, organization_id, case_id, policy_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (organization_id, case_id) DO NOTHING RETURNING id`,
        [id, input.organizationId, input.caseId, policy.id],
      );
      const created = (inserted.rowCount ?? 0) > 0;
      if (created) {
        for (const [position, topic] of policy.topics.entries()) {
          await client.query(
            `INSERT INTO interview_topics
              (organization_id, case_id, interview_id, topic_key, position, required)
             VALUES ($1, $2, $3, $4, $5, $6)`,
            [input.organizationId, input.caseId, id, topic.key, position, topic.required],
          );
        }
        await this.#audit(
          client,
          input.organizationId,
          input.caseId,
          id,
          "interview.created",
          input.correlationId,
        );
      }
      const interview = await this.#get(client, input.organizationId, input.caseId);
      if (!interview) throw new Error("interview_not_found");
      await client.query("COMMIT");
      return { created, interview };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async get(organizationId: string, caseId: string): Promise<InterviewState | undefined> {
    const client = await this.#pool.connect();
    try {
      return await this.#get(client, organizationId, caseId, false);
    } finally {
      client.release();
    }
  }

  async recordBriefRequest(input: {
    organizationId: string;
    caseId: string;
    sourceMessageId: string;
    correlationId: string;
  }): Promise<{ changed: boolean; interview: InterviewState }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.#get(client, input.organizationId, input.caseId, true);
      if (!current) throw new Error("interview_not_found");
      if (current.briefRequestMessageId) {
        await client.query("COMMIT");
        return { changed: false, interview: current };
      }
      const source = await client.query<{ direction: string; content_bytes: Buffer | null }>(
        `SELECT direction, content_bytes FROM messages
         WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
        [input.organizationId, input.caseId, input.sourceMessageId],
      );
      const message = source.rows[0];
      if (
        message?.direction !== "INBOUND" ||
        !message.content_bytes ||
        !isExplicitBriefRequest(message.content_bytes.toString("utf8"))
      )
        throw new Error("brief_request_not_explicit");
      await client.query(
        `UPDATE interviews SET brief_requested_at = now(), brief_request_message_id = $3,
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND case_id = $2`,
        [input.organizationId, input.caseId, input.sourceMessageId],
      );
      await this.#audit(
        client,
        input.organizationId,
        input.caseId,
        current.id,
        "interview.brief-requested",
        input.correlationId,
      );
      const interview = await this.#get(client, input.organizationId, input.caseId);
      await client.query("COMMIT");
      if (!interview) throw new Error("interview_not_found");
      return { changed: true, interview };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async update(input: {
    organizationId: string;
    caseId: string;
    expectedVersion: number;
    topicStates?: Partial<Record<string, InterviewTopicStatus>>;
    pendingQuestion?: string | null;
    correlationId: string;
  }): Promise<InterviewState> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.#get(client, input.organizationId, input.caseId, true);
      if (!current) throw new Error("interview_not_found");
      if (current.version !== input.expectedVersion) throw new Error("interview_version_conflict");
      const allowed = new Set(current.topics.map((topic) => topic.key));
      for (const [key, status] of Object.entries(input.topicStates ?? {})) {
        if (!allowed.has(key) || !status) throw new Error("interview_topic_invalid");
        await client.query(
          `UPDATE interview_topics SET status = $4::interview_topic_status, updated_at = now()
           WHERE organization_id = $1 AND interview_id = $2 AND topic_key = $3`,
          [input.organizationId, current.id, key, status],
        );
      }
      const states = Object.fromEntries(
        current.topics.map((topic) => [topic.key, input.topicStates?.[topic.key] ?? topic.status]),
      );
      const evaluation = evaluateInterviewPolicy(
        {
          version: current.policyVersion,
          topics: current.topics.map(({ key, required }) => ({ key, required })),
        },
        states,
      );
      const pendingQuestion =
        "pendingQuestion" in input
          ? input.pendingQuestion?.trim() || null
          : current.pendingQuestion;
      const updated = await client.query(
        `UPDATE interviews SET status = $4::interview_status, pending_question = $5,
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND version = $3`,
        [
          input.organizationId,
          input.caseId,
          input.expectedVersion,
          evaluation.sufficient ? "SUFFICIENT" : "ACTIVE",
          pendingQuestion,
        ],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error("interview_version_conflict");
      await this.#audit(
        client,
        input.organizationId,
        input.caseId,
        current.id,
        "interview.updated",
        input.correlationId,
      );
      const interview = await this.#get(client, input.organizationId, input.caseId);
      await client.query("COMMIT");
      if (!interview) throw new Error("interview_not_found");
      return interview;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pause(input: {
    organizationId: string;
    caseId: string;
    expectedVersion: number;
    reason: string;
    correlationId: string;
  }): Promise<{ changed: boolean; interview: InterviewState }> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 80) throw new Error("interview_pause_reason_invalid");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.#get(client, input.organizationId, input.caseId, true);
      if (!current) throw new Error("interview_not_found");
      if (current.pausedAt) {
        await client.query("COMMIT");
        return { changed: false, interview: current };
      }
      if (current.version !== input.expectedVersion) throw new Error("interview_version_conflict");
      const caseState = await client.query<{ status: string; next_action: string | null }>(
        `SELECT status, next_action FROM prospect_cases
         WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [input.organizationId, input.caseId],
      );
      const state = caseState.rows[0];
      if (state?.status !== "INTERVIEWING") throw new Error("interview_case_not_active");
      await client.query(
        `UPDATE case_quota_usages SET
           active_seconds = active_seconds + greatest(0, floor(extract(epoch FROM (now() - last_accounted_at))))::integer,
           last_accounted_at = now(), updated_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND window_ends_at > now()`,
        [input.organizationId, input.caseId],
      );
      await client.query(
        `UPDATE interviews SET
           active_seconds = active_seconds + greatest(0, floor(extract(epoch FROM (now() - active_started_at))))::bigint,
           active_started_at = NULL, paused_at = now(), pause_reason = $4,
           resume_case_status = $5::case_status, resume_next_action = $6,
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND version = $3`,
        [
          input.organizationId,
          input.caseId,
          input.expectedVersion,
          reason,
          state.status,
          state.next_action,
        ],
      );
      await client.query(
        `UPDATE prospect_cases SET status = 'PAUSED', next_action = 'INTERVIEW_PAUSED',
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.caseId],
      );
      await this.#audit(
        client,
        input.organizationId,
        input.caseId,
        current.id,
        "interview.paused",
        input.correlationId,
      );
      const interview = await this.#get(client, input.organizationId, input.caseId);
      await client.query("COMMIT");
      if (!interview) throw new Error("interview_not_found");
      return { changed: true, interview };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async resume(input: {
    organizationId: string;
    caseId: string;
    expectedVersion: number;
    correlationId: string;
  }): Promise<{ changed: boolean; interview: InterviewState }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const current = await this.#get(client, input.organizationId, input.caseId, true);
      if (!current) throw new Error("interview_not_found");
      if (!current.pausedAt) {
        await client.query("COMMIT");
        return { changed: false, interview: current };
      }
      if (current.version !== input.expectedVersion) throw new Error("interview_version_conflict");
      const state = await client.query<{
        case_status: string;
        next_action: string | null;
        resume_case_status: string | null;
        resume_next_action: string | null;
      }>(
        `SELECT pc.status AS case_status, pc.next_action, i.resume_case_status, i.resume_next_action
         FROM interviews i JOIN prospect_cases pc
           ON pc.organization_id = i.organization_id AND pc.id = i.case_id
         WHERE i.organization_id = $1 AND i.case_id = $2 FOR UPDATE OF pc`,
        [input.organizationId, input.caseId],
      );
      const paused = state.rows[0];
      if (paused?.case_status !== "PAUSED" || paused.next_action !== "INTERVIEW_PAUSED")
        throw new Error("interview_resume_not_authorized");
      const consent = await client.query<{ action: string; valid_until: Date | null }>(
        `SELECT action, valid_until FROM consent_records
         WHERE organization_id = $1 AND case_id = $2 AND purpose = 'DISCOVERY'
         ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
        [input.organizationId, input.caseId],
      );
      const currentConsent = consent.rows[0];
      if (
        currentConsent?.action !== "ACCEPTED" ||
        (currentConsent.valid_until && currentConsent.valid_until.getTime() <= Date.now())
      )
        throw new Error("interview_consent_required");
      await client.query(
        `UPDATE case_quota_usages SET last_accounted_at = now(), updated_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND window_ends_at > now()`,
        [input.organizationId, input.caseId],
      );
      await client.query(
        `UPDATE prospect_cases SET status = $3::case_status, next_action = $4,
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [
          input.organizationId,
          input.caseId,
          paused.resume_case_status ?? "INTERVIEWING",
          paused.resume_next_action,
        ],
      );
      await client.query(
        `UPDATE interviews SET active_started_at = now(), paused_at = NULL,
           pause_reason = NULL, resume_case_status = NULL, resume_next_action = NULL,
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND case_id = $2 AND version = $3`,
        [input.organizationId, input.caseId, input.expectedVersion],
      );
      await this.#audit(
        client,
        input.organizationId,
        input.caseId,
        current.id,
        "interview.resumed",
        input.correlationId,
      );
      const interview = await this.#get(client, input.organizationId, input.caseId);
      await client.query("COMMIT");
      if (!interview) throw new Error("interview_not_found");
      return { changed: true, interview };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #get(
    client: PoolClient,
    organizationId: string,
    caseId: string,
    lock = false,
  ): Promise<InterviewState | undefined> {
    const result = await client.query<{
      id: string;
      organization_id: string;
      case_id: string;
      policy_id: string;
      policy_version: number;
      status: InterviewStatus;
      pending_question: string | null;
      brief_requested_at: Date | null;
      brief_request_message_id: string | null;
      active_seconds: string;
      active_started_at: Date | null;
      paused_at: Date | null;
      pause_reason: string | null;
      version: number;
    }>(
      `SELECT i.id, i.organization_id, i.case_id, i.policy_id,
              p.version AS policy_version, i.status, i.pending_question,
              i.brief_requested_at, i.brief_request_message_id,
              i.active_seconds, i.active_started_at, i.paused_at, i.pause_reason, i.version
       FROM interviews i JOIN interview_policies p ON p.id = i.policy_id
       WHERE i.organization_id = $1 AND i.case_id = $2
       ${lock ? "FOR UPDATE OF i" : ""}`,
      [organizationId, caseId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    const topics = await client.query<{
      topic_key: string;
      position: number;
      required: boolean;
      status: InterviewTopicStatus;
    }>(
      `SELECT topic_key, position, required, status FROM interview_topics
       WHERE organization_id = $1 AND interview_id = $2 ORDER BY position`,
      [organizationId, row.id],
    );
    return {
      id: row.id,
      organizationId: row.organization_id,
      caseId: row.case_id,
      policyId: row.policy_id,
      policyVersion: row.policy_version,
      status: row.status,
      pendingQuestion: row.pending_question,
      briefRequestedAt: row.brief_requested_at,
      briefRequestMessageId: row.brief_request_message_id,
      activeSeconds: Number(row.active_seconds),
      activeStartedAt: row.active_started_at,
      pausedAt: row.paused_at,
      pauseReason: row.pause_reason,
      version: row.version,
      topics: topics.rows.map((topic) => ({
        key: topic.topic_key,
        position: topic.position,
        required: topic.required,
        status: topic.status,
      })),
    };
  }

  async #audit(
    client: PoolClient,
    organizationId: string,
    caseId: string,
    resourceId: string,
    action: string,
    correlationId: string,
  ) {
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         result, correlation_id, origin, metadata)
       VALUES ($1, $2, 'system', $3, 'interview', $4,
         'SUCCEEDED', $5, 'interview-store', '{}')`,
      [organizationId, caseId, action, resourceId, correlationId],
    );
  }
}
