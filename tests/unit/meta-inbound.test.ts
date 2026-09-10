import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { normalizeMetaWebhook } from "../../apps/worker/src/meta-inbound";

describe("Meta inbound normalization", () => {
  it("normalizes every batch item without materializing media content", async () => {
    const body = await readFile("tests/fixtures/messaging/meta-batch-out-of-order.json");
    const items = normalizeMetaWebhook(body);
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.itemKey)).toEqual([
      "message:wamid.inbound-text",
      "message:wamid.inbound-document",
      "status:wamid.outbound:READ:1789000005",
      "status:wamid.outbound:SENT:1789000003",
      "status:wamid.outbound:DELIVERED:1789000004",
    ]);
    const media = items.find((item) => item.media)?.media;
    expect(media).toEqual({
      providerMediaId: "media-reference-only",
      mediaType: "document",
      mimeType: "application/pdf",
      filename: "synthetic.pdf",
      sha256: "synthetic-hash",
    });
    expect(JSON.stringify(media)).not.toContain("url");
    expect(JSON.stringify(media)).not.toContain("content");
  });
});
