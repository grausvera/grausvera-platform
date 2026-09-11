import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { InterviewStore } from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const store = new InterviewStore(connectionString);
let organizationId: string;
const personId = randomUUID();
const contactPointId = randomUUID();
const connectionId = randomUUID();
let consentPolicyId: string;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  await pool.query(`INSERT INTO people (id, organization_id) VALUES ($1, $2)`, [
    personId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO contact_points
      (id, organization_id, person_id, kind, value_ciphertext, fingerprint,
       source, purpose, provider, external_id)
     VALUES ($1, $2, $3, 'WHATSAPP', 'synthetic', $4,
       'synthetic', 'interview-test', 'META', $5)`,
    [
      contactPointId,
      organizationId,
      personId,
      `interview-${contactPointId}`,
      `interview-${personId}`,
    ],
  );
  await pool.query(
    `INSERT INTO provider_connections
      (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/interview')`,
    [connectionId, organizationId, `interview-${connectionId}`],
  );
  consentPolicyId = await pool
    .query<{ id: string }>(
      `INSERT INTO consent_policies
        (id, organization_id, purpose, channel, locale, version, notice_text,
         notice_hash, scope, effective_at)
       VALUES ($1, $2, 'DISCOVERY', 'WHATSAPP', 'es-PE-interview', 1,
         'synthetic notice', repeat('b', 64), 'PROJECT_DISCOVERY', now() - interval '1 hour')
       RETURNING id`,
      [randomUUID(), organizationId],
    )
    .then((result) => result.rows[0]?.id ?? "");
});

afterAll(async () => {
  await store.close();
  await pool.end();
});

async function createCase(consented: boolean) {
  const caseId = randomUUID();
  await pool.query(
    `INSERT INTO prospect_cases (id, organization_id, status, next_action)
     VALUES ($1, $2, 'INTERVIEWING', 'ASK_QUESTION')`,
    [caseId, organizationId],
  );
  if (!consented) return caseId;
  const conversationId = randomUUID();
  const consentMessageId = randomUUID();
  await pool.query(
    `INSERT INTO case_participants (organization_id, case_id, person_id, role)
     VALUES ($1, $2, $3, 'REQUESTER')`,
    [organizationId, caseId, personId],
  );
  await pool.query(
    `INSERT INTO conversations (id, organization_id, case_id, provider_connection_id)
     VALUES ($1, $2, $3, $4)`,
    [conversationId, organizationId, caseId, connectionId],
  );
  await pool.query(
    `INSERT INTO messages
      (id, organization_id, case_id, conversation_id, provider_connection_id, direction,
       provider_message_id, message_type, content_bytes, provider_occurred_at,
       sender_person_id, sender_contact_point_id)
     VALUES ($1, $2, $3, $4, $5, 'INBOUND', $6, 'text', $7, now(), $8, $9)`,
    [
      consentMessageId,
      organizationId,
      caseId,
      conversationId,
      connectionId,
      `wamid.interview.${consentMessageId}`,
      Buffer.from("ACEPTO"),
      personId,
      contactPointId,
    ],
  );
  await pool.query(
    `INSERT INTO consent_records
      (organization_id, case_id, person_id, contact_point_id, policy_id, purpose,
       action, source_message_id, policy_version, notice_hash, channel, locale,
       scope, occurred_at, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, 'DISCOVERY', 'ACCEPTED', $6, 1,
       repeat('b', 64), 'WHATSAPP', 'es-PE-interview', 'PROJECT_DISCOVERY', now(), $7)`,
    [
      organizationId,
      caseId,
      personId,
      contactPointId,
      consentPolicyId,
      consentMessageId,
      randomUUID(),
    ],
  );
  return caseId;
}

describe("persistent interview", () => {
  it("requires current consent and creates one versioned interview under replay", async () => {
    const caseWithoutConsent = await createCase(false);
    await expect(
      store.create({ organizationId, caseId: caseWithoutConsent, correlationId: randomUUID() }),
    ).rejects.toThrow("interview_consent_required");

    const caseId = await createCase(true);
    const results = await Promise.all([
      store.create({ organizationId, caseId, correlationId: randomUUID() }),
      store.create({ organizationId, caseId, correlationId: randomUUID() }),
    ]);
    expect(results.filter((result) => result.created)).toHaveLength(1);
    expect(new Set(results.map((result) => result.interview.id)).size).toBe(1);
    expect(results[0]?.interview).toMatchObject({
      caseId,
      policyVersion: 1,
      status: "NOT_STARTED",
      pendingQuestion: null,
      version: 1,
    });
    expect(results[0]?.interview.topics.map((topic) => topic.key)).toEqual([
      "PROJECT_INTENT",
      "AUDIENCE",
      "DESIRED_OUTCOME",
      "CONTEXT",
      "CONSTRAINTS",
    ]);
  });

  it("persists topics and pending question with optimistic versioning", async () => {
    const caseId = await createCase(true);
    const created = await store.create({ organizationId, caseId, correlationId: randomUUID() });
    const partial = await store.update({
      organizationId,
      caseId,
      expectedVersion: created.interview.version,
      topicStates: { PROJECT_INTENT: "CAPTURED", AUDIENCE: "NOT_APPLICABLE" },
      pendingQuestion: "¿Qué resultado debería producir el proyecto?",
      correlationId: randomUUID(),
    });
    expect(partial).toMatchObject({
      status: "ACTIVE",
      pendingQuestion: "¿Qué resultado debería producir el proyecto?",
      version: 2,
    });
    await expect(
      store.update({
        organizationId,
        caseId,
        expectedVersion: 1,
        topicStates: { CONTEXT: "CAPTURED" },
        correlationId: randomUUID(),
      }),
    ).rejects.toThrow("interview_version_conflict");
    const reloaded = await store.get(organizationId, caseId);
    expect(reloaded).toEqual(partial);

    const completed = await store.update({
      organizationId,
      caseId,
      expectedVersion: partial.version,
      topicStates: {
        DESIRED_OUTCOME: "CAPTURED",
        CONTEXT: "CAPTURED",
        CONSTRAINTS: "CAPTURED",
      },
      pendingQuestion: null,
      correlationId: randomUUID(),
    });
    expect(completed).toMatchObject({ status: "SUFFICIENT", pendingQuestion: null, version: 3 });
  });

  it("keeps an interview pinned to its immutable policy version", async () => {
    const caseId = await createCase(true);
    const created = await store.create({ organizationId, caseId, correlationId: randomUUID() });
    await pool.query(
      `INSERT INTO interview_policies (organization_id, version, topics, effective_at)
       VALUES ($1, 2, '[{"key":"PROJECT_INTENT","required":true}]', now() + interval '1 minute')`,
      [organizationId],
    );
    expect(await store.get(organizationId, caseId)).toMatchObject({
      id: created.interview.id,
      policyVersion: 1,
    });
    await expect(
      pool.query(`UPDATE interview_policies SET locale = 'es' WHERE organization_id = $1`, [
        organizationId,
      ]),
    ).rejects.toThrow("interview policy is immutable");
  });
});
