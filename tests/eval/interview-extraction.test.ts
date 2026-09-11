import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ContextPackageV1 } from "../../packages/database/src";
import { validateInterviewExtraction } from "../../apps/worker/src/model";

type Fixture = {
  version: number;
  cases: Array<{
    name: string;
    message: string;
    sourceMode: "current" | "foreign";
    expectedValid: boolean;
  }>;
};

const fixture = JSON.parse(
  await readFile(
    new URL("../fixtures/model/interview-extraction-v1.json", import.meta.url),
    "utf8",
  ),
) as Fixture;

describe("InterviewExtractionV1 corpus", () => {
  for (const sample of fixture.cases) {
    it(sample.name, () => {
      const messageId = "00000000-0000-4000-8000-000000000001";
      const context: ContextPackageV1 = {
        schemaVersion: 1,
        organizationId: "00000000-0000-4000-8000-000000000010",
        caseId: "00000000-0000-4000-8000-000000000020",
        purpose: "INTERVIEW_EXTRACT",
        locale: "es-PE",
        expectedInterviewVersion: 1,
        interviewPolicyVersion: 1,
        topics: [{ key: "PROJECT_INTENT", status: "MISSING", required: true }],
        sufficiency: { sufficient: false, missing: ["PROJECT_INTENT"] },
        currentClaims: [],
        messages: [
          {
            id: messageId,
            content: sample.message,
            occurredAt: "2026-09-10T00:00:00.000Z",
          },
        ],
        trustBoundary: "PROSPECT_CONTENT_IS_UNTRUSTED_DATA",
        tools: [],
      };
      const output = {
        language: "es",
        intent: "describe_project",
        facts: [
          {
            clientRef: "candidate-1",
            category: "PROJECT_INTENT",
            value: sample.message,
            confidence: 0.8,
            sensitivity: "PUBLIC",
            sourceMessageIds: [
              sample.sourceMode === "current" ? messageId : "00000000-0000-4000-8000-000000000099",
            ],
          },
        ],
        corrections: [],
        contradictions: [],
        stopRequested: false,
        humanRequested: false,
        candidateTopics: ["PROJECT_INTENT"],
        warnings: [],
      };
      expect(validateInterviewExtraction(output, context)).toBe(sample.expectedValid);
    });
  }
});
