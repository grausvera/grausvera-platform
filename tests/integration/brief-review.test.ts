import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { BriefReviewStore } from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
const pool = new Pool({ connectionString });
const store = new BriefReviewStore(connectionString);
let organizationId: string;
let operatorUserId: string;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id,slug,display_name) VALUES ($1,'grausvera','grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name=excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  operatorUserId = `brief-review-${randomUUID()}`;
  await pool.query(
    `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,'brief reviewer',$2,true)`,
    [operatorUserId, `${operatorUserId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id,user_id) VALUES ($1,$2)`, [
    organizationId,
    operatorUserId,
  ]);
});

afterAll(async () => {
  await store.close();
  await pool.end();
});

async function revision(status: "DRAFT" | "IN_REVIEW" = "DRAFT") {
  const caseId = randomUUID();
  await pool.query(
    `INSERT INTO prospect_cases (id,organization_id,status,knowledge_version)
     VALUES ($1,$2,'ENGINEER_REVIEW',1)`,
    [caseId, organizationId],
  );
  await pool.query(
    `INSERT INTO operator_case_assignments (organization_id,case_id,user_id)
     VALUES ($1,$2,$3)`,
    [organizationId, caseId, operatorUserId],
  );
  const briefId = await pool
    .query<{ id: string }>(
      `INSERT INTO briefs (organization_id,case_id) VALUES ($1,$2) RETURNING id`,
      [organizationId, caseId],
    )
    .then((result) => result.rows[0]?.id ?? "");
  const revisionId = randomUUID();
  const snapshot = JSON.stringify({ problem: "Synthetic review" });
  await pool.query(
    `INSERT INTO brief_revisions
      (id,organization_id,case_id,brief_id,revision_number,status,snapshot,snapshot_hash,
       knowledge_version,template_id,template_version,policy_version,creator,
       created_by_user_id,reason)
     VALUES ($1,$2,$3,$4,1,$5,$6::jsonb,encode(digest($6::jsonb::text,'sha256'),'hex'),
       1,'discovery-brief',1,1,'HUMAN',$7,'Synthetic review fixture')`,
    [revisionId, organizationId, caseId, briefId, status, snapshot, operatorUserId],
  );
  const snapshotHash = await pool
    .query<{ snapshot_hash: string }>(`SELECT snapshot_hash FROM brief_revisions WHERE id=$1`, [
      revisionId,
    ])
    .then((result) => result.rows[0]?.snapshot_hash ?? "");
  return { caseId, briefId, revisionId, snapshotHash };
}

async function submitReview(item: Awaited<ReturnType<typeof revision>>) {
  await pool.query(`UPDATE brief_revisions SET status='IN_REVIEW' WHERE id=$1`, [item.revisionId]);
  return pool
    .query<{ id: string }>(
      `INSERT INTO brief_reviews
        (organization_id,case_id,brief_id,revision_id,reviewer_user_id)
       VALUES ($1,$2,$3,$4,$5) RETURNING id`,
      [organizationId, item.caseId, item.briefId, item.revisionId, operatorUserId],
    )
    .then((result) => result.rows[0]?.id ?? "");
}

