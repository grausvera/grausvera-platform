import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";

export type ConsentPurpose = "DISCOVERY";
export type ConsentAction = "ACCEPTED" | "REJECTED" | "REVOKED";

export interface ConsentPolicyDefinition {
  id: string;
  purpose: ConsentPurpose;
  channel: "WHATSAPP";
  locale: string;
  scope: "PROJECT_DISCOVERY";
  version: number;
  noticeText: string;
  noticeHash: string;
  effectiveAt: Date;
  expiresAt?: Date;
}

export interface ConsentEvidence {
  purpose: ConsentPurpose;
  action: ConsentAction;
  policyId: string;
  policyVersion: number;
  noticeHash: string;
  channel: "WHATSAPP";
  locale: string;
  scope: "PROJECT_DISCOVERY";
  occurredAt: Date;
  validUntil?: Date;
}

export type ConsentDecision =
  | { allowed: true; evidence: ConsentEvidence }
  | {
      allowed: false;
      reason:
        | "POLICY_NOT_EFFECTIVE"
        | "POLICY_EXPIRED"
        | "EVIDENCE_MISSING"
        | "NOT_ACCEPTED"
        | "POLICY_MISMATCH"
        | "CONSENT_EXPIRED";
    };

export function hashConsentNotice(noticeText: string): string {
  return createHash("sha256").update(noticeText, "utf8").digest("hex");
}

export function evaluateDiscoveryConsent(input: {
  policy: ConsentPolicyDefinition;
  records: ConsentEvidence[];
  now: Date;
}): ConsentDecision {
  const { policy, records, now } = input;
  if (policy.effectiveAt > now) return { allowed: false, reason: "POLICY_NOT_EFFECTIVE" };
  if (policy.expiresAt && policy.expiresAt <= now)
    return { allowed: false, reason: "POLICY_EXPIRED" };

  const latest = [...records]
    .filter((record) => record.purpose === policy.purpose)
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime())[0];
  if (!latest) return { allowed: false, reason: "EVIDENCE_MISSING" };
  if (latest.action !== "ACCEPTED") return { allowed: false, reason: "NOT_ACCEPTED" };
  if (
    latest.policyId !== policy.id ||
    latest.policyVersion !== policy.version ||
    latest.noticeHash !== policy.noticeHash ||
    latest.channel !== policy.channel ||
    latest.locale !== policy.locale ||
    latest.scope !== policy.scope
  )
    return { allowed: false, reason: "POLICY_MISMATCH" };
  if (latest.validUntil && latest.validUntil <= now)
    return { allowed: false, reason: "CONSENT_EXPIRED" };
  return { allowed: true, evidence: latest };
}

export function renderConsentRequest(noticeText: string): string {
  return `Soy el asistente automatizado de grausvera.\n\n${noticeText.trim()}\n\nNo envíes contraseñas, secretos ni datos innecesariamente sensibles. Responde ACEPTO para continuar con la evaluación de tu proyecto. También puedes pedir ayuda humana o detenerte.`;
}

export function classifyConsentResponse(text: string): ConsentAction | undefined {
  const normalized = text.trim().replace(/\s+/g, " ").toLocaleUpperCase("es-PE");
  if (normalized === "ACEPTO") return "ACCEPTED";
  if (normalized === "NO ACEPTO") return "REJECTED";
  if (normalized === "REVOCO MI CONSENTIMIENTO") return "REVOKED";
  return undefined;
}

export interface ConsentRequestReceipt {
  created: boolean;
  requestId: string;
  messageId: string;
  outboxEventId: string;
}

export interface ConsentRecordReceipt {
  created: boolean;
  recordId: string;
  action: ConsentAction;
}

