import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type NextActionAuthorizationResult =
  | { kind: "authorized"; action: string; messageId?: string; outboxEventId?: string }
  | { kind: "replayed"; action: string; messageId?: string; outboxEventId?: string }
  | { kind: "blocked"; action: string; reason: string };

const FORBIDDEN_COMMUNICATION =
  /\b(precio|costo|cotizaci[oó]n|plazo|contrato|promet(?:o|emos|ido)|contrase(?:ñ|n)a|secreto|token|api[_ -]?key)\b/iu;

export function isInterviewCommunicationAllowed(text: string): boolean {
  const normalized = text.trim();
  return (
    normalized.length > 0 && normalized.length <= 500 && !FORBIDDEN_COMMUNICATION.test(normalized)
  );
}

export class NextActionStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async authorize(input: {
    organizationId: string;
    proposalId: string;
    correlationId: string;
  }): Promise<NextActionAuthorizationResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{
        action: string;
        question: string | null;
        summary: string | null;
        target_topic: string | null;
        referenced_claim_ids: unknown;
        proposal_status: string;
        case_id: string;
        case_status: string;
        next_action: string | null;
        interview_id: string;
        interview_status: string;
        pending_question: string | null;
        interview_version: number;
        expected_interview_version: number;
        model_invocation_id: string;
      }>(
        `SELECT p.action, p.question, p.summary, p.target_topic, p.referenced_claim_ids,
                p.status AS proposal_status, p.case_id, pc.status AS case_status,
                pc.next_action, p.interview_id, i.status AS interview_status,
                i.pending_question, i.version AS interview_version,
                mi.expected_interview_version, p.model_invocation_id
         FROM next_action_proposals p
         JOIN model_invocations mi ON mi.organization_id = p.organization_id
           AND mi.case_id = p.case_id AND mi.id = p.model_invocation_id
         JOIN interviews i ON i.organization_id = p.organization_id
           AND i.case_id = p.case_id AND i.id = p.interview_id
         JOIN prospect_cases pc ON pc.organization_id = p.organization_id AND pc.id = p.case_id
         WHERE p.organization_id = $1 AND p.id = $2
         FOR UPDATE OF p, i, pc`,
        [input.organizationId, input.proposalId],
      );
      const proposal = result.rows[0];
      if (!proposal) throw new Error("next_action_proposal_not_found");
      if (proposal.proposal_status === "AUTHORIZED") {
        const delivery = await this.#delivery(client, input.organizationId, input.proposalId);
        await client.query("COMMIT");
        return { kind: "replayed", action: proposal.action, ...delivery };
      }
      if (proposal.proposal_status === "REJECTED") {
        await client.query("COMMIT");
        return { kind: "blocked", action: proposal.action, reason: "PROPOSAL_REJECTED" };
      }

      const blocked = await this.#blockedReason(client, input.organizationId, proposal);
      if (blocked) {
        await client.query(
          `UPDATE next_action_proposals SET status = 'REJECTED', updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [input.organizationId, input.proposalId],
        );
        await this.#audit(client, input, proposal.case_id, "next_action.rejected", {
          reason: blocked,
        });
        await client.query("COMMIT");
        return { kind: "blocked", action: proposal.action, reason: blocked };
      }

      let delivery: { messageId?: string; outboxEventId?: string } = {};
      const text = proposal.action === "ASK" ? proposal.question : proposal.summary;
      if (text)
        delivery = await this.#queue(client, input, proposal.case_id, text, proposal.action);

      if (proposal.action === "ASK") {
        await client.query(
          `UPDATE interviews SET status = 'ACTIVE', pending_question = $4,
             version = version + 1, updated_at = now()
           WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
          [input.organizationId, proposal.case_id, proposal.interview_id, proposal.question],
        );
      } else {
        await client.query(
          `UPDATE interviews SET status = $4::interview_status,
             pending_question = CASE WHEN $5 = 'READY' THEN NULL ELSE pending_question END,
             version = version + 1, updated_at = now()
           WHERE organization_id = $1 AND case_id = $2 AND id = $3`,
          [
            input.organizationId,
            proposal.case_id,
            proposal.interview_id,
            proposal.action === "READY" ? "SUFFICIENT" : proposal.interview_status,
            proposal.action,
          ],
        );
      }
      if (["PAUSE", "ESCALATE", "READY"].includes(proposal.action)) {
        const state = proposal.action === "READY" ? "READY_FOR_SYNTHESIS" : "PAUSED";
        const nextAction =
          proposal.action === "READY"
            ? "SYNTHESIZE"
            : proposal.action === "ESCALATE"
              ? "HUMAN_REVIEW_REQUIRED"
              : "INTERVIEW_PAUSED";
        await client.query(
          `UPDATE prospect_cases SET status = $3::case_status, next_action = $4,
             version = version + 1, updated_at = now()
           WHERE organization_id = $1 AND id = $2`,
          [input.organizationId, proposal.case_id, state, nextAction],
        );
      }
      await client.query(
        `UPDATE next_action_proposals SET status = 'AUTHORIZED', updated_at = now()
         WHERE organization_id = $1 AND id = $2`,
        [input.organizationId, input.proposalId],
      );
      await this.#audit(client, input, proposal.case_id, "next_action.authorized", {
        action: proposal.action,
        ...delivery,
      });
      await client.query("COMMIT");
      return { kind: "authorized", action: proposal.action, ...delivery };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #blockedReason(
    client: PoolClient,
    organizationId: string,
    proposal: {
      action: string;
      question: string | null;
      summary: string | null;
      target_topic: string | null;
      referenced_claim_ids: unknown;
      case_id: string;
      case_status: string;
      next_action: string | null;
      pending_question: string | null;
      interview_id: string;
      interview_version: number;
      expected_interview_version: number;
      model_invocation_id: string;
    },
  ): Promise<string | undefined> {
    if (proposal.next_action === "STOP_REQUESTED") return "STOP_REQUESTED";
    if (proposal.next_action === "HUMAN_REQUESTED") return "HUMAN_REQUESTED";
    if (proposal.case_status === "PAUSED") return proposal.next_action ?? "CASE_PAUSED";
    if (proposal.case_status !== "INTERVIEWING") return "CASE_NOT_INTERVIEWING";
    if (proposal.interview_version !== proposal.expected_interview_version)
      return "INTERVIEW_CHANGED";
    if (proposal.pending_question && ["ASK", "SUMMARIZE"].includes(proposal.action))
      return "QUESTION_ALREADY_PENDING";
    const references = Array.isArray(proposal.referenced_claim_ids)
      ? proposal.referenced_claim_ids.filter((id): id is string => typeof id === "string")
      : [];
    if (
      references.length !==
      (await client
        .query<{ count: number }>(
          `SELECT count(*)::integer AS count FROM claims
           WHERE organization_id = $1 AND case_id = $2 AND validity = 'CURRENT'
             AND id = ANY($3::uuid[])`,
          [organizationId, proposal.case_id, references],
        )
        .then((result) => result.rows[0]?.count ?? 0))
    )
      return "CLAIM_REFERENCE_CHANGED";
    if (proposal.action === "ASK") {
      if (
        !proposal.question ||
        !isInterviewCommunicationAllowed(proposal.question) ||
        (proposal.question.match(/\?/g) ?? []).length !== 1
      )
        return "QUESTION_NOT_ALLOWED";
      const topicMissing = await client.query(
        `SELECT 1 FROM interview_topics WHERE organization_id = $1 AND interview_id = $2
           AND topic_key = $3 AND status = 'MISSING'`,
        [organizationId, proposal.interview_id, proposal.target_topic],
      );
      if ((topicMissing.rowCount ?? 0) !== 1) return "TARGET_TOPIC_NOT_MISSING";
    }
    if (
      proposal.action === "SUMMARIZE" &&
      (!proposal.summary || !isInterviewCommunicationAllowed(proposal.summary))
    )
      return "SUMMARY_NOT_ALLOWED";
    if (proposal.action === "READY") {
      const missing = await client.query(
        `SELECT 1 FROM interview_topics WHERE organization_id = $1 AND interview_id = $2
           AND required AND status = 'MISSING' LIMIT 1`,
        [organizationId, proposal.interview_id],
      );
      if ((missing.rowCount ?? 0) > 0) return "INTERVIEW_NOT_SUFFICIENT";
    }
    if (proposal.question || proposal.summary) {
      const destinationAllowed = await client.query(
        `SELECT 1 FROM model_invocation_messages mim
         JOIN messages m ON m.organization_id = mim.organization_id AND m.id = mim.message_id
         JOIN contact_points cp ON cp.organization_id = m.organization_id
           AND cp.id = m.sender_contact_point_id AND cp.kind = 'WHATSAPP'
           AND cp.external_id IS NOT NULL
         JOIN LATERAL (
           SELECT action, valid_until FROM consent_records
           WHERE organization_id = m.organization_id AND case_id = m.case_id
             AND person_id = m.sender_person_id AND contact_point_id = m.sender_contact_point_id
             AND purpose = 'DISCOVERY'
           ORDER BY occurred_at DESC, created_at DESC LIMIT 1
         ) consent ON consent.action = 'ACCEPTED'
           AND (consent.valid_until IS NULL OR consent.valid_until > now())
         WHERE mim.organization_id = $1 AND mim.invocation_id = $2 LIMIT 1`,
        [organizationId, proposal.model_invocation_id],
      );
      if ((destinationAllowed.rowCount ?? 0) !== 1) return "ACTIVE_CONSENT_REQUIRED";
      const hash = createHash("sha256")
        .update(proposal.question ?? proposal.summary ?? "")
        .digest("hex");
      const repeated = await client.query(
        `SELECT 1 FROM messages WHERE organization_id = $1 AND case_id = $2
           AND direction = 'OUTBOUND' AND content_hash = $3 LIMIT 1`,
        [organizationId, proposal.case_id, hash],
      );
      if ((repeated.rowCount ?? 0) > 0) return "COMMUNICATION_REPEATED";
    }
    return undefined;
  }

  async #queue(
    client: PoolClient,
    input: { organizationId: string; proposalId: string; correlationId: string },
    caseId: string,
    text: string,
    action: string,
  ) {
    const target = await client.query<{
      conversation_id: string;
      provider_connection_id: string;
      external_id: string;
      consent_action: string | null;
      valid_until: Date | null;
    }>(
      `SELECT m.conversation_id, m.provider_connection_id, cp.external_id,
              consent.action AS consent_action, consent.valid_until
       FROM model_invocations mi
       JOIN model_invocation_messages mim ON mim.organization_id = mi.organization_id
         AND mim.invocation_id = mi.id
       JOIN messages m ON m.organization_id = mim.organization_id AND m.id = mim.message_id
       JOIN contact_points cp ON cp.organization_id = m.organization_id
         AND cp.id = m.sender_contact_point_id AND cp.kind = 'WHATSAPP'
       LEFT JOIN LATERAL (
         SELECT action, valid_until FROM consent_records
         WHERE organization_id = m.organization_id AND case_id = m.case_id
           AND person_id = m.sender_person_id AND contact_point_id = m.sender_contact_point_id
           AND purpose = 'DISCOVERY'
         ORDER BY occurred_at DESC, created_at DESC LIMIT 1
       ) consent ON true
       WHERE mi.organization_id = $1 AND mi.case_id = $2
         AND mi.id = (SELECT model_invocation_id FROM next_action_proposals WHERE id = $3)
         AND cp.external_id IS NOT NULL
       ORDER BY mim.position DESC LIMIT 1`,
      [input.organizationId, caseId, input.proposalId],
    );
    const destination = target.rows[0];
    if (
      destination?.consent_action !== "ACCEPTED" ||
      (destination.valid_until && destination.valid_until <= new Date())
    )
      throw new Error("next_action_active_consent_required");
    const messageId = randomUUID();
    const outboxEventId = randomUUID();
    const bytes = Buffer.from(text);
    await client.query(
      `INSERT INTO messages
        (id, organization_id, case_id, conversation_id, provider_connection_id,
         direction, provider_message_id, message_type, content_bytes, content_hash,
         provider_occurred_at, processing_status)
       VALUES ($1, $2, $3, $4, $5, 'OUTBOUND', $6, 'text', $7, $8, now(), 'PROCESSED')`,
      [
        messageId,
        input.organizationId,
        caseId,
        destination.conversation_id,
        destination.provider_connection_id,
        `local-next-action-${messageId}`,
        bytes,
        createHash("sha256").update(bytes).digest("hex"),
      ],
    );
    await client.query(
      `INSERT INTO outbox_events
        (id, organization_id, case_id, event_type, aggregate_type, aggregate_id,
         payload, idempotency_key, deadline_at)
       VALUES ($1, $2, $3, $4, 'message', $5, $6, $7, now() + interval '15 minutes')`,
      [
        outboxEventId,
        input.organizationId,
        caseId,
        action === "ASK" ? "whatsapp.interview.question.v1" : "whatsapp.interview.summary.v1",
        messageId,
        JSON.stringify({
          messaging_product: "whatsapp",
          to: destination.external_id,
          type: "text",
          text: { body: text },
        }),
        `next-action:${input.proposalId}`,
      ],
    );
    return { messageId, outboxEventId };
  }

  async #delivery(client: PoolClient, organizationId: string, proposalId: string) {
    return client
      .query<{ message_id: string; outbox_event_id: string }>(
        `SELECT aggregate_id AS message_id, id AS outbox_event_id FROM outbox_events
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [organizationId, `next-action:${proposalId}`],
      )
      .then((result) => {
        const row = result.rows[0];
        return row ? { messageId: row.message_id, outboxEventId: row.outbox_event_id } : {};
      });
  }

  async #audit(
    client: PoolClient,
    input: { organizationId: string; proposalId: string; correlationId: string },
    caseId: string,
    action: string,
    metadata: unknown,
  ) {
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         result, correlation_id, origin, metadata)
       VALUES ($1, $2, 'system', $3, 'next_action_proposal', $4,
         'SUCCEEDED', $5, 'next-action-store', $6::jsonb)`,
      [
        input.organizationId,
        caseId,
        action,
        input.proposalId,
        input.correlationId,
        JSON.stringify(metadata),
      ],
    );
  }
}
