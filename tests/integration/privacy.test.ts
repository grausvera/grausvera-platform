import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type DeletionJournalEntry,
  type DeletionJournalResult,
  type DeletionJournalPort,
  type PrivacyPrincipal,
  PrivacyStore,
} from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const store = new PrivacyStore(connectionString);
const userId = `privacy-${randomUUID()}`;
let organizationId: string;
let caseId: string;
let secondCaseId: string;
let personId: string;
let otherPersonId: string;
let messageId: string;
let claimId: string;
let connectionId: string;
let erasureActionId: string;
let erasureIdempotencyKey: string;
const journalResults: DeletionJournalResult[] = [];
const subjectCanary = "subject-canary-message";
const thirdPartyCanary = "third-party-canary-message";

function principal(now = new Date()): PrivacyPrincipal {
  return {
    userId,
    organizationId,
    twoFactorVerified: true,
    authenticatedAt: new Date(now.getTime() - 30_000),
    identityVerifiedAt: new Date(now.getTime() - 30_000),
  };
}

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id,slug,display_name) VALUES ($1,'grausvera','grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name=excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  caseId = randomUUID();
  secondCaseId = randomUUID();
  personId = randomUUID();
  otherPersonId = randomUUID();
  messageId = randomUUID();
  claimId = randomUUID();
  connectionId = randomUUID();
  const conversationId = randomUUID();
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,'privacy operator',$2,true)`,
    [userId, `${userId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id,user_id) VALUES ($1,$2)`, [
    organizationId,
    userId,
  ]);
  await pool.query(
    `INSERT INTO prospect_cases (id,organization_id,status) VALUES
      ($1,$3,'INTERVIEWING'),($2,$3,'INTERVIEWING')`,
    [caseId, secondCaseId, organizationId],
  );
  await pool.query(`INSERT INTO people (id,organization_id) VALUES ($1,$3),($2,$3)`, [
    personId,
    otherPersonId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO case_participants (organization_id,case_id,person_id,role) VALUES
      ($1,$2,$3,'REQUESTER'),($1,$2,$4,'COLLABORATOR'),($1,$5,$4,'REQUESTER')`,
    [organizationId, caseId, personId, otherPersonId, secondCaseId],
  );
  await pool.query(
    `INSERT INTO operator_case_assignments (organization_id,case_id,user_id) VALUES
      ($1,$2,$4),($1,$3,$4)`,
    [organizationId, caseId, secondCaseId, userId],
  );
  await pool.query(
    `INSERT INTO outbox_events
      (organization_id,case_id,event_type,aggregate_type,aggregate_id,payload,idempotency_key,deadline_at)
     VALUES ($1,$2,'synthetic.privacy.pending','prospect_case',$2,$3,$4,now()+interval '1 hour')`,
    [
      organizationId,
      secondCaseId,
      JSON.stringify({ text: thirdPartyCanary }),
      `privacy-pending-${randomUUID()}`,
    ],
  );
  await pool.query(
    `INSERT INTO contact_points
      (organization_id,person_id,kind,value_ciphertext,fingerprint,source,purpose) VALUES
      ($1,$2,'EMAIL',$4,$5,'TEST','PRIVACY'),($1,$3,'EMAIL',$6,$7,'TEST','PRIVACY')`,
    [
      organizationId,
      personId,
      otherPersonId,
      "encrypted-subject-contact",
      randomUUID(),
      "encrypted-third-party-contact",
      randomUUID(),
    ],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id,organization_id,kind,external_account_id,credential_reference)
     VALUES ($1,$2,'WHATSAPP',$3,'secret://synthetic/privacy')`,
    [connectionId, organizationId, `privacy-${connectionId}`],
  );
  await pool.query(
    `INSERT INTO conversations (id,organization_id,case_id,provider_connection_id)
     VALUES ($1,$2,$3,$4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
  const otherMessageId = randomUUID();
  await pool.query(
    `INSERT INTO messages
      (id,organization_id,case_id,conversation_id,provider_connection_id,direction,
       provider_message_id,message_type,content_bytes,provider_occurred_at,sender_person_id) VALUES
      ($1,$3,$4,$5,$6,'INBOUND',$7,'text',$8,now(),$9),
      ($2,$3,$4,$5,$6,'INBOUND',$10,'text',$11,now(),$12)`,
    [
      messageId,
      otherMessageId,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `subject-${messageId}`,
      Buffer.from(subjectCanary),
      personId,
      `other-${otherMessageId}`,
      Buffer.from(thirdPartyCanary),
      otherPersonId,
    ],
  );
  const otherClaimId = randomUUID();
  await pool.query(
    `INSERT INTO claims
      (id,organization_id,case_id,kind,category,content,confidence_basis_points,
       sensitivity,audience,creator) VALUES
      ($1,$3,$4,'FACT','PROJECT_INTENT',$5,9000,'CONFIDENTIAL','INTERNAL','HUMAN'),
      ($2,$3,$4,'FACT','PROJECT_INTENT',$6,9000,'CONFIDENTIAL','INTERNAL','HUMAN')`,
    [claimId, otherClaimId, organizationId, caseId, subjectCanary, thirdPartyCanary],
  );
  await pool.query(
    `INSERT INTO claim_sources (organization_id,case_id,claim_id,message_id,relation) VALUES
      ($1,$2,$3,$4,'SUPPORTS'),($1,$2,$5,$6,'SUPPORTS')`,
    [organizationId, caseId, claimId, messageId, otherClaimId, otherMessageId],
  );
});

