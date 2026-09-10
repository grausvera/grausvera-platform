import { MessagingStore } from "@grausvera/database";
import { createHash, randomUUID } from "node:crypto";
import {
  isMinimalWhatsAppPayload,
  readLimitedBody,
  verifyChallenge,
  verifyMetaSignature,
  WebhookBodyTooLargeError,
} from "../../../../../lib/meta-webhook";

export const dynamic = "force-dynamic";

const noStoreHeaders = { "cache-control": "no-store" };

export async function GET(request: Request): Promise<Response> {
  const token = process.env.META_WEBHOOK_VERIFY_TOKEN;
  if (!token)
    return Response.json({ status: "unavailable" }, { status: 503, headers: noStoreHeaders });

  const challenge = verifyChallenge(new URL(request.url), token);
  return challenge
    ? new Response(challenge, {
        status: 200,
        headers: { ...noStoreHeaders, "content-type": "text/plain" },
      })
    : Response.json({ status: "forbidden" }, { status: 403, headers: noStoreHeaders });
}

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();
  const secret = process.env.META_APP_SECRET;
  if (!secret)
    return Response.json(
      { status: "unavailable", correlationId },
      { status: 503, headers: noStoreHeaders },
    );

  let body: Uint8Array;
  try {
    body = await readLimitedBody(request);
  } catch (error) {
    if (error instanceof WebhookBodyTooLargeError) {
      return Response.json(
        { status: "too_large", correlationId },
        { status: 413, headers: noStoreHeaders },
      );
    }
    return Response.json(
      { status: "invalid", correlationId },
      { status: 400, headers: noStoreHeaders },
    );
  }

  if (!verifyMetaSignature(body, request.headers.get("x-hub-signature-256"), secret)) {
    return Response.json(
      { status: "unauthorized", correlationId },
      { status: 401, headers: noStoreHeaders },
    );
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(body));
  } catch {
    return Response.json(
      { status: "invalid", correlationId },
      { status: 400, headers: noStoreHeaders },
    );
  }
  if (!isMinimalWhatsAppPayload(payload)) {
    return Response.json(
      { status: "invalid", correlationId },
      { status: 400, headers: noStoreHeaders },
    );
  }

  const connectionId = process.env.META_PROVIDER_CONNECTION_ID;
  const connectionString = process.env.DATABASE_URL;
  if (!connectionId || !connectionString) {
    return Response.json(
      { status: "unavailable", correlationId },
      { status: 503, headers: noStoreHeaders },
    );
  }

  const store = new MessagingStore(connectionString);
  try {
    const receipt = await store.persistInbox({
      providerConnectionId: connectionId,
      externalEventId: createHash("sha256").update(body).digest("hex"),
      body,
    });
    return Response.json(
      { status: receipt.created ? "accepted" : "duplicate", correlationId },
      { status: 200, headers: noStoreHeaders },
    );
  } catch {
    return Response.json(
      { status: "unavailable", correlationId },
      { status: 503, headers: noStoreHeaders },
    );
  } finally {
    await store.close();
  }
}
