import { createHmac, timingSafeEqual } from "node:crypto";

export const META_WEBHOOK_MAX_BYTES = 1024 * 1024;

export class WebhookBodyTooLargeError extends Error {}

function equalSecrets(left: string, right: string): boolean {
  const leftDigest = createHmac("sha256", "grausvera-webhook-comparison").update(left).digest();
  const rightDigest = createHmac("sha256", "grausvera-webhook-comparison").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

export function verifyChallenge(url: URL, expectedToken: string): string | undefined {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  return mode === "subscribe" && token && challenge && equalSecrets(token, expectedToken)
    ? challenge
    : undefined;
}

export function verifyMetaSignature(body: Uint8Array, signature: string | null, secret: string) {
  if (!signature?.startsWith("sha256=")) return false;
  const supplied = signature.slice(7);
  if (!/^[a-f0-9]{64}$/i.test(supplied)) return false;

  const expected = createHmac("sha256", secret).update(body).digest();
  return timingSafeEqual(expected, Buffer.from(supplied, "hex"));
}

export async function readLimitedBody(request: Request): Promise<Uint8Array> {
  const declaredLength = request.headers.get("content-length");
  if (
    declaredLength &&
    (!/^\d+$/.test(declaredLength) || Number(declaredLength) > META_WEBHOOK_MAX_BYTES)
  ) {
    throw new WebhookBodyTooLargeError();
  }
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > META_WEBHOOK_MAX_BYTES) {
      await reader.cancel();
      throw new WebhookBodyTooLargeError();
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export function isMinimalWhatsAppPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const payload = value as { object?: unknown; entry?: unknown };
  return payload.object === "whatsapp_business_account" && Array.isArray(payload.entry);
}
