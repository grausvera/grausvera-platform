import { describe, expect, it } from "vitest";
import { evaluateQuota } from "../../packages/database/src/quota";

const limits = { caseMessages: 30, contactMessages: 60, caseActiveSeconds: 3_600 };

describe("quota policy", () => {
  it("allows usage below every limit", () => {
    expect(
      evaluateQuota({ caseMessages: 29, contactMessages: 59, caseActiveSeconds: 3_599 }, limits),
    ).toBeUndefined();
  });

  it("stops deterministically when a limit is reached", () => {
    expect(
      evaluateQuota({ caseMessages: 30, contactMessages: 60, caseActiveSeconds: 3_600 }, limits),
    ).toBe("CASE_MESSAGE_LIMIT");
    expect(
      evaluateQuota({ caseMessages: 1, contactMessages: 60, caseActiveSeconds: 3_600 }, limits),
    ).toBe("CONTACT_MESSAGE_LIMIT");
    expect(
      evaluateQuota({ caseMessages: 1, contactMessages: 1, caseActiveSeconds: 3_600 }, limits),
    ).toBe("CASE_ACTIVE_TIME_LIMIT");
  });
});
