import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  BudgetStore,
  type KnowledgeOperatorPrincipal,
  ResearchStore,
} from "../../packages/database/src";
import type { ModelPort } from "../../apps/worker/src/model";
import { BoundedResearchRunner, type ResearchPort } from "../../apps/worker/src/research";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const budgets = new BudgetStore(connectionString);
const store = new ResearchStore(connectionString);
const caseId = randomUUID();
const foreignCaseId = randomUUID();
const claimId = randomUUID();
const operatorUserId = `research-${randomUUID()}`;
let organizationId: string;
let principal: KnowledgeOperatorPrincipal;
let searchCalls = 0;
let modelCalls = 0;

const research: ResearchPort = {
  async search() {
    searchCalls += 1;
    return ["https://example.invalid/public"];
  },
  async read() {
    return {
      canonicalUrl: "https://example.invalid/public",
      title: "Synthetic evidence",
      publisher: "Example",
      publishedAt: null,
      consultedAt: "2026-09-10T00:00:00.000Z",
      excerpt: "Synthetic inspected evidence.",
      contentHash: "d".repeat(64),
    };
  },
};
const models: ModelPort = {
  async invoke(request) {
    modelCalls += 1;
    const context = request.context as {
      researchRequestId: string;
      question: string;
      currentClaims: Array<{ id: string }>;
      sources: Array<Record<string, unknown>>;
    };
    const source = {
      ...context.sources[0],
      relatedClaimIds: [context.currentClaims[0]?.id],
      relation: "SUPPORTS",
    };
    return {
      kind: "completed",
      responseId: `response-${randomUUID()}`,
      output: {
        researchRequestId: context.researchRequestId,
        question: context.question,
        sources: [source],
        findings: [
          {
            content: "A bounded synthetic inference.",
            kind: "INFERENCE",
            sourceRefs: [source.sourceRef],
            uncertainty: "Synthetic evidence only.",
          },
        ],
        unresolvedQuestions: [],
        warnings: [],
      },
      inputTokens: 10,
      outputTokens: 20,
      latencyMs: 3,
    };
  },
};
const runner = new BoundedResearchRunner(budgets, store, research, models, {
  model: "synthetic-research-model",
  maximumCostMicros: 50,
  toolCostMicros: 10,
  inputUsdPerMillion: 1,
  outputUsdPerMillion: 1,
});

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
     VALUES ($1, $2, $3, 'FACT', 'PROJECT_INTENT', 'synthetic intent', 8000,
       'CONFIDENTIAL', 'INTERNAL', 'HUMAN')`,
    [claimId, organizationId, caseId],
  );
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified")
     VALUES ($1, 'research operator', $2, true)`,
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
  await store.close();
  await budgets.close();
  await pool.end();
});

describe("bounded research", () => {
  it("requires explicit case authority before search or model use", async () => {
    await expect(
      runner.run(
        { ...principal, twoFactorVerified: false },
        {
          caseId,
          question: "What public evidence exists?",
          logicalOperationKey: `research-${randomUUID()}`,
          attemptKey: randomUUID(),
          correlationId: randomUUID(),
        },
      ),
    ).rejects.toThrow("operator_two_factor_required");
    await expect(
      runner.run(principal, {
        caseId: foreignCaseId,
        question: "What public evidence exists?",
        logicalOperationKey: `research-${randomUUID()}`,
        attemptKey: randomUUID(),
        correlationId: randomUUID(),
      }),
    ).rejects.toThrow("research_not_authorized");
    expect({ searchCalls, modelCalls }).toEqual({ searchCalls: 0, modelCalls: 0 });
  });

  it("reserves budget and persists only inspected, referenced evidence", async () => {
    const result = await runner.run(principal, {
      caseId,
      question: "What public evidence exists?",
      logicalOperationKey: `research-${randomUUID()}`,
      attemptKey: randomUUID(),
      correlationId: randomUUID(),
    });
    expect(result).toMatchObject({ kind: "completed", claimIds: [expect.any(String)] });
    const state = await pool.query(
      `SELECT
        (SELECT status FROM research_requests WHERE id = $1) AS request_status,
        (SELECT count(*)::integer FROM external_sources WHERE research_request_id = $1) AS sources,
        (SELECT count(*)::integer FROM claims
          WHERE case_id = $2 AND kind = 'INFERENCE' AND creator = 'MODEL') AS findings,
        (SELECT count(*)::integer FROM claim_relations
          WHERE case_id = $2 AND relation = 'DERIVES_FROM') AS relations,
        (SELECT status FROM budget_reservations
          WHERE purpose = 'BOUNDED_RESEARCH' AND case_id = $2 ORDER BY created_at DESC LIMIT 1) AS budget,
        (SELECT count(*)::integer FROM audit_events
          WHERE resource_id = $1 AND action IN ('research.authorized', 'research.succeeded')) AS audits`,
      [result.researchRequestId, caseId],
    );
    expect(state.rows[0]).toEqual({
      request_status: "SUCCEEDED",
      sources: 1,
      findings: 1,
      relations: 1,
      budget: "CONSUMED",
      audits: 2,
    });
    expect({ searchCalls, modelCalls }).toEqual({ searchCalls: 1, modelCalls: 1 });
  });
});
