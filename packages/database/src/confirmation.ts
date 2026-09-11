import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { OperatorPrincipal } from "./operator-console.js";

export const BRIEF_CONFIRMATION_TEXT =
  "El brief fue enviado a tu correo. Si representa tu necesidad y deseas continuar, responde CONFIRMO directamente a este mensaje. Esto no acepta un precio ni constituye un contrato.";

export function normalizeBriefConfirmation(text: string): "CONFIRMO" | undefined {
  return text.trim().replace(/\s+/g, " ").toLocaleUpperCase("es") === "CONFIRMO"
    ? "CONFIRMO"
    : undefined;
}

export class ConfirmationStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close() {
    return this.#pool.end();
  }

  async designate(
    principal: OperatorPrincipal,
    input: { caseId: string; participantId: string; contactPointId: string; reason: string },
  ): Promise<{ designationId: string }> {
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) throw new Error("confirmer_reason_invalid");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#authorize(client, principal, input.caseId);
      const participant = await client
        .query<{ person_id: string }>(
          `SELECT p.person_id FROM case_participants p JOIN contact_points cp
             ON cp.organization_id=p.organization_id AND cp.person_id=p.person_id
           WHERE p.id=$3 AND p.organization_id=$1 AND p.case_id=$2
             AND p.role IN ('REQUESTER','DECISION_MAKER') AND cp.id=$4 AND cp.kind='WHATSAPP'
           FOR UPDATE OF p,cp`,
          [principal.organizationId, input.caseId, input.participantId, input.contactPointId],
        )
        .then((result) => result.rows[0]);
      if (!participant) throw new Error("confirmer_not_eligible");
      const prior = await client.query<{ id: string }>(
        `UPDATE case_confirmer_designations SET status='REVOKED',revoked_at=now()
         WHERE organization_id=$1 AND case_id=$2 AND status='ACTIVE' RETURNING id`,
        [principal.organizationId, input.caseId],
      );
      if (prior.rows.length > 0) {
        await client.query(
          `UPDATE confirmation_requests SET status='REVOKED',revoked_at=now(),updated_at=now()
           WHERE organization_id=$1 AND case_id=$2 AND status='PENDING'`,
          [principal.organizationId, input.caseId],
        );
        await client.query(
          `UPDATE outbox_events SET status='CANCELLED',last_error_code='confirmer_changed',updated_at=now()
           WHERE id IN (SELECT outbox_event_id FROM confirmation_requests
             WHERE organization_id=$1 AND case_id=$2 AND status='REVOKED')
             AND status IN ('PENDING','DISPATCHING')`,
          [principal.organizationId, input.caseId],
        );
      }
      const designationId = randomUUID();
      await client.query(
        `INSERT INTO case_confirmer_designations
          (id,organization_id,case_id,participant_id,person_id,contact_point_id,
           designated_by_user_id,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          designationId,
          principal.organizationId,
          input.caseId,
          input.participantId,
          participant.person_id,
          input.contactPointId,
          principal.userId,
          reason,
        ],
      );
      await this.#audit(client, principal, input.caseId, "confirmer.designated", designationId);
      await client.query("COMMIT");
      return { designationId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async request(
    principal: OperatorPrincipal,
    input: { caseId: string; deliveryId: string; idempotencyKey: string; expiresAt: Date },
  ): Promise<{ requestId: string; messageId: string; outboxEventId: string; replayed: boolean }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#authorize(client, principal, input.caseId);
      const replay = await client
        .query<{ request_id: string; request_message_id: string; outbox_event_id: string }>(
          `SELECT r.id request_id,r.request_message_id,r.outbox_event_id FROM confirmation_requests r
           JOIN outbox_events o ON o.id=r.outbox_event_id
           WHERE r.organization_id=$1 AND o.idempotency_key=$2`,
          [principal.organizationId, input.idempotencyKey],
        )
        .then((result) => result.rows[0]);
      if (replay) {
        await client.query("COMMIT");
        return {
          requestId: replay.request_id,
          messageId: replay.request_message_id,
          outboxEventId: replay.outbox_event_id,
          replayed: true,
        };
      }
      const context = await client
        .query<{
          designation_id: string;
          participant_id: string;
          person_id: string;
          contact_point_id: string;
          external_id: string;
          approval_id: string;
          revision_id: string;
          conversation_id: string;
          provider_connection_id: string;
        }>(
          `SELECT d.id designation_id,d.participant_id,d.person_id,d.contact_point_id,
             cp.external_id,e.approval_id,e.revision_id,c.id conversation_id,
             c.provider_connection_id
           FROM case_confirmer_designations d
           JOIN contact_points cp ON cp.organization_id=d.organization_id
             AND cp.id=d.contact_point_id AND cp.kind='WHATSAPP'
           JOIN email_deliveries e ON e.organization_id=d.organization_id
             AND e.case_id=d.case_id AND e.id=$3 AND e.status='DELIVERED'
           JOIN brief_approvals a ON a.organization_id=e.organization_id AND a.id=e.approval_id
             AND a.status='ACTIVE' AND (a.expires_at IS NULL OR a.expires_at>now())
           JOIN brief_revisions r ON r.organization_id=e.organization_id AND r.id=e.revision_id
             AND r.status='APPROVED' AND r.is_candidate AND r.snapshot_hash=a.snapshot_hash
           JOIN conversations c ON c.organization_id=d.organization_id AND c.case_id=d.case_id
             AND c.channel='WHATSAPP'
           WHERE d.organization_id=$1 AND d.case_id=$2 AND d.status='ACTIVE'
             AND cp.provider='META' AND cp.external_id IS NOT NULL
           ORDER BY c.updated_at DESC LIMIT 1 FOR UPDATE OF d,e,a,r,cp`,
          [principal.organizationId, input.caseId, input.deliveryId],
        )
        .then((result) => result.rows[0]);
      if (!context || input.expiresAt <= new Date())
        throw new Error("confirmation_request_invalid");
      await client.query(
        `UPDATE confirmation_requests SET status='REVOKED',revoked_at=now(),updated_at=now()
         WHERE organization_id=$1 AND case_id=$2 AND status='PENDING'`,
        [principal.organizationId, input.caseId],
      );
      await client.query(
        `UPDATE outbox_events SET status='CANCELLED',last_error_code='confirmation_replaced',updated_at=now()
         WHERE id IN (SELECT outbox_event_id FROM confirmation_requests
           WHERE organization_id=$1 AND case_id=$2 AND status='REVOKED')
           AND status IN ('PENDING','DISPATCHING')`,
        [principal.organizationId, input.caseId],
      );
      const requestId = randomUUID();
      const messageId = randomUUID();
      const outboxEventId = randomUUID();
      await client.query(
        `INSERT INTO messages
          (id,organization_id,case_id,conversation_id,provider_connection_id,direction,
           provider_message_id,message_type,content_bytes,content_hash,provider_occurred_at)
         VALUES ($1,$2,$3,$4,$5,'OUTBOUND',$6,'text',$7,
           encode(digest($7::bytea,'sha256'),'hex'),now())`,
        [
          messageId,
          principal.organizationId,
          input.caseId,
          context.conversation_id,
          context.provider_connection_id,
          `pending:${messageId}`,
          Buffer.from(BRIEF_CONFIRMATION_TEXT),
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id,organization_id,case_id,event_type,aggregate_type,aggregate_id,payload,
           idempotency_key,deadline_at,authorized_operator_user_id)
         VALUES ($1,$2,$3,'whatsapp.confirmation.request.v1','confirmation_request',$4,$5,$6,$7,$8)`,
        [
          outboxEventId,
          principal.organizationId,
          input.caseId,
          requestId,
          JSON.stringify({
            messaging_product: "whatsapp",
            to: context.external_id,
            type: "text",
            text: { body: BRIEF_CONFIRMATION_TEXT },
          }),
          input.idempotencyKey,
          input.expiresAt,
          principal.userId,
        ],
      );
      await client.query(
        `INSERT INTO confirmation_requests
          (id,organization_id,case_id,designation_id,participant_id,person_id,contact_point_id,
           approval_id,revision_id,delivery_id,request_message_id,outbox_event_id,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          requestId,
          principal.organizationId,
          input.caseId,
          context.designation_id,
          context.participant_id,
          context.person_id,
          context.contact_point_id,
          context.approval_id,
          context.revision_id,
          input.deliveryId,
          messageId,
          outboxEventId,
          input.expiresAt,
        ],
      );
      await client.query(
        `UPDATE prospect_cases SET status='PROSPECT_CONFIRMATION',next_action='AWAIT_CONFIRMATION',
           version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [principal.organizationId, input.caseId],
      );
      await this.#audit(client, principal, input.caseId, "confirmation.requested", requestId);
      await client.query("COMMIT");
      return { requestId, messageId, outboxEventId, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async confirm(input: {
    organizationId: string;
    caseId: string;
    requestId: string;
    sourceMessageId: string;
    occurredAt: Date;
  }): Promise<{ confirmationId: string; replayed: boolean }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const replay = await client
        .query<{ id: string }>(`SELECT id FROM confirmations WHERE source_message_id=$1`, [
          input.sourceMessageId,
        ])
        .then((result) => result.rows[0]);
      if (replay) {
        await client.query("COMMIT");
        return { confirmationId: replay.id, replayed: true };
      }
      const context = await client
        .query<{
          participant_id: string;
          person_id: string;
          contact_point_id: string;
          revision_id: string;
          delivery_id: string;
          expires_at: Date;
          provider_external_id: string;
          reply_to_provider_message_id: string | null;
          content_bytes: Buffer | null;
        }>(
          `SELECT q.participant_id,q.person_id,q.contact_point_id,q.revision_id,q.delivery_id,
             q.expires_at,o.provider_external_id,m.reply_to_provider_message_id,m.content_bytes
           FROM confirmation_requests q
           JOIN case_confirmer_designations d ON d.id=q.designation_id AND d.status='ACTIVE'
           JOIN email_deliveries e ON e.id=q.delivery_id AND e.status='DELIVERED'
           JOIN brief_approvals a ON a.id=q.approval_id AND a.status='ACTIVE'
             AND (a.expires_at IS NULL OR a.expires_at>$5)
           JOIN brief_revisions r ON r.id=q.revision_id AND r.status='APPROVED'
             AND r.is_candidate AND r.snapshot_hash=a.snapshot_hash
           JOIN outbox_events o ON o.id=q.outbox_event_id AND o.provider_external_id IS NOT NULL
           JOIN messages m ON m.organization_id=q.organization_id AND m.case_id=q.case_id
             AND m.id=$4 AND m.direction='INBOUND' AND m.message_type='text'
             AND m.sender_person_id=q.person_id AND m.sender_contact_point_id=q.contact_point_id
           JOIN prospect_cases pc ON pc.organization_id=q.organization_id AND pc.id=q.case_id
             AND pc.status='PROSPECT_CONFIRMATION'
             AND coalesce(pc.next_action,'') NOT IN ('STOP_REQUESTED','HUMAN_REQUESTED')
           WHERE q.organization_id=$1 AND q.case_id=$2 AND q.id=$3 AND q.status='PENDING'
           FOR UPDATE OF q,d,e,a,r,pc`,
          [
            input.organizationId,
            input.caseId,
            input.requestId,
            input.sourceMessageId,
            input.occurredAt,
          ],
        )
        .then((result) => result.rows[0]);
      if (
        !context?.content_bytes ||
        context.expires_at <= input.occurredAt ||
        context.reply_to_provider_message_id !== context.provider_external_id ||
        !normalizeBriefConfirmation(context.content_bytes.toString("utf8"))
      ) {
        throw new Error("brief_confirmation_not_accepted");
      }
      const confirmationId = randomUUID();
      await client.query(
        `INSERT INTO confirmations
          (id,organization_id,case_id,request_id,participant_id,person_id,contact_point_id,
           revision_id,delivery_id,source_message_id,idempotency_key,occurred_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          confirmationId,
          input.organizationId,
          input.caseId,
          input.requestId,
          context.participant_id,
          context.person_id,
          context.contact_point_id,
          context.revision_id,
          context.delivery_id,
          input.sourceMessageId,
          `confirmation:${input.requestId}:${input.sourceMessageId}`,
          input.occurredAt,
        ],
      );
      await client.query(
        `UPDATE confirmation_requests SET status='CONSUMED',consumed_at=$2,updated_at=$2 WHERE id=$1`,
        [input.requestId, input.occurredAt],
      );
      await client.query(
        `UPDATE prospect_cases SET status='QUALIFIED',next_action='HUMAN_FOLLOW_UP',
           version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [input.organizationId, input.caseId],
      );
      await client.query(
        `INSERT INTO audit_events
          (organization_id,case_id,actor,action,resource_type,resource_id,result,correlation_id,origin)
         VALUES ($1,$2,'prospect','brief.confirmed','confirmation',$3,'SUCCEEDED',$4,'confirmation-store')`,
        [input.organizationId, input.caseId, confirmationId, input.sourceMessageId],
      );
      await client.query("COMMIT");
      return { confirmationId, replayed: false };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #authorize(client: PoolClient, principal: OperatorPrincipal, caseId: string) {
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const result = await client.query(
      `SELECT 1 FROM operator_memberships m JOIN operator_case_assignments a
         ON a.organization_id=m.organization_id AND a.user_id=m.user_id AND a.active
       WHERE m.organization_id=$1 AND m.user_id=$2 AND m.role='ENGINEER' AND m.active
         AND a.case_id=$3`,
      [principal.organizationId, principal.userId, caseId],
    );
    if ((result.rowCount ?? 0) !== 1) throw new Error("confirmation_not_authorized");
  }

  async #audit(
    client: PoolClient,
    principal: OperatorPrincipal,
    caseId: string,
    action: string,
    resourceId: string,
  ) {
    await client.query(
      `INSERT INTO audit_events
        (organization_id,case_id,actor,action,resource_type,resource_id,
         result,correlation_id,origin)
       VALUES ($1,$2,$3,$4,'confirmation',$5,'SUCCEEDED',$5,'confirmation-store')`,
      [principal.organizationId, caseId, `operator:${principal.userId}`, action, resourceId],
    );
  }
}
