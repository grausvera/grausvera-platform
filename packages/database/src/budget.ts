import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type BudgetPurpose =
  | "INTERVIEW_EXTRACT"
  | "NEXT_QUESTION"
  | "BRIEF_SYNTHESIS"
  | "BOUNDED_RESEARCH";
export type BudgetReconciliation = "CONSUMED" | "RELEASED" | "UNCERTAIN";

export function availableBudget(input: {
  hardLimitMicros: number;
  reservedMicros: number;
  consumedMicros: number;
  uncertainMicros: number;
}): number {
  return Math.max(
    0,
    input.hardLimitMicros - input.reservedMicros - input.consumedMicros - input.uncertainMicros,
  );
}

export interface BudgetReservationReceipt {
  reservationId: string;
  created: boolean;
  allowed: boolean;
  alerted: boolean;
  availableMicros: number;
  status: "RESERVED" | "CONSUMED" | "RELEASED" | "UNCERTAIN" | "REJECTED";
}

export interface BudgetReconciliationReceipt {
  reservationId: string;
  changed: boolean;
  status: BudgetReconciliation;
  reservedMicros: number;
  consumedMicros: number;
  uncertainMicros: number;
  availableMicros: number;
}

const DEFAULT_POLICY = { alertMicros: 250_000, hardLimitMicros: 500_000 } as const;

function positiveMicros(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`budget_${name}_invalid`);
}

