import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { OperatorPrincipal } from "./operator-console.js";

const RECENT_AUTHENTICATION_MS = 5 * 60 * 1000;

export interface BriefReviewPrincipal extends OperatorPrincipal {
  sessionId?: string;
  authenticatedAt?: Date;
}

export class BriefReviewStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close() {
    return this.#pool.end();
  }

  async #authorize(
    client: PoolClient,
    principal: BriefReviewPrincipal,
    caseId?: string,
  ): Promise<void> {
    if (!principal.twoFactorVerified) throw new Error("operator_two_factor_required");
    const authorized = await client.query(
      `SELECT 1 FROM operator_memberships m
       WHERE m.organization_id=$1 AND m.user_id=$2 AND m.role='ENGINEER' AND m.active
       AND ($3::uuid IS NULL OR EXISTS (
         SELECT 1 FROM operator_case_assignments a WHERE a.organization_id=m.organization_id
           AND a.case_id=$3 AND a.user_id=m.user_id AND a.active))`,
      [principal.organizationId, principal.userId, caseId ?? null],
    );
    if ((authorized.rowCount ?? 0) !== 1) throw new Error("brief_review_not_authorized");
  }

  async listQueue(principal: BriefReviewPrincipal) {
    const client = await this.#pool.connect();
    try {
      await this.#authorize(client, principal);
      const result = await client.query<{
        id: string;
        case_id: string;
        revision_number: number;
        status: string;
        review_status: string | null;
        updated_at: Date;
      }>(
        `SELECT r.id,r.case_id,r.revision_number,r.status,v.status review_status,r.updated_at
         FROM brief_revisions r
         JOIN operator_case_assignments a ON a.organization_id=r.organization_id
           AND a.case_id=r.case_id AND a.user_id=$2 AND a.active
         LEFT JOIN brief_reviews v ON v.organization_id=r.organization_id AND v.revision_id=r.id
         WHERE r.organization_id=$1 AND r.is_candidate
           AND r.status IN ('DRAFT','IN_REVIEW','APPROVED')
         ORDER BY r.updated_at,r.id`,
        [principal.organizationId, principal.userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        caseId: row.case_id,
        revisionNumber: row.revision_number,
        status: row.status,
        reviewStatus: row.review_status,
        updatedAt: row.updated_at,
      }));
    } finally {
      client.release();
    }
  }

  async getRevision(principal: BriefReviewPrincipal, revisionId: string) {
    const client = await this.#pool.connect();
    try {
      const revision = await client
        .query<{
          id: string;
          case_id: string;
          revision_number: number;
          status: string;
          snapshot: unknown;
          snapshot_hash: string;
          review_id: string | null;
          review_status: string | null;
          comments: string | null;
        }>(
          `SELECT r.id,r.case_id,r.revision_number,r.status,r.snapshot,r.snapshot_hash,
           v.id review_id,v.status review_status,v.comments
           FROM brief_revisions r LEFT JOIN brief_reviews v
             ON v.organization_id=r.organization_id AND v.revision_id=r.id
           WHERE r.organization_id=$1 AND r.id=$2`,
          [principal.organizationId, revisionId],
        )
        .then((result) => result.rows[0]);
      if (!revision) throw new Error("brief_revision_not_found");
      await this.#authorize(client, principal, revision.case_id);
      return {
        id: revision.id,
        caseId: revision.case_id,
        revisionNumber: revision.revision_number,
        status: revision.status,
        snapshot: revision.snapshot,
        snapshotHash: revision.snapshot_hash,
        reviewId: revision.review_id,
        reviewStatus: revision.review_status,
        comments: revision.comments,
      };
    } finally {
      client.release();
    }
  }

  async edit(
    principal: BriefReviewPrincipal,
    input: { revisionId: string; snapshot: unknown; reason: string; correlationId: string },
  ) {
    if (!input.snapshot || typeof input.snapshot !== "object" || Array.isArray(input.snapshot))
      throw new Error("brief_snapshot_invalid");
    const serialized = JSON.stringify(input.snapshot);
    if (serialized.length > 100_000) throw new Error("brief_snapshot_invalid");
    const reason = input.reason.trim();
    if (!reason || reason.length > 500) throw new Error("brief_revision_reason_invalid");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const base = await this.#lockRevision(client, principal, input.revisionId);
      if (!base.is_candidate || !["DRAFT", "IN_REVIEW", "APPROVED"].includes(base.status))
        throw new Error("brief_revision_not_editable");
      await client.query(
        `UPDATE brief_approvals SET status='REVOKED',revoked_at=now(),updated_at=now()
         WHERE organization_id=$1 AND revision_id=$2 AND status='ACTIVE'`,
        [principal.organizationId, base.id],
      );
      await client.query(
        `UPDATE brief_reviews SET status='REJECTED',comments='Superseded by a new revision',
         decided_at=now(),updated_at=now()
         WHERE organization_id=$1 AND revision_id=$2 AND status='PENDING'`,
        [principal.organizationId, base.id],
      );
      await client.query(
        `UPDATE brief_revisions SET status='SUPERSEDED',is_candidate=false,updated_at=now()
         WHERE organization_id=$1 AND id=$2`,
        [principal.organizationId, base.id],
      );
      const revisionId = randomUUID();
      await client.query(
        `INSERT INTO brief_revisions
          (id,organization_id,case_id,brief_id,revision_number,base_revision_id,
           snapshot,snapshot_hash,knowledge_version,template_id,template_version,
           policy_version,creator,created_by_user_id,reason)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,encode(digest($7::jsonb::text,'sha256'),'hex'),
           $8,$9,$10,$11,'HUMAN',$12,$13)`,
        [
          revisionId,
          principal.organizationId,
          base.case_id,
          base.brief_id,
          base.revision_number + 1,
          base.id,
          serialized,
          base.knowledge_version,
          base.template_id,
          base.template_version,
          base.policy_version,
          principal.userId,
          reason,
        ],
      );
      await client.query(
        `INSERT INTO brief_revision_claims
          (organization_id,case_id,brief_id,revision_id,claim_id,position,
           claim_content_hash,claim_validity)
         SELECT organization_id,case_id,brief_id,$3,claim_id,position,
           claim_content_hash,claim_validity FROM brief_revision_claims
         WHERE organization_id=$1 AND revision_id=$2 ORDER BY position`,
        [principal.organizationId, base.id, revisionId],
      );
      await this.#audit(
        client,
        principal,
        base.case_id,
        "brief_revision.edited",
        revisionId,
        input.correlationId,
      );
      await client.query("COMMIT");
      return { revisionId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async submit(
    principal: BriefReviewPrincipal,
    input: { revisionId: string; correlationId: string },
  ) {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const revision = await this.#lockRevision(client, principal, input.revisionId);
      if (!revision.is_candidate || revision.status !== "DRAFT")
        throw new Error("brief_revision_not_submittable");
      await client.query(
        `UPDATE brief_revisions SET status='IN_REVIEW',updated_at=now() WHERE id=$1`,
        [revision.id],
      );
      const reviewId = randomUUID();
      await client.query(
        `INSERT INTO brief_reviews
          (id,organization_id,case_id,brief_id,revision_id,reviewer_user_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          reviewId,
          principal.organizationId,
          revision.case_id,
          revision.brief_id,
          revision.id,
          principal.userId,
        ],
      );
      await this.#audit(
        client,
        principal,
        revision.case_id,
        "brief_revision.submitted",
        reviewId,
        input.correlationId,
      );
      await client.query("COMMIT");
      return { reviewId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async reject(
    principal: BriefReviewPrincipal,
    input: { revisionId: string; comments: string; correlationId: string },
  ) {
    const comments = input.comments.trim();
    if (!comments || comments.length > 2_000) throw new Error("brief_review_comments_invalid");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const revision = await this.#lockRevision(client, principal, input.revisionId);
      const review = await this.#pendingReview(client, principal, revision.id);
      await client.query(
        `UPDATE brief_reviews SET status='REJECTED',comments=$2,decided_at=now(),updated_at=now()
         WHERE id=$1`,
        [review.id, comments],
      );
      await client.query(
        `UPDATE brief_revisions SET status='WITHDRAWN',is_candidate=false,updated_at=now() WHERE id=$1`,
        [revision.id],
      );
      await client.query(
        `UPDATE prospect_cases SET status='ENGINEER_REVIEW',next_action='REVISE_BRIEF',
         version=version+1,updated_at=now() WHERE organization_id=$1 AND id=$2`,
        [principal.organizationId, revision.case_id],
      );
      await this.#audit(
        client,
        principal,
        revision.case_id,
        "brief_revision.rejected",
        review.id,
        input.correlationId,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async approve(
    principal: BriefReviewPrincipal,
    input: { revisionId: string; comments?: string; correlationId: string },
    now = new Date(),
  ) {
    if (!principal.sessionId || !principal.authenticatedAt)
      throw new Error("operator_recent_authentication_required");
    const age = now.getTime() - principal.authenticatedAt.getTime();
    if (age < 0 || age >= RECENT_AUTHENTICATION_MS)
      throw new Error("operator_recent_authentication_required");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const revision = await this.#lockRevision(client, principal, input.revisionId);
      const activeSession = await client.query(
        `SELECT 1 FROM "session" WHERE id=$1 AND "userId"=$2 AND "createdAt"=$3 AND "expiresAt">$4`,
        [principal.sessionId, principal.userId, principal.authenticatedAt, now],
      );
      if ((activeSession.rowCount ?? 0) !== 1)
        throw new Error("operator_recent_authentication_required");
      const review = await this.#pendingReview(client, principal, revision.id);
      const comments = input.comments?.trim() || null;
      await client.query(
        `UPDATE brief_reviews SET status='APPROVED',comments=$2,decided_at=$3,updated_at=$3
         WHERE id=$1`,
        [review.id, comments, now],
      );
      const approvalId = randomUUID();
      await client.query(
        `INSERT INTO brief_approvals
          (id,organization_id,case_id,brief_id,revision_id,review_id,snapshot_hash,
           approved_by_user_id,authentication_method,authenticated_at,approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'PASSWORD_TOTP',$9,$10)`,
        [
          approvalId,
          principal.organizationId,
          revision.case_id,
          revision.brief_id,
          revision.id,
          review.id,
          revision.snapshot_hash,
          principal.userId,
          principal.authenticatedAt,
          now,
        ],
      );
      await client.query(`UPDATE brief_revisions SET status='APPROVED',updated_at=$2 WHERE id=$1`, [
        revision.id,
        now,
      ]);
      await client.query(
        `UPDATE prospect_cases SET status='AWAITING_EMAIL_VERIFICATION',
         next_action='VERIFY_DELIVERY_EMAIL',version=version+1,updated_at=$3
         WHERE organization_id=$1 AND id=$2`,
        [principal.organizationId, revision.case_id, now],
      );
      await this.#audit(
        client,
        principal,
        revision.case_id,
        "brief_revision.approved",
        approvalId,
        input.correlationId,
      );
      await client.query("COMMIT");
      return { approvalId };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #lockRevision(client: PoolClient, principal: BriefReviewPrincipal, revisionId: string) {
    const revision = await client
      .query<{
        id: string;
        case_id: string;
        brief_id: string;
        revision_number: number;
        status: string;
        is_candidate: boolean;
        snapshot_hash: string;
        knowledge_version: number;
        template_id: string;
        template_version: number;
        policy_version: number;
      }>(
        `SELECT id,case_id,brief_id,revision_number,status,is_candidate,snapshot_hash,
         knowledge_version,template_id,template_version,policy_version
         FROM brief_revisions WHERE organization_id=$1 AND id=$2 FOR UPDATE`,
        [principal.organizationId, revisionId],
      )
      .then((result) => result.rows[0]);
    if (!revision) throw new Error("brief_revision_not_found");
    await this.#authorize(client, principal, revision.case_id);
    return revision;
  }

  async #pendingReview(client: PoolClient, principal: BriefReviewPrincipal, revisionId: string) {
    const review = await client
      .query<{ id: string }>(
        `SELECT id FROM brief_reviews WHERE organization_id=$1 AND revision_id=$2
         AND reviewer_user_id=$3 AND status='PENDING' FOR UPDATE`,
        [principal.organizationId, revisionId, principal.userId],
      )
      .then((result) => result.rows[0]);
    if (!review) throw new Error("brief_review_not_pending");
    return review;
  }

  async #audit(
    client: PoolClient,
    principal: BriefReviewPrincipal,
    caseId: string,
    action: string,
    resourceId: string,
    correlationId: string,
  ) {
    await client.query(
      `INSERT INTO audit_events
        (organization_id,case_id,actor,action,resource_type,resource_id,
         result,correlation_id,origin)
       VALUES ($1,$2,$3,$4,'brief_revision',$5,'SUCCEEDED',$6,'operator-console')`,
      [
        principal.organizationId,
        caseId,
        `operator:${principal.userId}`,
        action,
        resourceId,
        correlationId,
      ],
    );
  }
}
