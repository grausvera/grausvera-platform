import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InterviewStore, MessagingStore } from "../../packages/database/src";
import { normalizeMetaWebhook } from "../../apps/worker/src/meta-inbound";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const interviews = new InterviewStore(connectionString);
const messaging = new MessagingStore(connectionString);
let organizationId: string;
let personId: string;
let contactPointId: string;
let connectionId: string;
let consentPolicyId: string;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  personId = randomUUID();
  contactPointId = randomUUID();
  connectionId = randomUUID();
  await pool.query(`INSERT INTO people (id, organization_id) VALUES ($1, $2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO contact_points
      (id, organization_id, person_id, kind, value_ciphertext, fingerprint,
       source, purpose, provider, external_id)
     VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4,
       'synthetic', 'continuity-test', 'META', 'synthetic-continuity-contact')`,
    [contactPointId, organizationId, personId, `continuity-${contactPointId}`],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/continuity')`,
    [connectionId, organizationId, `continuity-${connectionId}`],
  );
  consentPolicyId = await pool
    .query<{ id: string }>(
      `INSERT INTO consent_policies
        (id, organization_id, purpose, channel, locale, version, notice_text,
         notice_hash, scope, effective_at)
       VALUES ($1, $2, 'DISCOVERY', 'WHATSAPP', 'es-PE-continuity', 1,
         'synthetic notice', repeat('c', 64), 'PROJECT_DISCOVERY', now() - interval '1 minute')
       RETURNING id`,
      [randomUUID(), organizationId],
    )
    .then((result) => result.rows[0]?.id ?? "");
});

afterAll(async () => {
  await interviews.close();
  await messaging.close();
  await pool.end();
});

async function createProject(label: string) {
  const caseId = randomUUID();
  const conversationId = randomUUID();
  const sourceMessageId = randomUUID();
  await pool.query(
    `INSERT INTO prospect_cases (id, organization_id, status, next_action)
     VALUES ($1, $2, 'INTERVIEWING', 'ASK_QUESTION')`,
    [caseId, organizationId],
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
       direction, provider_message_id, message_type, content_bytes,
       provider_occurred_at, sender_person_id, sender_contact_point_id)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', $7, now(), $8, $9)`,
    [
      sourceMessageId,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.consent.${label}`,
      Buffer.from("ACEPTO"),
      personId,
      contactPointId,
    ],
  );
  await pool.query(
    `INSERT INTO consent_records
      (organization_id, case_id, person_id, contact_point_id, policy_id, purpose,
       action, source_message_id, policy_version, notice_hash, channel, locale,
       scope, occurred_at, valid_until, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'DISCOVERY', 'ACCEPTED', $6, 1, repeat('c', 64),
       'WHATSAPP', 'es-PE-continuity', 'PROJECT_DISCOVERY', now(),
       now() + interval '1 day', $7)`,
    [
      organizationId,
      caseId,
      personId,
      contactPointId,
      consentPolicyId,
      sourceMessageId,
      randomUUID(),
    ],
  );
  const created = await interviews.create({ organizationId, caseId, correlationId: randomUUID() });
  const question = `¿Cuál es el objetivo del proyecto ${label}?`;
  const active = await interviews.update({
    organizationId,
    caseId,
    expectedVersion: created.interview.version,
    pendingQuestion: question,
    correlationId: randomUUID(),
  });
  await pool.query(
    `INSERT INTO messages
      (organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, content_bytes, provider_occurred_at,
       processing_status)
     VALUES ($1, $2, $3, $4, 'OUTBOUND', $5, 'text', $6, now(), 'PROCESSED')`,
    [
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.question.${label}`,
      Buffer.from(question),
    ],
  );
  await pool.query(
    `INSERT INTO claims
      (organization_id, case_id, kind, category, content, confidence_basis_points,
       sensitivity, audience, creator)
     VALUES ($1, $2, 'FACT', 'PROJECT_INTENT', $3, 10000,
       'CONFIDENTIAL', 'INTERNAL', 'HUMAN')`,
    [organizationId, caseId, `claim-${label}`],
  );
  return { caseId, conversationId, interview: active, question };
}

