import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
let organizationId: string;
let caseId: string;
let operatorUserId: string;
let claimId: string;

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  caseId = randomUUID();
  operatorUserId = `brief-${randomUUID()}`;
  claimId = randomUUID();
  await pool.query(
    `INSERT INTO prospect_cases (id, organization_id, status, knowledge_version)
     VALUES ($1, $2, 'READY_FOR_SYNTHESIS', 4)`,
    [caseId, organizationId],
  );
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     VALUES ($1, 'brief operator', $2, true)`,
    [operatorUserId, `${operatorUserId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id, user_id) VALUES ($1, $2)`, [
    organizationId,
    operatorUserId,
  ]);
  await pool.query(
    `INSERT INTO claims
      (id, organization_id, case_id, kind, category, content, confidence_basis_points,
       sensitivity, audience, creator)
     VALUES ($1, $2, $3, 'FACT', 'PROJECT_INTENT', 'Synthetic exact claim', 9000,
       'CONFIDENTIAL', 'INTERNAL', 'HUMAN')`,
    [claimId, organizationId, caseId],
  );
});

afterAll(async () => pool.end());

describe("immutable brief revisions", () => {
  it("keeps one stable brief identity per case and purpose", async () => {
    await pool.query(`INSERT INTO briefs (organization_id, case_id) VALUES ($1, $2)`, [
      organizationId,
      caseId,
    ]);
    await expect(
      pool.query(`INSERT INTO briefs (organization_id, case_id) VALUES ($1, $2)`, [
        organizationId,
        caseId,
      ]),
    ).rejects.toMatchObject({ code: "23505" });
  });

  it("pins an immutable snapshot and exact ordered claims", async () => {
    const briefId = await pool
      .query<{ id: string }>(`SELECT id FROM briefs WHERE case_id = $1`, [caseId])
      .then((result) => result.rows[0]?.id ?? "");
    const revisionId = randomUUID();
    const snapshot = { problem: "Synthetic problem", outcomes: ["Synthetic outcome"] };
    await pool.query(
      `INSERT INTO brief_revisions
        (id, organization_id, case_id, brief_id, revision_number, snapshot, snapshot_hash,
         knowledge_version, template_id, template_version, policy_version, creator,
         created_by_user_id, reason)
       VALUES ($1, $2, $3, $4, 1, $5::jsonb,
         encode(digest($5::jsonb::text, 'sha256'), 'hex'), 4, 'discovery-brief', 1, 1,
         'HUMAN', $6, 'Initial synthetic snapshot')`,
      [revisionId, organizationId, caseId, briefId, JSON.stringify(snapshot), operatorUserId],
    );
    await expect(
      pool.query(
        `INSERT INTO brief_revision_claims
          (organization_id, case_id, brief_id, revision_id, claim_id, position,
           claim_content_hash, claim_validity)
         VALUES ($1, $2, $3, $4, $5, 0, $6, 'CURRENT')`,
        [organizationId, caseId, briefId, revisionId, claimId, "0".repeat(64)],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `INSERT INTO brief_revision_claims
        (organization_id, case_id, brief_id, revision_id, claim_id, position,
         claim_content_hash, claim_validity)
       VALUES ($1, $2, $3, $4, $5, 0, $6, 'CURRENT')`,
      [organizationId, caseId, briefId, revisionId, claimId, hash("Synthetic exact claim")],
    );

    await expect(
      pool.query(`UPDATE brief_revisions SET snapshot = '{}'::jsonb WHERE id = $1`, [revisionId]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`UPDATE brief_revision_claims SET position = 1 WHERE revision_id = $1`, [
        revisionId,
      ]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`UPDATE brief_revisions SET status = 'IN_REVIEW' WHERE id = $1`, [revisionId]),
    ).resolves.toMatchObject({ rowCount: 1 });
  });

  it("allows one current candidate and requires an exact base for later revisions", async () => {
    const first = await pool
      .query<{ id: string; brief_id: string }>(
        `SELECT id, brief_id FROM brief_revisions WHERE case_id = $1 AND revision_number = 1`,
        [caseId],
      )
      .then((result) => result.rows[0]);
    if (!first) throw new Error("brief_revision_fixture_missing");
    const snapshot = { problem: "Revised synthetic problem" };
    await expect(
      pool.query(
        `INSERT INTO brief_revisions
          (organization_id, case_id, brief_id, revision_number, base_revision_id,
           snapshot, snapshot_hash, knowledge_version, template_id, template_version,
           policy_version, creator, created_by_user_id, reason)
         VALUES ($1, $2, $3, 2, $4, $5::jsonb,
           encode(digest($5::jsonb::text, 'sha256'), 'hex'), 4, 'discovery-brief', 1, 1,
           'HUMAN', $6, 'Candidate collision')`,
        [
          organizationId,
          caseId,
          first.brief_id,
          first.id,
          JSON.stringify(snapshot),
          operatorUserId,
        ],
      ),
    ).rejects.toMatchObject({ code: "23505" });

    await pool.query(
      `UPDATE brief_revisions SET status = 'SUPERSEDED', is_candidate = false WHERE id = $1`,
      [first.id],
    );
    await expect(
      pool.query(
        `INSERT INTO brief_revisions
          (organization_id, case_id, brief_id, revision_number, base_revision_id,
           snapshot, snapshot_hash, knowledge_version, template_id, template_version,
           policy_version, creator, created_by_user_id, reason)
         VALUES ($1, $2, $3, 2, $4, $5::jsonb,
           encode(digest($5::jsonb::text, 'sha256'), 'hex'), 4, 'discovery-brief', 1, 1,
           'HUMAN', $6, 'Material revision')`,
        [
          organizationId,
          caseId,
          first.brief_id,
          first.id,
          JSON.stringify(snapshot),
          operatorUserId,
        ],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
  });
});