afterAll(async () => {
  await store.close();
  await pool.end();
});

describe("privacy requests and independent deletion intent", () => {
  it("exports only the verified subject scope and replays without a duplicate request", async () => {
    const now = new Date();
    const input = { caseId, personId, idempotencyKey: `export-${randomUUID()}`, now };
    const first = await store.exportSubject(principal(now), input);
    const replay = await store.exportSubject(principal(now), input);
    expect(replay.requestId).toBe(first.requestId);
    expect(JSON.stringify(first)).toContain(subjectCanary);
    expect(JSON.stringify(first)).not.toContain(thirdPartyCanary);
    expect(JSON.stringify(first)).not.toContain("encrypted-subject-contact");
    expect(first.revisions).toEqual([]);
    const evidence = await pool.query(
      `SELECT p.status,p.kind,count(a.id)::integer audits FROM privacy_requests p
       LEFT JOIN audit_events a ON a.resource_id=p.id AND a.action='privacy.exported'
       WHERE p.id=$1 GROUP BY p.id`,
      [first.requestId],
    );
    expect(evidence.rows[0]).toEqual({ status: "COMPLETED", kind: "ACCESS_EXPORT", audits: 1 });
  });

  it("rectifies through the existing claim history instead of rewriting evidence", async () => {
    const now = new Date();
    const input = {
      caseId,
      personId,
      targetClaimId: claimId,
      replacement: "subject corrected fact",
      confidenceBasisPoints: 10_000,
      source: { kind: "MESSAGE", id: messageId, relation: "SUPPORTS" },
      correlationId: randomUUID(),
      idempotencyKey: `rectify-${randomUUID()}`,
      now,
    } as const;
    const corrected = await store.rectifyClaim(principal(now), input);
    await expect(store.rectifyClaim(principal(now), input)).resolves.toEqual(corrected);
    const state = await pool.query(
      `SELECT
        (SELECT validity FROM claims WHERE id=$1) old_validity,
        (SELECT content FROM claims WHERE id=$2) replacement,
        (SELECT status FROM privacy_requests WHERE id=$3) request_status,
        (SELECT count(*)::integer FROM audit_events WHERE resource_id=$3
          AND action='privacy.rectified') audits`,
      [claimId, corrected.claimId, corrected.requestId],
    );
    expect(state.rows[0]).toEqual({
      old_validity: "REPLACED",
      replacement: "subject corrected fact",
      request_status: "COMPLETED",
      audits: 1,
    });
  });

  it("requires recent authentication, verified identity, and exact person/case scope", async () => {
    const now = new Date();
    const input = { caseId, personId, idempotencyKey: randomUUID(), now };
    await expect(
      store.exportSubject(
        { ...principal(now), authenticatedAt: new Date(now.getTime() - 6 * 60_000) },
        input,
      ),
    ).rejects.toThrow("privacy_recent_authentication_required");
    await expect(
      store.exportSubject(
        { ...principal(now), identityVerifiedAt: new Date(now.getTime() - 16 * 60_000) },
        input,
      ),
    ).rejects.toThrow("privacy_identity_verification_required");
    await expect(
      store.exportSubject(principal(now), { ...input, caseId: secondCaseId }),
    ).rejects.toThrow("privacy_request_not_authorized");
  });

  it("keeps processing blocked when the independent journal is unavailable", async () => {
    const now = new Date();
    const entries: DeletionJournalEntry[] = [];
    const unavailable: DeletionJournalPort = {
      async append(entry) {
        entries.push(entry);
        throw new Error("journal offline");
      },
    };
    await expect(
      store.requestErasure(
        principal(now),
        { caseId: secondCaseId, personId: otherPersonId, idempotencyKey: randomUUID(), now },
        unavailable,
      ),
    ).rejects.toThrow("privacy_journal_unavailable");
    expect(JSON.stringify(entries)).not.toContain(thirdPartyCanary);
    const state = await pool.query(
      `SELECT c.status,c.next_action,r.status retention_status,r.last_error_code,
        (SELECT count(*)::integer FROM messages WHERE case_id=$1) messages,
        (SELECT count(*)::integer FROM outbox_events WHERE case_id=$1 AND status='PENDING') pending_outbox,
        (SELECT count(*)::integer FROM outbox_events WHERE case_id=$1 AND status='CANCELLED') cancelled_outbox
       FROM prospect_cases c JOIN retention_actions r ON r.case_id=c.id WHERE c.id=$1`,
      [secondCaseId],
    );
    expect(state.rows[0]).toEqual({
      status: "PAUSED",
      next_action: "PRIVACY_ERASURE_PENDING",
      retention_status: "JOURNAL_PENDING",
      last_error_code: "journal_unavailable",
      messages: 0,
      pending_outbox: 0,
      cancelled_outbox: 1,
    });
  });

  it("records the opaque journal checkpoint before permitting later disposition", async () => {
    const now = new Date();
    const entries: DeletionJournalEntry[] = [];
    const journal: DeletionJournalPort = {
      async append(entry) {
        entries.push(entry);
        return { checkpoint: `checkpoint-${randomUUID()}` };
      },
      async appendResult(entry) {
        journalResults.push(entry);
        return { checkpoint: `result-${randomUUID()}` };
      },
    };
    erasureIdempotencyKey = `erase-${randomUUID()}`;
    const input = {
      caseId,
      personId,
      idempotencyKey: erasureIdempotencyKey,
      now,
    };
    const confirmed = await store.requestErasure(principal(now), input, journal);
    erasureActionId = confirmed.actionId;
    const replay = await store.requestErasure(principal(now), input, journal);
    expect(replay).toEqual({ ...confirmed, replayed: true });
    expect(entries).toHaveLength(1);
    await expect(
      store.requestErasure(
        principal(now),
        {
          caseId: secondCaseId,
          personId: otherPersonId,
          idempotencyKey: erasureIdempotencyKey,
          now,
        },
        journal,
      ),
    ).rejects.toThrow("privacy_request_not_authorized");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.integrityHash).toBe(
      createHash("sha256")
        .update(
          JSON.stringify({
            actionId: confirmed.actionId,
            requestId: confirmed.requestId,
            scope: ["case", "person", "objects", "jobs", "derivatives"],
            cutoffAt: now.toISOString(),
          }),
        )
        .digest("hex"),
    );
    const state = await pool.query(
      `SELECT r.status,r.journal_checkpoint,p.status request_status,
        (SELECT count(*)::integer FROM audit_events WHERE resource_id=r.id
          AND action IN ('retention.intent_created','retention.journal_confirmed')) audits
       FROM retention_actions r JOIN privacy_requests p ON p.id=r.privacy_request_id
       WHERE r.id=$1`,
      [confirmed.actionId],
    );
    expect(state.rows[0]).toEqual({
      status: "JOURNALED",
      journal_checkpoint: confirmed.checkpoint,
      request_status: "IN_PROGRESS",
      audits: 2,
    });
    await expect(
      pool.query(`UPDATE retention_actions SET journal_checkpoint='replaced' WHERE id=$1`, [
        confirmed.actionId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("resumes an interrupted disposition and leaves the neighboring case intact", async () => {
    const inboxEventId = randomUUID();
    const inboxItemId = randomUUID();
    const mediaReferenceId = randomUUID();
    const objectKey = `privacy/${randomUUID()}.bin`;
    await pool.query(
      `INSERT INTO case_participants (organization_id,case_id,person_id,role)
       VALUES ($1,$2,$3,'COLLABORATOR')`,
      [organizationId, secondCaseId, personId],
    );
    await pool.query(
      `INSERT INTO inbox_events
        (id,organization_id,provider_connection_id,external_event_id,payload_bytes,payload_hash)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        inboxEventId,
        organizationId,
        connectionId,
        `privacy-event-${randomUUID()}`,
        Buffer.from(subjectCanary),
        createHash("sha256").update(subjectCanary).digest("hex"),
      ],
    );
    await pool.query(
      `INSERT INTO inbox_event_items
        (id,inbox_event_id,organization_id,provider_connection_id,item_key,kind,
         provider_occurred_at,received_ordinal,case_id,text_content)
       VALUES ($1,$2,$3,$4,$5,'MESSAGE',now(),0,$6,$7)`,
      [
        inboxItemId,
        inboxEventId,
        organizationId,
        connectionId,
        randomUUID(),
        caseId,
        subjectCanary,
      ],
    );
    await pool.query(
      `INSERT INTO media_references (id,inbox_item_id,provider_media_id,media_type)
       VALUES ($1,$2,$3,'document')`,
      [mediaReferenceId, inboxItemId, `media-${randomUUID()}`],
    );
    await pool.query(
      `INSERT INTO attachments
        (organization_id,case_id,media_reference_id,object_key,mime_type,size_bytes,sha256)
       VALUES ($1,$2,$3,$4,'application/octet-stream',1,$5)`,
      [organizationId, caseId, mediaReferenceId, objectKey, "a".repeat(64)],
    );
    const oldSnapshot = await pool.query(
      `SELECT
        (SELECT convert_from(content_bytes,'UTF8') FROM messages WHERE id=$1) target_content,
        (SELECT payload->>'text' FROM outbox_events WHERE case_id=$2) neighbor_content`,
      [messageId, secondCaseId],
    );
    expect(oldSnapshot.rows[0]).toEqual({
      target_content: subjectCanary,
      neighbor_content: thirdPartyCanary,
    });
    let failOnce = true;
    const removed: string[] = [];
    const objects = {
      async remove(key: string) {
        if (failOnce) {
          failOnce = false;
          throw new Error("synthetic object outage");
        }
        removed.push(key);
      },
    };
    const journal: DeletionJournalPort = {
      async append() {
        throw new Error("intent already exists");
      },
      async appendResult(entry) {
        journalResults.push(entry);
        return { checkpoint: `result-${randomUUID()}` };
      },
    };
    const input = { actionId: erasureActionId, caseId, personId, now: new Date() };
    await expect(
      store.executeErasure(principal(input.now), input, objects, journal),
    ).rejects.toThrow("synthetic object outage");
    const interrupted = await pool.query(
      `SELECT r.status,s.status step_status,s.attempts,s.last_error_code
       FROM retention_actions r JOIN retention_disposition_steps s ON s.action_id=r.id
       WHERE r.id=$1 AND s.step='OBJECTS'`,
      [erasureActionId],
    );
    expect(interrupted.rows[0]).toEqual({
      status: "EXECUTING",
      step_status: "PENDING",
      attempts: 1,
      last_error_code: "disposition_interrupted",
    });

    const completed = await store.executeErasure(principal(input.now), input, objects, journal);
    expect(completed.replayed).toBe(false);
    expect(removed).toEqual([objectKey]);
    expect(journalResults).toHaveLength(1);
    const state = await pool.query(
      `SELECT r.status,p.status request_status,
        (SELECT content_bytes IS NULL FROM messages WHERE id=$2) message_disposed,
        (SELECT payload_bytes=''::bytea FROM inbox_events WHERE id=$6) inbox_disposed,
        (SELECT content FROM claims WHERE id=$3) claim_content,
        (SELECT value_ciphertext FROM contact_points WHERE person_id=$4) contact_value,
        (SELECT payload->>'text' FROM outbox_events WHERE case_id=$5) neighbor_text,
        (SELECT count(*)::integer FROM retention_disposition_steps
          WHERE action_id=$1 AND status='COMPLETED') completed_steps
       FROM retention_actions r JOIN privacy_requests p ON p.id=r.privacy_request_id WHERE r.id=$1`,
      [erasureActionId, messageId, claimId, personId, secondCaseId, inboxEventId],
    );
    expect(state.rows[0]).toEqual({
      status: "COMPLETED",
      request_status: "COMPLETED",
      message_disposed: true,
      inbox_disposed: true,
      claim_content: "[disposed]",
      contact_value: "encrypted-subject-contact",
      neighbor_text: thirdPartyCanary,
      completed_steps: 5,
    });
    await expect(
      store.executeErasure(principal(input.now), input, objects, journal),
    ).resolves.toEqual({
      actionId: erasureActionId,
      resultCheckpoint: completed.resultCheckpoint,
      replayed: true,
    });
    expect(journalResults).toHaveLength(1);
  });
});
