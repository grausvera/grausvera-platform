import { randomInt, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  MessagingStore,
  OperationalInspectionStore,
  type OperatorPrincipal,
} from "../../packages/database/src/index.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const dashboard = new OperationalInspectionStore(connectionString);
const messaging = new MessagingStore(connectionString);
const userId = `operations-${randomUUID()}`;
const connectionId = randomUUID();
let organizationId = "";
let caseId = "";
let policyId = "";

const principal = (): OperatorPrincipal => ({
  userId,
  organizationId,
  twoFactorVerified: true,
});

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (slug,display_name) VALUES ('grausvera','grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name=excluded.display_name RETURNING id`,
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified","createdAt","updatedAt")
     VALUES ($1,'operations',$2,true,now(),now())`,
    [userId, `${userId}@example.test`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id,user_id) VALUES ($1,$2)`, [
    organizationId,
    userId,
  ]);
  caseId = await pool
    .query<{ id: string }>(
      `INSERT INTO prospect_cases (organization_id,status,next_action,updated_at)
       VALUES ($1,'PAUSED','HUMAN_ASSISTANCE_REQUESTED',now()-interval '11 minutes') RETURNING id`,
      [organizationId],
    )
    .then((result) => result.rows[0]?.id ?? "");
  policyId = await pool
    .query<{ id: string }>(
      `INSERT INTO budget_policies
        (organization_id,version,alert_micros,hard_limit_micros,effective_at)
       VALUES ($1,$2,250000,500000,now()+interval '1 day') RETURNING id`,
      [organizationId, randomInt(1_500_000_000, 2_000_000_000)],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(
    `INSERT INTO budget_ledgers
      (organization_id,case_id,policy_id,consumed_micros,uncertain_micros,alerted_at)
     VALUES ($1,$2,$3,250000,1000,now())`,
    [organizationId, caseId, policyId],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id,organization_id,kind,external_account_id,credential_reference)
     VALUES ($1,$2,'WHATSAPP',$3,'operations-load-fixture')`,
    [connectionId, organizationId, `load-${connectionId}`],
  );
});

afterAll(async () => {
  await pool.query(`DELETE FROM inbox_events WHERE provider_connection_id=$1`, [connectionId]);
  await pool.query(`DELETE FROM provider_connections WHERE id=$1`, [connectionId]);
  await pool.query(`DELETE FROM budget_ledgers WHERE case_id=$1`, [caseId]);
  await pool.query(`DELETE FROM prospect_cases WHERE id=$1`, [caseId]);
  await pool.query(`DELETE FROM operator_memberships WHERE user_id=$1`, [userId]);
  await pool.query(`DELETE FROM "user" WHERE id=$1`, [userId]);
  await dashboard.close();
  await messaging.close();
  await pool.end();
});

describe("operational dashboard", () => {
  it("shows accumulated capacity, cost, evidence, owner, and next action", async () => {
    const result = await dashboard.dashboard(principal());
    expect(result.cases.awaitingHuman).toBeGreaterThan(0);
    expect(result.cost.modelConsumedMicros).toBeGreaterThanOrEqual(250_000);
    expect(result.alerts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "HUMAN_ACTION_OVERDUE",
          owner: `operator:${userId}`,
          evidence: expect.stringContaining(`case:${caseId}`),
          action: "HUMAN_ASSISTANCE_REQUESTED",
        }),
      ]),
    );
    expect(result.alerts.some((alert) => alert.code.startsWith("MODEL_BUDGET_"))).toBe(true);
  });

  it("persists the 20 events/second design burst without loss or duplicates", async () => {
    const eventIds = Array.from({ length: 1_200 }, (_, index) => `load-event-${index}`);
    const started = performance.now();
    const receipts = await Promise.all(
      eventIds.map((externalEventId) =>
        messaging.persistInbox({
          providerConnectionId: connectionId,
          externalEventId,
          body: Buffer.from('{"synthetic":true}'),
        }),
      ),
    );
    const replay = await Promise.all(
      eventIds.map((externalEventId) =>
        messaging.persistInbox({
          providerConnectionId: connectionId,
          externalEventId,
          body: Buffer.from('{"synthetic":true}'),
        }),
      ),
    );
    const count = await pool
      .query<{ count: number }>(
        `SELECT count(*)::integer count FROM inbox_events WHERE provider_connection_id=$1`,
        [connectionId],
      )
      .then((result) => result.rows[0]?.count);
    expect(receipts.every((receipt) => receipt.created)).toBe(true);
    expect(replay.every((receipt) => !receipt.created)).toBe(true);
    expect(new Set(receipts.map((receipt) => receipt.inboxEventId))).toHaveLength(1_200);
    expect(count).toBe(1_200);
    expect(performance.now() - started).toBeLessThan(60_000);
  }, 70_000);

  it("quarantines a poison inbox event after three attempts instead of blocking the queue", async () => {
    const poison = await messaging.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: "poison-event",
      body: Buffer.from("{}"),
    });
    await pool.query(`UPDATE inbox_events SET received_at='2000-01-01' WHERE id=$1`, [
      poison.inboxEventId,
    ]);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const claimed = await messaging.claimNextInbox();
      expect(claimed?.id).toBe(poison.inboxEventId);
      await messaging.releaseInboxAfterFailure(
        poison.inboxEventId,
        "inbound_reconciliation_failed",
      );
    }
    const state = await pool
      .query<{ status: string; attempts: number }>(
        `SELECT status,attempts FROM inbox_events WHERE id=$1`,
        [poison.inboxEventId],
      )
      .then((result) => result.rows[0]);
    expect(state).toEqual({ status: "NEEDS_ACTION", attempts: 3 });
    expect((await dashboard.inspect(new Date())).actionInbox).toBeGreaterThanOrEqual(1);
  });

  it("rejects a dashboard read from an unauthenticated operator", async () => {
    await expect(dashboard.dashboard({ ...principal(), twoFactorVerified: false })).rejects.toThrow(
      "operator_two_factor_required",
    );
  });
});
