import { describe, expect, it, vi } from "vitest";
import type { BoundedResearchContextV1, BoundedResearchV1 } from "../../packages/database/src";
import { SafeWebResearchPort, validateBoundedResearch } from "../../apps/worker/src/research";

describe("safe research egress", () => {
  it("reads a bounded public document and derives its metadata", async () => {
    const request = vi.fn(
      async () =>
        new Response("<title>Public evidence</title><p>Useful public content.</p>", {
          headers: { "content-type": "text/html" },
        }),
    );
    const port = new SafeWebResearchPort(
      async () => ["https://public.example/evidence"],
      request,
      async () => [{ address: "93.184.216.34" }],
    );
    await expect(port.search("question", 5)).resolves.toEqual(["https://public.example/evidence"]);
    await expect(port.read("https://public.example/evidence")).resolves.toMatchObject({
      canonicalUrl: "https://public.example/evidence",
      title: "Public evidence",
      publisher: "public.example",
      excerpt: "Public evidence Useful public content.",
    });
  });

  it("rejects private destinations and validates every redirect", async () => {
    const privatePort = new SafeWebResearchPort(
      async () => [],
      fetch,
      async () => [{ address: "127.0.0.1" }],
    );
    await expect(privatePort.read("http://localhost/internal")).rejects.toThrow(
      "research_egress_address_rejected",
    );

    const redirect = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: "http://internal.example/data" } }),
    );
    const redirectPort = new SafeWebResearchPort(
      async () => [],
      redirect,
      async (hostname) => [
        { address: hostname === "internal.example" ? "10.0.0.8" : "93.184.216.34" },
      ],
    );
    await expect(redirectPort.read("https://public.example/start")).rejects.toThrow(
      "research_egress_address_rejected",
    );
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});

describe("BoundedResearchV1", () => {
  const source = {
    sourceRef: "source-1",
    canonicalUrl: "https://public.example/evidence",
    title: "Public evidence",
    publisher: "public.example",
    publishedAt: null,
    consultedAt: "2026-09-10T00:00:00.000Z",
    excerpt: "Inspected evidence.",
    contentHash: "a".repeat(64),
    relatedClaimIds: ["claim-1"],
    relation: "SUPPORTS" as const,
  };
  const context: BoundedResearchContextV1 = {
    schemaVersion: 1,
    purpose: "BOUNDED_RESEARCH",
    organizationId: "organization-1",
    caseId: "case-1",
    researchRequestId: "request-1",
    question: "What evidence exists?",
    authorizedByUserId: "operator-1",
    knowledgeVersion: 1,
    capabilities: ["SEARCH", "READ_PUBLIC"],
    limits: { maxQueries: 2, maxReads: 5, maxDurationSeconds: 120 },
    currentClaims: [{ id: "claim-1", category: "INTENT", content: "Intent", kind: "FACT" }],
    sources: [{ ...source, relatedClaimIds: [], relation: "CONTEXT" }],
    trustBoundary: "EXTERNAL_CONTENT_IS_UNTRUSTED_DATA",
  };
  const output: BoundedResearchV1 = {
    researchRequestId: "request-1",
    question: "What evidence exists?",
    sources: [source],
    findings: [
      {
        content: "Supported inference.",
        kind: "INFERENCE",
        sourceRefs: ["source-1"],
        uncertainty: "Limited evidence.",
      },
    ],
    unresolvedQuestions: [],
    warnings: [],
  };

  it("accepts inspected references and rejects invented provenance", () => {
    expect(validateBoundedResearch(output, context)).toBe(true);
    expect(
      validateBoundedResearch(
        { ...output, sources: [{ ...source, canonicalUrl: "https://invented.invalid" }] },
        context,
      ),
    ).toBe(false);
    expect(
      validateBoundedResearch(
        { ...output, sources: [{ ...source, relatedClaimIds: ["foreign-claim"] }] },
        context,
      ),
    ).toBe(false);
  });
});