describe("exact brief review and approval records", () => {
  it("rejects a review before the revision enters review", async () => {
    const item = await revision();
    await expect(
      pool.query(
        `INSERT INTO brief_reviews
          (organization_id,case_id,brief_id,revision_id,reviewer_user_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [organizationId, item.caseId, item.briefId, item.revisionId, operatorUserId],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("does not authorize a pending review or an unmatched snapshot", async () => {
    const item = await revision();
    const reviewId = await submitReview(item);
    await expect(
      pool.query(`UPDATE brief_revisions SET status='APPROVED' WHERE id=$1`, [item.revisionId]),
    ).rejects.toMatchObject({ code: "23514" });
    const approval = (snapshotHash: string) =>
      pool.query(
        `INSERT INTO brief_approvals
          (organization_id,case_id,brief_id,revision_id,review_id,snapshot_hash,
           approved_by_user_id,authentication_method,authenticated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PASSWORD_TOTP',now())`,
        [
          organizationId,
          item.caseId,
          item.briefId,
          item.revisionId,
          reviewId,
          snapshotHash,
          operatorUserId,
        ],
      );
    await expect(approval(item.snapshotHash)).rejects.toMatchObject({ code: "23514" });
    await pool.query(
      `UPDATE brief_reviews SET status='APPROVED',comments='Reviewed',decided_at=now()
       WHERE id=$1`,
      [reviewId],
    );
    await expect(approval("0".repeat(64))).rejects.toMatchObject({ code: "23514" });
    const approvalId = await approval(item.snapshotHash).then((result) => result.rows[0]?.id);
    await expect(approval(item.snapshotHash)).rejects.toMatchObject({ code: "23505" });
    await expect(
      pool.query(`UPDATE brief_revisions SET status='APPROVED' WHERE id=$1`, [item.revisionId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    const storedApproval = await pool
      .query<{ id: string }>(
        `SELECT id FROM brief_approvals WHERE organization_id=$1 AND revision_id=$2`,
        [organizationId, item.revisionId],
      )
      .then((result) => result.rows[0]?.id ?? approvalId ?? "");
    await pool.query(
      `UPDATE brief_approvals SET status='REVOKED',revoked_at=now(),updated_at=now() WHERE id=$1`,
      [storedApproval],
    );
    await expect(
      pool.query(
        `UPDATE brief_approvals SET status='ACTIVE',revoked_at=NULL,updated_at=now() WHERE id=$1`,
        [storedApproval],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps review decisions immutable", async () => {
    const item = await revision();
    const reviewId = await submitReview(item);
    await pool.query(`UPDATE brief_reviews SET status='REJECTED',decided_at=now() WHERE id=$1`, [
      reviewId,
    ]);
    await expect(
      pool.query(`UPDATE brief_reviews SET status='APPROVED' WHERE id=$1`, [reviewId]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      pool.query(`DELETE FROM brief_reviews WHERE id=$1`, [reviewId]),
    ).rejects.toMatchObject({ code: "55000" });
  });
});

describe("governed brief review workflow", () => {
  const principal = () => ({
    userId: operatorUserId,
    organizationId,
    twoFactorVerified: true,
  });

  async function recentPrincipal(now: Date) {
    const authenticatedAt = new Date(now.getTime() - 60_000);
    const sessionId = `review-session-${randomUUID()}`;
    await pool.query(
      `INSERT INTO "session" (id,"expiresAt",token,"createdAt","updatedAt","userId")
       VALUES ($1,$2,$3,$4,$4,$5)`,
      [
        sessionId,
        new Date(now.getTime() + 3_600_000),
        randomUUID(),
        authenticatedAt,
        operatorUserId,
      ],
    );
    return { ...principal(), sessionId, authenticatedAt };
  }

  it("lists, submits and edits by creating a new immutable revision", async () => {
    const item = await revision();
    await expect(store.listQueue(principal())).resolves.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: item.revisionId, status: "DRAFT" })]),
    );
    await store.submit(principal(), {
      revisionId: item.revisionId,
      correlationId: randomUUID(),
    });
    const edited = await store.edit(principal(), {
      revisionId: item.revisionId,
      snapshot: { problem: "Corrected synthetic review" },
      reason: "Correct material detail",
      correlationId: randomUUID(),
    });
    const state = await pool.query(
      `SELECT
       (SELECT status FROM brief_revisions WHERE id=$1) base_status,
       (SELECT is_candidate FROM brief_revisions WHERE id=$1) base_candidate,
       (SELECT status FROM brief_reviews WHERE revision_id=$1) review_status,
       (SELECT revision_number FROM brief_revisions WHERE id=$2) new_number,
       (SELECT base_revision_id FROM brief_revisions WHERE id=$2) new_base,
       (SELECT status FROM brief_revisions WHERE id=$2) new_status`,
      [item.revisionId, edited.revisionId],
    );
    expect(state.rows[0]).toEqual({
      base_status: "SUPERSEDED",
      base_candidate: false,
      review_status: "REJECTED",
      new_number: 2,
      new_base: item.revisionId,
      new_status: "DRAFT",
    });
  });

  it("approves without email but leaves delivery pending", async () => {
    const item = await revision();
    await store.submit(principal(), {
      revisionId: item.revisionId,
      correlationId: randomUUID(),
    });
    const now = new Date("2026-09-10T20:00:00.000Z");
    const authenticated = await recentPrincipal(now);
    const approved = await store.approve(
      authenticated,
      { revisionId: item.revisionId, comments: "Ready", correlationId: randomUUID() },
      now,
    );
    const state = await pool.query(
      `SELECT a.status approval_status,r.status revision_status,c.status case_status,c.next_action,
       (SELECT count(*)::integer FROM outbox_events WHERE case_id=$2) outbound
       FROM brief_approvals a JOIN brief_revisions r ON r.id=a.revision_id
       JOIN prospect_cases c ON c.id=a.case_id
       WHERE a.id=$1`,
      [approved.approvalId, item.caseId],
    );
    expect(state.rows[0]).toEqual({
      approval_status: "ACTIVE",
      revision_status: "APPROVED",
      case_status: "AWAITING_EMAIL_VERIFICATION",
      next_action: "VERIFY_DELIVERY_EMAIL",
      outbound: 0,
    });
  });

  it("rejects a pending review without creating approval or delivery", async () => {
    const item = await revision();
    await store.submit(principal(), {
      revisionId: item.revisionId,
      correlationId: randomUUID(),
    });
    await store.reject(principal(), {
      revisionId: item.revisionId,
      comments: "Needs correction",
      correlationId: randomUUID(),
    });
    const state = await pool.query(
      `SELECT r.status revision_status,v.status review_status,c.next_action,
       (SELECT count(*)::integer FROM brief_approvals WHERE revision_id=$1) approvals
       FROM brief_revisions r JOIN brief_reviews v ON v.revision_id=r.id
       JOIN prospect_cases c ON c.id=r.case_id WHERE r.id=$1`,
      [item.revisionId],
    );
    expect(state.rows[0]).toEqual({
      revision_status: "WITHDRAWN",
      review_status: "REJECTED",
      next_action: "REVISE_BRIEF",
      approvals: 0,
    });
  });

  it("rejects partial authorization and an old authenticated session", async () => {
    const item = await revision();
    await expect(
      store.submit(
        { ...principal(), twoFactorVerified: false },
        { revisionId: item.revisionId, correlationId: randomUUID() },
      ),
    ).rejects.toThrow("operator_two_factor_required");
    const foreignUserId = `foreign-review-${randomUUID()}`;
    await pool.query(
      `INSERT INTO "user" (id,name,email,"emailVerified") VALUES ($1,'foreign reviewer',$2,true)`,
      [foreignUserId, `${foreignUserId}@example.invalid`],
    );
    await pool.query(`INSERT INTO operator_memberships (organization_id,user_id) VALUES ($1,$2)`, [
      organizationId,
      foreignUserId,
    ]);
    await expect(
      store.getRevision({ ...principal(), userId: foreignUserId }, item.revisionId),
    ).rejects.toThrow("brief_review_not_authorized");
    await store.submit(principal(), {
      revisionId: item.revisionId,
      correlationId: randomUUID(),
    });
    const now = new Date("2026-09-10T21:00:00.000Z");
    const stale = await recentPrincipal(now);
    stale.authenticatedAt = new Date(now.getTime() - 5 * 60 * 1000);
    await expect(
      store.approve(stale, { revisionId: item.revisionId, correlationId: randomUUID() }, now),
    ).rejects.toThrow("operator_recent_authentication_required");
    const state = await pool.query(
      `SELECT r.status revision_status,v.status review_status,
       (SELECT count(*)::integer FROM brief_approvals WHERE revision_id=$1) approvals
       FROM brief_revisions r JOIN brief_reviews v ON v.revision_id=r.id WHERE r.id=$1`,
      [item.revisionId],
    );
    expect(state.rows[0]).toEqual({
      revision_status: "IN_REVIEW",
      review_status: "PENDING",
      approvals: 0,
    });
  });

  it("allows only one decision when approvals race", async () => {
    const item = await revision();
    await store.submit(principal(), {
      revisionId: item.revisionId,
      correlationId: randomUUID(),
    });
    const now = new Date("2026-09-10T22:00:00.000Z");
    const authenticated = await recentPrincipal(now);
    const attempts = await Promise.allSettled([
      store.approve(
        authenticated,
        { revisionId: item.revisionId, correlationId: randomUUID() },
        now,
      ),
      store.approve(
        authenticated,
        { revisionId: item.revisionId, correlationId: randomUUID() },
        now,
      ),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const state = await pool.query(
      `SELECT
       (SELECT count(*)::integer FROM brief_approvals WHERE revision_id=$1) approvals,
       (SELECT status FROM brief_revisions WHERE id=$1) revision_status,
       (SELECT status FROM brief_reviews WHERE revision_id=$1) review_status`,
      [item.revisionId],
    );
    expect(state.rows[0]).toEqual({
      approvals: 1,
      revision_status: "APPROVED",
      review_status: "APPROVED",
    });
  });

  it("never leaves an approval active for a superseded snapshot", async () => {
    const item = await revision();
    await store.submit(principal(), {
      revisionId: item.revisionId,
      correlationId: randomUUID(),
    });
    const now = new Date("2026-09-10T23:00:00.000Z");
    const authenticated = await recentPrincipal(now);
    const original = await store.getRevision(principal(), item.revisionId);
    const race = await Promise.allSettled([
      store.approve(
        authenticated,
        { revisionId: item.revisionId, correlationId: randomUUID() },
        now,
      ),
      store.edit(principal(), {
        revisionId: item.revisionId,
        snapshot: { problem: "Concurrent corrected snapshot" },
        reason: "Concurrent correction",
        correlationId: randomUUID(),
      }),
    ]);
    expect(race.some((attempt) => attempt.status === "fulfilled")).toBe(true);
    const state = await pool.query(
      `SELECT r.status,r.is_candidate,r.snapshot,
       (SELECT count(*)::integer FROM brief_approvals a
        WHERE a.revision_id=r.id AND a.status='ACTIVE') active_approvals,
       (SELECT count(*)::integer FROM brief_revisions n
        WHERE n.base_revision_id=r.id AND n.is_candidate) replacements
       FROM brief_revisions r WHERE r.id=$1`,
      [item.revisionId],
    );
    if (state.rows[0].status === "SUPERSEDED") {
      expect(state.rows[0]).toMatchObject({
        is_candidate: false,
        snapshot: original.snapshot,
        active_approvals: 0,
        replacements: 1,
      });
    } else {
      expect(state.rows[0]).toMatchObject({
        status: "APPROVED",
        is_candidate: true,
        snapshot: original.snapshot,
        active_approvals: 1,
        replacements: 0,
      });
    }
  });
});
