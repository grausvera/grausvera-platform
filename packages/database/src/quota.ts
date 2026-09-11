import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export interface QuotaLimits {
  caseMessages: number;
  contactMessages: number;
  caseActiveSeconds: number;
}

export type QuotaExceededReason =
  | "CASE_MESSAGE_LIMIT"
  | "CONTACT_MESSAGE_LIMIT"
  | "CASE_ACTIVE_TIME_LIMIT";

export function evaluateQuota(
  usage: { caseMessages: number; contactMessages: number; caseActiveSeconds: number },
  limits: QuotaLimits,
): QuotaExceededReason | undefined {
  if (usage.caseMessages >= limits.caseMessages) return "CASE_MESSAGE_LIMIT";
  if (usage.contactMessages >= limits.contactMessages) return "CONTACT_MESSAGE_LIMIT";
  if (usage.caseActiveSeconds >= limits.caseActiveSeconds) return "CASE_ACTIVE_TIME_LIMIT";
  return undefined;
}

interface UsageRow {
  id: string;
  window_ends_at: Date;
  message_count: number;
  active_seconds?: number;
  last_accounted_at?: Date;
}

export interface QuotaConsumptionReceipt {
  created: boolean;
  exceeded: boolean;
  reason?: QuotaExceededReason;
  caseMessages: number;
  contactMessages: number;
  caseActiveSeconds: number;
}

const DEFAULT_POLICY = {
  periodSeconds: 86_400,
  caseMessageLimit: 30,
  contactMessageLimit: 60,
  caseActiveSecondsLimit: 3_600,
} as const;

