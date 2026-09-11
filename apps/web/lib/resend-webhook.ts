import { createHmac, timingSafeEqual } from "node:crypto";
import { RESEND_EVENT_TYPES, type ResendWebhookProjection } from "@grausvera/database";

export const RESEND_WEBHOOK_MAX_BYTES = 256 * 1024;
export const RESEND_WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export function verifyResendSignature(
  body: Uint8Array,
  headers: Headers,
  secret: string,
  now = new Date(),
): boolean {
  const id = headers.get("svix-id");
  const timestamp = headers.get("svix-timestamp");
  const signatures = headers.get("svix-signature");
  if (!id || !timestamp || !/^\d+$/.test(timestamp) || !signatures) return false;
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > RESEND_WEBHOOK_TOLERANCE_SECONDS)
    return false;
  const encodedSecret = secret.startsWith("whsec_") ? secret.slice(6) : secret;
  let key: Buffer;
  try {
    key = Buffer.from(encodedSecret, "base64");
  } catch {
    return false;
  }
  if (key.byteLength < 16) return false;
  const signed = Buffer.concat([Buffer.from(`${id}.${timestamp}.`, "utf8"), Buffer.from(body)]);
  const expected = createHmac("sha256", key).update(signed).digest();
  return signatures.split(" ").some((candidate) => {
    const [version, value] = candidate.split(",", 2);
    if (version !== "v1" || !value) return false;
    const supplied = Buffer.from(value, "base64");
    return supplied.byteLength === expected.byteLength && timingSafeEqual(expected, supplied);
  });
}

export function parseResendWebhook(body: Uint8Array): ResendWebhookProjection | undefined {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const event = value as { type?: unknown; created_at?: unknown; data?: { email_id?: unknown } };
  if (
    typeof event.type !== "string" ||
    !RESEND_EVENT_TYPES.includes(event.type as (typeof RESEND_EVENT_TYPES)[number]) ||
    typeof event.created_at !== "string" ||
    typeof event.data?.email_id !== "string"
  ) {
    return undefined;
  }
  const providerOccurredAt = new Date(event.created_at);
  if (Number.isNaN(providerOccurredAt.getTime())) return undefined;
  return {
    eventType: event.type as (typeof RESEND_EVENT_TYPES)[number],
    providerEmailId: event.data.email_id,
    providerOccurredAt,
  };
}

export async function readLimitedResendBody(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > RESEND_WEBHOOK_MAX_BYTES)) {
    throw new Error("resend_webhook_too_large");
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > RESEND_WEBHOOK_MAX_BYTES) throw new Error("resend_webhook_too_large");
  return bytes;
}
