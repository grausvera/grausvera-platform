import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hardenOperatorSecurityChange } from "../../apps/web/app/api/auth/[...all]/route";
import { getAuth } from "../../apps/web/lib/auth";
import {
  BriefSynthesisStore,
  KnowledgeStore,
  OperatorConsoleStore,
  type OperatorPrincipal,
  ResearchStore,
} from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for security tests");

const pool = new Pool({ connectionString });
const store = new OperatorConsoleStore(connectionString);
const knowledge = new KnowledgeStore(connectionString);
const research = new ResearchStore(connectionString);
const synthesis = new BriefSynthesisStore(connectionString);
const userId = `operator-${randomUUID()}`;
const caseId = randomUUID();
const personId = randomUUID();
const contactPointId = randomUUID();
const connectionId = randomUUID();
const conversationId = randomUUID();
const claimId = randomUUID();
const externalSourceId = randomUUID();
let organizationId: string;
const foreignOrganizationId = randomUUID();
const foreignCaseId = randomUUID();
let principal: OperatorPrincipal;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "twoFactorEnabled")
     VALUES ($1, 'synthetic operator', $2, true, now(), now(), true)`,
    [userId, `${userId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id, user_id) VALUES ($1, $2)`, [
    organizationId,
    userId,
  ]);
  await pool.query(
    `INSERT INTO prospect_cases (id, organization_id, status, next_action)
     VALUES ($1, $2, 'INTERVIEWING', 'ASK_QUESTION')`,
    [caseId, organizationId],
  );
  await pool.query(`INSERT INTO people (id, organization_id) VALUES ($1, $2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO contact_points
      (id, organization_id, person_id, kind, value_ciphertext, fingerprint,
       source, purpose, provider, external_id)
     VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4,
       'synthetic', 'security-test', 'META', $5)`,
    [
      contactPointId,
      organizationId,
      personId,
      `fingerprint-${contactPointId}`,
      `recipient-${personId}`,
    ],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/operator')`,
    [connectionId, organizationId, `operator-${connectionId}`],
  );
  await pool.query(
    `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
  await pool.query(
    `INSERT INTO messages
      (organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, content_bytes, provider_occurred_at,
       sender_person_id, sender_contact_point_id)
     VALUES ($1, $2, $3, $4, 'INBOUND', $5, 'text', $6, now(), $7, $8)`,
    [
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.${caseId}`,
      Buffer.from("hola"),
      personId,
      contactPointId,
    ],
  );
  await pool.query(
    `INSERT INTO claims
      (id, organization_id, case_id, kind, category, content, confidence_basis_points,
       sensitivity, audience, creator)
     VALUES ($1, $2, $3, 'FACT', 'PROJECT_INTENT', 'synthetic console claim', 8000,
       'CONFIDENTIAL', 'INTERNAL', 'HUMAN')`,
    [claimId, organizationId, caseId],
  );
  await pool.query(
    `INSERT INTO external_sources
      (id, organization_id, case_id, canonical_url, title, publisher, accessed_at,
       excerpt, content_hash, purpose, confidence_basis_points)
     VALUES ($1, $2, $3, 'https://example.invalid/console-source', 'Console source',
       'Example', now(), 'Synthetic console evidence', repeat('e', 64),
       'PROJECT_DISCOVERY', 8000)`,
    [externalSourceId, organizationId, caseId],
  );
  await pool.query(
    `INSERT INTO claim_sources
      (organization_id, case_id, claim_id, external_source_id, relation)
     VALUES ($1, $2, $3, $4, 'SUPPORTS')`,
    [organizationId, caseId, claimId, externalSourceId],
  );
  principal = { userId, organizationId, twoFactorVerified: true };
});

afterAll(async () => {
  await pool.query(
    `UPDATE outbox_events SET status = 'CANCELLED', last_error_code = 'security_test_cleanup'
     WHERE authorized_operator_user_id = $1 AND status IN ('PENDING', 'DISPATCHING')`,
    [userId],
  );
  await store.close();
  await knowledge.close();
  await research.close();
  await synthesis.close();
  await pool.end();
});

