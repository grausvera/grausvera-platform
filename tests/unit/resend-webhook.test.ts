import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { parseResendWebhook, verifyResendSignature } from "../../apps/web/lib/resend-webhook";

function signed(body: string, now: Date, secret: Buffer) {
  const id = "evt_synthetic";
  const timestamp = String(Math.floor(now.getTime() / 1000));
  const signature = createHmac("sha256", secret)
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64");
  return new Headers({
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  });
}

describe("Resend webhook boundary", () => {
  it("authenticates exact raw bytes inside the replay window", () => {
    const now = new Date("2026-09-10T20:00:00Z");
    const secret = Buffer.alloc(32, 4);
    const body = JSON.stringify({ type: "email.delivered" });
    const headers = signed(body, now, secret);
    expect(
      verifyResendSignature(Buffer.from(body), headers, `whsec_${secret.toString("base64")}`, now),
    ).toBe(true);
    expect(
      verifyResendSignature(
        Buffer.from(`${body} `),
        headers,
        `whsec_${secret.toString("base64")}`,
        now,
      ),
    ).toBe(false);
    expect(
      verifyResendSignature(
        Buffer.from(body),
        headers,
        `whsec_${secret.toString("base64")}`,
        new Date(now.getTime() + 301_000),
      ),
    ).toBe(false);
  });

  it("accepts only known event containers with an email id and valid date", () => {
    const valid = Buffer.from(
      JSON.stringify({
        type: "email.bounced",
        created_at: "2026-09-10T20:00:00Z",
        data: { email_id: "email_synthetic" },
      }),
    );
    expect(parseResendWebhook(valid)).toEqual({
      eventType: "email.bounced",
      providerEmailId: "email_synthetic",
      providerOccurredAt: new Date("2026-09-10T20:00:00Z"),
    });
    expect(parseResendWebhook(Buffer.from("{}"))).toBeUndefined();
  });
});
