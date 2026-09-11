import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";

export interface OperatorPrincipal {
  userId: string;
  organizationId: string;
  twoFactorVerified: boolean;
}

export class OperatorConsoleStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }

  async #authorize(client: PoolClient, principal: OperatorPrincipal): Promise<void> {
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const membership = await client.query(
      `SELECT 1 FROM operator_memberships
       WHERE organization_id = $1 AND user_id = $2 AND role = 'ENGINEER' AND active`,
      [principal.organizationId, principal.userId],
    );
    if ((membership.rowCount ?? 0) !== 1) throw new Error("operator_forbidden");
  }

  async listCases(
    principal: OperatorPrincipal,
  ): Promise<Array<{ id: string; status: string; nextAction: string | null; updatedAt: Date }>> {
    const client = await this.#pool.connect();
    try {
      await this.#authorize(client, principal);
      const result = await client.query<{
        id: string;
        status: string;
        next_action: string | null;
        updated_at: Date;
      }>(
        `SELECT id, status, next_action, updated_at FROM prospect_cases
         WHERE organization_id = $1 ORDER BY updated_at DESC LIMIT 100`,
        [principal.organizationId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        status: row.status,
        nextAction: row.next_action,
        updatedAt: row.updated_at,
      }));
    } finally {
      client.release();
    }
  }

  async getCase(
    principal: OperatorPrincipal,
    caseId: string,
  ): Promise<{
    id: string;
    status: string;
    nextAction: string | null;
    assigned: boolean;
    messages: Array<{ id: string; direction: string; type: string; text: string | null; at: Date }>;
  }> {
    const client = await this.#pool.connect();
    try {
      await this.#authorize(client, principal);
      const found = await client.query<{ id: string; status: string; next_action: string | null }>(
        `SELECT id, status, next_action FROM prospect_cases
         WHERE organization_id = $1 AND id = $2`,
        [principal.organizationId, caseId],
      );
      const row = found.rows[0];
      if (!row) throw new Error("operator_case_not_found");
      const assigned = await client.query(
        `SELECT 1 FROM operator_case_assignments
         WHERE organization_id = $1 AND case_id = $2 AND user_id = $3 AND active`,
        [principal.organizationId, caseId, principal.userId],
      );
      const messages = await client.query<{
        id: string;
        direction: string;
        message_type: string;
        content_bytes: Buffer | null;
        provider_occurred_at: Date;
      }>(
        `SELECT id, direction, message_type, content_bytes, provider_occurred_at
         FROM messages WHERE organization_id = $1 AND case_id = $2
         ORDER BY provider_occurred_at, received_at`,
        [principal.organizationId, caseId],
      );
      return {
        id: row.id,
        status: row.status,
        nextAction: row.next_action,
        assigned: (assigned.rowCount ?? 0) === 1,
        messages: messages.rows.map((message) => ({
          id: message.id,
          direction: message.direction,
          type: message.message_type,
          text: message.content_bytes?.toString("utf8") ?? null,
          at: message.provider_occurred_at,
        })),
      };
    } finally {
      client.release();
    }
  }

  async takeCase(
    principal: OperatorPrincipal,
    caseId: string,
    correlationId: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#authorize(client, principal);
      const claimed = await client.query(
        `INSERT INTO operator_case_assignments (organization_id, case_id, user_id)
         SELECT $1, id, $3 FROM prospect_cases WHERE organization_id = $1 AND id = $2
         ON CONFLICT (organization_id, case_id) DO UPDATE
           SET user_id = excluded.user_id, active = true, updated_at = now()
         RETURNING id`,
        [principal.organizationId, caseId, principal.userId],
      );
      if ((claimed.rowCount ?? 0) !== 1) throw new Error("operator_case_not_found");
      await this.#cancelAutomatedDispatches(client, principal.organizationId, caseId);
      const state = await client.query<{ version: number }>(
        `UPDATE prospect_cases SET status = 'PAUSED', next_action = 'OPERATOR_ASSIGNED',
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING version`,
        [principal.organizationId, caseId],
      );
      const version = state.rows[0]?.version;
      if (!version) throw new Error("operator_case_not_found");
      await this.#audit(client, principal, caseId, version, "case.taken", correlationId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async pauseCase(
    principal: OperatorPrincipal,
    caseId: string,
    correlationId: string,
  ): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#authorize(client, principal);
      const paused = await client.query<{ version: number }>(
        `UPDATE prospect_cases SET status = 'PAUSED', next_action = 'OPERATOR_PAUSED',
           version = version + 1, updated_at = now()
         WHERE organization_id = $1 AND id = $2 RETURNING version`,
        [principal.organizationId, caseId],
      );
      if ((paused.rowCount ?? 0) !== 1) throw new Error("operator_case_not_found");
      await this.#cancelAutomatedDispatches(client, principal.organizationId, caseId);
      const version = paused.rows[0]?.version;
      if (!version) throw new Error("operator_case_not_found");
      await this.#audit(client, principal, caseId, version, "case.paused", correlationId);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #cancelAutomatedDispatches(
    client: PoolClient,
    organizationId: string,
    caseId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE message_delivery_attempts a
       SET completed_at = now(), outcome = 'REJECTED_PERMANENT', error_code = 'operator_paused'
       FROM outbox_events e
       WHERE a.outbox_event_id = e.id AND a.completed_at IS NULL
         AND e.organization_id = $1 AND e.case_id = $2
         AND e.status IN ('PENDING', 'DISPATCHING')
         AND e.event_type <> 'whatsapp.human.response.v1'`,
      [organizationId, caseId],
    );
    await client.query(
      `UPDATE outbox_events SET status = 'CANCELLED', locked_at = NULL,
         last_error_code = 'operator_paused', updated_at = now()
       WHERE organization_id = $1 AND case_id = $2
         AND status IN ('PENDING', 'DISPATCHING')
         AND event_type <> 'whatsapp.human.response.v1'`,
      [organizationId, caseId],
    );
  }

  async respond(
    principal: OperatorPrincipal,
    input: { caseId: string; text: string; idempotencyKey: string; correlationId: string },
  ): Promise<{ messageId: string; outboxEventId: string }> {
    const text = input.text.trim();
    if (!text || text.length > 2_000) throw new Error("operator_response_invalid");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await this.#authorize(client, principal);
      const target = await client.query<{
        conversation_id: string;
        provider_connection_id: string;
        external_id: string;
        version: number;
      }>(
        `SELECT c.id AS conversation_id, c.provider_connection_id, cp.external_id, pc.version
         FROM operator_case_assignments a
         JOIN prospect_cases pc ON pc.organization_id = a.organization_id AND pc.id = a.case_id
         JOIN conversations c ON c.organization_id = a.organization_id AND c.case_id = a.case_id
         JOIN messages m ON m.organization_id = c.organization_id AND m.conversation_id = c.id
           AND m.direction = 'INBOUND'
         JOIN contact_points cp ON cp.organization_id = m.organization_id
           AND cp.id = m.sender_contact_point_id AND cp.kind = 'WHATSAPP'
         WHERE a.organization_id = $1 AND a.case_id = $2 AND a.user_id = $3 AND a.active
           AND cp.external_id IS NOT NULL
         ORDER BY m.provider_occurred_at DESC LIMIT 1 FOR UPDATE OF a`,
        [principal.organizationId, input.caseId, principal.userId],
      );
      const destination = target.rows[0];
      if (!destination) throw new Error("operator_case_assignment_required");
      const existing = await client.query<{ id: string; aggregate_id: string }>(
        `SELECT id, aggregate_id FROM outbox_events
         WHERE organization_id = $1 AND idempotency_key = $2`,
        [principal.organizationId, input.idempotencyKey],
      );
      if (existing.rows[0]) {
        await client.query("COMMIT");
        return { messageId: existing.rows[0].aggregate_id, outboxEventId: existing.rows[0].id };
      }
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
          principal.organizationId,
          input.caseId,
          destination.conversation_id,
          destination.provider_connection_id,
          `local-human-${messageId}`,
          bytes,
          createHash("sha256").update(bytes).digest("hex"),
        ],
      );
      await client.query(
        `INSERT INTO outbox_events
          (id, organization_id, case_id, event_type, aggregate_type, aggregate_id,
           payload, idempotency_key, authorized_operator_user_id, deadline_at)
         VALUES ($1, $2, $3, 'whatsapp.human.response.v1', 'message', $4, $5, $6, $7,
           now() + interval '15 minutes')`,
        [
          outboxEventId,
          principal.organizationId,
          input.caseId,
          messageId,
          JSON.stringify({
            messaging_product: "whatsapp",
            to: destination.external_id,
            type: "text",
            text: { body: text },
          }),
          input.idempotencyKey,
          principal.userId,
        ],
      );
      await this.#audit(
        client,
        principal,
        input.caseId,
        destination.version,
        "case.responded",
        input.correlationId,
        { messageId, outboxEventId },
      );
      await client.query("COMMIT");
      return { messageId, outboxEventId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #audit(
    client: PoolClient,
    principal: OperatorPrincipal,
    caseId: string,
    expectedVersion: number,
    action: string,
    correlationId: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         expected_version, result, correlation_id, origin, metadata)
       VALUES ($1, $2, $3, $4, 'prospect_case', $5, $6, 'SUCCEEDED', $7,
         'operator-console', $8)`,
      [
        principal.organizationId,
        caseId,
        `operator:${principal.userId}`,
        action,
        caseId,
        expectedVersion,
        correlationId,
        JSON.stringify(metadata),
      ],
    );
  }
}
