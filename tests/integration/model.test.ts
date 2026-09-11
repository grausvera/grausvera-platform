import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  BudgetStore,
  KnowledgeStore,
  ModelInvocationStore,
  NextActionStore,
} from "../../packages/database/src";
import {
  FakeModelPort,
  InterviewExtractionRunner,
  NextQuestionRunner,
  type ModelResult,
} from "../../apps/worker/src/model";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const budgets = new BudgetStore(connectionString);
const invocations = new ModelInvocationStore(connectionString);
const knowledge = new KnowledgeStore(connectionString);
const nextActions = new NextActionStore(connectionString);
let organizationId: string;
let connectionId: string;
let policyId: string;
let consentPolicyId: string;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  connectionId = randomUUID();
  await pool.query(
    `INSERT INTO provider_connections
      (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/model')`,
    [connectionId, organizationId, `model-${connectionId}`],
  );
  policyId = await pool
    .query<{ id: string }>(
      `WITH inserted AS (
         INSERT INTO interview_policies (organization_id, version, topics, effective_at)
         VALUES ($1, 250, '[{"key":"PROJECT_INTENT","required":true}]', now() + interval '1 day')
         ON CONFLICT (organization_id, version) DO NOTHING RETURNING id
       )
       SELECT id FROM inserted
       UNION ALL
       SELECT id FROM interview_policies WHERE organization_id = $1 AND version = 250
       LIMIT 1`,
      [organizationId],
    )
    .then((result) => result.rows[0]?.id ?? "");
  consentPolicyId = await pool
    .query<{ id: string }>(
      `WITH inserted AS (
         INSERT INTO consent_policies
           (organization_id, purpose, channel, locale, version, notice_text,
            notice_hash, scope, effective_at)
         VALUES ($1, 'DISCOVERY', 'WHATSAPP', 'es-PE-model', 1, 'synthetic notice',
           repeat('a', 64), 'PROJECT_DISCOVERY', now() - interval '1 minute')
         ON CONFLICT (organization_id, purpose, channel, locale, version) DO NOTHING
         RETURNING id
       )
       SELECT id FROM inserted UNION ALL
       SELECT id FROM consent_policies WHERE organization_id = $1
         AND purpose = 'DISCOVERY' AND channel = 'WHATSAPP' AND locale = 'es-PE-model' AND version = 1
       LIMIT 1`,
      [organizationId],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(
    `INSERT INTO budget_policies
      (organization_id, version, alert_micros, hard_limit_micros, effective_at)
     VALUES ($1, 1, 500, 1000, now() - interval '1 minute')
     ON CONFLICT (organization_id, version) DO NOTHING`,
    [organizationId],
  );
});

afterAll(async () => {
  await invocations.close();
  await knowledge.close();
  await nextActions.close();
  await budgets.close();
  await pool.end();
});

