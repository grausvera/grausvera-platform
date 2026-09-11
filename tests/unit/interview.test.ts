import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVIEW_POLICY,
  evaluateInterviewPolicy,
  evaluateMaterialSufficiency,
  isExplicitBriefRequest,
} from "../../packages/database/src";

describe("basic interview policy", () => {
  it("returns ordered required topics that remain missing", () => {
    expect(
      evaluateInterviewPolicy(DEFAULT_INTERVIEW_POLICY, {
        PROJECT_INTENT: "CAPTURED",
        AUDIENCE: "NOT_APPLICABLE",
      }),
    ).toEqual({
      sufficient: false,
      missing: ["DESIRED_OUTCOME", "CONTEXT", "CONSTRAINTS"],
    });
  });

  it("is sufficient when every required topic is explicitly resolved", () => {
    const states = Object.fromEntries(
      DEFAULT_INTERVIEW_POLICY.topics.map((topic) => [topic.key, "CAPTURED" as const]),
    );
    expect(evaluateInterviewPolicy(DEFAULT_INTERVIEW_POLICY, states)).toEqual({
      sufficient: true,
      missing: [],
    });
  });

  it("rejects duplicated or empty policy topics", () => {
    expect(() =>
      evaluateInterviewPolicy(
        {
          version: 1,
          topics: [
            { key: "CONTEXT", required: true },
            { key: "CONTEXT", required: false },
          ],
        },
        {},
      ),
    ).toThrow("interview_policy_invalid");
  });
});

describe("material interview sufficiency", () => {
  const resolved = Object.fromEntries(
    DEFAULT_INTERVIEW_POLICY.topics.map((topic) => [topic.key, "CAPTURED" as const]),
  );

  it("accepts explicitly unknown constraints when the brief was requested", () => {
    expect(
      evaluateMaterialSufficiency({
        policy: DEFAULT_INTERVIEW_POLICY,
        states: { ...resolved, CONSTRAINTS: "DECLARED_UNKNOWN" },
        briefRequested: true,
        unresolvedContradictionIds: [],
        unbackedClaimIds: [],
      }),
    ).toEqual({ sufficient: true, missing: [], blockers: [] });
  });

  it("keeps core unknowns, the brief request and material evidence explicit", () => {
    expect(
      evaluateMaterialSufficiency({
        policy: DEFAULT_INTERVIEW_POLICY,
        states: { ...resolved, DESIRED_OUTCOME: "DECLARED_UNKNOWN" },
        briefRequested: false,
        unresolvedContradictionIds: ["contradiction-1"],
        unbackedClaimIds: ["claim-1"],
      }),
    ).toEqual({
      sufficient: false,
      missing: ["DESIRED_OUTCOME", "BRIEF_REQUEST"],
      blockers: ["CONTRADICTION:contradiction-1", "UNBACKED_CLAIM:claim-1"],
    });
  });

  it("recognizes only an explicit request for a brief or summary", () => {
    expect(isExplicitBriefRequest("Quisiera recibir el resumen del proyecto")).toBe(true);
    expect(isExplicitBriefRequest("Tal vez luego revisemos el resumen")).toBe(false);
  });
});
