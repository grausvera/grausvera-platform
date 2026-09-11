import { createHash, randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import type { ObjectPort } from "./object-storage.js";

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/jpeg",
  "image/png",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "video/mp4",
]);

export interface MediaDownload {
  contentType: string;
  contentLength?: number;
  body: AsyncIterable<Uint8Array>;
}

export interface MediaDownloadPort {
  download(providerMediaId: string): Promise<MediaDownload>;
}

export type AttachmentReview = "REVIEWED" | "REJECTED";

function hasSignature(mimeType: string, bytes: Uint8Array): boolean {
  const ascii = (start: number, end: number) => new TextDecoder().decode(bytes.slice(start, end));
  if (mimeType === "application/pdf") return ascii(0, 5) === "%PDF-";
  if (mimeType === "image/png") return bytes.slice(0, 8).toString() === "137,80,78,71,13,10,26,10";
  if (mimeType === "image/jpeg") return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mimeType === "image/webp") return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  if (mimeType === "audio/ogg") return ascii(0, 4) === "OggS";
  if (mimeType === "audio/mpeg")
    return ascii(0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1] ?? 0) >= 0xe0);
  if (mimeType === "video/mp4") return ascii(4, 8) === "ftyp";
  if (mimeType === "text/plain") {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export async function readBoundedAttachment(download: MediaDownload): Promise<Uint8Array> {
  if (!ALLOWED_MIME_TYPES.has(download.contentType)) throw new Error("attachment_mime_rejected");
  if (download.contentLength !== undefined && download.contentLength > MAX_ATTACHMENT_BYTES)
    throw new Error("attachment_size_exceeded");
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of download.body) {
    size += chunk.byteLength;
    if (size > MAX_ATTACHMENT_BYTES) throw new Error("attachment_size_exceeded");
    chunks.push(chunk);
  }
  if (size === 0 || (download.contentLength !== undefined && size !== download.contentLength))
    throw new Error("attachment_download_incomplete");
  const bytes = new Uint8Array(Buffer.concat(chunks));
  if (!hasSignature(download.contentType, bytes)) throw new Error("attachment_signature_rejected");
  return bytes;
}

export class AttachmentStore {
  readonly #pool: Pool;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString, max: 5 });
  }

  close(): Promise<void> {
    return this.#pool.end();
  }

  async acquireDownload(organizationId: string, providerConnectionId: string): Promise<void> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO attachment_circuit_breakers (organization_id, provider_connection_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [organizationId, providerConnectionId],
      );
      const result = await client.query<{
        consecutive_failures: number;
        open_until: Date | null;
        probe_in_flight: boolean;
      }>(
        `SELECT consecutive_failures, open_until, probe_in_flight
         FROM attachment_circuit_breakers
         WHERE organization_id = $1 AND provider_connection_id = $2 FOR UPDATE`,
        [organizationId, providerConnectionId],
      );
      const state = result.rows[0];
      if (!state) throw new Error("attachment_circuit_unavailable");
      if (state.open_until && state.open_until.getTime() > Date.now())
        throw new Error("attachment_circuit_open");
      if (state.consecutive_failures >= 3) {
        if (state.probe_in_flight) throw new Error("attachment_circuit_probe_busy");
        await client.query(
          `UPDATE attachment_circuit_breakers SET probe_in_flight = true, updated_at = now()
           WHERE organization_id = $1 AND provider_connection_id = $2`,
          [organizationId, providerConnectionId],
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordDownloadResult(
    organizationId: string,
    providerConnectionId: string,
    succeeded: boolean,
  ): Promise<void> {
    await this.#pool.query(
      succeeded
        ? `UPDATE attachment_circuit_breakers SET consecutive_failures = 0,
             open_until = NULL, probe_in_flight = false, updated_at = now()
           WHERE organization_id = $1 AND provider_connection_id = $2`
        : `UPDATE attachment_circuit_breakers SET
             consecutive_failures = consecutive_failures + 1,
             open_until = CASE WHEN consecutive_failures + 1 >= 3
               THEN now() + interval '60 seconds' ELSE NULL END,
             probe_in_flight = false, updated_at = now()
           WHERE organization_id = $1 AND provider_connection_id = $2`,
      [organizationId, providerConnectionId],
    );
  }

  async findByMedia(organizationId: string, mediaReferenceId: string) {
    return this.#pool
      .query<{ id: string; object_key: string; status: string }>(
        `SELECT id, object_key, status FROM attachments
         WHERE organization_id = $1 AND media_reference_id = $2`,
        [organizationId, mediaReferenceId],
      )
      .then((result) => result.rows[0]);
  }

  async authorizeDownload(input: {
    organizationId: string;
    caseId: string;
    providerConnectionId: string;
    mediaReferenceId: string;
    providerMediaId: string;
  }): Promise<void> {
    const authorized = await this.#pool.query(
      `SELECT 1 FROM media_references mr
       JOIN inbox_event_items i ON i.id = mr.inbox_item_id
       JOIN provider_connections pc ON pc.id = i.provider_connection_id
         AND pc.organization_id = i.organization_id
       WHERE i.organization_id = $1 AND i.case_id = $2
         AND i.provider_connection_id = $3 AND mr.id = $4 AND mr.provider_media_id = $5`,
      [
        input.organizationId,
        input.caseId,
        input.providerConnectionId,
        input.mediaReferenceId,
        input.providerMediaId,
      ],
    );
    if ((authorized.rowCount ?? 0) !== 1) throw new Error("attachment_download_not_authorized");
  }

  async quarantine(input: {
    id: string;
    organizationId: string;
    caseId: string;
    mediaReferenceId: string;
    objectKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
  }): Promise<boolean> {
    const result = await this.#pool.query(
      `INSERT INTO attachments
        (id, organization_id, case_id, media_reference_id, object_key, mime_type, size_bytes, sha256)
       SELECT $1, i.organization_id, i.case_id, mr.id, $5, $6, $7, $8
       FROM media_references mr JOIN inbox_event_items i ON i.id = mr.inbox_item_id
       WHERE mr.id = $4 AND i.organization_id = $2 AND i.case_id = $3
       ON CONFLICT (organization_id, media_reference_id) DO NOTHING`,
      [
        input.id,
        input.organizationId,
        input.caseId,
        input.mediaReferenceId,
        input.objectKey,
        input.mimeType,
        input.sizeBytes,
        input.sha256,
      ],
    );
    if ((result.rowCount ?? 0) === 0) {
      const existing = await this.findByMedia(input.organizationId, input.mediaReferenceId);
      if (!existing) throw new Error("attachment_media_not_authorized");
      return false;
    }
    return true;
  }

  async review(input: {
    organizationId: string;
    attachmentId: string;
    operatorUserId: string;
    decision: AttachmentReview;
    reason?: string;
    correlationId: string;
  }): Promise<void> {
    if (input.decision === "REJECTED" && !input.reason?.trim())
      throw new Error("attachment_rejection_reason_required");
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<{ case_id: string }>(
        `UPDATE attachments a SET status = $4::attachment_status,
           reviewed_by_user_id = $3, reviewed_at = now(),
           rejection_reason = CASE WHEN $4 = 'REJECTED' THEN $5 ELSE NULL END,
           updated_at = now()
         WHERE a.organization_id = $1 AND a.id = $2 AND a.status = 'QUARANTINED'
           AND EXISTS (SELECT 1 FROM operator_memberships m
             WHERE m.organization_id = $1 AND m.user_id = $3 AND m.active)
         RETURNING case_id`,
        [
          input.organizationId,
          input.attachmentId,
          input.operatorUserId,
          input.decision,
          input.reason?.trim(),
        ],
      );
      const row = updated.rows[0];
      if (!row) throw new Error("attachment_review_not_authorized");
      await this.#audit(
        client,
        input.organizationId,
        row.case_id,
        input.attachmentId,
        `attachment.${input.decision.toLowerCase()}`,
        input.operatorUserId,
        input.correlationId,
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async #audit(
    client: PoolClient,
    organizationId: string,
    caseId: string,
    resourceId: string,
    action: string,
    actor: string,
    correlationId: string,
  ) {
    await client.query(
      `INSERT INTO audit_events
        (organization_id, case_id, actor, action, resource_type, resource_id,
         result, correlation_id, origin, metadata)
       VALUES ($1, $2, $3, $4, 'attachment', $5, 'SUCCEEDED', $6, 'attachment-store', '{}')`,
      [organizationId, caseId, actor, action, resourceId, correlationId],
    );
  }
}

