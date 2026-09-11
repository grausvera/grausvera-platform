import { describe, expect, it } from "vitest";
import { DEFAULT_INTERVIEW_POLICY, evaluateInterviewPolicy } from "../../packages/database/src";

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
