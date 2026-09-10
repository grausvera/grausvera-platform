import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConversationInterventionStore, MessagingStore } from "../../packages/database/src";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const interventionStore = new ConversationInterventionStore(connectionString);
const messagingStore = new MessagingStore(connectionString);
let organizationId: string;
const caseId = randomUUID();
const personId = randomUUID();
const contactPointId = randomUUID();
const connectionId = randomUUID();
const conversationId = randomUUID();

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(
    `INSERT INTO prospect_cases (id, organization_id, status) VALUES ($1, $2, 'INTERVIEWING')`,
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
      `synthetic-intervention-${personId}`,
    ],
  );
  await pool.query(
    `INSERT INTO case_participants (organization_id, case_id, person_id, role)
     VALUES ($1, $2, $3, 'REQUESTER')`,
    [organizationId, caseId, personId],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/intervention')`,
    [connectionId, organizationId, `synthetic-intervention-${connectionId}`],
  );
  await pool.query(
    `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
});

afterAll(async () => {
  await interventionStore.close();
  await messagingStore.close();
  await pool.end();
});

async function inbound(text: string, suffix: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO messages
      (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, content_bytes, provider_occurred_at,
       sender_person_id, sender_contact_point_id)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', $7, now(), $8, $9)`,
    [
      id,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.intervention.${suffix}`,
      Buffer.from(text),
      personId,
      contactPointId,
    ],
  );
  return id;
}

async function outbox(status: "PENDING" | "DISPATCHING", suffix: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO outbox_events
      (id, organization_id, case_id, event_type, aggregate_type, aggregate_id,
       payload, idempotency_key, status, deadline_at, attempts, locked_at)
     VALUES ($1, $2, $3, 'whatsapp.interview.question.v1', 'message', $4,
       '{}', $5, $6::outbox_status, now() + interval '1 hour', $7,
       CASE WHEN $6::outbox_status = 'DISPATCHING' THEN now() ELSE NULL END)`,
    [
      id,
      organizationId,
      caseId,
      randomUUID(),
      `intervention-${caseId}-${suffix}`,
      status,
      status === "DISPATCHING" ? 1 : 0,
    ],
  );
  if (status === "DISPATCHING") {
    await pool.query(
      `INSERT INTO message_delivery_attempts (outbox_event_id, attempt_number) VALUES ($1, 1)`,
      [id],
    );
  }
  return id;
}

describe("deterministic conversation intervention", () => {
  it("records stop once, pauses the case, and cancels pending and claimed work", async () => {
    const sourceMessageId = await inbound("  quiero   detenerme ", "stop");
    const pendingId = await outbox("PENDING", "pending");
    const dispatchingId = await outbox("DISPATCHING", "dispatching");
    const input = { organizationId, caseId, sourceMessageId, correlationId: randomUUID() };

    expect(await interventionStore.record(input)).toEqual({
      created: true,
      kind: "STOP",
      cancelledOutbox: 2,
    });
    expect(await interventionStore.record({ ...input, correlationId: randomUUID() })).toEqual({
      created: false,
      kind: "STOP",
      cancelledOutbox: 0,
    });

    const state = await pool.query(
      `SELECT pc.status, pc.next_action,
              (SELECT count(*)::integer FROM conversation_interventions WHERE source_message_id = $2) AS interventions,
              (SELECT count(*)::integer FROM audit_events WHERE resource_type = 'conversation_intervention' AND case_id = $1) AS audits,
              (SELECT count(*)::integer FROM outbox_events WHERE id IN ($3, $4) AND status = 'CANCELLED') AS cancelled,
              (SELECT count(*)::integer FROM message_delivery_attempts WHERE outbox_event_id = $4
                AND completed_at IS NOT NULL AND error_code = 'prospect_stopped') AS closed_attempts
       FROM prospect_cases pc WHERE pc.id = $1`,
      [caseId, sourceMessageId, pendingId, dispatchingId],
    );
    expect(state.rows[0]).toEqual({
      status: "PAUSED",
      next_action: "STOP_REQUESTED",
      interventions: 1,
      audits: 1,
      cancelled: 2,
      closed_attempts: 1,
    });
  });

  it("rejects a dispatch claimed after pause before the provider effect", async () => {
    const claimedId = await outbox("DISPATCHING", "race");
    expect(
      await messagingStore.authorizeDispatch({
        id: claimedId,
        organizationId,
        caseId,
        eventType: "whatsapp.interview.question.v1",
        payload: {},
        idempotencyKey: `${caseId}-race`,
        attemptNumber: 1,
        deadlineAt: new Date(Date.now() + 60_000),
      }),
    ).toBe(false);
    const result = await pool.query(
      `SELECT o.status, a.completed_at IS NOT NULL AS completed, a.error_code
       FROM outbox_events o JOIN message_delivery_attempts a ON a.outbox_event_id = o.id
       WHERE o.id = $1`,
      [claimedId],
    );
    expect(result.rows[0]).toEqual({
      status: "CANCELLED",
      completed: true,
      error_code: "dispatch_cancelled",
    });
  });

  it("records a human request as a distinct paused next action", async () => {
    await pool.query(
      `UPDATE prospect_cases SET status = 'INTERVIEWING', next_action = 'ASK_QUESTION' WHERE id = $1`,
      [caseId],
    );
    const sourceMessageId = await inbound("quiero hablar con una persona", "human");
    expect(
      await interventionStore.record({
        organizationId,
        caseId,
        sourceMessageId,
        correlationId: randomUUID(),
      }),
    ).toMatchObject({ created: true, kind: "HUMAN_REQUEST" });
    const state = await pool.query(`SELECT status, next_action FROM prospect_cases WHERE id = $1`, [
      caseId,
    ]);
    expect(state.rows[0]).toEqual({ status: "PAUSED", next_action: "HUMAN_REQUESTED" });
  });

  it("applies a recognized stop atomically while reconciling inbound messaging", async () => {
    await pool.query(
      `UPDATE prospect_cases SET status = 'INTERVIEWING', next_action = 'ASK_QUESTION' WHERE id = $1`,
      [caseId],
    );
    const pendingId = await outbox("PENDING", "automatic");
    const body = new TextEncoder().encode('{"synthetic":"automatic-stop"}');
    const receipt = await messagingStore.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: `automatic-stop-${caseId}`,
      body,
    });
    await messagingStore.reconcileInbox(receipt.inboxEventId, [
      {
        itemKey: `message:automatic-stop-${caseId}`,
        kind: "MESSAGE",
        providerMessageId: `wamid.intervention.automatic.${caseId}`,
        senderExternalId: `synthetic-intervention-${personId}`,
        messageType: "text",
        textContent: "PARAR",
        providerOccurredAt: new Date(),
        receivedOrdinal: 0,
      },
    ]);

    const state = await pool.query(
      `SELECT pc.status, pc.next_action, o.status AS outbox_status,
              (SELECT count(*)::integer FROM conversation_interventions ci
               JOIN messages m ON m.id = ci.source_message_id
               WHERE m.provider_message_id = $3) AS interventions
       FROM prospect_cases pc JOIN outbox_events o ON o.id = $2 WHERE pc.id = $1`,
      [caseId, pendingId, `wamid.intervention.automatic.${caseId}`],
    );
    expect(state.rows[0]).toEqual({
      status: "PAUSED",
      next_action: "STOP_REQUESTED",
      outbox_status: "CANCELLED",
      interventions: 1,
    });
  });
});
