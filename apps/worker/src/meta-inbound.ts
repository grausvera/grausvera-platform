import { createHash } from "node:crypto";
import type { MessagingStore } from "@grausvera/database";

export type NormalizedInboundItem = {
  itemKey: string;
  kind: "MESSAGE" | "STATUS" | "UNSUPPORTED";
  providerMessageId?: string;
  senderExternalId?: string;
  replyToProviderMessageId?: string;
  messageType?: string;
  textContent?: string;
  providerOccurredAt: Date;
  receivedOrdinal: number;
  deliveryStatus?: "SENT" | "DELIVERED" | "READ" | "FAILED" | "DELETED";
  media?: {
    providerMediaId: string;
    mediaType: string;
    mimeType?: string;
    filename?: string;
    sha256?: string;
  };
};

type JsonObject = Record<string, unknown>;
const object = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const string = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;
const occurredAt = (value: unknown): Date => {
  const seconds = Number(value);
  return Number.isFinite(seconds) ? new Date(seconds * 1_000) : new Date(0);
};
const key = (parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

export function normalizeMetaWebhook(body: Uint8Array): NormalizedInboundItem[] {
  const root = object(JSON.parse(new TextDecoder().decode(body)));
  if (root?.object !== "whatsapp_business_account") throw new Error("invalid_meta_payload");
  const items: NormalizedInboundItem[] = [];
  let ordinal = 0;
  for (const entryValue of array(root.entry)) {
    const entry = object(entryValue);
    for (const changeValue of array(entry?.changes)) {
      const change = object(changeValue);
      const value = object(change?.value);
      for (const messageValue of array(value?.messages)) {
        const message = object(messageValue);
        const id = string(message?.id);
        const from = string(message?.from);
        const type = string(message?.type) ?? "unknown";
        if (!id || !from) continue;
        const typed = object(message?.[type]);
        const mediaId =
          type === "image" || type === "document" || type === "audio" || type === "video"
            ? string(typed?.id)
            : undefined;
        items.push({
          itemKey: `message:${id}`,
          kind: type === "text" || mediaId ? "MESSAGE" : "UNSUPPORTED",
          providerMessageId: id,
          senderExternalId: from,
          replyToProviderMessageId: string(object(message?.context)?.id),
          messageType: type,
          textContent: type === "text" ? string(object(message?.text)?.body) : undefined,
          providerOccurredAt: occurredAt(message?.timestamp),
          receivedOrdinal: ordinal++,
          media: mediaId
            ? {
                providerMediaId: mediaId,
                mediaType: type,
                mimeType: string(typed?.mime_type),
                filename: string(typed?.filename),
                sha256: string(typed?.sha256),
              }
            : undefined,
        });
      }
      for (const statusValue of array(value?.statuses)) {
        const status = object(statusValue);
        const id = string(status?.id);
        const rawStatus = string(status?.status)?.toUpperCase();
        if (!id || !rawStatus) continue;
        const supported = ["SENT", "DELIVERED", "READ", "FAILED", "DELETED"].includes(rawStatus);
        items.push({
          itemKey: supported
            ? `status:${id}:${rawStatus}:${string(status?.timestamp) ?? "0"}`
            : `unsupported:${key([id, rawStatus, status?.timestamp])}`,
          kind: supported ? "STATUS" : "UNSUPPORTED",
          providerMessageId: id,
          providerOccurredAt: occurredAt(status?.timestamp),
          receivedOrdinal: ordinal++,
          deliveryStatus: supported
            ? (rawStatus as NormalizedInboundItem["deliveryStatus"])
            : undefined,
        });
      }
    }
  }
  return items;
}

export class MetaInboxReconciler {
  constructor(private readonly store: MessagingStore) {}

  async reconcileOne(): Promise<"idle" | "processed"> {
    const receipt = await this.store.claimNextInbox();
    if (!receipt) return "idle";
    try {
      await this.store.reconcileInbox(receipt.id, normalizeMetaWebhook(receipt.body));
      return "processed";
    } catch {
      await this.store.releaseInboxAfterFailure(receipt.id, "inbound_reconciliation_failed");
      throw new Error("inbound_reconciliation_failed");
    }
  }
}
