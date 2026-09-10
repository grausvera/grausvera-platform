import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MetaMessagingPort,
  OutboxDispatcher,
  FakeMessagingPort,
} from "../../apps/worker/src/messaging";

const message = {
  id: "00000000-0000-4000-8000-000000000001",
  organizationId: "00000000-0000-4000-8000-000000000002",
  caseId: "00000000-0000-4000-8000-000000000003",
  eventType: "whatsapp.message.send.v1",
  payload: { messaging_product: "whatsapp" },
  idempotencyKey: "synthetic-key",
  attemptNumber: 1,
  deadlineAt: new Date(Date.now() + 60_000),
};

afterEach(() => vi.unstubAllGlobals());

describe("messaging ports", () => {
  it("maps Meta acceptance and ambiguous failures without exposing the token", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: "wamid.synthetic" }] }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("busy", { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    const port = new MetaMessagingPort({
      accessToken: "synthetic-token",
      baseUrl: "https://graph.example.test/v1",
      phoneNumberId: "phone-id",
      timeoutMs: 100,
    });

    expect(await port.send(message)).toEqual({ kind: "accepted", externalId: "wamid.synthetic" });
    expect(await port.send(message)).toEqual({ kind: "uncertain", errorCode: "meta_http_500" });
  });

  it("does not claim or call a provider while the emitter is disabled", async () => {
    const store = { claimNext: vi.fn(), finish: vi.fn() };
    const port = new FakeMessagingPort();
    const dispatcher = new OutboxDispatcher(store as never, port);

    expect(await dispatcher.dispatchOne()).toBe("disabled");
    expect(store.claimNext).not.toHaveBeenCalled();
    expect(port.sent).toHaveLength(0);
  });

  it("classifies a provider timeout as uncertain", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }),
      ),
    );
    const port = new MetaMessagingPort({
      accessToken: "synthetic-token",
      baseUrl: "https://graph.example.test/v1",
      phoneNumberId: "phone-id",
      timeoutMs: 1,
    });

    expect(await port.send(message)).toEqual({
      kind: "uncertain",
      errorCode: "meta_response_unknown",
    });
  });
});