export class ConsentStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async requestDiscoveryConsent(input: {
    organizationId: string;
    caseId: string;
    personId: string;
    contactPointId: string;
    conversationId: string;
    providerConnectionId: string;
    policyId: string;
    sourceMessageId: string;
    correlationId: string;
    now?: Date;
  }): Promise<ConsentRequestReceipt> {
    const client = await this.#pool.connect();
    const now = input.now ?? new Date();
    try {
      await client.query("BEGIN");
      const resolved = await client.query<{
        notice_text: string;
        notice_hash: string;
        version: number;
        locale: string;
        scope: "PROJECT_DISCOVERY";
        recipient: string;
        source_provider_message_id: string;
        source_occurred_at: Date;
      }>(
        `SELECT p.notice_text, p.notice_hash, p.version, p.locale, p.scope,
                cp.external_id AS recipient, m.provider_message_id AS source_provider_message_id,
                m.provider_occurred_at AS source_occurred_at
         FROM prospect_cases pc
         JOIN case_participants participant ON participant.organization_id = pc.organization_id
           AND participant.case_id = pc.id AND participant.person_id = $3
         JOIN consent_policies p ON p.organization_id = pc.organization_id AND p.id = $7
         JOIN contact_points cp ON cp.organization_id = pc.organization_id
           AND cp.person_id = $3 AND cp.id = $4 AND cp.kind = 'WHATSAPP'
           AND cp.provider = 'META' AND cp.external_id IS NOT NULL
         JOIN conversations c ON c.organization_id = pc.organization_id AND c.case_id = pc.id
           AND c.id = $5 AND c.provider_connection_id = $6
         JOIN messages m ON m.organization_id = pc.organization_id AND m.case_id = pc.id
           AND m.id = $8 AND m.conversation_id = c.id AND m.direction = 'INBOUND'
         WHERE pc.organization_id = $1 AND pc.id = $2
           AND pc.status IN ('NEW', 'AWAITING_CONSENT')
           AND p.purpose = 'DISCOVERY' AND p.channel = 'WHATSAPP'
           AND p.effective_at <= $9 AND (p.expires_at IS NULL OR p.expires_at > $9)
         FOR UPDATE OF pc`,
        [
          input.organizationId,
          input.caseId,
          input.personId,
          input.contactPointId,
          input.conversationId,
          input.providerConnectionId,
          input.policyId,
          input.sourceMessageId,
          now,
        ],
      );
      const context = resolved.rows[0];
      if (!context) throw new Error("consent_request_precondition_failed");
      const serviceWindowEnds = new Date(
        context.source_occurred_at.getTime() + 24 * 60 * 60 * 1_000,
      );
      if (context.source_occurred_at > now || serviceWindowEnds <= now)
        throw new Error("whatsapp_service_window_closed");

      const requestId = randomUUID();
      const messageId = randomUUID();
      const outboxEventId = randomUUID();
      const idempotencyKey = `consent-request:${input.caseId}:${input.personId}:${input.policyId}`;
      const content = Buffer.from(renderConsentRequest(context.notice_text));
      const deadlineAt = new Date(
        Math.min(serviceWindowEnds.getTime(), now.getTime() + 10 * 60 * 1_000),
      );
      await client.query(
        `INSERT INTO messages
          (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
           provider_message_id, message_type, content_bytes, content_hash, provider_occurred_at)
         VALUES ($1, $2, $3, $4, $5, 'OUTBOUND', $6, 'text', $7, $8, $9)`,
        [
          messageId,
          input.organizationId,
          input.caseId,
          input.conversationId,
          input.providerConnectionId,
          `local-consent-${requestId}`,
          content,
          createHash("sha256").update(content).digest("hex"),
          now,
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id, organization_id, case_id, event_type, aggregate_type, aggregate_id, payload,
           idempotency_key, deadline_at)
         VALUES ($1, $2, $3, 'whatsapp.consent.request.v1', 'consent_request', $4, $5, $6, $7)`,
        [
          outboxEventId,
          input.organizationId,
          input.caseId,
          requestId,
          JSON.stringify({
            messaging_product: "whatsapp",
            recipient_type: "individual",
            to: context.recipient,
            type: "text",
            context: { message_id: context.source_provider_message_id },
            text: { preview_url: false, body: content.toString("utf8") },
          }),
          idempotencyKey,
          deadlineAt,
        ],
      );
      await client.query(
        `INSERT INTO consent_requests
          (id, organization_id, case_id, person_id, contact_point_id, policy_id, purpose,
           policy_version, notice_hash, channel, locale, scope, source_message_id,
           request_message_id, outbox_event_id, idempotency_key, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'DISCOVERY', $7, $8, 'WHATSAPP', $9, $10,
           $11, $12, $13, $14, $15)`,
        [
          requestId,
          input.organizationId,
          input.caseId,
          input.personId,
          input.contactPointId,
          input.policyId,
          context.version,
          context.notice_hash,
          context.locale,
          context.scope,
          input.sourceMessageId,
          messageId,
          outboxEventId,
          idempotencyKey,
          deadlineAt,
        ],
      );
      await client.query(
        `UPDATE prospect_cases SET status = 'AWAITING_CONSENT',
           next_action = 'AWAITING_CONSENT_RESPONSE', version = version + 1, updated_at = $3
         WHERE organization_id = $1 AND id = $2 AND status = 'NEW'`,
        [input.organizationId, input.caseId, now],
      );
      await client.query(
        `INSERT INTO audit_events
          (organization_id, case_id, actor, action, resource_type, resource_id,
           result, correlation_id, origin, metadata)
         VALUES ($1, $2, 'system', 'consent.requested', 'consent_request', $3,
           'SUCCEEDED', $4, 'consent-store', $5)`,
        [
          input.organizationId,
          input.caseId,
          requestId,
          input.correlationId,
          JSON.stringify({
            purpose: "DISCOVERY",
            policyId: input.policyId,
            policyVersion: context.version,
            noticeHash: context.notice_hash,
          }),
        ],
      );
      await client.query("COMMIT");
      return { created: true, requestId, messageId, outboxEventId };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.#pool.query<{
          id: string;
          request_message_id: string;
          outbox_event_id: string;
        }>(
          `SELECT id, request_message_id, outbox_event_id FROM consent_requests
           WHERE organization_id = $1 AND case_id = $2 AND person_id = $3 AND policy_id = $4`,
          [input.organizationId, input.caseId, input.personId, input.policyId],
        );
        const request = existing.rows[0];
        if (request)
          return {
            created: false,
            requestId: request.id,
            messageId: request.request_message_id,
            outboxEventId: request.outbox_event_id,
          };
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async recordDiscoveryResponse(input: {
    organizationId: string;
    caseId: string;
    requestId: string;
    sourceMessageId: string;
    correlationId: string;
    now?: Date;
  }): Promise<ConsentRecordReceipt> {
    const client = await this.#pool.connect();
    const now = input.now ?? new Date();
    try {
      await client.query("BEGIN");
      const duplicate = await client.query<{ id: string; action: ConsentAction }>(
        `SELECT id, action FROM consent_records
         WHERE organization_id = $1 AND source_message_id = $2 AND purpose = 'DISCOVERY'`,
        [input.organizationId, input.sourceMessageId],
      );
      const duplicateRecord = duplicate.rows[0];
      if (duplicateRecord) {
        await client.query("COMMIT");
        return { created: false, recordId: duplicateRecord.id, action: duplicateRecord.action };
      }
      const resolved = await client.query<{
        person_id: string;
        contact_point_id: string;
        policy_id: string;
        purpose: ConsentPurpose;
        policy_version: number;
        notice_hash: string;
        channel: "WHATSAPP";
        locale: string;
        scope: "PROJECT_DISCOVERY";
        request_status: "PENDING" | "COMPLETED" | "EXPIRED" | "CANCELLED";
        request_expires_at: Date;
        policy_expires_at: Date | null;
        provider_external_id: string | null;
        reply_to_provider_message_id: string | null;
        content_bytes: Buffer | null;
      }>(
        `SELECT r.person_id, r.contact_point_id, r.policy_id, r.purpose,
                r.policy_version, r.notice_hash, r.channel, r.locale, r.scope,
                r.status AS request_status, r.expires_at AS request_expires_at,
                p.expires_at AS policy_expires_at, o.provider_external_id,
                response.reply_to_provider_message_id, response.content_bytes
         FROM consent_requests r
         JOIN consent_policies p ON p.organization_id = r.organization_id AND p.id = r.policy_id
         JOIN messages requested ON requested.organization_id = r.organization_id
           AND requested.case_id = r.case_id AND requested.id = r.request_message_id
         JOIN messages response ON response.organization_id = r.organization_id
           AND response.case_id = r.case_id AND response.id = $4
           AND response.conversation_id = requested.conversation_id
           AND response.direction = 'INBOUND' AND response.message_type = 'text'
           AND response.sender_person_id = r.person_id
           AND response.sender_contact_point_id = r.contact_point_id
         JOIN outbox_events o ON o.id = r.outbox_event_id
         WHERE r.organization_id = $1 AND r.case_id = $2 AND r.id = $3
         FOR UPDATE OF r`,
        [input.organizationId, input.caseId, input.requestId, input.sourceMessageId],
      );
      const context = resolved.rows[0];
      if (!context?.content_bytes) throw new Error("consent_response_precondition_failed");
      const action = classifyConsentResponse(context.content_bytes.toString("utf8"));
      if (!action) throw new Error("consent_response_unrecognized");

      if (action === "REVOKED") {
        const current = await client.query<{ action: ConsentAction }>(
          `SELECT action FROM consent_records
           WHERE organization_id = $1 AND case_id = $2 AND person_id = $3
             AND purpose = 'DISCOVERY' ORDER BY occurred_at DESC, created_at DESC LIMIT 1`,
          [input.organizationId, input.caseId, context.person_id],
        );
        if (current.rows[0]?.action !== "ACCEPTED") throw new Error("active_consent_unavailable");
      } else if (
        context.request_status !== "PENDING" ||
        context.request_expires_at <= now ||
        !context.provider_external_id ||
        context.reply_to_provider_message_id !== context.provider_external_id
      ) {
        throw new Error("consent_request_not_answerable");
      }

      const recordId = randomUUID();
      const idempotencyKey = `consent-response:${input.requestId}:${input.sourceMessageId}`;
      await client.query(
        `INSERT INTO consent_records
          (id, organization_id, case_id, person_id, contact_point_id, policy_id, purpose,
           action, source_message_id, policy_version, notice_hash, channel, locale, scope,
           occurred_at, valid_until, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::consent_action, $9, $10, $11,
           $12, $13, $14, $15, $16, $17)`,
        [
          recordId,
          input.organizationId,
          input.caseId,
          context.person_id,
          context.contact_point_id,
          context.policy_id,
          context.purpose,
          action,
          input.sourceMessageId,
          context.policy_version,
          context.notice_hash,
          context.channel,
          context.locale,
          context.scope,
          now,
          action === "ACCEPTED" ? context.policy_expires_at : null,
          idempotencyKey,
        ],
      );
      await client.query(
        `UPDATE consent_requests SET status = $2::consent_request_status,
           version = version + 1, updated_at = $3 WHERE id = $1`,
        [input.requestId, action === "ACCEPTED" ? "COMPLETED" : "CANCELLED", now],
      );
      if (action !== "ACCEPTED") {
        await client.query(
          `UPDATE outbox_events SET status = 'CANCELLED', updated_at = $3
           WHERE organization_id = $1 AND case_id = $2
             AND status = 'PENDING'`,
          [input.organizationId, input.caseId, now],
        );
      }
      await client.query(
        `UPDATE prospect_cases SET status = $3::case_status, next_action = $4,
           version = version + 1, updated_at = $5
         WHERE organization_id = $1 AND id = $2`,
        [
          input.organizationId,
          input.caseId,
          action === "ACCEPTED" ? "INTERVIEWING" : "PAUSED",
          action === "ACCEPTED" ? "START_INTERVIEW" : `CONSENT_${action}`,
          now,
        ],
      );
      await client.query(
        `INSERT INTO audit_events
          (organization_id, case_id, actor, action, resource_type, resource_id,
           result, correlation_id, origin, metadata)
         VALUES ($1, $2, 'prospect', 'consent.recorded', 'consent_record', $3,
           'SUCCEEDED', $4, 'consent-store', $5)`,
        [
          input.organizationId,
          input.caseId,
          recordId,
          input.correlationId,
          JSON.stringify({
            action,
            purpose: context.purpose,
            requestId: input.requestId,
            policyId: context.policy_id,
            policyVersion: context.policy_version,
            noticeHash: context.notice_hash,
          }),
        ],
      );
      await client.query("COMMIT");
      return { created: true, recordId, action };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") {
        const existing = await this.#pool.query<{ id: string; action: ConsentAction }>(
          `SELECT id, action FROM consent_records
           WHERE organization_id = $1 AND source_message_id = $2 AND purpose = 'DISCOVERY'`,
          [input.organizationId, input.sourceMessageId],
        );
        const record = existing.rows[0];
        if (record) return { created: false, recordId: record.id, action: record.action };
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
