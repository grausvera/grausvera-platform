import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { type ExistingClaimSource, KnowledgeStore } from "./knowledge.js";
import type { ObjectPort } from "./object-storage.js";
import type { OperatorPrincipal } from "./operator-console.js";

const RECENT_AUTHENTICATION_MS = 5 * 60 * 1000;
const RECENT_IDENTITY_VERIFICATION_MS = 15 * 60 * 1000;

export interface PrivacyPrincipal extends OperatorPrincipal {
  authenticatedAt: Date;
  identityVerifiedAt: Date;
}

export interface DeletionJournalEntry {
  actionId: string;
  requestId: string;
  opaqueOrganizationId: string;
  opaqueCaseId: string;
  opaqueSubjectId: string;
  scope: string[];
  cutoffAt: string;
  integrityHash: string;
}

export interface DeletionJournalPort {
  append(entry: DeletionJournalEntry): Promise<{ checkpoint: string }>;
  appendResult?(entry: DeletionJournalResult): Promise<{ checkpoint: string }>;
}

export interface DeletionJournalResult {
  actionId: string;
  requestId: string;
  intentCheckpoint: string;
  completedAt: string;
  disposedCounts: Record<string, number>;
  integrityHash: string;
}

export interface PrivacyExportV1 {
  schemaVersion: 1;
  requestId: string;
  generatedAt: string;
  subject: { id: string; version: number };
  case: { id: string; status: string; createdAt: string };
  contacts: Array<{ id: string; kind: string; purpose: string; verifiedAt: string | null }>;
  messages: Array<{ id: string; direction: string; type: string; text: string | null; at: string }>;
  claims: Array<{ id: string; category: string; content: string; validity: string }>;
  revisions: Array<{ id: string; revisionNumber: number; status: string; snapshot: unknown }>;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export class PrivacyStore {
  readonly #pool: Pool;
  readonly #knowledge: KnowledgeStore;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
    this.#knowledge = new KnowledgeStore(connectionString);
  }

  async close(): Promise<void> {
    await this.#knowledge.close();
    await this.#pool.end();
  }

