import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConsentStore } from "../../packages/database/src/consent";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const store = new ConsentStore(connectionString);
const ids = {
  organization: randomUUID(),
  case: randomUUID(),
  otherCase: randomUUID(),
  person: randomUUID(),
  contact: randomUUID(),
  connection: randomUUID(),
  conversation: randomUUID(),
  sourceMessage: randomUUID(),
  policy: randomUUID(),
};
const noticeText = "Synthetic consent notice";
const noticeHash = createHash("sha256").update(noticeText).digest("hex");

beforeAll(async () => {
  await pool
    .query(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [ids.organization],
    )
    .then((result) => {
      ids.organization = result.rows[0].id;
    });
  await pool.query(`INSERT INTO prospect_cases (id, organization_id) VALUES ($1, $3), ($2, $3)`, [
    ids.case,
    ids.otherCase,
    ids.organization,
  ]);
  await pool.query(`INSERT INTO people (id, organization_id) VALUES ($1, $2)`, [
    ids.person,
    ids.organization,
  ]);
  await pool.query(
    `INSERT INTO case_participants (organization_id, case_id, person_id, role)
     VALUES ($1, $2, $3, 'REQUESTER')`,
    [ids.organization, ids.case, ids.person],
  );
  await pool.query(
    `INSERT INTO contact_points
      (id, organization_id, person_id, kind, value_ciphertext, fingerprint, source, purpose,
       provider, external_id)
     VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4, 'synthetic', 'discovery',
       'META', 'synthetic-recipient')`,
    [ids.contact, ids.organization, ids.person, `fingerprint-${ids.contact}`],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/meta')`,
    [ids.connection, ids.organization, `account-${ids.connection}`],
  );
  await pool.query(
    `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id)
     VALUES ($1, $2, $3, $4)`,
    [ids.conversation, ids.organization, ids.case, ids.connection],
  );
  await pool.query(
    `INSERT INTO messages
      (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, provider_occurred_at)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', now())`,
    [
      ids.sourceMessage,
      ids.organization,
      ids.case,
      ids.conversation,
      ids.connection,
      `wamid-${ids.sourceMessage}`,
    ],
  );
  await pool.query(
    `INSERT INTO consent_policies
      (id, organization_id, purpose, channel, locale, version, notice_text, notice_hash, effective_at)
     VALUES ($1, $2, 'DISCOVERY', 'WHATSAPP', 'es-PE', 1, $3, $4, now())`,
    [ids.policy, ids.organization, noticeText, noticeHash],
  );
});

afterAll(async () => {
  await store.close();
  await pool.end();
});

function insertRecord(
  overrides: { hash?: string; caseId?: string; key?: string; sourceMessageId?: string } = {},
) {
  return pool.query(
    `INSERT INTO consent_records
      (organization_id, case_id, person_id, contact_point_id, policy_id, purpose, action,
       source_message_id, policy_version, notice_hash, channel, locale, occurred_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'DISCOVERY', 'ACCEPTED', $6, 1, $7,
       'WHATSAPP', 'es-PE', now(), $8) RETURNING id`,
    [
      ids.organization,
      overrides.caseId ?? ids.case,
      ids.person,
      ids.contact,
      ids.policy,
      overrides.sourceMessageId ?? ids.sourceMessage,
      overrides.hash ?? noticeHash,
      overrides.key ?? "consent-once",
    ],
  );
}

async function insertInboundResponse(text: string, replyTo?: string): Promise<string> {
  const id = randomUUID();
  const content = Buffer.from(text);
  await pool.query(
    `INSERT INTO messages
      (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, content_bytes, content_hash, provider_occurred_at,
       sender_person_id, sender_contact_point_id, reply_to_provider_message_id)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', $7, $8, now(), $9, $10, $11)`,
    [
      id,
      ids.organization,
      ids.case,
      ids.conversation,
      ids.connection,
      `wamid-${id}`,
      content,
      createHash("sha256").update(content).digest("hex"),
      ids.person,
      ids.contact,
      replyTo,
    ],
  );
  return id;
}

