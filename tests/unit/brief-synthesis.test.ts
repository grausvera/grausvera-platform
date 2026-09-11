import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BriefSynthesisContextV1 } from "../../packages/database/src";
import { validateBriefSynthesis } from "../../apps/worker/src/brief-synthesis";

const sourceId = "870b822d-1366-4921-9253-56bdc8a419af";
const context: BriefSynthesisContextV1 = {
  schemaVersion: 1,
  purpose: "BRIEF_SYNTHESIS",
  organizationId: "5ef62f60-aed4-49c5-9126-01039ddf6863",
  caseId: "e41cc6c5-c855-49c3-b831-23464c44bb44",
  briefId: "39268ff1-68ca-4cc1-aac2-77f9ff4c4931",
  synthesisRequestId: "2c6c5fc3-777c-48c5-b7c4-8755f188f044",
  knowledgeVersion: 3,
  policyVersion: 1,
  claims: [
    {
      id: "cf814d99-63e4-4de9-a363-363a7ed32a78",
      kind: "FACT",
      category: "PROJECT_INTENT",
      content: "Synthetic project",
      confidenceBasisPoints: 9000,
      sourceIds: [sourceId],
    },
  ],
  trustBoundary: "CLAIMS_AND_SOURCES_ARE_UNTRUSTED_DATA",
  tools: [],
};

const output = {
  title: "Synthetic",
  problem: "An internal process needs clearer coordination.",
  peopleAndUsers: [],
  objectives: ["Clarify the workflow"],
  currentSituation: "The team uses a manual process.",
  scopeIncluded: [],
  scopeExcluded: [],
  constraints: [],
  assumptions: [],
  openQuestions: [],
  risks: [],
  materialClaims: [
    {
      content: "A project exists",
      kind: "FACT",
      sourceIds: [sourceId],
      confidence: 0.9,
    },
  ],
  warnings: [],
};

describe("brief synthesis validation", () => {
  it("accepts a strict, grounded synthesis", () => {
    expect(validateBriefSynthesis(output, context)).toBe(true);
  });

  it("allows an explicitly identified source-free assumption", () => {
    const assumption = {
      ...output,
      materialClaims: [
        {
          content: "Users may need access",
          kind: "ASSUMPTION",
          sourceIds: [],
          confidence: 0.4,
        },
      ],
    };
    expect(validateBriefSynthesis(assumption, context)).toBe(true);
  });

  it.each([
    [
      "ungrounded fact",
      {
        ...output,
        materialClaims: [{ ...output.materialClaims[0], sourceIds: [] }],
      },
    ],
    [
      "foreign source",
      {
        ...output,
        materialClaims: [{ ...output.materialClaims[0], sourceIds: [randomUUID()] }],
      },
    ],
    ["extra field", { ...output, proposal: "unexpected" }],
    ["commercial language", { ...output, problem: "The proposal includes a fixed price." }],
  ])("rejects %s", (_label, candidate) => {
    expect(validateBriefSynthesis(candidate, context)).toBe(false);
  });
});