export class AttachmentService {
  constructor(
    private readonly store: AttachmentStore,
    private readonly source: MediaDownloadPort,
    private readonly objects: ObjectPort,
  ) {}

  async download(input: {
    organizationId: string;
    caseId: string;
    providerConnectionId: string;
    mediaReferenceId: string;
    providerMediaId: string;
    declaredMimeType?: string;
    declaredSha256?: string;
  }) {
    await this.store.authorizeDownload(input);
    const existing = await this.store.findByMedia(input.organizationId, input.mediaReferenceId);
    if (existing) return { ...existing, created: false };
    await this.store.acquireDownload(input.organizationId, input.providerConnectionId);
    let download: MediaDownload;
    try {
      download = await this.source.download(input.providerMediaId);
      await this.store.recordDownloadResult(input.organizationId, input.providerConnectionId, true);
    } catch {
      await this.store.recordDownloadResult(
        input.organizationId,
        input.providerConnectionId,
        false,
      );
      throw new Error("attachment_provider_download_failed");
    }
    if (input.declaredMimeType && input.declaredMimeType !== download.contentType)
      throw new Error("attachment_mime_mismatch");
    const bytes = await readBoundedAttachment(download);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (input.declaredSha256 && input.declaredSha256.toLowerCase() !== sha256)
      throw new Error("attachment_hash_mismatch");
    const id = randomUUID();
    const objectKey = `attachments/${input.organizationId}/${input.caseId}/${id}`;
    await this.objects.put(objectKey, bytes, download.contentType);
    try {
      const created = await this.store.quarantine({
        id,
        organizationId: input.organizationId,
        caseId: input.caseId,
        mediaReferenceId: input.mediaReferenceId,
        objectKey,
        mimeType: download.contentType,
        sizeBytes: bytes.byteLength,
        sha256,
      });
      if (!created) await this.objects.remove(objectKey);
      return created
        ? { id, object_key: objectKey, status: "QUARANTINED", created: true }
        : {
            ...(await this.store.findByMedia(input.organizationId, input.mediaReferenceId)),
            created: false,
          };
    } catch (error) {
      await this.objects.remove(objectKey);
      throw error;
    }
  }
}