function webhook(messages: unknown[]) {
  return new TextEncoder().encode(
    JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ changes: [{ value: { messages } }] }],
    }),
  );
}

describe("case continuity regression", () => {
  it("preserves two projects through pause, resume, reordering and duplicate delivery", async () => {
    const first = await createProject("alpha");
    const second = await createProject("beta");
    const quotaPolicyId = randomUUID();
    await pool.query(
      `INSERT INTO quota_policies
        (id, organization_id, version, period_seconds, case_message_limit,
         contact_message_limit, case_active_seconds_limit, effective_at)
       VALUES ($1, $2, 300, 86400, 30, 60, 3600, now() + interval '1 day')`,
      [quotaPolicyId, organizationId],
    );
    await pool.query(
      `INSERT INTO case_quota_usages
        (organization_id, case_id, policy_id, window_ends_at, active_seconds,
         last_accounted_at)
       VALUES ($1, $2, $3, now() + interval '1 day', 11, now())`,
      [organizationId, first.caseId, quotaPolicyId],
    );
    const paused = await interviews.pause({
      organizationId,
      caseId: first.caseId,
      expectedVersion: first.interview.version,
      reason: "PROSPECT_REQUESTED",
      correlationId: randomUUID(),
    });
    const resumed = await interviews.resume({
      organizationId,
      caseId: first.caseId,
      expectedVersion: paused.interview.version,
      correlationId: randomUUID(),
    });
    expect(resumed.interview).toMatchObject({
      id: first.interview.id,
      pendingQuestion: first.question,
    });

    const body = webhook([
      {
        from: "synthetic-continuity-contact",
        id: "wamid.answer.beta",
        context: { id: "wamid.question.beta" },
        timestamp: "1789000022",
        type: "text",
        text: { body: "Respuesta beta" },
      },
      {
        from: "synthetic-continuity-contact",
        id: "wamid.answer.alpha",
        context: { id: "wamid.question.alpha" },
        timestamp: "1789000021",
        type: "text",
        text: { body: "Respuesta alpha" },
      },
    ]);
    const receipt = await messaging.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: "continuity-out-of-order",
      body,
    });
    await messaging.reconcileInbox(receipt.inboxEventId, normalizeMetaWebhook(body).reverse());
    const duplicate = webhook([
      {
        from: "synthetic-continuity-contact",
        id: "wamid.answer.alpha",
        context: { id: "wamid.question.alpha" },
        timestamp: "1789000021",
        type: "text",
        text: { body: "Respuesta alpha" },
      },
    ]);
    const duplicateReceipt = await messaging.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: "continuity-duplicate",
      body: duplicate,
    });
    await messaging.reconcileInbox(duplicateReceipt.inboxEventId, normalizeMetaWebhook(duplicate));

    const state = await pool.query(
      `SELECT
        (SELECT count(*)::integer FROM messages WHERE provider_message_id = 'wamid.answer.alpha' AND case_id = $1) AS alpha_messages,
        (SELECT count(*)::integer FROM messages WHERE provider_message_id = 'wamid.answer.beta' AND case_id = $2) AS beta_messages,
        (SELECT count(*)::integer FROM claims WHERE case_id = $1 AND content = 'claim-alpha') AS alpha_claims,
        (SELECT count(*)::integer FROM claims WHERE case_id = $2 AND content = 'claim-beta') AS beta_claims,
        (SELECT count(*)::integer FROM claims WHERE case_id = $1 AND content = 'claim-beta') AS crossed_claims,
        (SELECT active_seconds FROM case_quota_usages WHERE case_id = $1) AS active_seconds,
        (SELECT pending_question FROM interviews WHERE case_id = $1) AS alpha_question,
        (SELECT pending_question FROM interviews WHERE case_id = $2) AS beta_question`,
      [first.caseId, second.caseId],
    );
    expect(state.rows[0]).toEqual({
      alpha_messages: 1,
      beta_messages: 1,
      alpha_claims: 1,
      beta_claims: 1,
      crossed_claims: 0,
      active_seconds: 11,
      alpha_question: first.question,
      beta_question: second.question,
    });
  });
});
