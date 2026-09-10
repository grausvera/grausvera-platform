import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString, max: 1 });
let client: PoolClient;

async function expectConstraint(query: string, values: unknown[], code: string) {
  const savepoint = `constraint_${randomUUID().replaceAll("-", "")}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    await expect(client.query(query, values)).rejects.toMatchObject({ code });
  } finally {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  }
}

beforeAll(async () => {
  client = await pool.connect();
  await client.query("BEGIN");
});

afterAll(async () => {
  await client.query("ROLLBACK");
  client.release();
  await pool.end();
});

describe("private data roots", () => {
  it("isolates two cases by explicit membership and preserves audit evidence", async () => {
    let organizationId = randomUUID();
    const firstCaseId = randomUUID();
    const secondCaseId = randomUUID();
    const firstPersonId = randomUUID();
    const secondPersonId = randomUUID();
    const connectionId = randomUUID();
    const auditId = randomUUID();

    await client
      .query(
        `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
         ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
        [organizationId],
      )
      .then((result) => {
        organizationId = result.rows[0].id;
      });
    await client.query(`INSERT INTO people (id, organization_id) VALUES ($1, $3), ($2, $3)`, [
      firstPersonId,
      secondPersonId,
      organizationId,
    ]);
    await client.query(
      `INSERT INTO prospect_cases (id, organization_id) VALUES ($1, $3), ($2, $3)`,
      [firstCaseId, secondCaseId, organizationId],
    );
    await client.query(
      `INSERT INTO case_participants (organization_id, case_id, person_id, role)
       VALUES ($1, $2, $3, 'REQUESTER'), ($1, $4, $5, 'REQUESTER')`,
      [organizationId, firstCaseId, firstPersonId, secondCaseId, secondPersonId],
    );
    await client.query(
      `INSERT INTO provider_connections (id, organization_id, kind, external_account_id, credential_reference)
       VALUES ($1, $2, 'WHATSAPP', 'synthetic-account', 'secret://synthetic/whatsapp')`,
      [connectionId, organizationId],
    );
    await client.query(
      `INSERT INTO conversations (organization_id, case_id, provider_connection_id, external_thread_id)
       VALUES ($1, $2, $4, 'thread-a'), ($1, $3, $4, 'thread-b')`,
      [organizationId, firstCaseId, secondCaseId, connectionId],
    );
    await client.query(
      `INSERT INTO audit_events (id, organization_id, case_id, actor, action, resource_type, resource_id, expected_version, result, correlation_id, origin)
       VALUES ($1, $2, $3, 'system', 'case.created', 'prospect_case', $3, 1, 'SUCCEEDED', $4, 'integration-test')`,
      [auditId, organizationId, firstCaseId, randomUUID()],
    );

    const result = await client.query(
      `SELECT case_id, count(*)::integer AS conversations
       FROM conversations WHERE organization_id = $1 AND case_id = ANY($2::uuid[])
       GROUP BY case_id ORDER BY case_id`,
      [organizationId, [firstCaseId, secondCaseId]],
    );
    expect(result.rows).toEqual([
      { case_id: [firstCaseId, secondCaseId].sort()[0], conversations: 1 },
      { case_id: [firstCaseId, secondCaseId].sort()[1], conversations: 1 },
    ]);

    await expectConstraint(
      `INSERT INTO organizations (slug, display_name) VALUES ('client', 'synthetic client')`,
      [],
      "23514",
    );
    await expectConstraint(
      `UPDATE prospect_cases SET version = 0 WHERE id = $1`,
      [firstCaseId],
      "23514",
    );
    await expectConstraint(
      `INSERT INTO case_participants (organization_id, case_id, person_id, role)
       VALUES ($1, $2, $3, 'COLLABORATOR')`,
      [randomUUID(), firstCaseId, firstPersonId],
      "23503",
    );
    await expectConstraint(
      `UPDATE audit_events SET action = 'changed' WHERE id = $1`,
      [auditId],
      "55000",
    );
    await expectConstraint(`DELETE FROM audit_events WHERE id = $1`, [auditId], "55000");
  });
});
