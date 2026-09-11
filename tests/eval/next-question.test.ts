import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ContextPackageV1 } from "../../packages/database/src";
import { validateNextQuestion } from "../../apps/worker/src/model";

const fixture = JSON.parse(
  await readFile(new URL("../fixtures/model/next-question-v1.json", import.meta.url), "utf8"),
) as {
  version: number;
  cases: Array<{ name: string; sufficient: boolean; output: unknown; expectedValid: boolean }>;
};

describe("NextQuestionV1 conversational corpus", () => {
  for (const sample of fixture.cases) {
    it(sample.name, () => {
      const context: ContextPackageV1 = {
        schemaVersion: 1,
        organizationId: "00000000-0000-4000-8000-000000000010",
        caseId: "00000000-0000-4000-8000-000000000020",
        purpose: "NEXT_QUESTION",
        locale: "es-PE",
        expectedInterviewVersion: 1,
        interviewPolicyVersion: 1,
        topics: [{ key: "PROJECT_INTENT", status: "MISSING", required: true }],
        sufficiency: {
          sufficient: sample.sufficient,
          missing: sample.sufficient ? [] : ["PROJECT_INTENT"],
        },
        currentClaims: [],
        messages: [],
        trustBoundary: "PROSPECT_CONTENT_IS_UNTRUSTED_DATA",
        tools: [],
      };
      expect(validateNextQuestion(sample.output, context)).toBe(sample.expectedValid);
    });
  }
});
