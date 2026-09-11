import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import type { EmailDeliveryResult } from "./email-outbox.js";

export const RESEND_EVENT_TYPES = [
  "email.sent",
  "email.delivered",
  "email.delivery_delayed",
  "email.bounced",
  "email.failed",
  "email.complained",
  "email.opened",
  "email.clicked",
] as const;

export interface ResendWebhookProjection {
  eventType: (typeof RESEND_EVENT_TYPES)[number];
  providerEmailId: string;
  providerOccurredAt: Date;
}

export class EmailDeliveryStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close() {
    return this.#pool.end();
  }

  async persistWebhook(
    input: ResendWebhookProjection & { externalEventId: string; body: Uint8Array },
  ) {
    const id = randomUUID();
    const inserted = await this.#pool.query<{ id: string }>(
      `INSERT INTO email_webhook_events
        (id,external_event_id,event_type,provider_email_id,provider_occurred_at,payload_bytes,payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (external_event_id) DO NOTHING RETURNING id`,
      [
        id,
        input.externalEventId,
        input.eventType,
        input.providerEmailId,
        input.providerOccurredAt,
        Buffer.from(input.body),
        createHash("sha256").update(input.body).digest("hex"),
      ],
    );
    const webhookEventId = inserted.rows[0]?.id;
    if (webhookEventId) {
      await this.reconcileWebhook(webhookEventId);
      return { created: true, webhookEventId };
    }
    const existing = await this.#pool
      .query<{ id: string }>(`SELECT id FROM email_webhook_events WHERE external_event_id=$1`, [
        input.externalEventId,
      ])
      .then((result) => result.rows[0]);
    if (!existing) throw new Error("email_webhook_not_persisted");
    return { created: false, webhookEventId: existing.id };
  }

  async reconcileWebhook(webhookEventId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const event = await client
        .query<{
          id: string;
          event_type: string;
          provider_email_id: string | null;
          provider_occurred_at: Date;
          status: string;
        }>(`SELECT * FROM email_webhook_events WHERE id=$1 FOR UPDATE`, [webhookEventId])
        .then((result) => result.rows[0]);
      if (!event || event.status === "PROCESSED" || event.status === "IGNORED") {
        await client.query("COMMIT");
        return;
      }
      const projected = projectStatus(event.event_type);
      if (!projected) {
        await client.query(
          `UPDATE email_webhook_events SET status='IGNORED',processed_at=now() WHERE id=$1`,
          [event.id],
        );
        await client.query("COMMIT");
        return;
      }
      const delivery = await client
        .query<{
          id: string;
          status: string;
          contact_point_id: string;
          last_provider_occurred_at: Date | null;
        }>(`SELECT * FROM email_deliveries WHERE provider_external_id=$1 FOR UPDATE`, [
          event.provider_email_id,
        ])
        .then((result) => result.rows[0]);
      if (!delivery) {
        await client.query(`UPDATE email_webhook_events SET status='UNMATCHED' WHERE id=$1`, [
          event.id,
        ]);
        await client.query("COMMIT");
        return;
      }
      await client.query(
        `INSERT INTO email_delivery_observations
          (delivery_id,webhook_event_id,status,provider_occurred_at)
         VALUES ($1,$2,$3,$4) ON CONFLICT (webhook_event_id) DO NOTHING`,
        [delivery.id, event.id, projected, event.provider_occurred_at],
      );
      if (
        (!delivery.last_provider_occurred_at ||
          event.provider_occurred_at >= delivery.last_provider_occurred_at) &&
        allowsTransition(delivery.status, projected)
      ) {
        await client.query(
          `UPDATE email_deliveries SET status=$2::email_delivery_status,last_provider_occurred_at=$3,
             failure_code=CASE WHEN $2::text IN ('BOUNCED','FAILED','COMPLAINED') THEN lower($2::text) ELSE failure_code END,
             updated_at=now() WHERE id=$1`,
          [delivery.id, projected, event.provider_occurred_at],
        );
      }
      if (projected === "BOUNCED" || projected === "COMPLAINED") {
        await client.query(
          `UPDATE contact_points SET delivery_blocked_at=COALESCE(delivery_blocked_at,now()),
             delivery_block_reason=$2,version=version+1,updated_at=now() WHERE id=$1`,
          [delivery.contact_point_id, projected.toLowerCase()],
        );
      }
      await client.query(
        `UPDATE email_webhook_events SET status='PROCESSED',delivery_id=$2,processed_at=now()
         WHERE id=$1`,
        [event.id, delivery.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reconcileUnmatched(): Promise<number> {
    const pending = await this.#pool.query<{ id: string }>(
      `SELECT id FROM email_webhook_events WHERE status='UNMATCHED' ORDER BY received_at LIMIT 100`,
    );
    for (const event of pending.rows) await this.reconcileWebhook(event.id);
    return pending.rows.length;
  }

  async startAttempt(deliveryId: string, now = new Date()) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = await client
        .query<{
          id: string;
          status: string;
          deadline_at: Date;
          deduplication_expires_at: Date;
          outbox_event_id: string;
          idempotency_key: string;
          attempts: number;
        }>(
          `SELECT d.id,d.status,d.deadline_at,d.deduplication_expires_at,d.outbox_event_id,
             o.idempotency_key,o.attempts FROM email_deliveries d
           JOIN outbox_events o ON o.id=d.outbox_event_id WHERE d.id=$1 FOR UPDATE OF d,o`,
          [deliveryId],
        )
        .then((result) => result.rows[0]);
      if (delivery?.status !== "PENDING") {
        await client.query("COMMIT");
        return undefined;
      }
      if (now >= delivery.deadline_at || now >= delivery.deduplication_expires_at) {
        await client.query(
          `UPDATE email_deliveries SET status='NEEDS_ACTION',failure_code='deduplication_window_expired',updated_at=$2 WHERE id=$1`,
          [delivery.id, now],
        );
        await client.query(
          `UPDATE outbox_events SET status='NEEDS_ACTION',last_error_code='deduplication_window_expired',updated_at=$2 WHERE id=$1`,
          [delivery.outbox_event_id, now],
        );
        await client.query(
          `UPDATE email_delivery_outbox_secrets SET ciphertext=NULL,initialization_vector=NULL,
             authentication_tag=NULL,destroyed_at=$2 WHERE delivery_id=$1 AND destroyed_at IS NULL`,
          [delivery.id, now],
        );
        await client.query("COMMIT");
        return undefined;
      }
      const attemptNumber = delivery.attempts + 1;
      await client.query(
        `INSERT INTO email_delivery_attempts (delivery_id,attempt_number,idempotency_key)
         VALUES ($1,$2,$3)`,
        [delivery.id, attemptNumber, delivery.idempotency_key],
      );
      await client.query(
        `UPDATE email_deliveries SET first_attempt_at=COALESCE(first_attempt_at,$2),updated_at=$2 WHERE id=$1`,
        [delivery.id, now],
      );
      await client.query(
        `UPDATE outbox_events SET status='DISPATCHING',attempts=$2,locked_at=$3,updated_at=$3 WHERE id=$1`,
        [delivery.outbox_event_id, attemptNumber, now],
      );
      await client.query("COMMIT");
      return { attemptNumber, idempotencyKey: delivery.idempotency_key };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async finishAttempt(
    deliveryId: string,
    attemptNumber: number,
    result: EmailDeliveryResult,
    now = new Date(),
  ): Promise<void> {
    const status =
      result.kind === "accepted"
        ? "ACCEPTED"
        : result.kind === "uncertain"
          ? "UNCERTAIN"
          : result.retryable
            ? "PENDING"
            : "NEEDS_ACTION";
    const outcome =
      result.kind === "accepted"
        ? "ACCEPTED"
        : result.kind === "uncertain"
          ? "UNCERTAIN"
          : result.retryable
            ? "REJECTED_TRANSIENT"
            : "REJECTED_PERMANENT";
    const externalId = result.kind === "accepted" ? result.externalId : null;
    const errorCode = result.kind === "accepted" ? null : result.errorCode;
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const delivery = await client
        .query<{ outbox_event_id: string; deadline_at: Date }>(
          `SELECT outbox_event_id,deadline_at FROM email_deliveries WHERE id=$1 FOR UPDATE`,
          [deliveryId],
        )
        .then((query) => query.rows[0]);
      if (!delivery) throw new Error("email_delivery_unavailable");
      const effectiveStatus =
        status === "PENDING" && now >= delivery.deadline_at ? "NEEDS_ACTION" : status;
      await client.query(
        `UPDATE email_delivery_attempts SET completed_at=$3,outcome=$4,
           provider_external_id=$5,error_code=$6
         WHERE delivery_id=$1 AND attempt_number=$2 AND completed_at IS NULL`,
        [deliveryId, attemptNumber, now, outcome, externalId, errorCode],
      );
      await client.query(
        `UPDATE email_deliveries SET status=$2::email_delivery_status,
           provider_external_id=COALESCE($3,provider_external_id),failure_code=$4,updated_at=$5 WHERE id=$1`,
        [deliveryId, effectiveStatus, externalId, errorCode, now],
      );
      await client.query(
        `UPDATE outbox_events SET status=$2::outbox_status,
           provider_external_id=COALESCE($3,provider_external_id),last_error_code=$4,
           locked_at=NULL,updated_at=$5 WHERE id=$1`,
        [
          delivery.outbox_event_id,
          effectiveStatus === "ACCEPTED"
            ? "ACCEPTED"
            : effectiveStatus === "PENDING"
              ? "PENDING"
              : effectiveStatus === "UNCERTAIN"
                ? "UNCERTAIN"
                : "NEEDS_ACTION",
          externalId,
          errorCode,
          now,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async expireUnreconciled(now = new Date()): Promise<number> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ outbox_event_id: string }>(
        `UPDATE email_deliveries SET status='NEEDS_ACTION',failure_code='deduplication_window_expired',updated_at=$1
         WHERE status IN ('PENDING','UNCERTAIN','DELAYED')
           AND (deadline_at<=$1 OR deduplication_expires_at<=$1) RETURNING outbox_event_id`,
        [now],
      );
      if (result.rows.length > 0) {
        await client.query(
          `UPDATE outbox_events SET status='NEEDS_ACTION',last_error_code='deduplication_window_expired',
             locked_at=NULL,updated_at=$2 WHERE id=ANY($1::uuid[])`,
          [result.rows.map((row) => row.outbox_event_id), now],
        );
        await client.query(
          `UPDATE email_delivery_outbox_secrets SET ciphertext=NULL,initialization_vector=NULL,
             authentication_tag=NULL,destroyed_at=$2
           WHERE delivery_id IN (SELECT id FROM email_deliveries WHERE outbox_event_id=ANY($1::uuid[]))
             AND destroyed_at IS NULL`,
          [result.rows.map((row) => row.outbox_event_id), now],
        );
      }
      await client.query("COMMIT");
      return result.rows.length;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

function projectStatus(eventType: string): string | undefined {
  return {
    "email.sent": "ACCEPTED",
    "email.delivered": "DELIVERED",
    "email.delivery_delayed": "DELAYED",
    "email.bounced": "BOUNCED",
    "email.failed": "FAILED",
    "email.complained": "COMPLAINED",
  }[eventType];
}

function allowsTransition(current: string, next: string): boolean {
  if (current === next) return true;
  if (["BOUNCED", "FAILED", "COMPLAINED", "CANCELLED"].includes(current)) return false;
  if (current === "DELIVERED") return next === "COMPLAINED";
  if (current === "DELAYED") return ["DELIVERED", "BOUNCED", "FAILED", "COMPLAINED"].includes(next);
  return ["ACCEPTED", "DELAYED", "DELIVERED", "BOUNCED", "FAILED", "COMPLAINED"].includes(next);
}
