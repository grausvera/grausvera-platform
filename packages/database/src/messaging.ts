import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

export interface InboxReceipt {
  created: boolean;
  inboxEventId: string;
}

export interface OutboxMessage {
  id: string;
  organizationId: string;
  caseId: string;
  eventType: string;
  payload: unknown;
  idempotencyKey: string;
  attemptNumber: number;
  deadlineAt: Date;
}

export type DeliveryResult =
  | { kind: "accepted"; externalId: string }
  | { kind: "rejected"; errorCode: string; retryable: boolean }
  | { kind: "uncertain"; errorCode: string };

export interface InboundItem {
  itemKey: string;
  kind: "MESSAGE" | "STATUS" | "UNSUPPORTED";
  providerMessageId?: string;
  senderExternalId?: string;
  replyToProviderMessageId?: string;
  messageType?: string;
  textContent?: string;
  providerOccurredAt: Date;
  receivedOrdinal: number;
  deliveryStatus?: "SENT" | "DELIVERED" | "READ" | "FAILED" | "DELETED";
  media?: {
    providerMediaId: string;
    mediaType: string;
    mimeType?: string;
    filename?: string;
    sha256?: string;
  };
}

export interface ClaimedInbox {
  id: string;
  body: Uint8Array;
}

export class MessagingStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async persistInbox(input: {
    providerConnectionId: string;
    externalEventId: string;
    body: Uint8Array;
  }): Promise<InboxReceipt> {
    const id = randomUUID();
    const hash = createHash("sha256").update(input.body).digest("hex");
    const result = await this.#pool.query<{ id: string }>(
      `INSERT INTO inbox_events
        (id, organization_id, provider_connection_id, external_event_id, payload_bytes, payload_hash)
       SELECT $1, organization_id, id, $2, $3, $4
       FROM provider_connections WHERE id = $5 AND kind = 'WHATSAPP'
       ON CONFLICT (provider_connection_id, external_event_id) DO NOTHING
       RETURNING id`,
      [id, input.externalEventId, Buffer.from(input.body), hash, input.providerConnectionId],
    );
    if ((result.rowCount ?? 0) > 0)
      return { created: true, inboxEventId: result.rows[0]?.id ?? id };

    const existing = await this.#pool.query<{ id: string }>(
      `SELECT id FROM inbox_events WHERE provider_connection_id = $1 AND external_event_id = $2`,
      [input.providerConnectionId, input.externalEventId],
    );
    const inboxEventId = existing.rows[0]?.id;
    if (!inboxEventId) throw new Error("provider_connection_unavailable");
    return { created: false, inboxEventId };
  }

  async reconcileInbox(inboxEventId: string, items: InboundItem[]): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const receipt = await client.query<{
        organization_id: string;
        provider_connection_id: string;
      }>(
        `SELECT organization_id, provider_connection_id FROM inbox_events WHERE id = $1 FOR UPDATE`,
        [inboxEventId],
      );
      const context = receipt.rows[0];
      if (!context) throw new Error("inbox_event_unavailable");

      for (const item of [...items].sort(
        (a, b) =>
          a.providerOccurredAt.getTime() - b.providerOccurredAt.getTime() ||
          a.receivedOrdinal - b.receivedOrdinal,
      )) {
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO inbox_event_items
            (inbox_event_id, organization_id, provider_connection_id, item_key, kind,
             provider_message_id, sender_external_id, reply_to_provider_message_id, message_type,
             text_content, provider_occurred_at, received_ordinal)
           VALUES ($1, $2, $3, $4, $5::inbox_item_kind, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (provider_connection_id, item_key) DO NOTHING RETURNING id`,
          [
            inboxEventId,
            context.organization_id,
            context.provider_connection_id,
            item.itemKey,
            item.kind,
            item.providerMessageId,
            item.senderExternalId,
            item.replyToProviderMessageId,
            item.messageType,
            item.textContent,
            item.providerOccurredAt,
            item.receivedOrdinal,
          ],
        );
        let itemId = inserted.rows[0]?.id;
        if (!itemId) {
          const existing = await client.query<{ id: string; status: string }>(
            `SELECT id, status FROM inbox_event_items
             WHERE provider_connection_id = $1 AND item_key = $2`,
            [context.provider_connection_id, item.itemKey],
          );
          itemId = existing.rows[0]?.id;
          if (!itemId || existing.rows[0]?.status === "PROCESSED") continue;
        }

        if (item.media) {
          await client.query(
            `INSERT INTO media_references
              (inbox_item_id, provider_media_id, media_type, mime_type, filename, sha256)
             VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (inbox_item_id) DO NOTHING`,
            [
              itemId,
              item.media.providerMediaId,
              item.media.mediaType,
              item.media.mimeType,
              item.media.filename,
              item.media.sha256,
            ],
          );
        }

        if (item.kind === "STATUS" && item.providerMessageId && item.deliveryStatus) {
          await client.query(
            `INSERT INTO message_status_observations
              (organization_id, provider_connection_id, provider_message_id, status,
               provider_occurred_at, inbox_item_id)
             VALUES ($1, $2, $3, $4::provider_delivery_status, $5, $6)
             ON CONFLICT (provider_connection_id, provider_message_id, status, provider_occurred_at)
             DO NOTHING`,
            [
              context.organization_id,
              context.provider_connection_id,
              item.providerMessageId,
              item.deliveryStatus,
              item.providerOccurredAt,
              itemId,
            ],
          );
          await client.query(`UPDATE inbox_event_items SET status = 'PROCESSED' WHERE id = $1`, [
            itemId,
          ]);
          continue;
        }
        if (item.kind === "UNSUPPORTED" || !item.providerMessageId || !item.senderExternalId) {
          await client.query(
            `UPDATE inbox_event_items SET status = 'PROCESSED', reason_code = 'unsupported_preserved'
             WHERE id = $1`,
            [itemId],
          );
          continue;
        }

        const candidates = await client.query<{
          case_id: string;
          conversation_id: string;
          person_id: string;
          contact_point_id: string;
        }>(
          `SELECT DISTINCT c.case_id, c.id AS conversation_id, cp.person_id, cp.id AS contact_point_id
           FROM contact_points cp
           JOIN case_participants p ON p.organization_id = cp.organization_id AND p.person_id = cp.person_id
           JOIN conversations c ON c.organization_id = p.organization_id AND c.case_id = p.case_id
           WHERE cp.organization_id = $1 AND cp.kind = 'WHATSAPP' AND cp.provider = 'META'
             AND cp.external_id = $2 AND c.provider_connection_id = $3`,
          [context.organization_id, item.senderExternalId, context.provider_connection_id],
        );
        if (candidates.rowCount !== 1) {
          await client.query(
            `UPDATE inbox_event_items SET status = $2::inbox_item_status,
               reason_code = $3 WHERE id = $1`,
            [
              itemId,
              candidates.rowCount === 0 ? "UNMATCHED" : "AMBIGUOUS",
              candidates.rowCount === 0 ? "association_missing" : "association_ambiguous",
            ],
          );
          continue;
        }
        const candidate = candidates.rows[0];
        if (!candidate) throw new Error("association_candidate_unavailable");
        const content = item.textContent ? Buffer.from(item.textContent) : null;
        await client.query(
          `INSERT INTO messages
            (organization_id, case_id, conversation_id, provider_connection_id, direction,
             provider_message_id, message_type, content_bytes, content_hash, provider_occurred_at,
             sender_person_id, sender_contact_point_id, reply_to_provider_message_id)
           VALUES ($1, $2, $3, $4, 'INBOUND', $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (provider_connection_id, provider_message_id) DO NOTHING`,
          [
            context.organization_id,
            candidate.case_id,
            candidate.conversation_id,
            context.provider_connection_id,
            item.providerMessageId,
            item.messageType ?? "unknown",
            content,
            content ? createHash("sha256").update(content).digest("hex") : null,
            item.providerOccurredAt,
            candidate.person_id,
            candidate.contact_point_id,
            item.replyToProviderMessageId,
          ],
        );
        await client.query(
          `UPDATE inbox_event_items SET status = 'PROCESSED', case_id = $2,
             conversation_id = $3, reason_code = NULL WHERE id = $1`,
          [itemId, candidate.case_id, candidate.conversation_id],
        );
      }
      const pending = await client.query<{ unresolved: number; ambiguous: number }>(
        `SELECT count(*) FILTER (WHERE status = 'UNMATCHED')::integer AS unresolved,
                count(*) FILTER (WHERE status = 'AMBIGUOUS')::integer AS ambiguous
         FROM inbox_event_items WHERE inbox_event_id = $1`,
        [inboxEventId],
      );
      const counts = pending.rows[0] ?? { unresolved: 0, ambiguous: 0 };
      await client.query(
        `UPDATE inbox_events SET status = $2::inbox_status, processed_at = CASE WHEN $2 = 'PROCESSED' THEN now() ELSE NULL END,
           attempts = attempts + 1, last_error_code = $3 WHERE id = $1`,
        [
          inboxEventId,
          counts.ambiguous > 0 ? "NEEDS_ACTION" : counts.unresolved > 0 ? "RECEIVED" : "PROCESSED",
          counts.ambiguous > 0
            ? "association_ambiguous"
            : counts.unresolved > 0
              ? "association_missing"
              : null,
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

  async claimNextInbox(): Promise<ClaimedInbox | undefined> {
    const result = await this.#pool.query<{ id: string; payload_bytes: Buffer }>(
      `WITH candidate AS (
         SELECT id FROM inbox_events WHERE status = 'RECEIVED'
         ORDER BY received_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE inbox_events i SET status = 'PROCESSING', attempts = attempts + 1
       FROM candidate WHERE i.id = candidate.id RETURNING i.id, i.payload_bytes`,
    );
    const item = result.rows[0];
    return item ? { id: item.id, body: item.payload_bytes } : undefined;
  }

  async releaseInboxAfterFailure(inboxEventId: string, errorCode: string): Promise<void> {
    await this.#pool.query(
      `UPDATE inbox_events SET status = 'RECEIVED', last_error_code = $2
       WHERE id = $1 AND status = 'PROCESSING'`,
      [inboxEventId, errorCode],
    );
  }

  async releaseAbandonedInbox(): Promise<number> {
    const result = await this.#pool.query(
      `UPDATE inbox_events SET status = 'RECEIVED', last_error_code = 'worker_interrupted'
       WHERE status = 'PROCESSING'`,
    );
    return result.rowCount ?? 0;
  }

  async getEffectiveDeliveryStatus(
    providerConnectionId: string,
    providerMessageId: string,
  ): Promise<string | undefined> {
    const result = await this.#pool.query<{ status: string }>(
      `SELECT status FROM message_status_observations
       WHERE provider_connection_id = $1 AND provider_message_id = $2
       ORDER BY CASE status WHEN 'READ' THEN 30 WHEN 'DELIVERED' THEN 20 WHEN 'SENT' THEN 10 ELSE 0 END DESC,
                provider_occurred_at DESC LIMIT 1`,
      [providerConnectionId, providerMessageId],
    );
    return result.rows[0]?.status;
  }

  async createOutboundIntent(input: {
    organizationId: string;
    caseId: string;
    conversationId: string;
    providerConnectionId: string;
    providerMessageId: string;
    messageType: string;
    content: Uint8Array;
    eventType: string;
    payload: unknown;
    idempotencyKey: string;
    deadlineAt: Date;
    correlationId: string;
  }): Promise<{ messageId: string; outboxEventId: string }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const messageId = randomUUID();
      const outboxEventId = randomUUID();
      await client.query(
        `INSERT INTO messages
          (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
           provider_message_id, message_type, content_bytes, content_hash, provider_occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'OUTBOUND', $6, $7, $8, $9, now())`,
        [
          messageId,
          input.organizationId,
          input.caseId,
          input.conversationId,
          input.providerConnectionId,
          input.providerMessageId,
          input.messageType,
          Buffer.from(input.content),
          createHash("sha256").update(input.content).digest("hex"),
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id, organization_id, case_id, event_type, aggregate_type, aggregate_id, payload,
           idempotency_key, deadline_at)
         VALUES ($1, $2, $3, $4, 'message', $5, $6, $7, $8)`,
        [
          outboxEventId,
          input.organizationId,
          input.caseId,
          input.eventType,
          messageId,
          JSON.stringify(input.payload),
          input.idempotencyKey,
          input.deadlineAt,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (organization_id, case_id, actor, action, resource_type, resource_id, expected_version,
           result, correlation_id, origin)
         VALUES ($1, $2, 'system', 'message.queued', 'message', $3, 1, 'SUCCEEDED', $4, 'messaging-store')`,
        [input.organizationId, input.caseId, messageId, input.correlationId],
      );
      await client.query("COMMIT");
      return { messageId, outboxEventId };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.#pool.query<{ id: string; aggregate_id: string }>(
          `SELECT id, aggregate_id FROM outbox_events
           WHERE organization_id = $1 AND idempotency_key = $2`,
          [input.organizationId, input.idempotencyKey],
        );
        const event = existing.rows[0];
        if (event) return { messageId: event.aggregate_id, outboxEventId: event.id };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async claimNext(): Promise<OutboxMessage | undefined> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE outbox_events SET status = 'NEEDS_ACTION', last_error_code = 'deadline_expired',
           updated_at = now() WHERE status = 'PENDING' AND deadline_at <= now()`,
      );
      const result = await client.query<
        OutboxMessage & { attempt_number: number; deadline_at: Date }
      >(
        `WITH candidate AS (
           SELECT id FROM outbox_events
           WHERE status = 'PENDING' AND available_at <= now() AND deadline_at > now()
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE outbox_events o SET status = 'DISPATCHING', locked_at = now(),
           attempts = attempts + 1, updated_at = now()
         FROM candidate WHERE o.id = candidate.id
         RETURNING o.id, o.organization_id AS "organizationId", o.case_id AS "caseId",
           o.event_type AS "eventType", o.payload, o.idempotency_key AS "idempotencyKey",
           o.attempts AS "attemptNumber", o.deadline_at AS "deadlineAt"`,
      );
      const item = result.rows[0];
      if (item) {
        await client.query(
          `INSERT INTO message_delivery_attempts (outbox_event_id, attempt_number) VALUES ($1, $2)`,
          [item.id, item.attemptNumber],
        );
      }
      await client.query("COMMIT");
      return item;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async markAbandonedDispatchesUncertain(lockedBefore: Date): Promise<number> {
    const result = await this.#pool.query(
      `UPDATE outbox_events SET status = 'UNCERTAIN', last_error_code = 'worker_interrupted',
         locked_at = null, updated_at = now()
       WHERE status = 'DISPATCHING' AND locked_at < $1`,
      [lockedBefore],
    );
    return result.rowCount ?? 0;
  }

  async finish(item: OutboxMessage, result: DeliveryResult): Promise<void> {
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
      await client.query(
        `UPDATE message_delivery_attempts SET completed_at = now(), outcome = $3,
           provider_external_id = $4, error_code = $5
         WHERE outbox_event_id = $1 AND attempt_number = $2`,
        [item.id, item.attemptNumber, outcome, externalId, errorCode],
      );
      await client.query(
        `UPDATE outbox_events SET status = $2::outbox_status, provider_external_id = $3,
           last_error_code = $4, locked_at = null, updated_at = now(),
           available_at = CASE WHEN $2::outbox_status = 'PENDING' THEN now() + interval '30 seconds' ELSE available_at END
         WHERE id = $1 AND status = 'DISPATCHING'`,
        [item.id, status, externalId, errorCode],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
