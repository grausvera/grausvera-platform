import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { BudgetStore, OperationalInspectionStore } from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const store = new BudgetStore(connectionString);
const inspection = new OperationalInspectionStore(connectionString);
let organizationId: string;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(
    `INSERT INTO budget_policies
      (organization_id, version, alert_micros, hard_limit_micros, effective_at)
     VALUES ($1, 1000, 50, 100, now() - interval '1 minute')`,
    [organizationId],
  );
});

afterAll(async () => {
  await store.close();
  await inspection.close();
  await pool.end();
});

async function activeCase() {
  return pool
    .query<{ id: string }>(
      `INSERT INTO prospect_cases (id, organization_id, status)
       VALUES ($1, $2, 'INTERVIEWING') RETURNING id`,
      [randomUUID(), organizationId],
    )
    .then((result) => result.rows[0]?.id ?? "");
}

function reservation(caseId: string, attemptKey: string, maximumCostMicros: number) {
  return {
    organizationId,
    caseId,
    stage: "INTERVIEW",
    purpose: "INTERVIEW_EXTRACT" as const,
    logicalOperationKey: `operation-${caseId}`,
    attemptKey,
    maximumCostMicros,
    correlationId: randomUUID(),
  };
}

describe("transactional budget ledger", () => {
  it("allows only one worker to reserve the last balance and pauses on rejection", async () => {
    const caseId = await activeCase();
    const firstAttempt = randomUUID();
    const secondAttempt = randomUUID();
    const results = await Promise.all([
      store.reserve(reservation(caseId, firstAttempt, 60)),
      store.reserve(reservation(caseId, secondAttempt, 60)),
    ]);
    expect(results.filter((result) => result.allowed)).toHaveLength(1);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    const rejected = results.find((result) => !result.allowed);
    expect(rejected).toMatchObject({ status: "REJECTED", availableMicros: 40, alerted: true });
    const replay = await store.reserve(
      reservation(
        caseId,
        rejected?.reservationId === results[0]?.reservationId ? firstAttempt : secondAttempt,
        60,
      ),
    );
    expect(replay).toMatchObject({
      reservationId: rejected?.reservationId,
      created: false,
      allowed: false,
    });

    const state = await pool.query(
      `SELECT pc.status, pc.next_action, l.reserved_micros::integer,
              l.consumed_micros::integer, l.uncertain_micros::integer,
              (SELECT count(*)::integer FROM budget_reservations WHERE case_id = $1) AS attempts,
              (SELECT count(*)::integer FROM audit_events WHERE case_id = $1
                AND action = 'budget.rejected') AS rejections
       FROM prospect_cases pc JOIN budget_ledgers l ON l.case_id = pc.id WHERE pc.id = $1`,
      [caseId],
    );
    expect(state.rows[0]).toEqual({
      status: "PAUSED",
      next_action: "BUDGET_EXCEEDED",
      reserved_micros: 60,
      consumed_micros: 0,
      uncertain_micros: 0,
      attempts: 2,
      rejections: 1,
    });
  });

  it("retains an uncertain reservation until explicit reconciliation", async () => {
    const caseId = await activeCase();
    const reserved = await store.reserve(reservation(caseId, randomUUID(), 40));
    expect(
      await store.reconcile({
        organizationId,
        reservationId: reserved.reservationId,
        outcome: "UNCERTAIN",
        correlationId: randomUUID(),
      }),
    ).toMatchObject({
      changed: true,
      reservedMicros: 0,
      consumedMicros: 0,
      uncertainMicros: 40,
      availableMicros: 60,
    });
    await expect(store.reserve(reservation(caseId, randomUUID(), 70))).resolves.toMatchObject({
      allowed: false,
      availableMicros: 60,
    });
    expect(
      await store.reconcile({
        organizationId,
        reservationId: reserved.reservationId,
        outcome: "CONSUMED",
        actualCostMicros: 20,
        correlationId: randomUUID(),
      }),
    ).toMatchObject({
      changed: true,
      reservedMicros: 0,
      consumedMicros: 20,
      uncertainMicros: 0,
      availableMicros: 80,
    });
  });

  it("releases confirmed unused cost and keeps reconciliation idempotent", async () => {
    const caseId = await activeCase();
    const reserved = await store.reserve(reservation(caseId, randomUUID(), 40));
    const input = {
      organizationId,
      reservationId: reserved.reservationId,
      outcome: "RELEASED" as const,
      correlationId: randomUUID(),
    };
    expect(await store.reconcile(input)).toMatchObject({ changed: true, availableMicros: 100 });
    expect(await store.reconcile({ ...input, correlationId: randomUUID() })).toMatchObject({
      changed: false,
      availableMicros: 100,
    });
  });

  it("moves an abandoned reservation to explicit reconciliation without releasing its cost", async () => {
    const caseId = await activeCase();
    const reserved = await store.reserve(reservation(caseId, randomUUID(), 40));
    const now = new Date();
    await pool.query(`UPDATE budget_reservations SET updated_at=$2 WHERE id=$1`, [
      reserved.reservationId,
      new Date(now.getTime() - 16 * 60_000),
    ]);

    await expect(
      store.markAbandonedReservationsUncertain(new Date(now.getTime() - 15 * 60_000)),
    ).resolves.toBe(1);
    await expect(
      store.markAbandonedReservationsUncertain(new Date(now.getTime() - 15 * 60_000)),
    ).resolves.toBe(0);
    const state = await pool.query(
      `SELECT r.status,l.reserved_micros::integer,l.uncertain_micros::integer
       FROM budget_reservations r JOIN budget_ledgers l ON l.id=r.ledger_id WHERE r.id=$1`,
      [reserved.reservationId],
    );
    expect(state.rows[0]).toEqual({
      status: "UNCERTAIN",
      reserved_micros: 0,
      uncertain_micros: 40,
    });
    const operations = await inspection.inspect(new Date(now.getTime() - 5 * 60_000));
    expect(operations).toMatchObject({
      actions: expect.arrayContaining(["RECONCILE_PROVIDER_USAGE"]),
    });
    expect(operations.uncertainReservations).toBeGreaterThanOrEqual(1);
  });
});
