import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MessagingStore } from "../../packages/database/src";
import { FakeMessagingPort, OutboxDispatcher } from "../../apps/worker/src/messaging";
import { Pool } from "pg";
import { POST } from "../../apps/web/app/api/webhooks/meta/whatsapp/route";
import { normalizeMetaWebhook } from "../../apps/worker/src/meta-inbound";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const store = new MessagingStore(connectionString);
let organizationId: string;
let caseId: string;
let conversationId: string;
let connectionId: string;

beforeAll(async () => {
  organizationId = randomUUID();
  caseId = randomUUID();
  conversationId = randomUUID();
  connectionId = randomUUID();
  await pool
    .query(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
     ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [organizationId],
    )
    .then((result) => {
      organizationId = result.rows[0].id;
    });
  await pool.query(`INSERT INTO prospect_cases (id, organization_id) VALUES ($1, $2)`, [
    caseId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO provider_connections (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/meta')`,
    [connectionId, organizationId, `account-${connectionId}`],
  );
  await pool.query(
    `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
});

afterAll(async () => {
  await store.close();
  await pool.end();
});

function intent(suffix: string) {
  return {
    organizationId,
    caseId,
    conversationId,
    providerConnectionId: connectionId,
    providerMessageId: `local-${suffix}`,
    messageType: "text",
    content: new TextEncoder().encode(`synthetic-${suffix}`),
    eventType: "whatsapp.message.send.v1",
    payload: { messaging_product: "whatsapp", to: "synthetic-recipient", type: "text" },
    idempotencyKey: `${caseId}-send-${suffix}`,
    deadlineAt: new Date(Date.now() + 60_000),
    correlationId: randomUUID(),
  };
}

describe("durable messaging", () => {
  it("persists one inbox receipt under concurrent replay", async () => {
    const body = new TextEncoder().encode('{"object":"whatsapp_business_account","entry":[]}');
    const receipts = await Promise.all([
      store.persistInbox({ providerConnectionId: connectionId, externalEventId: "event-1", body }),
      store.persistInbox({ providerConnectionId: connectionId, externalEventId: "event-1", body }),
    ]);
    expect(receipts.filter((receipt) => receipt.created)).toHaveLength(1);
    expect(new Set(receipts.map((receipt) => receipt.inboxEventId)).size).toBe(1);
  });

  it("acknowledges a signed webhook only after durable persistence", async () => {
    process.env.META_APP_SECRET = "synthetic-app-secret";
    process.env.META_PROVIDER_CONNECTION_ID = connectionId;
    process.env.DATABASE_URL = connectionString;
    const body = JSON.stringify({
      object: "whatsapp_business_account",
      entry: [{ id: "synthetic" }],
    });
    const signature = `sha256=${createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex")}`;
    const request = () =>
      new Request("http://local/api/webhooks/meta/whatsapp", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": signature },
      });

    expect(await (await POST(request())).json()).toMatchObject({ status: "accepted" });
    expect(await (await POST(request())).json()).toMatchObject({ status: "duplicate" });
  });

  it("creates message, outbox, and audit atomically without duplicating an intent", async () => {
    const original = await store.createOutboundIntent(intent("atomic"));
    const duplicate = await store.createOutboundIntent({
      ...intent("duplicate"),
      idempotencyKey: `${caseId}-send-atomic`,
    });
    const counts = await pool.query(
      `SELECT (SELECT count(*)::integer FROM messages WHERE case_id = $1) AS messages,
              (SELECT count(*)::integer FROM outbox_events WHERE case_id = $1) AS outbox,
              (SELECT count(*)::integer FROM audit_events WHERE case_id = $1) AS audit`,
      [caseId],
    );
    expect(counts.rows[0]).toEqual({ messages: 1, outbox: 1, audit: 1 });
    expect(duplicate).toEqual(original);
  });

  it("claims once under concurrency, preserves uncertainty, and honors emitter shutdown", async () => {
    await pool.query(
      `UPDATE outbox_events SET available_at = now() + interval '1 hour'
       WHERE case_id <> $1 AND status = 'PENDING'`,
      [caseId],
    );
    const firstPort = new FakeMessagingPort();
    const secondPort = new FakeMessagingPort();
    const first = new OutboxDispatcher(store, firstPort);
    const second = new OutboxDispatcher(store, secondPort);
    first.setEnabled(true);
    second.setEnabled(true);
    await Promise.all([first.dispatchOne(), second.dispatchOne()]);
    expect(firstPort.sent.length + secondPort.sent.length).toBe(1);

    await store.createOutboundIntent(intent("uncertain"));
    const uncertainPort = new FakeMessagingPort([{ kind: "uncertain", errorCode: "timeout" }]);
    const uncertain = new OutboxDispatcher(store, uncertainPort);
    uncertain.setEnabled(true);
    expect(await uncertain.dispatchOne()).toEqual({ kind: "uncertain", errorCode: "timeout" });

    await store.createOutboundIntent(intent("disabled"));
    const disabledPort = new FakeMessagingPort();
    const disabled = new OutboxDispatcher(store, disabledPort);
    expect(await disabled.dispatchOne()).toBe("disabled");
    expect(disabledPort.sent).toHaveLength(0);

    const states = await pool.query(
      `SELECT status, count(*)::integer AS count FROM outbox_events
       WHERE case_id = $1 GROUP BY status ORDER BY status`,
      [caseId],
    );
    expect(states.rows).toEqual([
      { status: "PENDING", count: 1 },
      { status: "ACCEPTED", count: 1 },
      { status: "UNCERTAIN", count: 1 },
    ]);
  });

  it("converges reordered batches, preserves status history, and stores media by reference", async () => {
    const personId = randomUUID();
    await pool.query(`INSERT INTO people (id, organization_id) VALUES ($1, $2)`, [
      personId,
      organizationId,
    ]);
    await pool.query(
      `INSERT INTO contact_points
        (organization_id, person_id, kind, value_ciphertext, fingerprint, source, purpose, provider, external_id)
       VALUES ($1, $2, 'WHATSAPP', 'synthetic-ciphertext', $3, 'synthetic', 'conversation', 'META', 'synthetic-sender')`,
      [organizationId, personId, `fingerprint-${personId}`],
    );
    await pool.query(
      `INSERT INTO case_participants (organization_id, case_id, person_id, role)
       VALUES ($1, $2, $3, 'REQUESTER')`,
      [organizationId, caseId, personId],
    );
    await pool.query(
      `INSERT INTO messages
        (organization_id, case_id, conversation_id, provider_connection_id, direction,
         provider_message_id, message_type, provider_occurred_at)
       VALUES ($1, $2, $3, $4, 'OUTBOUND', 'wamid.outbound', 'text', now())`,
      [organizationId, caseId, conversationId, connectionId],
    );
    const body = await readFile("tests/fixtures/messaging/meta-batch-out-of-order.json");
    const receipt = await store.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: "adversarial-batch",
      body,
    });
    const items = normalizeMetaWebhook(body);
    await Promise.all([
      store.reconcileInbox(receipt.inboxEventId, items),
      store.reconcileInbox(receipt.inboxEventId, [...items].reverse()),
    ]);

    const result = await pool.query(
      `SELECT
         (SELECT count(*)::integer FROM messages WHERE provider_connection_id = $1 AND direction = 'INBOUND') AS messages,
         (SELECT count(*)::integer FROM message_status_observations WHERE provider_connection_id = $1 AND provider_message_id = 'wamid.outbound') AS observations,
         (SELECT count(*)::integer FROM media_references mr JOIN inbox_event_items i ON i.id = mr.inbox_item_id WHERE i.provider_connection_id = $1) AS media,
         (SELECT bool_and(restricted) FROM media_references mr JOIN inbox_event_items i ON i.id = mr.inbox_item_id WHERE i.provider_connection_id = $1) AS restricted`,
      [connectionId],
    );
    expect(result.rows[0]).toEqual({ messages: 2, observations: 3, media: 1, restricted: true });
    expect(await store.getEffectiveDeliveryStatus(connectionId, "wamid.outbound")).toBe("READ");
  });

  it("stops when association is ambiguous without choosing a default case", async () => {
    const secondCaseId = randomUUID();
    const secondConversationId = randomUUID();
    const person = await pool.query<{ person_id: string }>(
      `SELECT person_id FROM contact_points WHERE external_id = 'synthetic-sender'`,
    );
    const participantPersonId = person.rows[0]?.person_id;
    if (!participantPersonId) throw new Error("synthetic_person_unavailable");
    await pool.query(`INSERT INTO prospect_cases (id, organization_id) VALUES ($1, $2)`, [
      secondCaseId,
      organizationId,
    ]);
    await pool.query(
      `INSERT INTO case_participants (organization_id, case_id, person_id, role) VALUES ($1, $2, $3, 'REQUESTER')`,
      [organizationId, secondCaseId, participantPersonId],
    );
    await pool.query(
      `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id) VALUES ($1, $2, $3, $4)`,
      [secondConversationId, organizationId, secondCaseId, connectionId],
    );
    const body = new TextEncoder().encode(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: "synthetic-sender",
                      id: "wamid.ambiguous",
                      timestamp: "1789000010",
                      type: "text",
                      text: { body: "No elegir caso" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const receipt = await store.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: "ambiguous-batch",
      body,
    });
    await store.reconcileInbox(receipt.inboxEventId, normalizeMetaWebhook(body));
    const state = await pool.query(
      `SELECT i.status AS item_status, e.status AS inbox_status,
              i.reason_code, i.clarification_prompt,
              (SELECT count(*)::integer FROM messages WHERE provider_message_id = 'wamid.ambiguous') AS messages
       FROM inbox_event_items i JOIN inbox_events e ON e.id = i.inbox_event_id
       WHERE i.item_key = 'message:wamid.ambiguous'`,
    );
    expect(state.rows[0]).toEqual({
      item_status: "AMBIGUOUS",
      inbox_status: "NEEDS_ACTION",
      reason_code: "association_clarification_required",
      clarification_prompt: "¿Quieres continuar con un proyecto existente o iniciar uno nuevo?",
      messages: 0,
    });

    const replyBody = new TextEncoder().encode(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: "synthetic-sender",
                      id: "wamid.safe-continuation",
                      context: { id: "wamid.outbound" },
                      timestamp: "1789000011",
                      type: "text",
                      text: { body: "Continuemos" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const replyReceipt = await store.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: "safe-continuation-batch",
      body: replyBody,
    });
    await store.reconcileInbox(replyReceipt.inboxEventId, normalizeMetaWebhook(replyBody));
    const continued = await pool.query<{ case_id: string }>(
      `SELECT case_id FROM messages WHERE provider_message_id = 'wamid.safe-continuation'`,
    );
    expect(continued.rows[0]?.case_id).toBe(caseId);

    const newBody = new TextEncoder().encode(
      JSON.stringify({
        object: "whatsapp_business_account",
        entry: [
          {
            changes: [
              {
                value: {
                  messages: [
                    {
                      from: "synthetic-sender",
                      id: "wamid.explicit-new-project",
                      timestamp: "1789000012",
                      type: "text",
                      text: { body: "NUEVO PROYECTO" },
                    },
                  ],
                },
              },
            ],
          },
        ],
      }),
    );
    const newReceipt = await store.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: "explicit-new-project-batch",
      body: newBody,
    });
    await store.reconcileInbox(newReceipt.inboxEventId, normalizeMetaWebhook(newBody));
    const created = await pool.query<{ case_id: string; status: string; next_action: string }>(
      `SELECT m.case_id, pc.status, pc.next_action
       FROM messages m JOIN prospect_cases pc ON pc.id = m.case_id
       WHERE m.provider_message_id = 'wamid.explicit-new-project'`,
    );
    expect(created.rows[0]).toMatchObject({
      status: "AWAITING_CONSENT",
      next_action: "REQUEST_CONSENT",
    });
    expect(created.rows[0]?.case_id).not.toBe(caseId);
    expect(created.rows[0]?.case_id).not.toBe(secondCaseId);
    const audit = await pool.query<{ mode: string }>(
      `SELECT a.metadata ->> 'mode' AS mode FROM audit_events a
       JOIN inbox_event_items i ON i.id = a.resource_id
       WHERE i.provider_message_id IN ('wamid.safe-continuation', 'wamid.explicit-new-project')
       ORDER BY mode`,
    );
    expect(audit.rows).toEqual([{ mode: "NEW_CASE" }, { mode: "REPLY" }]);
  });
});