export class QuotaStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async consumeInbound(input: {
    organizationId: string;
    messageId: string;
    correlationId: string;
  }): Promise<QuotaConsumptionReceipt> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const contextResult = await client.query<{
        case_id: string;
        contact_point_id: string;
        case_status: string;
        consent_action: string | null;
        consent_valid_until: Date | null;
        now: Date;
      }>(
        `SELECT m.case_id, m.sender_contact_point_id AS contact_point_id,
                pc.status AS case_status, consent.action AS consent_action,
                consent.valid_until AS consent_valid_until, clock_timestamp() AS now
         FROM messages m
         JOIN prospect_cases pc ON pc.organization_id = m.organization_id AND pc.id = m.case_id
         LEFT JOIN LATERAL (
           SELECT action, valid_until FROM consent_records
           WHERE organization_id = m.organization_id AND case_id = m.case_id
             AND person_id = m.sender_person_id
             AND contact_point_id = m.sender_contact_point_id
             AND purpose = 'DISCOVERY'
           ORDER BY occurred_at DESC, created_at DESC LIMIT 1
         ) consent ON true
         WHERE m.organization_id = $1 AND m.id = $2 AND m.direction = 'INBOUND'
           AND m.sender_contact_point_id IS NOT NULL
         FOR UPDATE OF pc`,
        [input.organizationId, input.messageId],
      );
      const context = contextResult.rows[0];
      if (!context) throw new Error("quota_source_precondition_failed");
      if (
        context.consent_action !== "ACCEPTED" ||
        (context.consent_valid_until && context.consent_valid_until <= context.now)
      ) {
        throw new Error("quota_active_consent_required");
      }

      const replay = await this.#getReceipt(client, input.organizationId, input.messageId);
      if (replay) {
        await client.query("COMMIT");
        return { ...replay, created: false };
      }
      if (context.case_status === "PAUSED") throw new Error("quota_case_paused");

      await client.query(
        `INSERT INTO quota_policies
          (organization_id, version, period_seconds, case_message_limit,
           contact_message_limit, case_active_seconds_limit)
         VALUES ($1, 1, $2, $3, $4, $5)
         ON CONFLICT (organization_id, version) DO NOTHING`,
        [
          input.organizationId,
          DEFAULT_POLICY.periodSeconds,
          DEFAULT_POLICY.caseMessageLimit,
          DEFAULT_POLICY.contactMessageLimit,
          DEFAULT_POLICY.caseActiveSecondsLimit,
        ],
      );
      const policyResult = await client.query<{
        id: string;
        period_seconds: number;
        case_message_limit: number;
        contact_message_limit: number;
        case_active_seconds_limit: number;
      }>(
        `SELECT id, period_seconds, case_message_limit, contact_message_limit,
                case_active_seconds_limit
         FROM quota_policies
         WHERE organization_id = $1 AND effective_at <= $2
         ORDER BY version DESC LIMIT 1`,
        [input.organizationId, context.now],
      );
      const policy = policyResult.rows[0];
      if (!policy) throw new Error("quota_policy_unavailable");

      const caseUsage = await this.#lockCaseUsage(
        client,
        input.organizationId,
        context.case_id,
        policy.id,
        policy.period_seconds,
        context.now,
      );
      const contactUsage = await this.#lockContactUsage(
        client,
        input.organizationId,
        context.contact_point_id,
        policy.id,
        policy.period_seconds,
        context.now,
      );
      const elapsed =
        context.case_status === "INTERVIEWING" && caseUsage.last_accounted_at
          ? Math.max(
              0,
              Math.floor(
                (Math.min(context.now.getTime(), caseUsage.window_ends_at.getTime()) -
                  caseUsage.last_accounted_at.getTime()) /
                  1_000,
              ),
            )
          : 0;
      const usage = {
        caseMessages: caseUsage.message_count + 1,
        contactMessages: contactUsage.message_count + 1,
        caseActiveSeconds: (caseUsage.active_seconds ?? 0) + elapsed,
      };
      const reason = evaluateQuota(usage, {
        caseMessages: policy.case_message_limit,
        contactMessages: policy.contact_message_limit,
        caseActiveSeconds: policy.case_active_seconds_limit,
      });

      await client.query(
        `UPDATE case_quota_usages SET message_count = $2, active_seconds = $3,
           last_accounted_at = $4::timestamptz,
           exceeded_at = CASE WHEN $5::boolean THEN $4::timestamptz ELSE NULL END,
           updated_at = $4::timestamptz WHERE id = $1`,
        [caseUsage.id, usage.caseMessages, usage.caseActiveSeconds, context.now, Boolean(reason)],
      );
      await client.query(
        `UPDATE contact_quota_usages SET message_count = $2,
           exceeded_at = CASE WHEN $3::boolean THEN $4::timestamptz ELSE NULL END,
           updated_at = $4::timestamptz WHERE id = $1`,
        [contactUsage.id, usage.contactMessages, Boolean(reason), context.now],
      );
      const consumptionId = randomUUID();
      await client.query(
        `INSERT INTO quota_consumptions
          (id, organization_id, message_id, case_usage_id, contact_usage_id, exceeded, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          consumptionId,
          input.organizationId,
          input.messageId,
          caseUsage.id,
          contactUsage.id,
          Boolean(reason),
          reason ?? null,
        ],
      );
      if (reason) {
        await this.#pauseExceededCase(client, {
          organizationId: input.organizationId,
          caseId: context.case_id,
          consumptionId,
          messageId: input.messageId,
          correlationId: input.correlationId,
          reason,
        });
      }
      await client.query("COMMIT");
      return { created: true, exceeded: Boolean(reason), reason, ...usage };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #lockCaseUsage(
    client: PoolClient,
    organizationId: string,
    caseId: string,
    policyId: string,
    periodSeconds: number,
    now: Date,
  ): Promise<UsageRow> {
    await client.query(
      `INSERT INTO case_quota_usages
        (organization_id, case_id, policy_id, window_started_at, window_ends_at, last_accounted_at)
       VALUES ($1, $2, $3, $4::timestamptz,
         $4::timestamptz + make_interval(secs => $5::integer), $4::timestamptz)
       ON CONFLICT (organization_id, case_id, policy_id) DO NOTHING`,
      [organizationId, caseId, policyId, now, periodSeconds],
    );
    const locked = await client.query<UsageRow>(
      `SELECT id, window_ends_at, message_count, active_seconds, last_accounted_at
       FROM case_quota_usages
       WHERE organization_id = $1 AND case_id = $2 AND policy_id = $3 FOR UPDATE`,
      [organizationId, caseId, policyId],
    );
    const initialUsage = locked.rows[0];
    if (!initialUsage) throw new Error("case_quota_usage_unavailable");
    let usage: UsageRow = initialUsage;
    if (usage.window_ends_at <= now) {
      usage = await client
        .query<UsageRow>(
          `UPDATE case_quota_usages SET window_started_at = $2::timestamptz,
             window_ends_at = $2::timestamptz + make_interval(secs => $3::integer), message_count = 0,
             active_seconds = 0, last_accounted_at = $2::timestamptz,
             exceeded_at = NULL, updated_at = $2::timestamptz
           WHERE id = $1
           RETURNING id, window_ends_at, message_count, active_seconds, last_accounted_at`,
          [usage.id, now, periodSeconds],
        )
        .then((result) => result.rows[0] ?? usage);
    }
    return usage;
  }

  async #lockContactUsage(
    client: PoolClient,
    organizationId: string,
    contactPointId: string,
    policyId: string,
    periodSeconds: number,
    now: Date,
  ): Promise<UsageRow> {
    await client.query(
      `INSERT INTO contact_quota_usages
        (organization_id, contact_point_id, policy_id, window_started_at, window_ends_at)
       VALUES ($1, $2, $3, $4::timestamptz,
         $4::timestamptz + make_interval(secs => $5::integer))
       ON CONFLICT (organization_id, contact_point_id, policy_id) DO NOTHING`,
      [organizationId, contactPointId, policyId, now, periodSeconds],
    );
    const locked = await client.query<UsageRow>(
      `SELECT id, window_ends_at, message_count FROM contact_quota_usages
       WHERE organization_id = $1 AND contact_point_id = $2 AND policy_id = $3 FOR UPDATE`,
      [organizationId, contactPointId, policyId],
    );
    const initialUsage = locked.rows[0];
    if (!initialUsage) throw new Error("contact_quota_usage_unavailable");
    let usage: UsageRow = initialUsage;
    if (usage.window_ends_at <= now) {
      usage = await client
        .query<UsageRow>(
          `UPDATE contact_quota_usages SET window_started_at = $2::timestamptz,
             window_ends_at = $2::timestamptz + make_interval(secs => $3::integer), message_count = 0,
             exceeded_at = NULL, updated_at = $2::timestamptz WHERE id = $1
           RETURNING id, window_ends_at, message_count`,
          [usage.id, now, periodSeconds],
        )
        .then((result) => result.rows[0] ?? usage);
    }
    return usage;
  }

  async #getReceipt(
    client: PoolClient,
    organizationId: string,
    messageId: string,
  ): Promise<Omit<QuotaConsumptionReceipt, "created"> | undefined> {
    const result = await client.query<{
      exceeded: boolean;
      reason: QuotaExceededReason | null;
      case_messages: number;
      contact_messages: number;
      active_seconds: number;
    }>(
      `SELECT q.exceeded, q.reason, cu.message_count AS case_messages,
              tu.message_count AS contact_messages, cu.active_seconds
       FROM quota_consumptions q
       JOIN case_quota_usages cu ON cu.id = q.case_usage_id
       JOIN contact_quota_usages tu ON tu.id = q.contact_usage_id
       WHERE q.organization_id = $1 AND q.message_id = $2`,
      [organizationId, messageId],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      exceeded: row.exceeded,
      reason: row.reason ?? undefined,
      caseMessages: row.case_messages,
      contactMessages: row.contact_messages,
      caseActiveSeconds: row.active_seconds,
    };
  }

  async #pauseExceededCase(
    client: PoolClient,
    input: {
      organizationId: string;
      caseId: string;
      consumptionId: string;
      messageId: string;
      correlationId: string;
      reason: QuotaExceededReason;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE message_delivery_attempts a
       SET completed_at = now(), outcome = 'REJECTED_PERMANENT', error_code = 'quota_exceeded'
       FROM outbox_events o
       WHERE a.outbox_event_id = o.id AND a.completed_at IS NULL
         AND o.organization_id = $1 AND o.case_id = $2 AND o.status = 'DISPATCHING'
         AND o.event_type <> 'whatsapp.human.response.v1'`,
      [input.organizationId, input.caseId],
    );
    await client.query(
      `UPDATE outbox_events SET status = 'CANCELLED', locked_at = NULL,
         last_error_code = 'quota_exceeded', updated_at = now()
       WHERE organization_id = $1 AND case_id = $2
         AND status IN ('PENDING', 'DISPATCHING')
         AND event_type <> 'whatsapp.human.response.v1'`,
      [input.organizationId, input.caseId],
    );
    await client.query(
      `UPDATE prospect_cases SET status = 'PAUSED', next_action = 'QUOTA_EXCEEDED',
         version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2`,
      [input.organizationId, input.caseId],
    );
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         result, correlation_id, origin, metadata)
       VALUES ($1, $2, 'system', 'quota.exceeded', 'quota_consumption', $3,
         'SUCCEEDED', $4, 'quota-store', $5)`,
      [
        input.organizationId,
        input.caseId,
        input.consumptionId,
        input.correlationId,
        JSON.stringify({ reason: input.reason, sourceMessageId: input.messageId }),
      ],
    );
  }
}
