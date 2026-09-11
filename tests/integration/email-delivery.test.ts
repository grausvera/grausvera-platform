import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AesGcmEmailSecretCodec,
  BriefDeliveryDispatcher,
  FakeEmailPort,
} from "../../apps/worker/src/email";
import {
  BRIEF_CONFIRMATION_TEXT,
  BriefDeliveryService,
  BriefReviewStore,
  ConfirmationStore,
  EmailDeliveryStore,
  type ObjectPort,
} from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const store = new EmailDeliveryStore(connectionString);
const confirmations = new ConfirmationStore(connectionString);
const reviews = new BriefReviewStore(connectionString);
let organizationId: string;
let userId: string;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id,slug,display_name) VALUES ($1,'grausvera','grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name=excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  userId = `email-delivery-${randomUUID()}`;
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,'reviewer',$2,true)`,
    [userId, `${userId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id,user_id) VALUES ($1,$2)`, [
    organizationId,
    userId,
  ]);
});

afterAll(async () => {
  await store.close();
  await confirmations.close();
  await reviews.close();
  await pool.end();
});

async function deliveryFixture(status: "PENDING" | "ACCEPTED" = "ACCEPTED") {
  const caseId = randomUUID();
  const personId = randomUUID();
  const contactPointId = randomUUID();
  const whatsappContactPointId = randomUUID();
  const participantId = randomUUID();
  const providerConnectionId = randomUUID();
  const conversationId = randomUUID();
  const briefId = randomUUID();
  const revisionId = randomUUID();
  const reviewId = randomUUID();
  const approvalId = randomUUID();
  const deliveryId = randomUUID();
  const outboxEventId = randomUUID();
  const representationReference = `brief-deliveries/${organizationId}/${caseId}/${revisionId}.json`;
  const representationHash = "a".repeat(64);
  await pool.query(
    `INSERT INTO prospect_cases (id,organization_id,status) VALUES ($1,$2,'ENGINEER_REVIEW')`,
    [caseId, organizationId],
  );
  await pool.query(`INSERT INTO people (id,organization_id) VALUES ($1,$2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO case_participants (id,organization_id,case_id,person_id,role) VALUES ($1,$2,$3,$4,'REQUESTER')`,
    [participantId, organizationId, caseId, personId],
  );
  await pool.query(
    `INSERT INTO contact_points
      (id,organization_id,person_id,kind,value_ciphertext,fingerprint,source,purpose,provider,external_id)
     VALUES ($1,$2,$3,'WHATSAPP','synthetic-ciphertext',$4,'TEST','CONFIRMATION','META',$5)`,
    [whatsappContactPointId, organizationId, personId, randomUUID(), `wa-${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id,organization_id,kind,external_account_id,credential_reference)
     VALUES ($1,$2,'WHATSAPP',$3,'synthetic-reference')`,
    [providerConnectionId, organizationId, `account-${randomUUID()}`],
  );
  await pool.query(
    `INSERT INTO conversations (id,organization_id,case_id,provider_connection_id)
     VALUES ($1,$2,$3,$4)`,
    [conversationId, organizationId, caseId, providerConnectionId],
  );
  await pool.query(
    `INSERT INTO operator_case_assignments (organization_id,case_id,user_id) VALUES ($1,$2,$3)`,
    [organizationId, caseId, userId],
  );
  await pool.query(
    `INSERT INTO contact_points
      (id,organization_id,person_id,kind,value_ciphertext,fingerprint,source,purpose,verified_at)
     VALUES ($1,$2,$3,'EMAIL','synthetic-ciphertext',$4,'TEST','BRIEF_DELIVERY',now())`,
    [contactPointId, organizationId, personId, randomUUID()],
  );
  await pool.query(`INSERT INTO briefs (id,organization_id,case_id) VALUES ($1,$2,$3)`, [
    briefId,
    organizationId,
    caseId,
  ]);
  const snapshot = JSON.stringify({ problem: "Synthetic approved brief" });
  await pool.query(
    `INSERT INTO brief_revisions
      (id,organization_id,case_id,brief_id,revision_number,status,snapshot,snapshot_hash,
       knowledge_version,template_id,template_version,policy_version,creator,created_by_user_id,reason)
     VALUES ($1,$2,$3,$4,1,'IN_REVIEW',$5::jsonb,encode(digest($5::jsonb::text,'sha256'),'hex'),
       1,'discovery-brief',1,1,'HUMAN',$6,'Delivery fixture')`,
    [revisionId, organizationId, caseId, briefId, snapshot, userId],
  );
  await pool.query(
    `INSERT INTO brief_reviews
      (id,organization_id,case_id,brief_id,revision_id,reviewer_user_id,status,decided_at)
     VALUES ($1,$2,$3,$4,$5,$6,'APPROVED',now())`,
    [reviewId, organizationId, caseId, briefId, revisionId, userId],
  );
  const snapshotHash = await pool
    .query<{ snapshot_hash: string }>(`SELECT snapshot_hash FROM brief_revisions WHERE id=$1`, [
      revisionId,
    ])
    .then((result) => result.rows[0]?.snapshot_hash ?? "");
  await pool.query(
    `INSERT INTO brief_approvals
      (id,organization_id,case_id,brief_id,revision_id,review_id,snapshot_hash,
       approved_by_user_id,authentication_method,authenticated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PASSWORD_TOTP',now())`,
    [approvalId, organizationId, caseId, briefId, revisionId, reviewId, snapshotHash, userId],
  );
  await pool.query(`UPDATE brief_revisions SET status='APPROVED' WHERE id=$1`, [revisionId]);
  const deadline = new Date(Date.now() + 23 * 60 * 60 * 1000);
  const deduplicationExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
  await pool.query(
    `INSERT INTO outbox_events
      (id,organization_id,case_id,event_type,aggregate_type,aggregate_id,payload,idempotency_key,deadline_at)
     VALUES ($1,$2,$3,'email.transactional.send.v1','email_delivery',$4,$5,$6,$7)`,
    [
      outboxEventId,
      organizationId,
      caseId,
      deliveryId,
      JSON.stringify({
        purpose: "BRIEF_DELIVERY",
        approvalId,
        briefRevisionId: revisionId,
        contactPointId,
        representationReference,
      }),
      `delivery-${deliveryId}`,
      deadline,
    ],
  );
  await pool.query(
    `INSERT INTO email_deliveries
      (id,organization_id,case_id,brief_id,revision_id,approval_id,contact_point_id,
       outbox_event_id,deadline_at,deduplication_expires_at,status,provider_external_id,first_attempt_at,
       representation_object_key,representation_hash,representation_content_type,representation_byte_size)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::email_delivery_status,$12,
       CASE WHEN $11::text='ACCEPTED' THEN now() ELSE NULL END,$13,$14,'application/json',1)`,
    [
      deliveryId,
      organizationId,
      caseId,
      briefId,
      revisionId,
      approvalId,
      contactPointId,
      outboxEventId,
      deadline,
      deduplicationExpiry,
      status,
      `email-${deliveryId}`,
      representationReference,
      representationHash,
    ],
  );
  return {
    deliveryId,
    caseId,
    approvalId,
    revisionId,
    personId,
    participantId,
    contactPointId,
    whatsappContactPointId,
    providerConnectionId,
    conversationId,
    deadline,
    deduplicationExpiry,
    providerEmailId: `email-${deliveryId}`,
  };
}

