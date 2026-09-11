import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { SealedEmailSecret } from "./email-outbox.js";
import type { ObjectPort } from "./object-storage.js";

export interface EmailDestinationSealer {
  sealDestination(to: string): SealedEmailSecret;
}

export interface ClaimedBriefDelivery {
  deliveryId: string;
  organizationId: string;
  caseId: string;
  approvalId: string;
  briefRevisionId: string;
  contactPointId: string;
  representationReference: string;
  representationHash: string;
  snapshotHash: string;
  secretReference: string;
  ciphertext: Uint8Array;
  initializationVector: Uint8Array;
  authenticationTag: Uint8Array;
  keyReference: string;
  idempotencyKey: string;
  deadlineAt: Date;
}

export class BriefDeliveryService {
  readonly #pool: Pool;

  constructor(
    connectionString: string,
    private readonly objects: ObjectPort,
  ) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close() {
    return this.#pool.end();
  }

  async prepare(input: {
    organizationId: string;
    caseId: string;
    approvalId: string;
    briefRevisionId: string;
    contactPointId: string;
    destination: string;
    idempotencyKey: string;
    sealer: EmailDestinationSealer;
    now?: Date;
  }): Promise<{ deliveryId: string; outboxEventId: string; replayed: boolean }> {
    if (!/^\S+@\S+\.\S+$/.test(input.destination)) throw new Error("invalid_email_destination");
    const existing = await this.#existing(input.organizationId, input.idempotencyKey);
    if (existing) return { ...existing, replayed: true };
    const approved = await this.#approvedSnapshot(input);
    const deliveryId = randomUUID();
    const outboxEventId = randomUUID();
    const secretReference = randomUUID();
    const representation = Buffer.from(
      JSON.stringify(
        {
          schemaVersion: 1,
          briefRevisionId: input.briefRevisionId,
          snapshotHash: approved.snapshotHash,
          brief: approved.snapshot,
        },
        null,
        2,
      ),
    );
    const representationHash = createHash("sha256").update(representation).digest("hex");
    const objectKey = `brief-deliveries/${input.organizationId}/${input.caseId}/${input.briefRevisionId}-${representationHash}.json`;
    const sealed = input.sealer.sealDestination(input.destination);
    const now = input.now ?? new Date();
    const deadlineAt = new Date(now.getTime() + 23 * 60 * 60 * 1000);
    const deduplicationExpiresAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    await this.objects.put(objectKey, representation, "application/json");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await this.#approvedSnapshot(input, client, true);
      if (locked.snapshotHash !== approved.snapshotHash)
        throw new Error("brief_delivery_authority_changed");
      await client.query(
        `INSERT INTO outbox_events
          (id,organization_id,case_id,event_type,aggregate_type,aggregate_id,payload,
           idempotency_key,deadline_at)
         VALUES ($1,$2,$3,'email.transactional.send.v1','email_delivery',$4,$5,$6,$7)`,
        [
          outboxEventId,
          input.organizationId,
          input.caseId,
          deliveryId,
          JSON.stringify({
            purpose: "BRIEF_DELIVERY",
            organizationId: input.organizationId,
            caseId: input.caseId,
            approvalId: input.approvalId,
            briefRevisionId: input.briefRevisionId,
            contactPointId: input.contactPointId,
            representationReference: objectKey,
            representationHash,
            templateId: "brief-delivery",
            templateVersion: 1,
            idempotencyKey: input.idempotencyKey,
            deadlineAt: deadlineAt.toISOString(),
          }),
          input.idempotencyKey,
          deadlineAt,
        ],
      );
      await client.query(
        `INSERT INTO email_deliveries
          (id,organization_id,case_id,brief_id,revision_id,approval_id,contact_point_id,
           outbox_event_id,deadline_at,deduplication_expires_at,representation_object_key,
           representation_hash,representation_content_type,representation_byte_size)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'application/json',$13)`,
        [
          deliveryId,
          input.organizationId,
          input.caseId,
          approved.briefId,
          input.briefRevisionId,
          input.approvalId,
          input.contactPointId,
          outboxEventId,
          deadlineAt,
          deduplicationExpiresAt,
          objectKey,
          representationHash,
          representation.byteLength,
        ],
      );
      await client.query(
        `INSERT INTO email_delivery_outbox_secrets
          (id,delivery_id,ciphertext,initialization_vector,authentication_tag,key_reference)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          secretReference,
          deliveryId,
          Buffer.from(sealed.ciphertext),
          Buffer.from(sealed.initializationVector),
          Buffer.from(sealed.authenticationTag),
          sealed.keyReference,
        ],
      );
      await client.query("COMMIT");
      return { deliveryId, outboxEventId, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      await this.objects.remove(objectKey);
      if ((error as { code?: string }).code === "23505") {
        const replay = await this.#existing(input.organizationId, input.idempotencyKey);
        if (replay) return { ...replay, replayed: true };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async nextPreparedId(): Promise<string | undefined> {
    return this.#pool
      .query<{ id: string }>(
        `SELECT d.id FROM email_deliveries d JOIN outbox_events o ON o.id=d.outbox_event_id
         WHERE d.status='PENDING' AND o.status='PENDING' AND o.available_at<=now()
         ORDER BY o.created_at LIMIT 1`,
      )
      .then((result) => result.rows[0]?.id);
  }

  async loadClaimed(deliveryId: string): Promise<ClaimedBriefDelivery | undefined> {
    return this.#pool
      .query<ClaimedBriefDelivery>(
        `SELECT d.id "deliveryId",d.organization_id "organizationId",d.case_id "caseId",
           d.approval_id "approvalId",d.revision_id "briefRevisionId",
           d.contact_point_id "contactPointId",d.representation_object_key "representationReference",
           d.representation_hash "representationHash",r.snapshot_hash "snapshotHash",
           s.id "secretReference",s.ciphertext,
           s.initialization_vector "initializationVector",s.authentication_tag "authenticationTag",
           s.key_reference "keyReference",o.idempotency_key "idempotencyKey",d.deadline_at "deadlineAt"
         FROM email_deliveries d JOIN outbox_events o ON o.id=d.outbox_event_id
         JOIN brief_revisions r ON r.id=d.revision_id AND r.organization_id=d.organization_id
         JOIN email_delivery_outbox_secrets s ON s.delivery_id=d.id
         WHERE d.id=$1 AND o.status='DISPATCHING' AND s.destroyed_at IS NULL`,
        [deliveryId],
      )
      .then((result) => result.rows[0]);
  }

  async authorize(item: ClaimedBriefDelivery): Promise<boolean> {
    const result = await this.#pool.query(
      `SELECT 1 FROM email_deliveries d
       JOIN brief_approvals a ON a.id=d.approval_id AND a.organization_id=d.organization_id
       JOIN brief_revisions r ON r.id=d.revision_id AND r.organization_id=d.organization_id
       JOIN contact_points cp ON cp.id=d.contact_point_id AND cp.organization_id=d.organization_id
       WHERE d.id=$1 AND d.organization_id=$2 AND d.case_id=$3 AND d.status='PENDING'
         AND a.status='ACTIVE' AND (a.expires_at IS NULL OR a.expires_at>now())
         AND r.status='APPROVED' AND r.is_candidate AND r.snapshot_hash=a.snapshot_hash
         AND cp.kind='EMAIL' AND cp.verified_at IS NOT NULL AND cp.delivery_blocked_at IS NULL`,
      [item.deliveryId, item.organizationId, item.caseId],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async destroySecret(deliveryId: string): Promise<void> {
    await this.#pool.query(
      `UPDATE email_delivery_outbox_secrets SET ciphertext=NULL,initialization_vector=NULL,
         authentication_tag=NULL,destroyed_at=now() WHERE delivery_id=$1 AND destroyed_at IS NULL`,
      [deliveryId],
    );
  }

  async #approvedSnapshot(
    input: {
      organizationId: string;
      caseId: string;
      approvalId: string;
      briefRevisionId: string;
      contactPointId: string;
    },
    client: Pool | PoolClient = this.#pool,
    lock = false,
  ) {
    const row = await client
      .query<{ brief_id: string; snapshot: unknown; snapshot_hash: string }>(
        `SELECT r.brief_id,r.snapshot,r.snapshot_hash FROM brief_approvals a
         JOIN brief_revisions r ON r.organization_id=a.organization_id AND r.case_id=a.case_id
           AND r.brief_id=a.brief_id AND r.id=a.revision_id
         JOIN contact_points cp ON cp.organization_id=a.organization_id AND cp.id=$5
         JOIN case_participants p ON p.organization_id=cp.organization_id
           AND p.person_id=cp.person_id AND p.case_id=a.case_id
         WHERE a.organization_id=$1 AND a.case_id=$2 AND a.id=$3 AND a.revision_id=$4
           AND a.status='ACTIVE' AND (a.expires_at IS NULL OR a.expires_at>now())
           AND r.status='APPROVED' AND r.is_candidate AND r.snapshot_hash=a.snapshot_hash
           AND cp.kind='EMAIL' AND cp.verified_at IS NOT NULL AND cp.delivery_blocked_at IS NULL
         ${lock ? "FOR UPDATE OF a,r,cp" : ""}`,
        [
          input.organizationId,
          input.caseId,
          input.approvalId,
          input.briefRevisionId,
          input.contactPointId,
        ],
      )
      .then((result) => result.rows[0]);
    if (!row) throw new Error("brief_delivery_not_authorized");
    return { briefId: row.brief_id, snapshot: row.snapshot, snapshotHash: row.snapshot_hash };
  }

  async #existing(organizationId: string, idempotencyKey: string) {
    return this.#pool
      .query<{ deliveryId: string; outboxEventId: string }>(
        `SELECT aggregate_id "deliveryId",id "outboxEventId" FROM outbox_events
         WHERE organization_id=$1 AND idempotency_key=$2 AND aggregate_type='email_delivery'`,
        [organizationId, idempotencyKey],
      )
      .then((result) => result.rows[0]);
  }
}
