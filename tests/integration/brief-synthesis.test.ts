import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { BriefSynthesisStore, BudgetStore } from "../../packages/database/src";
import { BriefSynthesisRunner } from "../../apps/worker/src/brief-synthesis";
import { FakeModelPort, type ModelPort } from "../../apps/worker/src/model";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const budgets = new BudgetStore(connectionString);
const store = new BriefSynthesisStore(connectionString);
let organizationId: string;
let policyId: string;
let connectionId: string;
const operatorUserId = `brief-synthesis-${randomUUID()}`;
const principal = () => ({ userId: operatorUserId, organizationId, twoFactorVerified: true });

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1,'grausvera','grausvera')
     ON CONFLICT (slug) DO UPDATE SET display_name=excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((r) => r.rows[0]?.id ?? "");
  policyId = await pool
    .query<{ id: string }>(
      `INSERT INTO interview_policies (organization_id,version,topics,effective_at)
     VALUES ($1,390,'[{"key":"PROJECT_INTENT","required":true}]',now()+interval '1 day') RETURNING id`,
      [organizationId],
    )
    .then((r) => r.rows[0]?.id ?? "");
  connectionId = randomUUID();
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,'brief synthesis operator',$2,true)`,
    [operatorUserId, `${operatorUserId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id,user_id) VALUES ($1,$2)`, [
    organizationId,
    operatorUserId,
  ]);
  await pool.query(
    `INSERT INTO provider_connections
    (id,organization_id,kind,external_account_id,credential_reference)
    VALUES ($1,$2,'WHATSAPP',$3,'secret://synthetic/brief')`,
    [connectionId, organizationId, `brief-${connectionId}`],
  );
  await pool.query(
    `INSERT INTO budget_policies
    (organization_id,version,alert_micros,hard_limit_micros,effective_at)
    VALUES ($1,390,500,1000,now()+interval '1 day')`,
    [organizationId],
  );
});

afterAll(async () => {
  await store.close();
  await budgets.close();
  await pool.end();
});

async function readyCase() {
  const caseId = randomUUID(),
    personId = randomUUID(),
    contactId = randomUUID();
  const conversationId = randomUUID(),
    messageId = randomUUID(),
    interviewId = randomUUID();
  await pool.query(
    `INSERT INTO prospect_cases (id,organization_id,status,knowledge_version)
    VALUES ($1,$2,'READY_FOR_SYNTHESIS',3)`,
    [caseId, organizationId],
  );
  await pool.query(`INSERT INTO people (id,organization_id) VALUES ($1,$2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO contact_points
    (id,organization_id,person_id,kind,value_ciphertext,fingerprint,source,purpose,provider,external_id)
    VALUES ($1,$2,$3,'WHATSAPP','synthetic',$4,'synthetic','brief','META',$5)`,
    [contactId, organizationId, personId, `brief-${contactId}`, `brief-${personId}`],
  );
  await pool.query(
    `INSERT INTO conversations (id,organization_id,case_id,provider_connection_id)
    VALUES ($1,$2,$3,$4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
  await pool.query(
    `INSERT INTO messages
    (id,organization_id,case_id,conversation_id,provider_connection_id,direction,
     provider_message_id,message_type,content_bytes,provider_occurred_at,sender_person_id,sender_contact_point_id)
    VALUES ($1,$2,$3,$4,$5,'INBOUND',$6,'text',$7,now(),$8,$9)`,
    [
      messageId,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.brief.${messageId}`,
      Buffer.from("Quiero el resumen"),
      personId,
      contactId,
    ],
  );
  await pool.query(
    `INSERT INTO interviews
    (id,organization_id,case_id,policy_id,status,brief_requested_at,brief_request_message_id)
    VALUES ($1,$2,$3,$4,'SUFFICIENT',now(),$5)`,
    [interviewId, organizationId, caseId, policyId, messageId],
  );
  await pool.query(
    `INSERT INTO interview_topics
    (organization_id,case_id,interview_id,topic_key,position,required,status)
    VALUES ($1,$2,$3,'PROJECT_INTENT',0,true,'CAPTURED')`,
    [organizationId, caseId, interviewId],
  );
  const claimId = randomUUID();
  await pool.query(
    `INSERT INTO claims
    (id,organization_id,case_id,kind,category,content,confidence_basis_points,sensitivity,audience,creator)
    VALUES ($1,$2,$3,'FACT','PROJECT_INTENT','Synthetic project',9000,'CONFIDENTIAL','INTERNAL','HUMAN')`,
    [claimId, organizationId, caseId],
  );
  await pool.query(
    `INSERT INTO claim_sources
    (organization_id,case_id,claim_id,message_id,relation) VALUES ($1,$2,$3,$4,'SUPPORTS')`,
    [organizationId, caseId, claimId, messageId],
  );
  await pool.query(
    `INSERT INTO operator_case_assignments (organization_id,case_id,user_id)
     VALUES ($1,$2,$3)`,
    [organizationId, caseId, operatorUserId],
  );
  await store.request(principal(), { caseId, correlationId: randomUUID() });
  return caseId;
}

const candidate = {
  title: "Synthetic",
  problem: "Problem",
  peopleAndUsers: [],
  objectives: [],
  currentSituation: "Current",
  scopeIncluded: [],
  scopeExcluded: [],
  constraints: [],
  assumptions: [],
  openQuestions: [],
  risks: [],
  materialClaims: [],
  warnings: [],
};
const config = {
  model: "gpt-5.6-terra",
  maximumCostMicros: 50,
  inputUsdPerMillion: 2,
  outputUsdPerMillion: 12,
  timeoutMs: 20,
};

describe("reserved brief synthesis", () => {
  it("persists one exact revision under concurrent execution", async () => {
    const caseId = await readyCase();
    const model = new FakeModelPort([
      {
        kind: "completed",
        responseId: "brief-1",
        output: candidate,
        inputTokens: 5,
        outputTokens: 10,
        latencyMs: 2,
      },
    ]);
    const runner = new BriefSynthesisRunner(budgets, store, model, config);
    const input = {
      organizationId,
      caseId,
      attemptKey: randomUUID(),
      correlationId: randomUUID(),
    };
    const results = await Promise.all([
      runner.run(input),
      runner.run({ ...input, attemptKey: randomUUID() }),
    ]);
    expect(results.map((r) => r.kind).sort()).toEqual(["candidate", "replayed"]);
    expect(model.requests).toHaveLength(1);
    const state = await pool.query(
      `SELECT
      (SELECT count(*)::integer FROM brief_synthesis_requests WHERE case_id=$1) requests,
      (SELECT count(*)::integer FROM model_invocations WHERE case_id=$1 AND purpose='BRIEF_SYNTHESIS') invocations,
      (SELECT count(*)::integer FROM brief_revisions WHERE case_id=$1) revisions`,
      [caseId],
    );
    expect(state.rows[0]).toEqual({
      requests: 1,
      invocations: 1,
      revisions: 1,
    });
    const revision = await pool.query(
      `SELECT r.status, r.revision_number, r.knowledge_version, r.policy_version,
       r.snapshot, c.status case_status, count(rc.claim_id)::integer claim_count,
       (SELECT count(*)::integer FROM outbox_events WHERE case_id=$1) outbound_count
       FROM brief_revisions r
       JOIN prospect_cases c ON c.id=r.case_id AND c.organization_id=r.organization_id
       LEFT JOIN brief_revision_claims rc ON rc.revision_id=r.id AND rc.organization_id=r.organization_id
       WHERE r.case_id=$1 GROUP BY r.id,c.status`,
      [caseId],
    );
    expect(revision.rows[0]).toMatchObject({
      status: "DRAFT",
      revision_number: 1,
      knowledge_version: 3,
      policy_version: 390,
      snapshot: candidate,
      case_status: "ENGINEER_REVIEW",
      claim_count: 1,
      outbound_count: 0,
    });
  });

  it("governs and deduplicates the internal synthesis request", async () => {
    const caseId = await readyCase();
    await expect(
      store.request(
        { ...principal(), twoFactorVerified: false },
        { caseId, correlationId: randomUUID() },
      ),
    ).rejects.toThrow("operator_two_factor_required");
    await expect(
      store.request(principal(), { caseId, correlationId: randomUUID() }),
    ).resolves.toMatchObject({ kind: "replayed" });
    const state = await pool.query(
      `SELECT count(DISTINCT r.id)::integer requests,
       count(a.id) FILTER (WHERE a.action='brief_synthesis.requested')::integer audits
       FROM brief_synthesis_requests r LEFT JOIN audit_events a
         ON a.resource_id=r.id AND a.organization_id=r.organization_id
       WHERE r.case_id=$1`,
      [caseId],
    );
    expect(state.rows[0]).toEqual({ requests: 1, audits: 2 });
  });

  it("retains uncertain budget when the model times out", async () => {
    const caseId = await readyCase();
    let calls = 0;
    const hanging: ModelPort = {
      invoke: () => {
        calls += 1;
        return new Promise(() => {});
      },
    };
    const runner = new BriefSynthesisRunner(budgets, store, hanging, {
      ...config,
      timeoutMs: 5,
    });
    await expect(
      runner.run({
        organizationId,
        caseId,
        attemptKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: "uncertain" });
    const state = await pool.query(
      `SELECT r.status, b.status budget
      FROM brief_synthesis_requests r JOIN budget_reservations b ON b.id=r.reservation_id
      WHERE r.case_id=$1`,
      [caseId],
    );
    expect(state.rows[0]).toEqual({ status: "UNCERTAIN", budget: "UNCERTAIN" });
    await expect(
      runner.run({
        organizationId,
        caseId,
        attemptKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: "uncertain" });
    await expect(
      runner.run({
        organizationId,
        caseId,
        attemptKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: "exhausted" });
    expect(calls).toBe(2);
  });

  it("rejects commercial output without creating a revision", async () => {
    const caseId = await readyCase();
    const model = new FakeModelPort([
      {
        kind: "completed",
        responseId: "brief-invalid",
        output: { ...candidate, problem: "A proposal with a fixed price." },
        inputTokens: 5,
        outputTokens: 10,
        latencyMs: 2,
      },
    ]);
    const runner = new BriefSynthesisRunner(budgets, store, model, config);
    await expect(
      runner.run({
        organizationId,
        caseId,
        attemptKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
    const state = await pool.query(
      `SELECT r.status, i.status invocation, b.status budget,
       (SELECT count(*)::integer FROM brief_revisions WHERE case_id=$1) revisions
       FROM brief_synthesis_requests r
       JOIN model_invocations i ON i.id=r.model_invocation_id
       JOIN budget_reservations b ON b.id=r.reservation_id
       WHERE r.case_id=$1`,
      [caseId],
    );
    expect(state.rows[0]).toEqual({
      status: "INVALID",
      invocation: "INVALID",
      budget: "CONSUMED",
      revisions: 0,
    });
  });

  it("creates one revision when the explicit second attempt is valid", async () => {
    const caseId = await readyCase();
    const model = new FakeModelPort([
      {
        kind: "completed",
        responseId: "brief-invalid-first",
        output: { ...candidate, problem: "The proposed deadline is fixed." },
        inputTokens: 5,
        outputTokens: 10,
        latencyMs: 2,
      },
      {
        kind: "completed",
        responseId: "brief-valid-second",
        output: candidate,
        inputTokens: 5,
        outputTokens: 10,
        latencyMs: 2,
      },
    ]);
    const runner = new BriefSynthesisRunner(budgets, store, model, config);
    await expect(
      runner.run({
        organizationId,
        caseId,
        attemptKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: "invalid" });
    await expect(
      runner.run({
        organizationId,
        caseId,
        attemptKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({ kind: "candidate" });
    const state = await pool.query(
      `SELECT r.status, r.attempt_count,
       (SELECT count(*)::integer FROM brief_revisions WHERE case_id=$1) revisions,
       (SELECT count(*)::integer FROM model_invocations WHERE case_id=$1) invocations
       FROM brief_synthesis_requests r WHERE r.case_id=$1`,
      [caseId],
    );
    expect(state.rows[0]).toEqual({
      status: "SUCCEEDED",
      attempt_count: 2,
      revisions: 1,
      invocations: 2,
    });
  });
});
