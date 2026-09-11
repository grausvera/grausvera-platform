import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { KnowledgeStore, type KnowledgeOperatorPrincipal } from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const knowledge = new KnowledgeStore(connectionString);
let organizationId: string;
const caseId = randomUUID();
const foreignCaseId = randomUUID();
const targetClaimId = randomUUID();
const foreignClaimId = randomUUID();
const originalSourceId = randomUUID();
const correctionSourceId = randomUUID();
const foreignSourceId = randomUUID();
const operatorUserId = `operator-${randomUUID()}`;
let principal: KnowledgeOperatorPrincipal;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  principal = { userId: operatorUserId, organizationId, twoFactorVerified: true };
  await pool.query(`INSERT INTO prospect_cases (id, organization_id) VALUES ($1, $3), ($2, $3)`, [
    caseId,
    foreignCaseId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO claims
      (id, organization_id, case_id, kind, category, content, confidence_basis_points,
       sensitivity, audience, creator)
     VALUES
      ($1, $3, $4, 'FACT', 'PROJECT_INTENT', 'original statement', 7000,
       'CONFIDENTIAL', 'INTERNAL', 'HUMAN'),
      ($2, $3, $5, 'FACT', 'PROJECT_INTENT', 'foreign statement', 7000,
       'CONFIDENTIAL', 'INTERNAL', 'HUMAN')`,
    [targetClaimId, foreignClaimId, organizationId, caseId, foreignCaseId],
  );
  await pool.query(
    `INSERT INTO external_sources
      (id, organization_id, case_id, canonical_url, title, publisher, accessed_at,
       excerpt, content_hash, purpose, confidence_basis_points)
     VALUES
      ($1, $4, $5, 'https://example.invalid/original', 'Original source', 'Example', now(),
       'Original evidence', repeat('a', 64), 'PROJECT_DISCOVERY', 7000),
      ($2, $4, $5, 'https://example.invalid/correction', 'Correction source', 'Example', now(),
       'Correction evidence', repeat('b', 64), 'PROJECT_DISCOVERY', 9000),
      ($3, $4, $6, 'https://example.invalid/foreign', 'Foreign source', 'Example', now(),
       'Foreign evidence', repeat('c', 64), 'PROJECT_DISCOVERY', 9000)`,
    [originalSourceId, correctionSourceId, foreignSourceId, organizationId, caseId, foreignCaseId],
  );
  await pool.query(
    `INSERT INTO claim_sources
      (organization_id, case_id, claim_id, external_source_id, relation)
     VALUES ($1, $2, $3, $4, 'SUPPORTS')`,
    [organizationId, caseId, targetClaimId, originalSourceId],
  );
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     VALUES ($1, 'operator', $2, true)`,
    [operatorUserId, `${operatorUserId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id, user_id) VALUES ($1, $2)`, [
    organizationId,
    operatorUserId,
  ]);
  await pool.query(
    `INSERT INTO operator_case_assignments (organization_id, case_id, user_id)
     VALUES ($1, $2, $3)`,
    [organizationId, caseId, operatorUserId],
  );
});

afterAll(async () => {
  await knowledge.close();
  await pool.end();
});

describe("protected human claim correction", () => {
  it("preserves original evidence and rejects unassigned cases and foreign sources", async () => {
    const correction = {
      caseId,
      targetClaimId,
      replacement: "corrected statement",
      confidenceBasisPoints: 9500,
      source: { kind: "EXTERNAL" as const, id: correctionSourceId, relation: "SUPPORTS" as const },
      correlationId: randomUUID(),
    };
    await expect(
      knowledge.correctClaim({ ...principal, twoFactorVerified: false }, correction),
    ).rejects.toThrow("operator_two_factor_required");
    await expect(
      knowledge.correctClaim(principal, {
        ...correction,
        caseId: foreignCaseId,
        targetClaimId: foreignClaimId,
      }),
    ).rejects.toThrow("claim_correction_not_authorized");
    await expect(
      knowledge.correctClaim(principal, {
        ...correction,
        source: { kind: "EXTERNAL", id: foreignSourceId, relation: "SUPPORTS" },
      }),
    ).rejects.toThrow("claim_correction_source_not_allowed");

    const result = await knowledge.correctClaim(principal, correction);
    await expect(knowledge.correctClaim(principal, correction)).rejects.toThrow(
      "claim_correction_not_authorized",
    );
    const state = await pool.query(
      `SELECT
        (SELECT jsonb_build_object('content', content, 'validity', validity)
         FROM claims WHERE id = $1) AS original,
        (SELECT jsonb_build_object('content', content, 'validity', validity,
          'creator', creator, 'confirmed', confirmed)
         FROM claims WHERE id = $2) AS correction,
        (SELECT count(*)::integer FROM claim_sources
         WHERE claim_id = $1 AND external_source_id = $3) AS original_sources,
        (SELECT count(*)::integer FROM claim_sources
         WHERE claim_id = $2 AND external_source_id = $4) AS correction_sources,
        (SELECT count(*)::integer FROM claim_relations
         WHERE source_claim_id = $2 AND target_claim_id = $1 AND relation = 'REPLACES') AS replacements,
        (SELECT count(*)::integer FROM audit_events
         WHERE case_id = $5 AND resource_id = $2 AND action = 'claim.corrected') AS audits,
        (SELECT count(*)::integer FROM model_invocations WHERE case_id = $5) AS invocations`,
      [targetClaimId, result.claimId, originalSourceId, correctionSourceId, caseId],
    );
    expect(state.rows[0]).toEqual({
      original: { content: "original statement", validity: "REPLACED" },
      correction: {
        content: "corrected statement",
        validity: "CURRENT",
        creator: "HUMAN",
        confirmed: true,
      },
      original_sources: 1,
      correction_sources: 1,
      replacements: 1,
      audits: 1,
      invocations: 0,
    });
  });
});
