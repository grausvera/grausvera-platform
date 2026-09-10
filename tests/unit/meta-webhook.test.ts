import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { GET, POST } from "../../apps/web/app/api/webhooks/meta/whatsapp/route";
import { META_WEBHOOK_MAX_BYTES } from "../../apps/web/lib/meta-webhook";

const originalToken = process.env.META_WEBHOOK_VERIFY_TOKEN;
const originalSecret = process.env.META_APP_SECRET;

afterEach(() => {
  process.env.META_WEBHOOK_VERIFY_TOKEN = originalToken;
  process.env.META_APP_SECRET = originalSecret;
});

describe("Meta WhatsApp webhook boundary", () => {
  it("returns the challenge only for the exact configured token", async () => {
    process.env.META_WEBHOOK_VERIFY_TOKEN = "synthetic-verify-token";
    const valid = await GET(
      new Request(
        "http://local/api?hub.mode=subscribe&hub.verify_token=synthetic-verify-token&hub.challenge=12345",
      ),
    );
    const invalid = await GET(
      new Request(
        "http://local/api?hub.mode=subscribe&hub.verify_token=changed&hub.challenge=12345",
      ),
    );

    expect(valid.status).toBe(200);
    expect(await valid.text()).toBe("12345");
    expect(invalid.status).toBe(403);
  });

  it("verifies the original bytes but refuses success before persistence exists", async () => {
    process.env.META_APP_SECRET = "synthetic-app-secret";
    const body = JSON.stringify({ object: "whatsapp_business_account", entry: [] });
    const signature = `sha256=${createHmac("sha256", process.env.META_APP_SECRET).update(body).digest("hex")}`;
    const response = await POST(
      new Request("http://local/api", {
        method: "POST",
        body,
        headers: { "x-hub-signature-256": signature },
      }),
    );
    const altered = await POST(
      new Request("http://local/api", {
        method: "POST",
        body: `${body} `,
        headers: { "x-hub-signature-256": signature },
      }),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "unavailable" });
    expect(altered.status).toBe(401);
  });

  it("rejects declared and streamed bodies larger than one MiB", async () => {
    process.env.META_APP_SECRET = "synthetic-app-secret";
    const declared = await POST(
      new Request("http://local/api", {
        method: "POST",
        body: "{}",
        headers: { "content-length": String(META_WEBHOOK_MAX_BYTES + 1) },
      }),
    );
    const streamed = await POST(
      new Request("http://local/api", {
        method: "POST",
        body: "x".repeat(META_WEBHOOK_MAX_BYTES + 1),
      }),
    );

    expect(declared.status).toBe(413);
    expect(streamed.status).toBe(413);
  });
});