  async exportSubject(
    principal: PrivacyPrincipal,
    input: { caseId: string; personId: string; idempotencyKey: string; now?: Date },
  ): Promise<PrivacyExportV1> {
    const now = input.now ?? new Date();
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const subject = await this.#authorize(client, principal, input, now);
      const existing = await this.#existingRequest(client, principal.organizationId, input);
      const requestId = existing ?? randomUUID();
      if (!existing) {
        await client.query(
          `INSERT INTO privacy_requests
            (id,organization_id,case_id,person_id,kind,status,requested_by_user_id,
             identity_verified_at,scope,idempotency_key,completed_at)
           VALUES ($1,$2,$3,$4,'ACCESS_EXPORT','COMPLETED',$5,$6,$7,$8,$9)`,
          [
            requestId,
            principal.organizationId,
            input.caseId,
            input.personId,
            principal.userId,
            principal.identityVerifiedAt,
            JSON.stringify({ subjectOnly: true }),
            input.idempotencyKey,
            now,
          ],
        );
        await this.#audit(client, principal, input.caseId, requestId, "privacy.exported", now, {
          personId: input.personId,
        });
      }
      const contacts = await client.query<{
        id: string;
        kind: string;
        purpose: string;
        verified_at: Date | null;
      }>(
        `SELECT id,kind,purpose,verified_at FROM contact_points
         WHERE organization_id=$1 AND person_id=$2 ORDER BY created_at,id`,
        [principal.organizationId, input.personId],
      );
      const messages = await client.query<{
        id: string;
        direction: string;
        message_type: string;
        content_bytes: Buffer | null;
        provider_occurred_at: Date;
      }>(
        `SELECT id,direction,message_type,content_bytes,provider_occurred_at FROM messages
         WHERE organization_id=$1 AND case_id=$2 AND sender_person_id=$3
         ORDER BY provider_occurred_at,id`,
        [principal.organizationId, input.caseId, input.personId],
      );
      const claims = await client.query<{
        id: string;
        category: string;
        content: string;
        validity: string;
      }>(
        `SELECT c.id,c.category,c.content,c.validity FROM claims c
         WHERE c.organization_id=$1 AND c.case_id=$2
           AND EXISTS (SELECT 1 FROM claim_sources cs JOIN messages m ON m.id=cs.message_id
             WHERE cs.organization_id=c.organization_id AND cs.case_id=c.case_id
               AND cs.claim_id=c.id AND m.sender_person_id=$3)
           AND NOT EXISTS (SELECT 1 FROM claim_sources cs JOIN messages m ON m.id=cs.message_id
             WHERE cs.organization_id=c.organization_id AND cs.case_id=c.case_id
               AND cs.claim_id=c.id AND m.sender_person_id IS DISTINCT FROM $3)
         ORDER BY c.created_at,c.id`,
        [principal.organizationId, input.caseId, input.personId],
      );
      const revisions =
        subject.participant_count === 1
          ? await client.query<{
              id: string;
              revision_number: number;
              status: string;
              snapshot: unknown;
            }>(
              `SELECT id,revision_number,status,snapshot FROM brief_revisions
               WHERE organization_id=$1 AND case_id=$2 ORDER BY revision_number,id`,
              [principal.organizationId, input.caseId],
            )
          : { rows: [] };
      await client.query("COMMIT");
      return {
        schemaVersion: 1,
        requestId,
        generatedAt: now.toISOString(),
        subject: { id: input.personId, version: subject.person_version },
        case: {
          id: input.caseId,
          status: subject.case_status,
          createdAt: subject.case_created_at.toISOString(),
        },
        contacts: contacts.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          purpose: row.purpose,
          verifiedAt: row.verified_at?.toISOString() ?? null,
        })),
        messages: messages.rows.map((row) => ({
          id: row.id,
          direction: row.direction,
          type: row.message_type,
          text: row.content_bytes?.toString("utf8") ?? null,
          at: row.provider_occurred_at.toISOString(),
        })),
        claims: claims.rows,
        revisions: revisions.rows.map((row) => ({
          id: row.id,
          revisionNumber: row.revision_number,
          status: row.status,
          snapshot: row.snapshot,
        })),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async rectifyClaim(
    principal: PrivacyPrincipal,
    input: {
      caseId: string;
      personId: string;
      targetClaimId: string;
      replacement: string;
      confidenceBasisPoints: number;
      source: ExistingClaimSource;
      correlationId: string;
      idempotencyKey: string;
      now?: Date;
    },
  ): Promise<{ requestId: string; claimId: string }> {
    const now = input.now ?? new Date();
    const authorization = await this.#pool.connect();
    try {
      await this.#authorize(authorization, principal, input, now);
    } finally {
      authorization.release();
    }
    const existing = await this.#pool
      .query<{ id: string; claim_id: string }>(
        `SELECT id,scope->>'replacementClaimId' claim_id FROM privacy_requests
         WHERE organization_id=$1 AND case_id=$2 AND person_id=$3
           AND idempotency_key=$4 AND kind='RECTIFICATION'`,
        [principal.organizationId, input.caseId, input.personId, input.idempotencyKey],
      )
      .then((result) => result.rows[0]);
    if (existing?.claim_id) return { requestId: existing.id, claimId: existing.claim_id };
    const corrected = await this.#knowledge.correctClaim(principal, input);
    const requestId = randomUUID();
    const audit = await this.#pool.connect();
    try {
      await audit.query("BEGIN");
      await audit.query(
        `INSERT INTO privacy_requests
          (id,organization_id,case_id,person_id,kind,status,requested_by_user_id,
           identity_verified_at,scope,idempotency_key,completed_at)
         VALUES ($1,$2,$3,$4,'RECTIFICATION','COMPLETED',$5,$6,$7,$8,$9)`,
        [
          requestId,
          principal.organizationId,
          input.caseId,
          input.personId,
          principal.userId,
          principal.identityVerifiedAt,
          JSON.stringify({
            targetClaimId: input.targetClaimId,
            replacementClaimId: corrected.claimId,
          }),
          input.idempotencyKey,
          now,
        ],
      );
      await this.#audit(audit, principal, input.caseId, requestId, "privacy.rectified", now, {
        targetClaimId: input.targetClaimId,
        replacementClaimId: corrected.claimId,
      });
      await audit.query("COMMIT");
    } catch (error) {
      await audit.query("ROLLBACK");
      throw error;
    } finally {
      audit.release();
    }
    return { requestId, claimId: corrected.claimId };
  }

  async requestErasure(
    principal: PrivacyPrincipal,
    input: { caseId: string; personId: string; idempotencyKey: string; now?: Date },
    journal: DeletionJournalPort,
  ): Promise<{ requestId: string; actionId: string; checkpoint: string; replayed: boolean }> {
    const now = input.now ?? new Date();
    const scope = ["case", "person", "objects", "jobs", "derivatives"];
    const client = await this.#pool.connect();
    let requestId: string;
    let actionId: string;
    let integrityHash: string;
    let cutoffAt = now;
    let opaqueSubjectId = digest(`${principal.organizationId}:${input.personId}`);
    let replayed = false;
    try {
      await client.query("BEGIN");
      await this.#authorize(client, principal, input, now);
      const existing = await client
        .query<{
          request_id: string;
          action_id: string;
          integrity_hash: string;
          checkpoint: string | null;
          cutoff_at: Date;
          opaque_subject_id: string;
          case_id: string;
          person_id: string;
          kind: string;
        }>(
          `SELECT p.id request_id,r.id action_id,r.integrity_hash,r.journal_checkpoint checkpoint,
             r.cutoff_at,r.opaque_subject_id,p.case_id,p.person_id,p.kind
           FROM privacy_requests p JOIN retention_actions r ON r.privacy_request_id=p.id
           WHERE p.organization_id=$1 AND p.idempotency_key=$2 FOR UPDATE OF p,r`,
          [principal.organizationId, input.idempotencyKey],
        )
        .then((result) => result.rows[0]);
      if (
        existing &&
        (existing.case_id !== input.caseId ||
          existing.person_id !== input.personId ||
          existing.kind !== "ERASURE")
      )
        throw new Error("privacy_request_not_authorized");
      if (existing?.checkpoint) {
        await client.query("COMMIT");
        return {
          requestId: existing.request_id,
          actionId: existing.action_id,
          checkpoint: existing.checkpoint,
          replayed: true,
        };
      }
      requestId = existing?.request_id ?? randomUUID();
      actionId = existing?.action_id ?? randomUUID();
      cutoffAt = existing?.cutoff_at ?? now;
      opaqueSubjectId = existing?.opaque_subject_id ?? opaqueSubjectId;
      const basis = JSON.stringify({
        actionId,
        requestId,
        scope,
        cutoffAt: cutoffAt.toISOString(),
      });
      integrityHash = existing?.integrity_hash ?? digest(basis);
      replayed = Boolean(existing);
      if (!existing) {
        await client.query(
          `INSERT INTO privacy_requests
            (id,organization_id,case_id,person_id,kind,requested_by_user_id,
             identity_verified_at,scope,idempotency_key)
           VALUES ($1,$2,$3,$4,'ERASURE',$5,$6,$7,$8)`,
          [
            requestId,
            principal.organizationId,
            input.caseId,
            input.personId,
            principal.userId,
            principal.identityVerifiedAt,
            JSON.stringify({ resources: scope }),
            input.idempotencyKey,
          ],
        );
        await client.query(
          `INSERT INTO retention_actions
            (id,organization_id,case_id,privacy_request_id,opaque_subject_id,scope,cutoff_at,integrity_hash)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [
            actionId,
            principal.organizationId,
            input.caseId,
            requestId,
            opaqueSubjectId,
            JSON.stringify(scope),
            now,
            integrityHash,
          ],
        );
        await client.query(
          `UPDATE brief_approvals SET status='REVOKED',revoked_at=$3,updated_at=$3
           WHERE organization_id=$1 AND case_id=$2 AND status='ACTIVE'`,
          [principal.organizationId, input.caseId, now],
        );
        await client.query(
          `UPDATE email_verification_challenges SET status='REVOKED',revoked_at=$3,updated_at=$3
           WHERE organization_id=$1 AND case_id=$2 AND status='PENDING'`,
          [principal.organizationId, input.caseId, now],
        );
        await client.query(
          `UPDATE confirmation_requests SET status='REVOKED',revoked_at=$3,updated_at=$3
           WHERE organization_id=$1 AND case_id=$2 AND status='PENDING'`,
          [principal.organizationId, input.caseId, now],
        );
        await client.query(
          `UPDATE email_deliveries SET status='CANCELLED',failure_code='privacy_erasure_pending',
             updated_at=$3 WHERE organization_id=$1 AND case_id=$2 AND status='PENDING'`,
          [principal.organizationId, input.caseId, now],
        );
        await client.query(
          `UPDATE outbox_events SET status='CANCELLED',locked_at=NULL,
             last_error_code='privacy_erasure_pending',updated_at=$3
           WHERE organization_id=$1 AND case_id=$2 AND status IN ('PENDING','DISPATCHING')`,
          [principal.organizationId, input.caseId, now],
        );
        await client.query(
          `UPDATE prospect_cases SET status='PAUSED',next_action='PRIVACY_ERASURE_PENDING',
             version=version+1,updated_at=$3 WHERE organization_id=$1 AND id=$2`,
          [principal.organizationId, input.caseId, now],
        );
        await this.#audit(
          client,
          principal,
          input.caseId,
          actionId,
          "retention.intent_created",
          now,
          {},
          "retention_action",
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    if (!requestId || !actionId || !integrityHash) throw new Error("retention_action_unavailable");
    const entry: DeletionJournalEntry = {
      actionId,
      requestId,
      opaqueOrganizationId: digest(principal.organizationId),
      opaqueCaseId: digest(input.caseId),
      opaqueSubjectId,
      scope,
      cutoffAt: cutoffAt.toISOString(),
      integrityHash,
    };
    try {
      const confirmed = await journal.append(entry);
      if (!confirmed.checkpoint.trim()) throw new Error("journal_checkpoint_invalid");
      const confirmation = await this.#pool.connect();
      try {
        await confirmation.query("BEGIN");
        await confirmation.query(
          `UPDATE retention_actions SET status='JOURNALED',journal_checkpoint=$2,
             journal_confirmed_at=$3,last_error_code=NULL,updated_at=$3
           WHERE id=$1 AND status='JOURNAL_PENDING'`,
          [actionId, confirmed.checkpoint, now],
        );
        await this.#audit(
          confirmation,
          principal,
          input.caseId,
          actionId,
          "retention.journal_confirmed",
          now,
          { checkpoint: confirmed.checkpoint },
          "retention_action",
        );
        await confirmation.query("COMMIT");
      } catch (error) {
        await confirmation.query("ROLLBACK");
        throw error;
      } finally {
        confirmation.release();
      }
      return {
        requestId,
        actionId,
        checkpoint: confirmed.checkpoint,
        replayed,
      };
    } catch {
      const failure = await this.#pool.connect();
      try {
        await failure.query("BEGIN");
        await failure.query(
          `UPDATE retention_actions SET last_error_code='journal_unavailable',updated_at=$2
           WHERE id=$1 AND status='JOURNAL_PENDING'`,
          [actionId, now],
        );
        await this.#audit(
          failure,
          principal,
          input.caseId,
          actionId,
          "retention.journal_failed",
          now,
          { errorCode: "journal_unavailable" },
          "retention_action",
          "FAILED",
        );
        await failure.query("COMMIT");
      } catch (error) {
        await failure.query("ROLLBACK");
        throw error;
      } finally {
        failure.release();
      }
      throw new Error("privacy_journal_unavailable");
    }
  }

  async executeErasure(
    principal: PrivacyPrincipal,
    input: { actionId: string; caseId: string; personId: string; now?: Date },
    objects: Pick<ObjectPort, "remove">,
    journal: DeletionJournalPort,
  ): Promise<{ actionId: string; resultCheckpoint: string; replayed: boolean }> {
    const now = input.now ?? new Date();
    const client = await this.#pool.connect();
    let action: {
      request_id: string;
      status: string;
      journal_checkpoint: string;
      integrity_hash: string;
    };
    try {
      await client.query("BEGIN");
      await this.#authorize(client, principal, input, now);
      const found = await client
        .query<typeof action>(
          `SELECT r.privacy_request_id request_id,r.status,r.journal_checkpoint,r.integrity_hash
           FROM retention_actions r JOIN privacy_requests p ON p.id=r.privacy_request_id
           WHERE r.id=$1 AND r.organization_id=$2 AND r.case_id=$3 AND p.person_id=$4
           FOR UPDATE OF r`,
          [input.actionId, principal.organizationId, input.caseId, input.personId],
        )
        .then((result) => result.rows[0]);
      if (!found?.journal_checkpoint || found.status === "JOURNAL_PENDING")
        throw new Error("retention_journal_confirmation_required");
      action = found;
      await client.query(
        `INSERT INTO retention_disposition_steps (action_id,step)
         SELECT $1,unnest(ARRAY['OBJECTS','DATABASE','JOBS','DERIVATIVES','RESULT_JOURNAL'])
         ON CONFLICT DO NOTHING`,
        [input.actionId],
      );
      if (found.status === "JOURNALED") {
        await client.query(
          `UPDATE retention_actions SET status='EXECUTING',last_error_code=NULL,updated_at=$2 WHERE id=$1`,
          [input.actionId, now],
        );
      }
      await client.query("COMMIT");
      if (found.status === "COMPLETED") {
        const checkpoint = await this.#stepCheckpoint(input.actionId);
        return { actionId: input.actionId, resultCheckpoint: checkpoint, replayed: true };
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    await this.#runStep(input.actionId, "OBJECTS", now, async () => {
      const keys = await this.#pool.query<{ object_key: string }>(
        `SELECT object_key FROM attachments WHERE organization_id=$1 AND case_id=$2
         UNION SELECT representation_object_key FROM email_deliveries
           WHERE organization_id=$1 AND case_id=$2 AND representation_object_key IS NOT NULL`,
        [principal.organizationId, input.caseId],
      );
      for (const row of keys.rows) await objects.remove(row.object_key);
      return keys.rowCount ?? 0;
    });

    await this.#runDatabaseStep(input.actionId, principal, input.caseId, input.personId, now);
    await this.#completeMarkerStep(input.actionId, "JOBS", principal, input.caseId, now);
    await this.#completeMarkerStep(input.actionId, "DERIVATIVES", principal, input.caseId, now);

    const appendResult = journal.appendResult;
    if (!appendResult) throw new Error("privacy_result_journal_unavailable");
    let resultCheckpoint = "";
    await this.#runStep(input.actionId, "RESULT_JOURNAL", now, async () => {
      const counts = await this.#pool.query<{ step: string; disposed_count: number }>(
        `SELECT step,disposed_count FROM retention_disposition_steps
         WHERE action_id=$1 AND step <> 'RESULT_JOURNAL' ORDER BY step`,
        [input.actionId],
      );
      const disposedCounts = Object.fromEntries(
        counts.rows.map((row) => [row.step.toLowerCase(), row.disposed_count]),
      );
      const result = await appendResult({
        actionId: input.actionId,
        requestId: action.request_id,
        intentCheckpoint: action.journal_checkpoint,
        completedAt: now.toISOString(),
        disposedCounts,
        integrityHash: digest(
          JSON.stringify({
            actionId: input.actionId,
            requestId: action.request_id,
            intentCheckpoint: action.journal_checkpoint,
            completedAt: now.toISOString(),
            disposedCounts,
          }),
        ),
      });
      if (!result.checkpoint.trim()) throw new Error("journal_checkpoint_invalid");
      resultCheckpoint = result.checkpoint;
      return { count: 1, checkpoint: result.checkpoint };
    });
    if (!resultCheckpoint) resultCheckpoint = await this.#stepCheckpoint(input.actionId);

    const completion = await this.#pool.connect();
    try {
      await completion.query("BEGIN");
      await completion.query(
        `UPDATE retention_actions SET status='COMPLETED',last_error_code=NULL,updated_at=$2
         WHERE id=$1 AND status='EXECUTING'`,
        [input.actionId, now],
      );
      await completion.query(
        `UPDATE privacy_requests SET status='COMPLETED',completed_at=$2,updated_at=$2
         WHERE id=$1 AND status='IN_PROGRESS'`,
        [action.request_id, now],
      );
      await this.#audit(
        completion,
        principal,
        input.caseId,
        input.actionId,
        "retention.disposition_completed",
        now,
        { resultCheckpoint },
        "retention_action",
      );
      await completion.query("COMMIT");
    } catch (error) {
      await completion.query("ROLLBACK");
      throw error;
    } finally {
      completion.release();
    }
    return { actionId: input.actionId, resultCheckpoint, replayed: false };
  }

  async #runDatabaseStep(
    actionId: string,
    principal: PrivacyPrincipal,
    caseId: string,
    personId: string,
    now: Date,
  ): Promise<void> {
    await this.#runStep(actionId, "DATABASE", now, async () => {
      const client = await this.#pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SELECT set_config('app.retention_action_id',$1,true)`, [actionId]);
        const results = await Promise.all([
          client.query(
            `UPDATE messages SET content_bytes=NULL,content_hash=NULL,
               provider_message_id='disposed:'||id,reply_to_provider_message_id=NULL,
               sender_person_id=NULL,sender_contact_point_id=NULL
             WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId],
          ),
          client.query(
            `UPDATE inbox_events e SET payload_bytes=''::bytea,
               payload_hash=encode(digest('','sha256'),'hex')
             WHERE e.organization_id=$1
               AND EXISTS (SELECT 1 FROM inbox_event_items i
                 WHERE i.inbox_event_id=e.id AND i.case_id=$2)
               AND NOT EXISTS (SELECT 1 FROM inbox_event_items i
                 WHERE i.inbox_event_id=e.id AND i.case_id IS DISTINCT FROM $2)`,
            [principal.organizationId, caseId],
          ),
          client.query(
            `UPDATE claims SET content='[disposed]',updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId, now],
          ),
          client.query(
            `UPDATE brief_revisions SET snapshot='{}',snapshot_hash=encode(digest('{}','sha256'),'hex'),reason='privacy_disposition',updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId, now],
          ),
          client.query(
            `UPDATE model_invocations SET context_package='{}',structured_output=NULL,provider_response_id=NULL,error_code=coalesce(error_code,'privacy_disposition') WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId],
          ),
          client.query(
            `UPDATE model_candidate_batches SET output='{}' WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId],
          ),
          client.query(
            `UPDATE research_requests SET question='[disposed]',updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId, now],
          ),
          client.query(
            `UPDATE next_action_proposals SET question=CASE WHEN question IS NULL THEN NULL ELSE '[disposed]' END,summary=CASE WHEN summary IS NULL THEN NULL ELSE '[disposed]' END,target_topic=CASE WHEN target_topic IS NULL THEN NULL ELSE '[disposed]' END,referenced_claim_ids='[]',updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId, now],
          ),
          client.query(
            `UPDATE conversations SET external_thread_id=NULL,version=version+1,updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId, now],
          ),
          client.query(
            `UPDATE interviews SET pending_question=NULL,resume_next_action=NULL,version=version+1,updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId, now],
          ),
          client.query(
            `UPDATE external_sources SET canonical_url='disposed:'||id,title='[disposed]',publisher='[disposed]',excerpt='[disposed]',content_hash=NULL,source_version=NULL WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId],
          ),
          client.query(
            `UPDATE inbox_event_items SET provider_message_id=NULL,sender_external_id=NULL,
               reply_to_provider_message_id=NULL,text_content=NULL,
               clarification_prompt=CASE WHEN status='AMBIGUOUS' THEN '[disposed]' ELSE NULL END
             WHERE organization_id=$1 AND case_id=$2`,
            [principal.organizationId, caseId],
          ),
          client.query(
            `UPDATE media_references SET provider_media_id='disposed:'||media_references.id,filename=NULL,sha256=NULL FROM inbox_event_items i WHERE media_references.inbox_item_id=i.id AND i.organization_id=$1 AND i.case_id=$2`,
            [principal.organizationId, caseId],
          ),
          client.query(
            `UPDATE contact_points cp SET value_ciphertext='[disposed]',fingerprint=encode(digest(id::text,'sha256'),'hex'),provider=NULL,external_id=NULL,verified_at=NULL,delivery_blocked_at=$3,delivery_block_reason='privacy_disposition',version=version+1,updated_at=$3
             WHERE cp.organization_id=$1 AND cp.person_id=$2
               AND NOT EXISTS (SELECT 1 FROM case_participants p
                 WHERE p.organization_id=cp.organization_id AND p.person_id=cp.person_id
                   AND p.case_id <> $4)`,
            [principal.organizationId, personId, now, caseId],
          ),
        ]);
        await client.query("COMMIT");
        return results.reduce((sum, result) => sum + (result.rowCount ?? 0), 0);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async #completeMarkerStep(
    actionId: string,
    step: "JOBS" | "DERIVATIVES",
    principal: PrivacyPrincipal,
    caseId: string,
    now: Date,
  ): Promise<void> {
    await this.#runStep(actionId, step, now, async () => {
      const statements =
        step === "JOBS"
          ? [
              `UPDATE outbox_events SET payload='{}',status=CASE WHEN status IN ('PENDING','DISPATCHING') THEN 'CANCELLED'::outbox_status ELSE status END,locked_at=NULL,last_error_code='privacy_disposition',updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
              `UPDATE brief_synthesis_requests SET status=CASE WHEN status IN ('READY','RUNNING') THEN 'FAILED'::brief_synthesis_status ELSE status END,error_code='privacy_disposition',updated_at=$3 WHERE organization_id=$1 AND case_id=$2`,
            ]
          : [
              `UPDATE email_delivery_outbox_secrets s SET ciphertext=NULL,initialization_vector=NULL,authentication_tag=NULL,destroyed_at=$3 FROM email_deliveries d WHERE s.delivery_id=d.id AND d.organization_id=$1 AND d.case_id=$2 AND s.destroyed_at IS NULL`,
              `UPDATE email_webhook_events w SET payload_bytes=''::bytea,payload_hash=encode(digest('','sha256'),'hex') FROM email_deliveries d WHERE w.delivery_id=d.id AND d.organization_id=$1 AND d.case_id=$2`,
            ];
      let count = 0;
      for (const statement of statements) {
        const parameters = statement.includes("$3")
          ? [principal.organizationId, caseId, now]
          : [principal.organizationId, caseId];
        const result = await this.#pool.query(statement, parameters);
        count += result.rowCount ?? 0;
      }
      return count;
    });
  }

  async #runStep(
    actionId: string,
    step: string,
    now: Date,
    operation: () => Promise<number | { count: number; checkpoint: string }>,
  ): Promise<void> {
    const state = await this.#pool.query<{ status: string }>(
      `SELECT status FROM retention_disposition_steps WHERE action_id=$1 AND step=$2`,
      [actionId, step],
    );
    if (state.rows[0]?.status === "COMPLETED") return;
    await this.#pool.query(
      `UPDATE retention_disposition_steps SET attempts=attempts+1,last_error_code=NULL,updated_at=$3
       WHERE action_id=$1 AND step=$2`,
      [actionId, step, now],
    );
    try {
      const outcome = await operation();
      const count = typeof outcome === "number" ? outcome : outcome.count;
      const checkpoint = typeof outcome === "number" ? null : outcome.checkpoint;
      await this.#pool.query(
        `UPDATE retention_disposition_steps SET status='COMPLETED',disposed_count=$3,
           result_checkpoint=$4,completed_at=$5,last_error_code=NULL,updated_at=$5
         WHERE action_id=$1 AND step=$2`,
        [actionId, step, count, checkpoint, now],
      );
    } catch (error) {
      await this.#pool.query(
        `UPDATE retention_disposition_steps SET last_error_code='disposition_interrupted',updated_at=$3
         WHERE action_id=$1 AND step=$2`,
        [actionId, step, now],
      );
      throw error;
    }
  }

  async #stepCheckpoint(actionId: string): Promise<string> {
    return this.#pool
      .query<{ checkpoint: string }>(
        `SELECT result_checkpoint checkpoint FROM retention_disposition_steps
         WHERE action_id=$1 AND step='RESULT_JOURNAL' AND status='COMPLETED'`,
        [actionId],
      )
      .then((result) => result.rows[0]?.checkpoint ?? "confirmed");
  }

  async #authorize(
    client: PoolClient,
    principal: PrivacyPrincipal,
    input: { caseId: string; personId: string },
    now: Date,
  ) {
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const authenticatedAge = now.getTime() - principal.authenticatedAt.getTime();
    const identityAge = now.getTime() - principal.identityVerifiedAt.getTime();
    if (authenticatedAge < 0 || authenticatedAge > RECENT_AUTHENTICATION_MS)
      throw new Error("privacy_recent_authentication_required");
    if (identityAge < 0 || identityAge > RECENT_IDENTITY_VERIFICATION_MS)
      throw new Error("privacy_identity_verification_required");
    const subject = await client
      .query<{
        person_version: number;
        case_status: string;
        case_created_at: Date;
        participant_count: number;
      }>(
        `SELECT p.version person_version,c.status case_status,c.created_at case_created_at,
           (SELECT count(*)::integer FROM case_participants allp
             WHERE allp.organization_id=c.organization_id AND allp.case_id=c.id) participant_count
         FROM prospect_cases c JOIN case_participants cp
           ON cp.organization_id=c.organization_id AND cp.case_id=c.id AND cp.person_id=$3
         JOIN people p ON p.organization_id=cp.organization_id AND p.id=cp.person_id
         JOIN operator_memberships m ON m.organization_id=c.organization_id
           AND m.user_id=$4 AND m.role='ENGINEER' AND m.active
         JOIN operator_case_assignments a ON a.organization_id=c.organization_id
           AND a.case_id=c.id AND a.user_id=m.user_id AND a.active
         WHERE c.organization_id=$1 AND c.id=$2`,
        [principal.organizationId, input.caseId, input.personId, principal.userId],
      )
      .then((result) => result.rows[0]);
    if (!subject) throw new Error("privacy_request_not_authorized");
    return subject;
  }

  async #existingRequest(
    client: PoolClient,
    organizationId: string,
    input: { caseId: string; personId: string; idempotencyKey: string },
  ): Promise<string | undefined> {
    return client
      .query<{ id: string }>(
        `SELECT id FROM privacy_requests WHERE organization_id=$1 AND case_id=$2
           AND person_id=$3 AND idempotency_key=$4 AND kind='ACCESS_EXPORT'`,
        [organizationId, input.caseId, input.personId, input.idempotencyKey],
      )
      .then((result) => result.rows[0]?.id);
  }

  async #audit(
    client: PoolClient,
    principal: PrivacyPrincipal,
    caseId: string,
    resourceId: string,
    action: string,
    occurredAt: Date,
    metadata: Record<string, unknown> = {},
    resourceType = "privacy_request",
    result: "SUCCEEDED" | "FAILED" = "SUCCEEDED",
  ): Promise<void> {
    await client.query(
      `INSERT INTO audit_events
        (organization_id,case_id,actor,action,resource_type,resource_id,result,
         correlation_id,origin,metadata,occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'privacy-store',$9,$10)`,
      [
        principal.organizationId,
        caseId,
        `operator:${principal.userId}`,
        action,
        resourceType,
        resourceId,
        result,
        randomUUID(),
        JSON.stringify(metadata),
        occurredAt,
      ],
    );
  }
}
