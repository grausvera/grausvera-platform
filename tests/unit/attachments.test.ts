import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LocalObjectPort,
  S3ObjectPort,
  readBoundedAttachment,
  type S3ClientPort,
} from "../../packages/database/src";

const roots: string[] = [];
const body = (bytes: Uint8Array) =>
  (async function* () {
    yield bytes;
  })();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("safe attachments", () => {
  it("accepts a matching bounded file and rejects size, MIME and signature mismatches", async () => {
    const pdf = new TextEncoder().encode("%PDF-synthetic");
    await expect(
      readBoundedAttachment({
        contentType: "application/pdf",
        contentLength: pdf.length,
        body: body(pdf),
      }),
    ).resolves.toEqual(pdf);
    await expect(
      readBoundedAttachment({ contentType: "application/zip", body: body(pdf) }),
    ).rejects.toThrow("attachment_mime_rejected");
    await expect(
      readBoundedAttachment({
        contentType: "application/pdf",
        contentLength: 10_485_761,
        body: body(pdf),
      }),
    ).rejects.toThrow("attachment_size_exceeded");
    await expect(
      readBoundedAttachment({
        contentType: "application/pdf",
        body: body(new TextEncoder().encode("not-pdf")),
      }),
    ).rejects.toThrow("attachment_signature_rejected");
  });

  it("keeps local objects under its private root and blocks traversal", async () => {
    const root = await mkdtemp(join(tmpdir(), "grausvera-objects-"));
    roots.push(root);
    const objects = new LocalObjectPort(root);
    const bytes = new TextEncoder().encode("synthetic");
    await objects.put("attachments/org/case/id", bytes, "text/plain");
    await expect(objects.get("attachments/org/case/id")).resolves.toEqual(bytes);
    await expect(objects.put("../escape", bytes, "text/plain")).rejects.toThrow(
      "object_key_invalid",
    );
  });

  it("delegates opaque keys to an injected S3 client without credentials", async () => {
    const calls: string[] = [];
    const client: S3ClientPort = {
      async putObject(input) {
        calls.push(`put:${input.bucket}:${input.key}`);
      },
      async getObject(input) {
        calls.push(`get:${input.bucket}:${input.key}`);
        return new Uint8Array([1]);
      },
      async deleteObject(input) {
        calls.push(`delete:${input.bucket}:${input.key}`);
      },
    };
    const objects = new S3ObjectPort(client, "synthetic-bucket");
    await objects.put("attachments/org/case/id", new Uint8Array([1]), "application/pdf");
    await objects.get("attachments/org/case/id");
    await objects.remove("attachments/org/case/id");
    expect(calls).toEqual([
      "put:synthetic-bucket:attachments/org/case/id",
      "get:synthetic-bucket:attachments/org/case/id",
      "delete:synthetic-bucket:attachments/org/case/id",
    ]);
  });
});
