import { Pool, type PoolClient } from "pg";
import type { OperatorPrincipal } from "./operator-console.js";

export interface OperationalInspection {
  pendingInbox: number;
  actionInbox: number;
  uncertainOutbox: number;
  actionOutbox: number;
  uncertainDeliveries: number;
  uncertainReservations: number;
  actions: string[];
}

export interface OperationalAlert {
  severity: "P1" | "P2" | "P3";
  code: string;
  owner: string;
  evidence: string;
  action: string;
}

export interface OperationalDashboard {
  generatedAt: Date;
  cases: { today: number; month: number; active: number; awaitingHuman: number };
  delivery: {
    pendingInbox: number;
    actionInbox: number;
    uncertainOutbox: number;
    actionOutbox: number;
    uncertainDeliveries: number;
    webhookP95Ms: number | null;
  };
  capacity: {
    maxMessagesPerCase: number;
    maxAttachmentsPerCase: number;
    maxAttachmentBytesPerCase: number;
    briefsThisMonth: number;
  };
  cost: {
    modelConsumedMicros: number;
    modelReservedMicros: number;
    modelUncertainMicros: number;
    casesAtAlert: number;
    casesAtLimit: number;
  };
  alerts: OperationalAlert[];
}

export class OperationalInspectionStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 2 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async inspect(cutoff: Date): Promise<OperationalInspection> {
    const row = await this.#pool
      .query<{
        pending_inbox: number;
        action_inbox: number;
        uncertain_outbox: number;
        action_outbox: number;
        uncertain_deliveries: number;
        uncertain_reservations: number;
      }>(
        `SELECT
          (SELECT count(*)::integer FROM inbox_events
            WHERE status='RECEIVED' AND received_at<$1) pending_inbox,
          (SELECT count(*)::integer FROM inbox_events
            WHERE status='NEEDS_ACTION') action_inbox,
          (SELECT count(*)::integer FROM outbox_events
            WHERE status='UNCERTAIN') uncertain_outbox,
          (SELECT count(*)::integer FROM outbox_events
            WHERE status='NEEDS_ACTION') action_outbox,
          (SELECT count(*)::integer FROM email_deliveries
            WHERE status IN ('UNCERTAIN','DELAYED')) uncertain_deliveries,
          (SELECT count(*)::integer FROM budget_reservations
            WHERE status='UNCERTAIN') uncertain_reservations`,
        [cutoff],
      )
      .then((result) => result.rows[0]);
    if (!row) throw new Error("operational_inspection_unavailable");
    const actions: string[] = [];
    if (row.pending_inbox > 0) actions.push("RECONCILE_INBOX");
    if (row.action_inbox > 0) actions.push("OPERATOR_REVIEW");
    if (row.uncertain_outbox > 0 || row.uncertain_deliveries > 0)
      actions.push("RECONCILE_PROVIDER_EFFECT");
    if (row.uncertain_reservations > 0) actions.push("RECONCILE_PROVIDER_USAGE");
    if (row.action_outbox > 0) actions.push("OPERATOR_REVIEW");
    return {
      pendingInbox: row.pending_inbox,
      actionInbox: row.action_inbox,
      uncertainOutbox: row.uncertain_outbox,
      actionOutbox: row.action_outbox,
      uncertainDeliveries: row.uncertain_deliveries,
      uncertainReservations: row.uncertain_reservations,
      actions,
    };
  }

  async dashboard(principal: OperatorPrincipal, now = new Date()): Promise<OperationalDashboard> {
    const client = await this.#pool.connect();
    try {
      await this.#authorize(client, principal);
      const row = await client
        .query<{
          cases_today: number;
          cases_month: number;
          active_cases: number;
          awaiting_human: number;
          pending_inbox: number;
          action_inbox: number;
          uncertain_outbox: number;
          action_outbox: number;
          uncertain_deliveries: number;
          webhook_p95_ms: number | null;
          max_messages: number;
          max_attachments: number;
          max_attachment_bytes: string;
          briefs_month: number;
          consumed_micros: string;
          reserved_micros: string;
          uncertain_micros: string;
          cases_at_alert: number;
          cases_at_limit: number;
        }>(
          `SELECT
            (SELECT count(*)::integer FROM prospect_cases WHERE organization_id=$1 AND created_at >= $2::timestamptz - interval '24 hours') cases_today,
            (SELECT count(*)::integer FROM prospect_cases WHERE organization_id=$1 AND created_at >= date_trunc('month',$2::timestamptz)) cases_month,
            (SELECT count(*)::integer FROM prospect_cases WHERE organization_id=$1 AND status NOT IN ('CLOSED','NOT_A_FIT')) active_cases,
            (SELECT count(*)::integer FROM prospect_cases WHERE organization_id=$1 AND next_action IN ('OPERATOR_ASSIGNED','OPERATOR_PAUSED','HUMAN_ASSISTANCE_REQUESTED','ENGINEER_REVIEW')) awaiting_human,
            (SELECT count(*)::integer FROM inbox_events WHERE organization_id=$1 AND status='RECEIVED') pending_inbox,
            (SELECT count(*)::integer FROM inbox_events WHERE organization_id=$1 AND status='NEEDS_ACTION') action_inbox,
            (SELECT count(*)::integer FROM outbox_events WHERE organization_id=$1 AND status='UNCERTAIN') uncertain_outbox,
            (SELECT count(*)::integer FROM outbox_events WHERE organization_id=$1 AND status='NEEDS_ACTION') action_outbox,
            (SELECT count(*)::integer FROM email_deliveries WHERE organization_id=$1 AND status IN ('UNCERTAIN','DELAYED')) uncertain_deliveries,
            (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (e.received_at-i.provider_occurred_at))*1000)
               FROM inbox_event_items i JOIN inbox_events e ON e.id=i.inbox_event_id
               WHERE i.organization_id=$1 AND i.provider_occurred_at <= e.received_at) webhook_p95_ms,
            (SELECT coalesce(max(total),0)::integer FROM (SELECT count(*) total FROM messages WHERE organization_id=$1 GROUP BY case_id) x) max_messages,
            (SELECT coalesce(max(total),0)::integer FROM (SELECT count(*) total FROM attachments WHERE organization_id=$1 GROUP BY case_id) x) max_attachments,
            (SELECT coalesce(max(total),0)::bigint FROM (SELECT coalesce(sum(size_bytes),0) total FROM attachments WHERE organization_id=$1 GROUP BY case_id) x) max_attachment_bytes,
            (SELECT count(*)::integer FROM briefs WHERE organization_id=$1 AND created_at >= date_trunc('month',$2::timestamptz)) briefs_month,
            (SELECT coalesce(sum(consumed_micros),0)::bigint FROM budget_ledgers WHERE organization_id=$1) consumed_micros,
            (SELECT coalesce(sum(reserved_micros),0)::bigint FROM budget_ledgers WHERE organization_id=$1) reserved_micros,
            (SELECT coalesce(sum(uncertain_micros),0)::bigint FROM budget_ledgers WHERE organization_id=$1) uncertain_micros,
            (SELECT count(*)::integer FROM budget_ledgers l JOIN budget_policies p ON p.id=l.policy_id WHERE l.organization_id=$1 AND l.consumed_micros+l.reserved_micros+l.uncertain_micros >= p.alert_micros) cases_at_alert,
            (SELECT count(*)::integer FROM budget_ledgers l JOIN budget_policies p ON p.id=l.policy_id WHERE l.organization_id=$1 AND l.consumed_micros+l.reserved_micros+l.uncertain_micros >= p.hard_limit_micros) cases_at_limit`,
          [principal.organizationId, now],
        )
        .then((result) => result.rows[0]);
      if (!row) throw new Error("operational_dashboard_unavailable");
      const critical = await client.query<{ id: string; next_action: string; updated_at: Date }>(
        `SELECT id,next_action,updated_at FROM prospect_cases
         WHERE organization_id=$1 AND next_action IN ('HUMAN_ASSISTANCE_REQUESTED','ENGINEER_REVIEW')
           AND updated_at <= $2::timestamptz - interval '10 minutes'
         ORDER BY updated_at LIMIT 20`,
        [principal.organizationId, now],
      );
      const alerts: OperationalAlert[] = critical.rows.map((item) => ({
        severity: "P1",
        code: "HUMAN_ACTION_OVERDUE",
        owner: `operator:${principal.userId}`,
        evidence: `case:${item.id}@${item.updated_at.toISOString()}`,
        action: item.next_action,
      }));
      if (row.uncertain_outbox + row.uncertain_deliveries > 0)
        alerts.push({
          severity: "P2",
          code: "PROVIDER_EFFECT_UNCERTAIN",
          owner: `operator:${principal.userId}`,
          evidence: `outbox:${row.uncertain_outbox};email:${row.uncertain_deliveries}`,
          action: "RECONCILE_PROVIDER_EFFECT",
        });
      if (row.cases_at_limit > 0 || row.cases_at_alert > 0)
        alerts.push({
          severity: row.cases_at_limit > 0 ? "P1" : "P3",
          code: row.cases_at_limit > 0 ? "MODEL_BUDGET_LIMIT" : "MODEL_BUDGET_ALERT",
          owner: `operator:${principal.userId}`,
          evidence: `alert:${row.cases_at_alert};limit:${row.cases_at_limit}`,
          action: "CONTINUE_MANUALLY_OR_REVIEW_BUDGET",
        });
      return {
        generatedAt: now,
        cases: {
          today: row.cases_today,
          month: row.cases_month,
          active: row.active_cases,
          awaitingHuman: row.awaiting_human,
        },
        delivery: {
          pendingInbox: row.pending_inbox,
          actionInbox: row.action_inbox,
          uncertainOutbox: row.uncertain_outbox,
          actionOutbox: row.action_outbox,
          uncertainDeliveries: row.uncertain_deliveries,
          webhookP95Ms: row.webhook_p95_ms === null ? null : Math.round(row.webhook_p95_ms),
        },
        capacity: {
          maxMessagesPerCase: row.max_messages,
          maxAttachmentsPerCase: row.max_attachments,
          maxAttachmentBytesPerCase: Number(row.max_attachment_bytes),
          briefsThisMonth: row.briefs_month,
        },
        cost: {
          modelConsumedMicros: Number(row.consumed_micros),
          modelReservedMicros: Number(row.reserved_micros),
          modelUncertainMicros: Number(row.uncertain_micros),
          casesAtAlert: row.cases_at_alert,
          casesAtLimit: row.cases_at_limit,
        },
        alerts,
      };
    } finally {
      client.release();
    }
  }

  async #authorize(client: PoolClient, principal: OperatorPrincipal) {
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const membership = await client.query(
      `SELECT 1 FROM operator_memberships WHERE organization_id=$1 AND user_id=$2
       AND role='ENGINEER' AND active`,
      [principal.organizationId, principal.userId],
    );
    if ((membership.rowCount ?? 0) !== 1) throw new Error("operator_forbidden");
  }
}