function body(type: string, providerEmailId: string, occurredAt: Date) {
  return Buffer.from(
    JSON.stringify({
      type,
      created_at: occurredAt.toISOString(),
      data: { email_id: providerEmailId },
    }),
  );
}

describe("email delivery evidence", () => {
  it("persists webhook replay once and never lets an older event regress delivery", async () => {
    const item = await deliveryFixture();
    const deliveredAt = new Date("2026-09-10T20:02:00Z");
    const sentAt = new Date("2026-09-10T20:01:00Z");
    const replayId = `evt-${randomUUID()}`;
    const delivered = await store.persistWebhook({
      externalEventId: `evt-${randomUUID()}`,
      eventType: "email.delivered",
      providerEmailId: item.providerEmailId,
      providerOccurredAt: deliveredAt,
      body: body("email.delivered", item.providerEmailId, deliveredAt),
    });
    await expect(
      store.persistWebhook({
        externalEventId: replayId,
        eventType: "email.sent",
        providerEmailId: item.providerEmailId,
        providerOccurredAt: sentAt,
        body: body("email.sent", item.providerEmailId, sentAt),
      }),
    ).resolves.toMatchObject({ created: true });
    await expect(
      store.persistWebhook({
        externalEventId: replayId,
        eventType: "email.sent",
        providerEmailId: item.providerEmailId,
        providerOccurredAt: sentAt,
        body: body("email.sent", item.providerEmailId, sentAt),
      }),
    ).resolves.toMatchObject({ created: false });
    const state = await pool.query<{ status: string; observations: number }>(
      `SELECT d.status,(SELECT count(*)::integer FROM email_delivery_observations o WHERE o.delivery_id=d.id) observations FROM email_deliveries d WHERE d.id=$1`,
      [item.deliveryId],
    );
    expect(delivered.created).toBe(true);
    expect(state.rows[0]).toEqual({ status: "DELIVERED", observations: 2 });
  });

  it("suppresses a bounced contact and preserves the original deduplication deadline", async () => {
    const item = await deliveryFixture();
    const bouncedAt = new Date("2026-09-10T21:00:00Z");
    await store.persistWebhook({
      externalEventId: `evt-${randomUUID()}`,
      eventType: "email.bounced",
      providerEmailId: item.providerEmailId,
      providerOccurredAt: bouncedAt,
      body: body("email.bounced", item.providerEmailId, bouncedAt),
    });
    const state = await pool.query<{
      status: string;
      delivery_block_reason: string;
      deadline_at: Date;
    }>(
      `SELECT d.status,cp.delivery_block_reason,d.deadline_at FROM email_deliveries d JOIN contact_points cp ON cp.id=d.contact_point_id WHERE d.id=$1`,
      [item.deliveryId],
    );
    expect(state.rows[0]).toMatchObject({
      status: "BOUNCED",
      delivery_block_reason: "bounced",
      deadline_at: item.deadline,
    });
    await expect(
      pool.query(
        `UPDATE email_deliveries SET deadline_at=deadline_at+interval '1 hour' WHERE id=$1`,
        [item.deliveryId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps timeout uncertain and refuses another attempt after the original window", async () => {
    const item = await deliveryFixture("PENDING");
    const started = await store.startAttempt(item.deliveryId);
    expect(started).toMatchObject({ attemptNumber: 1 });
    await store.finishAttempt(item.deliveryId, 1, {
      kind: "uncertain",
      errorCode: "resend_response_unknown",
    });
    expect(
      await store.expireUnreconciled(new Date(item.deduplicationExpiry.getTime() + 1)),
    ).toBeGreaterThanOrEqual(1);
    await expect(
      store.startAttempt(item.deliveryId, new Date(item.deduplicationExpiry.getTime() + 2)),
    ).resolves.toBeUndefined();
    const state = await pool.query<{ status: string; deadline_at: Date; attempts: number }>(
      `SELECT d.status,d.deadline_at,o.attempts FROM email_deliveries d
       JOIN outbox_events o ON o.id=d.outbox_event_id WHERE d.id=$1`,
      [item.deliveryId],
    );
    expect(state.rows[0]).toEqual({
      status: "NEEDS_ACTION",
      deadline_at: item.deadline,
      attempts: 1,
    });
  });
});

describe("approved brief representation and dispatch", () => {
  it("stores and sends the exact approved representation without treating acceptance as delivery", async () => {
    const fixture = await deliveryFixture();
    const values = new Map<string, Uint8Array>();
    const objects: ObjectPort = {
      async put(key, bytes) {
        if (values.has(key)) throw new Error("object_exists");
        values.set(key, bytes);
      },
      async get(key) {
        const value = values.get(key);
        if (!value) throw new Error("object_missing");
        return value;
      },
      async remove(key) {
        values.delete(key);
      },
    };
    const service = new BriefDeliveryService(connectionString, objects);
    const codec = new AesGcmEmailSecretCodec(Buffer.alloc(32, 6), "delivery-test-key");
    const idempotencyKey = `approved-delivery-${randomUUID()}`;
    try {
      const prepared = await service.prepare({
        organizationId,
        caseId: fixture.caseId,
        approvalId: fixture.approvalId,
        briefRevisionId: fixture.revisionId,
        contactPointId: fixture.contactPointId,
        destination: "approved-recipient@example.invalid",
        idempotencyKey,
        sealer: codec,
      });
      await expect(
        service.prepare({
          organizationId,
          caseId: fixture.caseId,
          approvalId: fixture.approvalId,
          briefRevisionId: fixture.revisionId,
          contactPointId: fixture.contactPointId,
          destination: "approved-recipient@example.invalid",
          idempotencyKey,
          sealer: codec,
        }),
      ).resolves.toEqual({ ...prepared, replayed: true });
      const acceptedId = `email-approved-${randomUUID()}`;
      const port = new FakeEmailPort([{ kind: "accepted", externalId: acceptedId }]);
      const dispatcher = new BriefDeliveryDispatcher(service, store, objects, port, codec);
      dispatcher.setEnabled(true);
      await expect(dispatcher.dispatchOne()).resolves.toEqual({
        kind: "accepted",
        externalId: acceptedId,
      });
      expect(port.sent).toHaveLength(1);
      expect(port.sent[0]?.text).toContain("Synthetic approved brief");
      const state = await pool.query<{
        status: string;
        representation_hash: string;
        provider_external_id: string;
        destroyed_at: Date | null;
      }>(
        `SELECT d.status,d.representation_hash,d.provider_external_id,s.destroyed_at
         FROM email_deliveries d JOIN email_delivery_outbox_secrets s ON s.delivery_id=d.id
         WHERE d.id=$1`,
        [prepared.deliveryId],
      );
      expect(state.rows[0]).toMatchObject({
        status: "ACCEPTED",
        provider_external_id: acceptedId,
      });
      expect(state.rows[0]?.representation_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(state.rows[0]?.destroyed_at).toBeInstanceOf(Date);
      await expect(
        pool.query(`UPDATE email_deliveries SET representation_hash=$2 WHERE id=$1`, [
          prepared.deliveryId,
          "b".repeat(64),
        ]),
      ).rejects.toMatchObject({ code: "55000" });
    } finally {
      await service.close();
    }
  });

  it("cancels before the provider call when the exact approval is no longer active", async () => {
    const fixture = await deliveryFixture();
    const values = new Map<string, Uint8Array>();
    const objects: ObjectPort = {
      async put(key, bytes) {
        values.set(key, bytes);
      },
      async get(key) {
        const value = values.get(key);
        if (!value) throw new Error("object_missing");
        return value;
      },
      async remove(key) {
        values.delete(key);
      },
    };
    const service = new BriefDeliveryService(connectionString, objects);
    const codec = new AesGcmEmailSecretCodec(Buffer.alloc(32, 8), "delivery-test-key");
    try {
      const prepared = await service.prepare({
        organizationId,
        caseId: fixture.caseId,
        approvalId: fixture.approvalId,
        briefRevisionId: fixture.revisionId,
        contactPointId: fixture.contactPointId,
        destination: "approved-recipient@example.invalid",
        idempotencyKey: `revoked-delivery-${randomUUID()}`,
        sealer: codec,
      });
      await pool.query(`UPDATE brief_approvals SET status='REVOKED',revoked_at=now() WHERE id=$1`, [
        fixture.approvalId,
      ]);
      const port = new FakeEmailPort();
      const dispatcher = new BriefDeliveryDispatcher(service, store, objects, port, codec);
      dispatcher.setEnabled(true);
      await expect(dispatcher.dispatchOne()).resolves.toBe("cancelled");
      expect(port.sent).toHaveLength(0);
      const state = await pool.query<{ status: string; destroyed_at: Date | null }>(
        `SELECT d.status,s.destroyed_at FROM email_deliveries d
         JOIN email_delivery_outbox_secrets s ON s.delivery_id=d.id WHERE d.id=$1`,
        [prepared.deliveryId],
      );
      expect(state.rows[0]?.status).toBe("NEEDS_ACTION");
      expect(state.rows[0]?.destroyed_at).toBeInstanceOf(Date);
    } finally {
      await service.close();
    }
  });
});

describe("exact prospect confirmation", () => {
  const principal = () => ({
    userId,
    organizationId,
    twoFactorVerified: true,
    authenticatedAt: new Date(),
  });

  async function requested() {
    const fixture = await deliveryFixture();
    await pool.query(`UPDATE email_deliveries SET status='DELIVERED' WHERE id=$1`, [
      fixture.deliveryId,
    ]);
    const designation = await confirmations.designate(principal(), {
      caseId: fixture.caseId,
      participantId: fixture.participantId,
      contactPointId: fixture.whatsappContactPointId,
      reason: "Designated requester for synthetic confirmation",
    });
    const request = await confirmations.request(principal(), {
      caseId: fixture.caseId,
      deliveryId: fixture.deliveryId,
      idempotencyKey: `confirmation-request-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const outboundProviderId = `wamid-request-${randomUUID()}`;
    await pool.query(
      `UPDATE outbox_events SET status='ACCEPTED',provider_external_id=$2 WHERE id=$1`,
      [request.outboxEventId, outboundProviderId],
    );
    return { ...fixture, ...designation, ...request, outboundProviderId };
  }

  async function response(
    item: Awaited<ReturnType<typeof requested>>,
    text: string,
    replyTo = item.outboundProviderId,
    sender = { personId: item.personId, contactPointId: item.whatsappContactPointId },
  ) {
    const sourceMessageId = randomUUID();
    const bytes = Buffer.from(text);
    await pool.query(
      `INSERT INTO messages
        (id,organization_id,case_id,conversation_id,provider_connection_id,direction,
         provider_message_id,message_type,content_bytes,content_hash,provider_occurred_at,
         sender_person_id,sender_contact_point_id,reply_to_provider_message_id)
       VALUES ($1,$2,$3,$4,$5,'INBOUND',$6,'text',$7,
         encode(digest($7::bytea,'sha256'),'hex'),now(),$8,$9,$10)`,
      [
        sourceMessageId,
        organizationId,
        item.caseId,
        item.conversationId,
        item.providerConnectionId,
        `wamid-response-${randomUUID()}`,
        bytes,
        sender.personId,
        sender.contactPointId,
        replyTo,
      ],
    );
    return sourceMessageId;
  }

  it("qualifies once only for CONFIRMO from the designated contact replying to the exact request", async () => {
    const item = await requested();
    const sourceMessageId = await response(item, "  confirmo  ");
    const result = await confirmations.confirm({
      organizationId,
      caseId: item.caseId,
      requestId: item.requestId,
      sourceMessageId,
      occurredAt: new Date(),
    });
    await expect(
      confirmations.confirm({
        organizationId,
        caseId: item.caseId,
        requestId: item.requestId,
        sourceMessageId,
        occurredAt: new Date(),
      }),
    ).resolves.toEqual({ ...result, replayed: true });
    const state = await pool.query<{
      case_status: string;
      request_status: string;
      confirmations: number;
    }>(
      `SELECT pc.status case_status,q.status request_status,
         (SELECT count(*)::integer FROM confirmations c WHERE c.request_id=q.id) confirmations
       FROM prospect_cases pc JOIN confirmation_requests q ON q.case_id=pc.id WHERE q.id=$1`,
      [item.requestId],
    );
    expect(state.rows[0]).toEqual({
      case_status: "QUALIFIED",
      request_status: "CONSUMED",
      confirmations: 1,
    });
    expect(BRIEF_CONFIRMATION_TEXT).toContain("constituye un contrato");
  });

  it("rejects ambiguous or unquoted replies and revokes a request when correction creates a revision", async () => {
    const ambiguous = await requested();
    const yesMessage = await response(ambiguous, "sí");
    await expect(
      confirmations.confirm({
        organizationId,
        caseId: ambiguous.caseId,
        requestId: ambiguous.requestId,
        sourceMessageId: yesMessage,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow("brief_confirmation_not_accepted");
    const unquoted = await response(ambiguous, "CONFIRMO", "wamid-other");
    await expect(
      confirmations.confirm({
        organizationId,
        caseId: ambiguous.caseId,
        requestId: ambiguous.requestId,
        sourceMessageId: unquoted,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow("brief_confirmation_not_accepted");
    await reviews.edit(principal(), {
      revisionId: ambiguous.revisionId,
      snapshot: { problem: "Synthetic corrected brief" },
      reason: "Prospect requested a correction",
      correlationId: randomUUID(),
    });
    const status = await pool
      .query<{ status: string }>(`SELECT status FROM confirmation_requests WHERE id=$1`, [
        ambiguous.requestId,
      ])
      .then((result) => result.rows[0]?.status);
    expect(status).toBe("REVOKED");
    const obsolete = await response(ambiguous, "CONFIRMO");
    await expect(
      confirmations.confirm({
        organizationId,
        caseId: ambiguous.caseId,
        requestId: ambiguous.requestId,
        sourceMessageId: obsolete,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow("brief_confirmation_not_accepted");
  });

  it("rejects the exact words from another contact or after request expiry", async () => {
    const item = await requested();
    const otherPersonId = randomUUID();
    const otherContactId = randomUUID();
    await pool.query(`INSERT INTO people (id,organization_id) VALUES ($1,$2)`, [
      otherPersonId,
      organizationId,
    ]);
    await pool.query(
      `INSERT INTO case_participants (organization_id,case_id,person_id,role)
       VALUES ($1,$2,$3,'COLLABORATOR')`,
      [organizationId, item.caseId, otherPersonId],
    );
    await pool.query(
      `INSERT INTO contact_points
        (id,organization_id,person_id,kind,value_ciphertext,fingerprint,source,purpose,provider,external_id)
       VALUES ($1,$2,$3,'WHATSAPP','synthetic-ciphertext',$4,'TEST','CONFIRMATION','META',$5)`,
      [otherContactId, organizationId, otherPersonId, randomUUID(), `wa-${randomUUID()}`],
    );
    const foreign = await response(item, "CONFIRMO", item.outboundProviderId, {
      personId: otherPersonId,
      contactPointId: otherContactId,
    });
    await expect(
      confirmations.confirm({
        organizationId,
        caseId: item.caseId,
        requestId: item.requestId,
        sourceMessageId: foreign,
        occurredAt: new Date(),
      }),
    ).rejects.toThrow("brief_confirmation_not_accepted");
    const expired = await response(item, "CONFIRMO");
    await expect(
      confirmations.confirm({
        organizationId,
        caseId: item.caseId,
        requestId: item.requestId,
        sourceMessageId: expired,
        occurredAt: new Date(Date.now() + 120_000),
      }),
    ).rejects.toThrow("brief_confirmation_not_accepted");
  });
});
