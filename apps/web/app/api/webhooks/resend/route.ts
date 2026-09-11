import { randomUUID } from "node:crypto";
import { EmailDeliveryStore } from "@grausvera/database";
import {
  parseResendWebhook,
  readLimitedResendBody,
  verifyResendSignature,
} from "../../../../lib/resend-webhook";

export const dynamic = "force-dynamic";
const noStoreHeaders = { "cache-control": "no-store" };

export async function POST(request: Request): Promise<Response> {
  const correlationId = randomUUID();
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  const connectionString = process.env.DATABASE_URL;
  if (!secret || !connectionString)
    return Response.json(
      { status: "unavailable", correlationId },
      { status: 503, headers: noStoreHeaders },
    );
  let body: Uint8Array;
  try {
    body = await readLimitedResendBody(request);
  } catch {
    return Response.json(
      { status: "too_large", correlationId },
      { status: 413, headers: noStoreHeaders },
    );
  }
  if (!verifyResendSignature(body, request.headers, secret)) {
    return Response.json(
      { status: "unauthorized", correlationId },
      { status: 401, headers: noStoreHeaders },
    );
  }
  const event = parseResendWebhook(body);
  const externalEventId = request.headers.get("svix-id");
  if (!event || !externalEventId)
    return Response.json(
      { status: "invalid", correlationId },
      { status: 400, headers: noStoreHeaders },
    );
  const store = new EmailDeliveryStore(connectionString);
  try {
    const receipt = await store.persistWebhook({ ...event, externalEventId, body });
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
