import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ConsentEvidence,
  type ConsentPolicyDefinition,
  classifyConsentResponse,
  evaluateDiscoveryConsent,
  hashConsentNotice,
  renderConsentRequest,
} from "../../packages/database/src/consent";

const now = new Date("2026-09-10T12:00:00Z");
const noticeText = "Synthetic privacy notice";
const policy: ConsentPolicyDefinition = {
  id: randomUUID(),
  purpose: "DISCOVERY",
  channel: "WHATSAPP",
  locale: "es-PE",
  scope: "PROJECT_DISCOVERY",
  version: 1,
  noticeText,
  noticeHash: hashConsentNotice(noticeText),
  effectiveAt: new Date("2026-09-01T00:00:00Z"),
};

function evidence(overrides: Partial<ConsentEvidence> = {}): ConsentEvidence {
  return {
    purpose: "DISCOVERY",
    action: "ACCEPTED",
    policyId: policy.id,
    policyVersion: policy.version,
    noticeHash: policy.noticeHash,
    channel: "WHATSAPP",
    locale: "es-PE",
    scope: "PROJECT_DISCOVERY",
    occurredAt: new Date("2026-09-10T11:00:00Z"),
    ...overrides,
  };
}

describe("consent policy", () => {
  it("classifies only explicit consent actions", () => {
    expect(classifyConsentResponse("  acepto ")).toBe("ACCEPTED");
    expect(classifyConsentResponse("NO   ACEPTO")).toBe("REJECTED");
    expect(classifyConsentResponse("revoco mi consentimiento")).toBe("REVOKED");
    expect(classifyConsentResponse("sí")).toBeUndefined();
    expect(classifyConsentResponse("acepto marketing")).toBeUndefined();
  });

  it("hashes the exact notice and allows only matching current acceptance", () => {
    expect(hashConsentNotice(noticeText)).toHaveLength(64);
    expect(evaluateDiscoveryConsent({ policy, records: [evidence()], now })).toMatchObject({
      allowed: true,
    });
    expect(
      evaluateDiscoveryConsent({
        policy,
        records: [evidence({ noticeHash: hashConsentNotice(`${noticeText}.`) })],
        now,
      }),
    ).toEqual({ allowed: false, reason: "POLICY_MISMATCH" });
  });

  it("renders one deterministic request without changing the approved notice", () => {
    const rendered = renderConsentRequest(`  ${noticeText}  `);
    expect(rendered).toContain("asistente automatizado de grausvera");
    expect(rendered).toContain(noticeText);
    expect(rendered).toContain("ACEPTO");
    expect(rendered).toContain("ayuda humana");
    expect(rendered).toContain("No envíes contraseñas");
  });

  it("denies missing, expired, rejected, or revoked consent", () => {
    expect(evaluateDiscoveryConsent({ policy, records: [], now })).toEqual({
      allowed: false,
      reason: "EVIDENCE_MISSING",
    });
    expect(
      evaluateDiscoveryConsent({
        policy,
        records: [evidence({ validUntil: new Date("2026-09-10T11:30:00Z") })],
        now,
      }),
    ).toEqual({ allowed: false, reason: "CONSENT_EXPIRED" });
    for (const action of ["REJECTED", "REVOKED"] as const) {
      expect(evaluateDiscoveryConsent({ policy, records: [evidence({ action })], now })).toEqual({
        allowed: false,
        reason: "NOT_ACCEPTED",
      });
    }
  });

  it("gives a later rejection or revocation precedence over acceptance", () => {
    const accepted = evidence();
    const revoked = evidence({
      action: "REVOKED",
      occurredAt: new Date("2026-09-10T11:30:00Z"),
    });
    expect(evaluateDiscoveryConsent({ policy, records: [accepted, revoked], now })).toEqual({
      allowed: false,
      reason: "NOT_ACCEPTED",
    });
  });
});