describe("operator console authorization", () => {
  it("keeps public operator registration disabled", async () => {
    process.env.BETTER_AUTH_SECRET = "synthetic-security-secret-with-32-characters";
    await expect(
      getAuth().api.signUpEmail({
        body: {
          name: "unauthorized",
          email: `unauthorized-${randomUUID()}@example.invalid`,
          password: "synthetic-password-not-a-secret",
        },
      }),
    ).rejects.toThrow();
  });

  it("rejects partial 2FA and an identity without an active membership", async () => {
    await expect(store.listCases({ ...principal, twoFactorVerified: false })).rejects.toThrow(
      "operator_two_factor_required",
    );
    await expect(
      store.getCase({ ...principal, userId: `foreign-${randomUUID()}` }, caseId),
    ).rejects.toThrow("operator_forbidden");
    await expect(
      knowledge.listCaseClaims({ ...principal, twoFactorVerified: false }, caseId),
    ).rejects.toThrow("operator_two_factor_required");
    await expect(
      knowledge.listCaseClaims({ ...principal, userId: `foreign-${randomUUID()}` }, caseId),
    ).rejects.toThrow("knowledge_case_not_authorized");
  });

  it("rejects foreign reads, mutations, and jobs without another permission system", async () => {
    const foreignPrincipal = { ...principal, organizationId: foreignOrganizationId };
    await expect(store.listCases(foreignPrincipal)).rejects.toThrow("operator_forbidden");
    await expect(store.getCase(foreignPrincipal, caseId)).rejects.toThrow("operator_forbidden");
    await expect(knowledge.listCaseClaims(foreignPrincipal, caseId)).rejects.toThrow(
      "knowledge_case_not_authorized",
    );
    await expect(store.getCase(principal, foreignCaseId)).rejects.toThrow(
      "operator_case_not_found",
    );
    await expect(knowledge.listCaseClaims(principal, foreignCaseId)).rejects.toThrow(
      "knowledge_case_not_authorized",
    );
    await expect(store.takeCase(foreignPrincipal, caseId, randomUUID())).rejects.toThrow(
      "operator_forbidden",
    );
    await expect(store.pauseCase(foreignPrincipal, caseId, randomUUID())).rejects.toThrow(
      "operator_forbidden",
    );
    await expect(
      research.authorize(foreignPrincipal, {
        caseId,
        question: "Foreign synthetic question",
        correlationId: randomUUID(),
      }),
    ).rejects.toThrow("research_not_authorized");
    await expect(
      synthesis.claim({
        organizationId: foreignOrganizationId,
        caseId,
        attemptKey: randomUUID(),
      }),
    ).rejects.toThrow("brief_synthesis_case_not_ready");
  });

  it("navigates an authorized claim to its external provenance", async () => {
    await expect(knowledge.listCaseClaims(principal, caseId)).resolves.toEqual([
      expect.objectContaining({
        claim: expect.objectContaining({ id: claimId, content: "synthetic console claim" }),
        sources: [
          expect.objectContaining({
            kind: "EXTERNAL",
            referenceId: externalSourceId,
            href: "https://example.invalid/console-source",
          }),
        ],
      }),
    ]);
  });

  it("does not allow a response before the operator takes the case", async () => {
    await expect(
      store.respond(principal, {
        caseId,
        text: "respuesta no autorizada",
        idempotencyKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).rejects.toThrow("operator_case_assignment_required");
  });

  it("takes and pauses the case before creating one audited human response", async () => {
    await store.takeCase(principal, caseId, randomUUID());
    await store.pauseCase(principal, caseId, randomUUID());
    const idempotencyKey = randomUUID();
    const input = {
      caseId,
      text: "Respuesta humana sintética",
      idempotencyKey,
      correlationId: randomUUID(),
    };
    const first = await store.respond(principal, input);
    const replay = await store.respond(principal, { ...input, correlationId: randomUUID() });
    expect(replay).toEqual(first);

    const result = await pool.query(
      `SELECT pc.status AS case_status, pc.next_action, o.status AS outbox_status, o.event_type,
              o.authorized_operator_user_id,
              (SELECT count(*)::integer FROM audit_events
               WHERE case_id = $1 AND action = 'case.responded') AS response_audits
       FROM prospect_cases pc JOIN outbox_events o ON o.id = $2 WHERE pc.id = $1`,
      [caseId, first.outboxEventId],
    );
    expect(result.rows[0]).toEqual({
      case_status: "PAUSED",
      next_action: "OPERATOR_PAUSED",
      outbox_status: "PENDING",
      event_type: "whatsapp.human.response.v1",
      authorized_operator_user_id: userId,
      response_audits: 1,
    });
    const audits = await pool.query(
      `SELECT actor,action,resource_type,resource_id,expected_version,result,
         correlation_id,origin FROM audit_events
       WHERE case_id=$1 AND action IN ('case.taken','case.paused','case.responded')
       ORDER BY occurred_at,id`,
      [caseId],
    );
    expect(audits.rows).toHaveLength(3);
    for (const audit of audits.rows) {
      expect(audit).toMatchObject({
        actor: `operator:${userId}`,
        resource_type: "prospect_case",
        resource_id: caseId,
        result: "SUCCEEDED",
        origin: "operator-console",
      });
      expect(audit.expected_version).toBeGreaterThan(0);
      expect(audit.correlation_id).toMatch(/^[a-f0-9-]{36}$/);
    }
  });

  it("revokes incompatible sessions after recovery or a TOTP reset", async () => {
    const currentId = `session-${randomUUID()}`;
    const otherId = `session-${randomUUID()}`;
    await pool.query(
      `INSERT INTO "session" (id,"expiresAt",token,"updatedAt","userId")
       VALUES ($1,now()+interval '1 hour',$2,now(),$3),
              ($4,now()+interval '1 hour',$5,now(),$3)`,
      [currentId, randomUUID(), userId, otherId, randomUUID()],
    );
    await hardenOperatorSecurityChange(userId, currentId, "authentication.recovered");
    await expect(
      pool.query(`SELECT id FROM "session" WHERE "userId"=$1`, [userId]).then((r) => r.rows),
    ).resolves.toEqual([{ id: currentId }]);
    await hardenOperatorSecurityChange(userId, null, "authentication.totp_reset");
    const state = await pool.query(
      `SELECT
       (SELECT count(*)::integer FROM "session" WHERE "userId"=$1) sessions,
       (SELECT count(*)::integer FROM audit_events WHERE actor=$2
         AND action IN ('authentication.recovered','authentication.totp_reset')) audits`,
      [userId, `operator:${userId}`],
    );
    expect(state.rows[0]).toEqual({ sessions: 0, audits: 2 });
  });
});
