import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export type ConversationInterventionKind = "STOP" | "HUMAN_REQUEST";

const STOP_PHRASES = new Set(["DETENER", "PARAR", "QUIERO DETENERME", "NO QUIERO CONTINUAR"]);
const HUMAN_PHRASES = new Set([
  "AYUDA HUMANA",
  "HABLAR CON UNA PERSONA",
  "QUIERO HABLAR CON UNA PERSONA",
]);

function normalizeInterventionText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLocaleUpperCase("es");
}

export function classifyConversationIntervention(
  text: string,
): ConversationInterventionKind | undefined {
  const normalized = normalizeInterventionText(text);
  if (STOP_PHRASES.has(normalized)) return "STOP";
  if (HUMAN_PHRASES.has(normalized)) return "HUMAN_REQUEST";
  return undefined;
}

export async function applyConversationIntervention(
  client: PoolClient,
  input: {
    organizationId: string;
    caseId: string;
    sourceMessageId: string;
    personId: string;
    contactPointId: string;
    correlationId: string;
    kind: ConversationInterventionKind;
  },
): Promise<{ created: boolean; kind: ConversationInterventionKind; cancelledOutbox: number }> {
  const interventionId = randomUUID();
  const inserted = await client.query(
    `INSERT INTO conversation_interventions
      (id, organization_id, case_id, person_id, contact_point_id, source_message_id, kind)
     VALUES ($1, $2, $3, $4, $5, $6, $7::conversation_intervention_kind)
     ON CONFLICT (organization_id, source_message_id) DO NOTHING`,
    [
      interventionId,
      input.organizationId,
      input.caseId,
      input.personId,
      input.contactPointId,
      input.sourceMessageId,
      input.kind,
    ],
  );
  if ((inserted.rowCount ?? 0) === 0) {
    return { created: false, kind: input.kind, cancelledOutbox: 0 };
  }

  const errorCode = input.kind === "STOP" ? "prospect_stopped" : "human_requested";
  await client.query(
    `UPDATE message_delivery_attempts a
     SET completed_at = now(), outcome = 'REJECTED_PERMANENT', error_code = $3
     FROM outbox_events o
     WHERE a.outbox_event_id = o.id AND a.completed_at IS NULL
       AND o.organization_id = $1 AND o.case_id = $2 AND o.status = 'DISPATCHING'`,
    [input.organizationId, input.caseId, errorCode],
  );
  const cancelled = await client.query(
    `UPDATE outbox_events SET status = 'CANCELLED', locked_at = NULL,
       last_error_code = $3, updated_at = now()
     WHERE organization_id = $1 AND case_id = $2
       AND status IN ('PENDING', 'DISPATCHING')`,
    [input.organizationId, input.caseId, errorCode],
  );
  await client.query(
    `UPDATE prospect_cases SET status = 'PAUSED', next_action = $3,
       version = version + 1, updated_at = now()
     WHERE organization_id = $1 AND id = $2`,
    [
      input.organizationId,
      input.caseId,
      input.kind === "STOP" ? "STOP_REQUESTED" : "HUMAN_REQUESTED",
    ],
  );
  await client.query(
    `INSERT INTO audit_events
      (organization_id, case_id, actor, action, resource_type, resource_id,
       result, correlation_id, origin, metadata)
     VALUES ($1, $2, 'prospect', $3, 'conversation_intervention', $4,
       'SUCCEEDED', $5, 'conversation-intervention-store', $6)`,
    [
      input.organizationId,
      input.caseId,
      input.kind === "STOP" ? "conversation.stopped" : "conversation.human-requested",
      interventionId,
      input.correlationId,
      JSON.stringify({ kind: input.kind, sourceMessageId: input.sourceMessageId }),
    ],
  );
  return { created: true, kind: input.kind, cancelledOutbox: cancelled.rowCount ?? 0 };
}

export class ConversationInterventionStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async record(input: {
    organizationId: string;
    caseId: string;
    sourceMessageId: string;
    correlationId: string;
  }): Promise<{ created: boolean; kind: ConversationInterventionKind; cancelledOutbox: number }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const resolved = await client.query<{
        person_id: string;
        contact_point_id: string;
        content_bytes: Buffer | null;
      }>(
        `SELECT m.sender_person_id AS person_id,
                m.sender_contact_point_id AS contact_point_id, m.content_bytes
         FROM messages m
         JOIN prospect_cases pc ON pc.organization_id = m.organization_id AND pc.id = m.case_id
         JOIN case_participants cp ON cp.organization_id = m.organization_id
           AND cp.case_id = m.case_id AND cp.person_id = m.sender_person_id
         WHERE m.organization_id = $1 AND m.case_id = $2 AND m.id = $3
           AND m.direction = 'INBOUND' AND m.message_type = 'text'
           AND m.sender_person_id IS NOT NULL AND m.sender_contact_point_id IS NOT NULL
         FOR UPDATE OF pc`,
        [input.organizationId, input.caseId, input.sourceMessageId],
      );
      const context = resolved.rows[0];
      if (!context?.content_bytes) throw new Error("intervention_source_precondition_failed");
      const kind = classifyConversationIntervention(context.content_bytes.toString("utf8"));
      if (!kind) throw new Error("intervention_unrecognized");

      const result = await applyConversationIntervention(client, {
        organizationId: input.organizationId,
        caseId: input.caseId,
        sourceMessageId: input.sourceMessageId,
        personId: context.person_id,
        contactPointId: context.contact_point_id,
        correlationId: input.correlationId,
        kind,
      });
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