async function caseWithMessage(content = "Quiero crear una plataforma") {
  const caseId = randomUUID();
  const conversationId = randomUUID();
  const interviewId = randomUUID();
  const messageId = randomUUID();
  const personId = randomUUID();
  const contactPointId = randomUUID();
  await pool.query(
    `INSERT INTO prospect_cases (id, organization_id, status)
     VALUES ($1, $2, 'INTERVIEWING')`,
    [caseId, organizationId],
  );
  await pool.query(`INSERT INTO people (id, organization_id) VALUES ($1, $2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO contact_points
      (id, organization_id, person_id, kind, value_ciphertext, fingerprint,
       source, purpose, provider, external_id)
     VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4,
       'synthetic', 'discovery', 'META', $5)`,
    [
      contactPointId,
      organizationId,
      personId,
      `fingerprint-${contactPointId}`,
      `synthetic-model-${personId}`,
    ],
  );
  await pool.query(
    `INSERT INTO case_participants (organization_id, case_id, person_id, role)
     VALUES ($1, $2, $3, 'REQUESTER')`,
    [organizationId, caseId, personId],
  );
  await pool.query(
    `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
  await pool.query(
    `INSERT INTO messages
      (id, organization_id, case_id, conversation_id, provider_connection_id,
       direction, provider_message_id, message_type, content_bytes, provider_occurred_at,
       sender_person_id, sender_contact_point_id)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', $7, now(), $8, $9)`,
    [
      messageId,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.model.${messageId}`,
      Buffer.from(content),
      personId,
      contactPointId,
    ],
  );
  await pool.query(
    `INSERT INTO consent_records
      (organization_id, case_id, person_id, contact_point_id, policy_id, purpose,
       action, source_message_id, policy_version, notice_hash, channel, locale,
       scope, occurred_at, valid_until, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'DISCOVERY', 'ACCEPTED', $6, 1, repeat('a', 64),
       'WHATSAPP', 'es-PE-model', 'PROJECT_DISCOVERY', now(), now() + interval '1 day', $7)`,
    [organizationId, caseId, personId, contactPointId, consentPolicyId, messageId, randomUUID()],
  );
  await pool.query(
    `INSERT INTO interviews (id, organization_id, case_id, policy_id, status)
     VALUES ($1, $2, $3, $4, 'ACTIVE')`,
    [interviewId, organizationId, caseId, policyId],
  );
  await pool.query(
    `INSERT INTO interview_topics
      (organization_id, case_id, interview_id, topic_key, position, required)
     VALUES ($1, $2, $3, 'PROJECT_INTENT', 0, true)`,
    [organizationId, caseId, interviewId],
  );
  return { caseId, messageId };
}

function extraction(sourceMessageId: string) {
  return {
    language: "es",
    intent: "describir proyecto",
    facts: [
      {
        clientRef: "fact-1",
        category: "PROJECT_INTENT",
        value: "crear una plataforma",
        confidence: 0.9,
        sensitivity: "PUBLIC",
        sourceMessageIds: [sourceMessageId],
      },
    ],
    corrections: [],
    contradictions: [],
    stopRequested: false,
    humanRequested: false,
    candidateTopics: ["PROJECT_INTENT"],
    warnings: [],
  };
}

function runner(results: ModelResult[] | FakeModelPort) {
  return new InterviewExtractionRunner(
    budgets,
    invocations,
    results instanceof FakeModelPort ? results : new FakeModelPort(results),
    {
      model: "gpt-5.6-luna",
      maximumCostMicros: 30,
      inputUsdPerMillion: 0.2,
      outputUsdPerMillion: 1.2,
    },
  );
}

function nextRunner(results: ModelResult[] | FakeModelPort) {
  return new NextQuestionRunner(
    budgets,
    invocations,
    results instanceof FakeModelPort ? results : new FakeModelPort(results),
    {
      model: "gpt-5.6-luna",
      maximumCostMicros: 30,
      inputUsdPerMillion: 0.2,
      outputUsdPerMillion: 1.2,
    },
  );
}

function runInput(caseId: string, messageId: string) {
  return {
    organizationId,
    caseId,
    messageIds: [messageId],
    logicalOperationKey: randomUUID(),
    attemptKey: randomUUID(),
    correlationId: randomUUID(),
  };
}

describe("reserved structured model extraction", () => {
  it("rejects a message from another case before reserving or invoking", async () => {
    const first = await caseWithMessage();
    const second = await caseWithMessage();
    await expect(
      invocations.buildExtractionContext({
        organizationId,
        caseId: first.caseId,
        messageIds: [second.messageId],
      }),
    ).rejects.toThrow("model_context_message_not_authorized");
  });

  it("applies valid candidates once with exact sources and immutable messages", async () => {
    const current = await caseWithMessage();
    const input = runInput(current.caseId, current.messageId);
    const result = await runner([
      {
        kind: "completed",
        responseId: "resp-valid",
        output: extraction(current.messageId),
        inputTokens: 10,
        outputTokens: 20,
        latencyMs: 12,
      },
    ]).run(input);
    expect(result.kind).toBe("candidates");
    const replayPort = new FakeModelPort([]);
    await expect(runner(replayPort).run(input)).resolves.toEqual({
      kind: "replayed",
      invocationId: result.invocationId,
    });
    expect(replayPort.requests).toHaveLength(0);
    const batchId = await pool
      .query<{ id: string }>(`SELECT id FROM model_candidate_batches WHERE invocation_id = $1`, [
        result.invocationId,
      ])
      .then((query) => query.rows[0]?.id ?? "");
    const before = await pool
      .query<{ content: Buffer }>(`SELECT content_bytes AS content FROM messages WHERE id = $1`, [
        current.messageId,
      ])
      .then((query) => query.rows[0]?.content);
    const applied = await knowledge.applyCandidateBatch({
      organizationId,
      batchId,
      correlationId: randomUUID(),
    });
    expect(applied.applied).toBe(true);
    await expect(
      knowledge.applyCandidateBatch({ organizationId, batchId, correlationId: randomUUID() }),
    ).resolves.toEqual({ applied: false, claimIds: applied.claimIds });
    const state = await pool.query(
      `SELECT mi.status, mi.input_tokens, mi.output_tokens, mi.cost_micros::integer,
        (SELECT count(*)::integer FROM model_candidate_batches WHERE invocation_id = mi.id AND status = 'APPLIED') AS batches,
        (SELECT count(*)::integer FROM claims WHERE case_id = mi.case_id) AS claims,
        (SELECT count(*)::integer FROM claim_sources cs JOIN claims c ON c.id = cs.claim_id
          WHERE c.case_id = mi.case_id AND cs.message_id = $2) AS sources,
        (SELECT status FROM interviews WHERE case_id = mi.case_id) AS interview_status,
        (SELECT version FROM interviews WHERE case_id = mi.case_id) AS interview_version,
        br.status AS reservation_status, bl.consumed_micros::integer
       FROM model_invocations mi
       JOIN budget_reservations br ON br.id = mi.reservation_id
       JOIN budget_ledgers bl ON bl.id = br.ledger_id
       WHERE mi.id = $1`,
      [result.invocationId, current.messageId],
    );
    expect(state.rows[0]).toEqual({
      status: "SUCCEEDED",
      input_tokens: 10,
      output_tokens: 20,
      cost_micros: 26,
      batches: 1,
      claims: 1,
      sources: 1,
      interview_status: "SUFFICIENT",
      interview_version: 2,
      reservation_status: "CONSUMED",
      consumed_micros: 26,
    });
    const after = await pool
      .query<{ content: Buffer }>(`SELECT content_bytes AS content FROM messages WHERE id = $1`, [
        current.messageId,
      ])
      .then((query) => query.rows[0]?.content);
    expect(after).toEqual(before);

    const revised = await runner([
      {
        kind: "completed",
        responseId: "resp-revised",
        output: {
          language: "es",
          intent: "corregir y señalar contradicción",
          facts: [],
          corrections: [
            {
              targetClaimId: applied.claimIds[0],
              replacement: "crear una herramienta interna",
              sourceMessageIds: [current.messageId],
            },
          ],
          contradictions: [
            {
              claimIds: [applied.claimIds[0]],
              explanation: "La descripción nueva contradice el alcance anterior.",
              sourceMessageIds: [current.messageId],
            },
          ],
          stopRequested: false,
          humanRequested: false,
          candidateTopics: [],
          warnings: [],
        },
        inputTokens: 5,
        outputTokens: 10,
        latencyMs: 2,
      },
    ]).run(runInput(current.caseId, current.messageId));
    const revisedBatchId = await pool
      .query<{ id: string }>(`SELECT id FROM model_candidate_batches WHERE invocation_id = $1`, [
        revised.invocationId,
      ])
      .then((query) => query.rows[0]?.id ?? "");
    const revision = await knowledge.applyCandidateBatch({
      organizationId,
      batchId: revisedBatchId,
      correlationId: randomUUID(),
    });
    expect(revision.claimIds).toHaveLength(2);
    const revisedState = await pool.query(
      `SELECT
        (SELECT validity FROM claims WHERE id = $1) AS original_validity,
        (SELECT count(*)::integer FROM claim_relations WHERE case_id = $2 AND relation = 'REPLACES') AS replacements,
        (SELECT count(*)::integer FROM claim_relations WHERE case_id = $2 AND relation = 'CONTRADICTS') AS contradictions,
        (SELECT audience FROM claims WHERE id = $3) AS contradiction_audience`,
      [applied.claimIds[0], current.caseId, revision.claimIds[1]],
    );
    expect(revisedState.rows[0]).toEqual({
      original_validity: "REPLACED",
      replacements: 1,
      contradictions: 1,
      contradiction_audience: "INTERNAL",
    });
    const externalSourceId = await knowledge.recordExternalSource({
      organizationId,
      caseId: current.caseId,
      claimId: revision.claimIds[0],
      canonicalUrl: "https://example.invalid/synthetic-source",
      title: "Synthetic public source",
      publisher: "Example",
      accessedAt: new Date("2026-09-10T00:00:00Z"),
      excerpt: "A minimal synthetic excerpt supporting the corrected scope.",
      contentHash: "b".repeat(64),
      purpose: "PROJECT_DISCOVERY",
      confidenceBasisPoints: 8000,
      relation: "SUPPORTS",
    });
    const trace = await knowledge.getClaimTrace(
      organizationId,
      current.caseId,
      revision.claimIds[0],
    );
    expect(trace.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "MESSAGE",
          referenceId: current.messageId,
        }),
        expect.objectContaining({
          kind: "EXTERNAL",
          referenceId: externalSourceId,
          label: "Synthetic public source",
        }),
      ]),
    );
    expect(trace.relations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relation: "REPLACES", claimId: applied.claimIds[0] }),
      ]),
    );
    await expect(knowledge.listContradictions(organizationId, current.caseId)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          contradictionClaimId: revision.claimIds[1],
          targetClaimId: applied.claimIds[0],
        }),
      ]),
    );
  });

  it("rejects a stale batch atomically", async () => {
    const current = await caseWithMessage();
    const result = await runner([
      {
        kind: "completed",
        responseId: "resp-stale",
        output: extraction(current.messageId),
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      },
    ]).run(runInput(current.caseId, current.messageId));
    const batchId = await pool
      .query<{ id: string }>(`SELECT id FROM model_candidate_batches WHERE invocation_id = $1`, [
        result.invocationId,
      ])
      .then((query) => query.rows[0]?.id ?? "");
    await pool.query(`UPDATE interviews SET version = version + 1 WHERE case_id = $1`, [
      current.caseId,
    ]);
    await expect(
      knowledge.applyCandidateBatch({ organizationId, batchId, correlationId: randomUUID() }),
    ).rejects.toThrow("candidate_batch_stale");
    const state = await pool.query(
      `SELECT b.status,
        (SELECT count(*)::integer FROM claims WHERE case_id = b.case_id) AS claims
       FROM model_candidate_batches b WHERE b.id = $1`,
      [batchId],
    );
    expect(state.rows[0]).toEqual({ status: "PENDING", claims: 0 });
  });

  it("persists a valid next action as pending without changing or sending it", async () => {
    const current = await caseWithMessage();
    const port = new FakeModelPort([
      {
        kind: "completed",
        responseId: "resp-next",
        output: {
          action: "ASK",
          question: "¿Qué deseas conseguir con el proyecto?",
          reasonCode: "MISSING_REQUIRED_TOPIC",
          targetTopic: "PROJECT_INTENT",
          referencedClaimIds: [],
        },
        inputTokens: 4,
        outputTokens: 8,
        latencyMs: 2,
      },
    ]);
    const next = nextRunner(port);
    const input = runInput(current.caseId, current.messageId);
    const result = await next.run(input);
    expect(result).toMatchObject({ kind: "proposal", action: "ASK" });
    await expect(next.run(input)).resolves.toMatchObject({ kind: "replayed" });
    expect(port.requests).toHaveLength(1);
    const state = await pool.query(
      `SELECT p.action, p.question, p.status, i.status AS interview_status,
        i.pending_question,
        (SELECT count(*)::integer FROM outbox_events WHERE case_id = p.case_id) AS outbox
       FROM next_action_proposals p JOIN interviews i ON i.id = p.interview_id
       WHERE p.id = $1`,
      [result.kind === "proposal" ? result.proposalId : randomUUID()],
    );
    expect(state.rows[0]).toEqual({
      action: "ASK",
      question: "¿Qué deseas conseguir con el proyecto?",
      status: "PENDING",
      interview_status: "ACTIVE",
      pending_question: null,
      outbox: 0,
    });
    const authorized = await nextActions.authorize({
      organizationId,
      proposalId: result.kind === "proposal" ? result.proposalId : randomUUID(),
      correlationId: randomUUID(),
    });
    expect(authorized).toMatchObject({ kind: "authorized", action: "ASK" });
    await expect(
      nextActions.authorize({
        organizationId,
        proposalId: result.kind === "proposal" ? result.proposalId : randomUUID(),
        correlationId: randomUUID(),
      }),
    ).resolves.toMatchObject({
      kind: "replayed",
      messageId: authorized.messageId,
      outboxEventId: authorized.outboxEventId,
    });
    const authorizedState = await pool.query(
      `SELECT p.status, i.pending_question, i.version,
        (SELECT count(*)::integer FROM outbox_events WHERE case_id = p.case_id
          AND idempotency_key = $2) AS outbox,
        (SELECT count(*)::integer FROM messages WHERE case_id = p.case_id
          AND direction = 'OUTBOUND') AS outbound
       FROM next_action_proposals p JOIN interviews i ON i.id = p.interview_id
       WHERE p.id = $1`,
      [
        result.kind === "proposal" ? result.proposalId : randomUUID(),
        `next-action:${result.kind === "proposal" ? result.proposalId : ""}`,
      ],
    );
    expect(authorizedState.rows[0]).toEqual({
      status: "AUTHORIZED",
      pending_question: "¿Qué deseas conseguir con el proyecto?",
      version: 2,
      outbox: 1,
      outbound: 1,
    });
    await pool.query(`UPDATE outbox_events SET status = 'CANCELLED' WHERE id = $1`, [
      authorized.outboxEventId,
    ]);
  });

  it("gives stop priority over a pending model question", async () => {
    const current = await caseWithMessage();
    const result = await nextRunner([
      {
        kind: "completed",
        responseId: "resp-blocked-stop",
        output: {
          action: "ASK",
          question: "¿Qué resultado buscas obtener?",
          reasonCode: "MISSING_REQUIRED_TOPIC",
          targetTopic: "PROJECT_INTENT",
          referencedClaimIds: [],
        },
        inputTokens: 2,
        outputTokens: 4,
        latencyMs: 1,
      },
    ]).run(runInput(current.caseId, current.messageId));
    await pool.query(
      `UPDATE prospect_cases SET status = 'PAUSED', next_action = 'STOP_REQUESTED'
       WHERE organization_id = $1 AND id = $2`,
      [organizationId, current.caseId],
    );
    const blocked = await nextActions.authorize({
      organizationId,
      proposalId: result.kind === "proposal" ? result.proposalId : randomUUID(),
      correlationId: randomUUID(),
    });
    expect(blocked).toEqual({ kind: "blocked", action: "ASK", reason: "STOP_REQUESTED" });
    const state = await pool.query(
      `SELECT p.status, i.pending_question,
        (SELECT count(*)::integer FROM outbox_events WHERE case_id = p.case_id) AS outbox
       FROM next_action_proposals p JOIN interviews i ON i.id = p.interview_id
       WHERE p.id = $1`,
      [result.kind === "proposal" ? result.proposalId : randomUUID()],
    );
    expect(state.rows[0]).toEqual({ status: "REJECTED", pending_question: null, outbox: 0 });
  });

  it("rejects foreign references and retains uncertain cost without creating claims", async () => {
    const invalidCase = await caseWithMessage();
    const invalid = await runner([
      {
        kind: "completed",
        responseId: "resp-invalid",
        output: extraction(randomUUID()),
        inputTokens: 5,
        outputTokens: 5,
        latencyMs: 4,
      },
    ]).run(runInput(invalidCase.caseId, invalidCase.messageId));
    expect(invalid.kind).toBe("invalid");

    const uncertainCase = await caseWithMessage();
    const uncertain = await runner([
      { kind: "uncertain", errorCode: "openai_timeout", latencyMs: 1_000 },
    ]).run(runInput(uncertainCase.caseId, uncertainCase.messageId));
    expect(uncertain.kind).toBe("uncertain");
    const states = await pool.query(
      `SELECT mi.status,
        (SELECT count(*)::integer FROM model_candidate_batches WHERE invocation_id = mi.id) AS batches,
        br.status AS reservation_status, bl.uncertain_micros::integer
       FROM model_invocations mi
       JOIN budget_reservations br ON br.id = mi.reservation_id
       JOIN budget_ledgers bl ON bl.id = br.ledger_id
       WHERE mi.id = ANY($1::uuid[]) ORDER BY mi.status`,
      [[invalid.invocationId, uncertain.invocationId]],
    );
    expect(states.rows).toEqual([
      { status: "INVALID", batches: 0, reservation_status: "CONSUMED", uncertain_micros: 0 },
      { status: "UNCERTAIN", batches: 0, reservation_status: "UNCERTAIN", uncertain_micros: 30 },
    ]);
  });
});