describe("consent evidence schema", () => {
  it("queues one versioned notice and leaves the case awaiting a response", async () => {
    const input = {
      organizationId: ids.organization,
      caseId: ids.case,
      personId: ids.person,
      contactPointId: ids.contact,
      conversationId: ids.conversation,
      providerConnectionId: ids.connection,
      policyId: ids.policy,
      sourceMessageId: ids.sourceMessage,
      correlationId: randomUUID(),
    };
    const first = await store.requestDiscoveryConsent(input);
    const duplicate = await store.requestDiscoveryConsent({
      ...input,
      correlationId: randomUUID(),
    });
    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ ...first, created: false });

    const state = await pool.query(
      `SELECT pc.status, pc.next_action,
        (SELECT count(*)::integer FROM consent_requests WHERE case_id = pc.id) AS requests,
        (SELECT count(*)::integer FROM outbox_events WHERE case_id = pc.id
          AND event_type = 'whatsapp.consent.request.v1') AS outbox,
        (SELECT count(*)::integer FROM consent_records WHERE case_id = pc.id) AS records
       FROM prospect_cases pc WHERE pc.id = $1`,
      [ids.case],
    );
    expect(state.rows[0]).toEqual({
      status: "AWAITING_CONSENT",
      next_action: "AWAITING_CONSENT_RESPONSE",
      requests: 1,
      outbox: 1,
      records: 0,
    });
    const payload = await pool.query<{ payload: { type: string; text: { body: string } } }>(
      `SELECT payload FROM outbox_events WHERE id = $1`,
      [first.outboxEventId],
    );
    expect(payload.rows[0]?.payload.type).toBe("text");
    expect(payload.rows[0]?.payload.text.body).toContain(noticeText);
  });

  it("records one exact acceptance and later revocation without duplicate effects", async () => {
    const request = await pool.query<{ id: string; outbox_event_id: string }>(
      `SELECT id, outbox_event_id FROM consent_requests WHERE case_id = $1`,
      [ids.case],
    );
    const current = request.rows[0];
    if (!current) throw new Error("synthetic_request_unavailable");
    const externalRequestId = "wamid.synthetic-consent-request";
    await pool.query(
      `UPDATE outbox_events SET status = 'ACCEPTED', provider_external_id = $2 WHERE id = $1`,
      [current.outbox_event_id, externalRequestId],
    );
    const ambiguousMessageId = await insertInboundResponse("sí", externalRequestId);
    await expect(
      store.recordDiscoveryResponse({
        organizationId: ids.organization,
        caseId: ids.case,
        requestId: current.id,
        sourceMessageId: ambiguousMessageId,
        correlationId: randomUUID(),
      }),
    ).rejects.toThrow("consent_response_unrecognized");
    const acceptanceMessageId = await insertInboundResponse("  acepto  ", externalRequestId);
    const input = {
      organizationId: ids.organization,
      caseId: ids.case,
      requestId: current.id,
      sourceMessageId: acceptanceMessageId,
      correlationId: randomUUID(),
    };
    const accepted = await store.recordDiscoveryResponse(input);
    const replay = await store.recordDiscoveryResponse({ ...input, correlationId: randomUUID() });
    expect(accepted).toMatchObject({ created: true, action: "ACCEPTED" });
    expect(replay).toEqual({ ...accepted, created: false });

    const revocationMessageId = await insertInboundResponse("REVOCO MI CONSENTIMIENTO");
    const pendingWorkId = randomUUID();
    await pool.query(
      `INSERT INTO outbox_events
        (id, organization_id, case_id, event_type, aggregate_type, aggregate_id,
         payload, idempotency_key, deadline_at)
       VALUES ($1, $2, $3, 'whatsapp.interview.question.v1', 'message', $4,
         '{}', $5, now() + interval '10 minutes')`,
      [pendingWorkId, ids.organization, ids.case, randomUUID(), `pending-${pendingWorkId}`],
    );
    const revoked = await store.recordDiscoveryResponse({
      ...input,
      sourceMessageId: revocationMessageId,
      correlationId: randomUUID(),
    });
    expect(revoked).toMatchObject({ created: true, action: "REVOKED" });

    const state = await pool.query(
      `SELECT pc.status, pc.next_action,
        (SELECT count(*)::integer FROM consent_records WHERE case_id = pc.id) AS records,
        (SELECT count(*)::integer FROM outbox_events WHERE case_id = pc.id AND status = 'PENDING') AS pending
       FROM prospect_cases pc WHERE pc.id = $1`,
      [ids.case],
    );
    expect(state.rows[0]).toEqual({
      status: "PAUSED",
      next_action: "CONSENT_REVOKED",
      records: 2,
      pending: 0,
    });
    const cancelled = await pool.query<{ status: string }>(
      `SELECT status FROM outbox_events WHERE id = $1`,
      [pendingWorkId],
    );
    expect(cancelled.rows[0]?.status).toBe("CANCELLED");

    const secondPolicyId = randomUUID();
    await pool.query(
      `INSERT INTO consent_policies
        (id, organization_id, purpose, channel, locale, version, notice_text, notice_hash, effective_at)
       VALUES ($1, $2, 'DISCOVERY', 'WHATSAPP', 'es-PE', 2, $3, $4, now())`,
      [secondPolicyId, ids.organization, noticeText, noticeHash],
    );
    await pool.query(`UPDATE prospect_cases SET status = 'NEW', next_action = NULL WHERE id = $1`, [
      ids.case,
    ]);
    const secondRequest = await store.requestDiscoveryConsent({
      organizationId: ids.organization,
      caseId: ids.case,
      personId: ids.person,
      contactPointId: ids.contact,
      conversationId: ids.conversation,
      providerConnectionId: ids.connection,
      policyId: secondPolicyId,
      sourceMessageId: ids.sourceMessage,
      correlationId: randomUUID(),
    });
    const secondExternalId = "wamid.synthetic-consent-request-2";
    await pool.query(
      `UPDATE outbox_events SET status = 'ACCEPTED', provider_external_id = $2 WHERE id = $1`,
      [secondRequest.outboxEventId, secondExternalId],
    );
    const rejectionMessageId = await insertInboundResponse("NO ACEPTO", secondExternalId);
    const rejected = await store.recordDiscoveryResponse({
      organizationId: ids.organization,
      caseId: ids.case,
      requestId: secondRequest.requestId,
      sourceMessageId: rejectionMessageId,
      correlationId: randomUUID(),
    });
    expect(rejected).toMatchObject({ created: true, action: "REJECTED" });
  });

  it("registers exact policy evidence and keeps it append-only and idempotent", async () => {
    const record = await insertRecord();
    await expect(insertRecord()).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(`UPDATE consent_records SET locale = 'en-US' WHERE id = $1`, [record.rows[0].id]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`DELETE FROM consent_policies WHERE id = $1`, [ids.policy]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects a different notice hash or a source message from another case", async () => {
    const wrongHashSource = await insertInboundResponse("synthetic wrong hash");
    await expect(
      insertRecord({
        hash: "0".repeat(64),
        key: "wrong-hash",
        sourceMessageId: wrongHashSource,
      }),
    ).rejects.toMatchObject({ code: "23503" });
    const wrongCaseSource = await insertInboundResponse("synthetic wrong case");
    await expect(
      insertRecord({
        caseId: ids.otherCase,
        key: "wrong-case",
        sourceMessageId: wrongCaseSource,
      }),
    ).rejects.toMatchObject({ code: "23503" });
  });
});
