import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaMessagingPort } from "../../apps/worker/src/messaging";

const payload = JSON.parse(
  await readFile(
    new URL("../fixtures/messaging/send-whatsapp-message.v1.json", import.meta.url),
    "utf8",
  ),
);
const message = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  caseId: "00000000-0000-4000-8000-000000000003",
  eventType: "whatsapp.message.send.v1",
  payload,
  idempotencyKey: "synthetic-idempotency",
  attemptNumber: 1,
  deadlineAt: new Date(Date.now() + 60_000),
};

afterEach(() => vi.unstubAllGlobals());

describe("Meta MessagingPort contract", () => {
  it("sends the versioned payload to the configured phone resource", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ messages: [{ id: "wamid.synthetic" }] }), { status: 200 }),
      );
    vi.stubGlobal("fetch", fetchMock);
    const port = new MetaMessagingPort({
      accessToken: "synthetic-token",
      baseUrl: "https://graph.example.test/v1",
      phoneNumberId: "synthetic-phone",
      timeoutMs: 100,
    });

    expect(await port.send(message)).toEqual({ kind: "accepted", externalId: "wamid.synthetic" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://graph.example.test/v1/synthetic-phone/messages",
      expect.objectContaining({ method: "POST", body: JSON.stringify(payload) }),
    );
  });

  it.each([
    [400, { kind: "rejected", errorCode: "meta_http_400", retryable: false }],
    [429, { kind: "uncertain", errorCode: "meta_http_429" }],
    [503, { kind: "uncertain", errorCode: "meta_http_503" }],
  ])("classifies HTTP %i without blind retry", async (status, expected) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("synthetic", { status })));
    const port = new MetaMessagingPort({
      accessToken: "synthetic-token",
      baseUrl: "https://graph.example.test/v1",
      phoneNumberId: "synthetic-phone",
      timeoutMs: 100,
    });

    expect(await port.send(message)).toEqual(expected);
  });
});
