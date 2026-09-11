import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AesGcmEmailSecretCodec,
  FakeEmailPort,
  ResendEmailPort,
  renderEmailVerification,
} from "../../apps/worker/src/email";
import { createLogger } from "../../packages/operations/src";

afterEach(() => vi.unstubAllGlobals());

describe("transactional email ports", () => {
  it("renders only the verification challenge and no brief content", () => {
    const email = renderEmailVerification({
      to: "prospect@example.invalid",
      verificationUrl: "https://example.invalid/verify/challenge?token=synthetic",
    });
    expect(email.subject).toContain("Verifica");
    expect(email.text).toContain("token=synthetic");
    expect(JSON.stringify(email)).not.toContain("briefRevisionId");
  });

  it("seals and authenticates the transient destination and link", () => {
    const codec = new AesGcmEmailSecretCodec(Buffer.alloc(32, 7), "test-key");
    const sealed = codec.seal({
      to: "prospect@example.invalid",
      verificationUrl: "https://example.invalid/verify/token",
    });
    expect(Buffer.from(sealed.ciphertext).toString("utf8")).not.toContain("prospect@example");
    expect(() =>
      new AesGcmEmailSecretCodec(Buffer.alloc(32, 8), "test-key").open({
        ...sealed,
        id: "event",
        organizationId: "organization",
        caseId: "case",
        challengeId: "challenge",
        contactPointId: "contact",
        secretReference: "secret",
        idempotencyKey: "key",
        attemptNumber: 1,
        deadlineAt: new Date(),
      }),
    ).toThrow();
  });

  it("sends through Resend with provider idempotency and classifies outcomes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "email.synthetic" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("busy", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = new ResendEmailPort({
      apiKey: "synthetic-key",
      baseUrl: "https://api.example.invalid",
      from: "grausvera <notify@example.invalid>",
      timeoutMs: 100,
    });
    const email = {
      ...renderEmailVerification({
        to: "prospect@example.invalid",
        verificationUrl: "https://example.invalid/verify",
      }),
      idempotencyKey: "verification-case-1",
    };
    await expect(port.send(email)).resolves.toEqual({
      kind: "accepted",
      externalId: "email.synthetic",
    });
    await expect(port.send(email)).resolves.toEqual({
      kind: "uncertain",
      errorCode: "resend_http_500",
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      "idempotency-key": "verification-case-1",
    });
  });

  it("records messages in the fake port", async () => {
    const port = new FakeEmailPort();
    const email = {
      ...renderEmailVerification({
        to: "prospect@example.invalid",
        verificationUrl: "https://example.invalid/verify",
      }),
      idempotencyKey: "fake-key",
    };
    await expect(port.send(email)).resolves.toMatchObject({ kind: "accepted" });
    expect(port.sent).toEqual([email]);
  });

  it("does not admit verification secrets into structured logs", () => {
    const lines: string[] = [];
    const logger = createLogger("worker", "test", "debug", (line) => lines.push(line));
    logger.write("error", {
      event: "email_dispatch_failed",
      errorCode: "provider_failed",
      token: "token-canary",
      destination: "prospect@example.invalid",
      verificationUrl: "https://example.invalid/token-canary",
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain("token-canary");
    expect(lines[0]).not.toContain("prospect@example.invalid");
  });
});