export class BudgetStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async reserve(input: {
    organizationId: string;
    caseId: string;
    stage: string;
    purpose: BudgetPurpose;
    logicalOperationKey: string;
    attemptKey: string;
    maximumCostMicros: number;
    correlationId: string;
  }): Promise<BudgetReservationReceipt> {
    positiveMicros(input.maximumCostMicros, "maximum_cost");
    if (!input.stage.trim() || !input.logicalOperationKey.trim() || !input.attemptKey.trim())
      throw new Error("budget_reservation_identity_invalid");

    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await this.#reservationReceipt(client, input.organizationId, input.attemptKey);
      if (replay) {
        await client.query("COMMIT");
        return replay;
      }
      const caseResult = await client.query<{ status: string }>(
        `SELECT status FROM prospect_cases WHERE organization_id = $1 AND id = $2 FOR UPDATE`,
        [input.organizationId, input.caseId],
      );
      const caseState = caseResult.rows[0];
      if (!caseState) throw new Error("budget_case_not_found");
      if (caseState.status === "PAUSED") throw new Error("budget_case_paused");

      await client.query(
        `INSERT INTO budget_policies
          (organization_id, version, alert_micros, hard_limit_micros)
         VALUES ($1, 1, $2, $3)
         ON CONFLICT (organization_id, version) DO NOTHING`,
        [input.organizationId, DEFAULT_POLICY.alertMicros, DEFAULT_POLICY.hardLimitMicros],
      );
      const policy = await client.query<{ id: string }>(
        `SELECT id FROM budget_policies WHERE organization_id = $1 AND effective_at <= now()
         ORDER BY version DESC LIMIT 1`,
        [input.organizationId],
      );
      const policyId = policy.rows[0]?.id;
      if (!policyId) throw new Error("budget_policy_unavailable");
      await client.query(
        `INSERT INTO budget_ledgers (organization_id, case_id, policy_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (organization_id, case_id, period_key) DO NOTHING`,
        [input.organizationId, input.caseId, policyId],
      );
      const ledgerResult = await client.query<{
        id: string;
        reserved_micros: string;
        consumed_micros: string;
        uncertain_micros: string;
        alert_micros: string;
        hard_limit_micros: string;
        alerted_at: Date | null;
      }>(
        `SELECT l.id, l.reserved_micros, l.consumed_micros, l.uncertain_micros,
                l.alerted_at, p.alert_micros, p.hard_limit_micros
         FROM budget_ledgers l JOIN budget_policies p ON p.id = l.policy_id
         WHERE l.organization_id = $1 AND l.case_id = $2
           AND l.period_key = 'R1_CASE_LIFETIME' FOR UPDATE OF l`,
        [input.organizationId, input.caseId],
      );
      const ledger = ledgerResult.rows[0];
      if (!ledger) throw new Error("budget_ledger_unavailable");
      const reserved = Number(ledger.reserved_micros);
      const consumed = Number(ledger.consumed_micros);
      const uncertain = Number(ledger.uncertain_micros);
      const hardLimit = Number(ledger.hard_limit_micros);
      const allowed =
        input.maximumCostMicros <=
        availableBudget({
          hardLimitMicros: hardLimit,
          reservedMicros: reserved,
          consumedMicros: consumed,
          uncertainMicros: uncertain,
        });
      const reservationId = randomUUID();
      await client.query(
        `INSERT INTO budget_reservations
          (id, organization_id, case_id, ledger_id, stage, purpose,
           logical_operation_key, attempt_key, maximum_cost_micros, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,
           $10::budget_reservation_status)`,
        [
          reservationId,
          input.organizationId,
          input.caseId,
          ledger.id,
          input.stage.trim(),
          input.purpose,
          input.logicalOperationKey.trim(),
          input.attemptKey.trim(),
          input.maximumCostMicros,
          allowed ? "RESERVED" : "REJECTED",
        ],
      );
      const newReserved = allowed ? reserved + input.maximumCostMicros : reserved;
      const totalHeld = newReserved + consumed + uncertain;
      const alerted = Boolean(ledger.alerted_at) || totalHeld >= Number(ledger.alert_micros);
      await client.query(
        `UPDATE budget_ledgers SET reserved_micros = $2,
           alerted_at = CASE WHEN $3::boolean THEN coalesce(alerted_at, now()) ELSE alerted_at END,
           updated_at = now() WHERE id = $1`,
        [ledger.id, newReserved, alerted],
      );
      if (!allowed) {
        await this.#pauseBudgetCase(client, input.organizationId, input.caseId);
      }
      await this.#audit(client, {
        organizationId: input.organizationId,
        caseId: input.caseId,
        resourceId: reservationId,
        action: allowed ? "budget.reserved" : "budget.rejected",
        correlationId: input.correlationId,
        metadata: {
          purpose: input.purpose,
          stage: input.stage.trim(),
          maximumCostMicros: input.maximumCostMicros,
        },
      });
      await client.query("COMMIT");
      return {
        reservationId,
        created: true,
        allowed,
        alerted,
        availableMicros: availableBudget({
          hardLimitMicros: hardLimit,
          reservedMicros: newReserved,
          consumedMicros: consumed,
          uncertainMicros: uncertain,
        }),
        status: allowed ? "RESERVED" : "REJECTED",
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcile(input: {
    organizationId: string;
    reservationId: string;
    outcome: BudgetReconciliation;
    actualCostMicros?: number;
    correlationId: string;
  }): Promise<BudgetReconciliationReceipt> {
    if (input.outcome === "CONSUMED") {
      if (!Number.isSafeInteger(input.actualCostMicros) || (input.actualCostMicros ?? -1) < 0)
        throw new Error("budget_actual_cost_invalid");
    } else if (input.actualCostMicros !== undefined) {
      throw new Error("budget_actual_cost_not_allowed");
    }
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        status: string;
        maximum_cost_micros: string;
        actual_cost_micros: string | null;
        ledger_id: string;
        case_id: string;
        reserved_micros: string;
        consumed_micros: string;
        uncertain_micros: string;
        alert_micros: string;
        hard_limit_micros: string;
        alerted_at: Date | null;
      }>(
        `SELECT r.status, r.maximum_cost_micros, r.actual_cost_micros, r.ledger_id,
                r.case_id, l.reserved_micros, l.consumed_micros, l.uncertain_micros,
                l.alerted_at, p.alert_micros, p.hard_limit_micros
         FROM budget_reservations r
         JOIN budget_ledgers l ON l.id = r.ledger_id
         JOIN budget_policies p ON p.id = l.policy_id
         WHERE r.organization_id = $1 AND r.id = $2 FOR UPDATE OF r, l`,
        [input.organizationId, input.reservationId],
      );
      const row = result.rows[0];
      if (!row) throw new Error("budget_reservation_not_found");
      if (row.status === "REJECTED") throw new Error("budget_reservation_rejected");
      if (row.status !== "RESERVED" && row.status !== "UNCERTAIN") {
        if (
          row.status === input.outcome &&
          (input.outcome !== "CONSUMED" ||
            Number(row.actual_cost_micros) === input.actualCostMicros)
        ) {
          const receipt = this.#reconciliationReceipt(
            row,
            input.reservationId,
            input.outcome,
            false,
          );
          await client.query("COMMIT");
          return receipt;
        }
        throw new Error("budget_reconciliation_conflict");
      }
      if (row.status === "UNCERTAIN" && input.outcome === "UNCERTAIN") {
        const receipt = this.#reconciliationReceipt(row, input.reservationId, input.outcome, false);
        await client.query("COMMIT");
        return receipt;
      }

      const maximum = Number(row.maximum_cost_micros);
      let reserved = Number(row.reserved_micros);
      let consumed = Number(row.consumed_micros);
      let uncertain = Number(row.uncertain_micros);
      if (row.status === "RESERVED") reserved -= maximum;
      else uncertain -= maximum;
      if (input.outcome === "CONSUMED") consumed += input.actualCostMicros ?? 0;
      if (input.outcome === "UNCERTAIN") uncertain += maximum;
      const totalHeld = consumed + reserved + uncertain;
      const alerted = Boolean(row.alerted_at) || totalHeld >= Number(row.alert_micros);

      await client.query(
        `UPDATE budget_ledgers SET reserved_micros = $2, consumed_micros = $3,
           uncertain_micros = $4,
           alerted_at = CASE WHEN $5::boolean THEN coalesce(alerted_at, now()) ELSE alerted_at END,
           updated_at = now() WHERE id = $1`,
        [row.ledger_id, reserved, consumed, uncertain, alerted],
      );
      await client.query(
        `UPDATE budget_reservations SET status = $2::budget_reservation_status,
           actual_cost_micros = $3, reconciled_at = now(), updated_at = now() WHERE id = $1`,
        [
          input.reservationId,
          input.outcome,
          input.outcome === "CONSUMED" ? input.actualCostMicros : null,
        ],
      );
      if (totalHeld >= Number(row.hard_limit_micros)) {
        await this.#pauseBudgetCase(client, input.organizationId, row.case_id);
      }
      await this.#audit(client, {
        organizationId: input.organizationId,
        caseId: row.case_id,
        resourceId: input.reservationId,
        action: `budget.${input.outcome.toLowerCase()}`,
        correlationId: input.correlationId,
        metadata: { actualCostMicros: input.actualCostMicros ?? null },
      });
      await client.query("COMMIT");
      return {
        reservationId: input.reservationId,
        changed: true,
        status: input.outcome,
        reservedMicros: reserved,
        consumedMicros: consumed,
        uncertainMicros: uncertain,
        availableMicros: availableBudget({
          hardLimitMicros: Number(row.hard_limit_micros),
          reservedMicros: reserved,
          consumedMicros: consumed,
          uncertainMicros: uncertain,
        }),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAbandonedReservationsUncertain(cutoff: Date): Promise<number> {
    const candidates = await this.#pool.query<{ id: string; organization_id: string }>(
      `SELECT id,organization_id FROM budget_reservations
       WHERE status='RESERVED' AND updated_at<$1 ORDER BY updated_at LIMIT 100`,
      [cutoff],
    );
    let changed = 0;
    for (const candidate of candidates.rows) {
      try {
        const result = await this.reconcile({
          organizationId: candidate.organization_id,
          reservationId: candidate.id,
          outcome: "UNCERTAIN",
          correlationId: randomUUID(),
        });
        if (result.changed) changed += 1;
      } catch (error) {
        if ((error as Error).message !== "budget_reconciliation_conflict") throw error;
      }
    }
    return changed;
  }

  async #reservationReceipt(
    client: PoolClient,
    organizationId: string,
    attemptKey: string,
  ): Promise<BudgetReservationReceipt | undefined> {
    const result = await client.query<{
      id: string;
      status: BudgetReservationReceipt["status"];
      alerted_at: Date | null;
      hard_limit_micros: string;
      reserved_micros: string;
      consumed_micros: string;
      uncertain_micros: string;
    }>(
      `SELECT r.id, r.status, l.alerted_at, p.hard_limit_micros,
              l.reserved_micros, l.consumed_micros, l.uncertain_micros
       FROM budget_reservations r JOIN budget_ledgers l ON l.id = r.ledger_id
       JOIN budget_policies p ON p.id = l.policy_id
       WHERE r.organization_id = $1 AND r.attempt_key = $2`,
      [organizationId, attemptKey],
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      reservationId: row.id,
      created: false,
      allowed: row.status !== "REJECTED",
      alerted: Boolean(row.alerted_at),
      availableMicros: availableBudget({
        hardLimitMicros: Number(row.hard_limit_micros),
        reservedMicros: Number(row.reserved_micros),
        consumedMicros: Number(row.consumed_micros),
        uncertainMicros: Number(row.uncertain_micros),
      }),
      status: row.status,
    };
  }

  #reconciliationReceipt(
    row: {
      reserved_micros: string;
      consumed_micros: string;
      uncertain_micros: string;
      hard_limit_micros: string;
    },
    reservationId: string,
    status: BudgetReconciliation,
    changed: boolean,
  ): BudgetReconciliationReceipt {
    const reservedMicros = Number(row.reserved_micros);
    const consumedMicros = Number(row.consumed_micros);
    const uncertainMicros = Number(row.uncertain_micros);
    return {
      reservationId,
      changed,
      status,
      reservedMicros,
      consumedMicros,
      uncertainMicros,
      availableMicros: availableBudget({
        hardLimitMicros: Number(row.hard_limit_micros),
        reservedMicros,
        consumedMicros,
        uncertainMicros,
      }),
    };
  }

  async #pauseBudgetCase(client: PoolClient, organizationId: string, caseId: string) {
    await client.query(
      `UPDATE message_delivery_attempts a SET completed_at = now(),
         outcome = 'REJECTED_PERMANENT', error_code = 'budget_exceeded'
       FROM outbox_events o WHERE a.outbox_event_id = o.id AND a.completed_at IS NULL
         AND o.organization_id = $1 AND o.case_id = $2 AND o.status = 'DISPATCHING'
         AND o.event_type <> 'whatsapp.human.response.v1'`,
      [organizationId, caseId],
    );
    await client.query(
      `UPDATE outbox_events SET status = 'CANCELLED', locked_at = NULL,
         last_error_code = 'budget_exceeded', updated_at = now()
       WHERE organization_id = $1 AND case_id = $2
         AND status IN ('PENDING', 'DISPATCHING')
         AND event_type <> 'whatsapp.human.response.v1'`,
      [organizationId, caseId],
    );
    await client.query(
      `UPDATE prospect_cases SET status = 'PAUSED', next_action = 'BUDGET_EXCEEDED',
         version = version + 1, updated_at = now()
       WHERE organization_id = $1 AND id = $2 AND status <> 'PAUSED'`,
      [organizationId, caseId],
    );
  }

  async #audit(
    client: PoolClient,
    input: {
      organizationId: string;
      caseId: string;
      resourceId: string;
      action: string;
      correlationId: string;
      metadata: Record<string, unknown>;
    },
  ) {
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         result, correlation_id, origin, metadata)
       VALUES ($1, $2, 'system', $3, 'budget_reservation', $4,
         'SUCCEEDED', $5, 'budget-store', $6)`,
      [
        input.organizationId,
        input.caseId,
        input.action,
        input.resourceId,
        input.correlationId,
        JSON.stringify(input.metadata),
      ],
    );
  }
}
