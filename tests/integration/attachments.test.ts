import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import {
  AttachmentService,
  AttachmentStore,
  type MediaDownloadPort,
  type ObjectPort,
} from "../../packages/database/src";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");

const pool = new Pool({ connectionString });
const store = new AttachmentStore(connectionString);
const objects = new Map<string, Uint8Array>();
const objectPort: ObjectPort = {
  async put(key, bytes) {
    objects.set(key, bytes);
  },
  async get(key) {
    const value = objects.get(key);
    if (!value) throw new Error("missing");
    return value;
  },
  async remove(key) {
    objects.delete(key);
  },
};
const pdf = new TextEncoder().encode("%PDF-synthetic-safe");
const source: MediaDownloadPort = {
  async download() {
    return {
      contentType: "application/pdf",
      contentLength: pdf.length,
      body: (async function* () {
        yield pdf;
      })(),
    };
  },
};
const service = new AttachmentService(store, source, objectPort);
let organizationId: string;
let caseId: string;
let connectionId: string;
let mediaReferenceId: string;
const operatorUserId = `operator-${randomUUID()}`;

beforeAll(async () => {
  organizationId = await pool
    .query<{ id: string }>(
      `INSERT INTO organizations (id, slug, display_name) VALUES ($1, 'grausvera', 'grausvera')
       ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name RETURNING id`,
      [randomUUID()],
    )
    .then((result) => result.rows[0]?.id ?? "");
  caseId = randomUUID();
  connectionId = randomUUID();
  const inboxId = randomUUID();
  const itemId = randomUUID();
  mediaReferenceId = randomUUID();
  await pool.query(`INSERT INTO prospect_cases (id, organization_id) VALUES ($1, $2)`, [
    caseId,
    organizationId,
  ]);
  await pool.query(
    `INSERT INTO provider_connections (id, organization_id, kind, external_account_id, credential_reference)
     VALUES ($1, $2, 'WHATSAPP', $3, 'secret://synthetic/meta')`,
    [connectionId, organizationId, `account-${connectionId}`],
  );
  await pool.query(
    `INSERT INTO inbox_events
      (id, organization_id, provider_connection_id, external_event_id, payload_bytes, payload_hash)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      inboxId,
      organizationId,
      connectionId,
      randomUUID(),
      Buffer.from("{}"),
      createHash("sha256").update("{}").digest("hex"),
    ],
  );
  await pool.query(
    `INSERT INTO inbox_event_items
      (id, inbox_event_id, organization_id, provider_connection_id, item_key, kind,
       provider_message_id, message_type, provider_occurred_at, received_ordinal, status, case_id)
     VALUES ($1, $2, $3, $4, $5, 'MESSAGE', $6, 'document', now(), 0, 'ASSOCIATED', $7)`,
    [itemId, inboxId, organizationId, connectionId, randomUUID(), randomUUID(), caseId],
  );
  await pool.query(
    `INSERT INTO media_references
      (id, inbox_item_id, provider_media_id, media_type, mime_type, sha256)
     VALUES ($1, $2, 'synthetic-media', 'document', 'application/pdf', $3)`,
    [mediaReferenceId, itemId, createHash("sha256").update(pdf).digest("hex")],
  );
  await pool.query(
    `INSERT INTO "user" (id, name, email, "emailVerified") VALUES ($1, 'operator', $2, true)`,
    [operatorUserId, `${operatorUserId}@example.invalid`],
  );
  await pool.query(`INSERT INTO operator_memberships (organization_id, user_id) VALUES ($1, $2)`, [
    organizationId,
    operatorUserId,
  ]);
});

afterAll(async () => {
  await store.close();
  await pool.end();
});

describe("durable safe attachments", () => {
  it("opens after a failure burst and permits only one recovery probe", async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store.acquireDownload(organizationId, connectionId);
      await store.recordDownloadResult(organizationId, connectionId, false);
    }
    await expect(store.acquireDownload(organizationId, connectionId)).rejects.toThrow(
      "attachment_circuit_open",
    );
    await pool.query(
      `UPDATE attachment_circuit_breakers SET open_until = now() - interval '1 second'
       WHERE organization_id = $1 AND provider_connection_id = $2`,
      [organizationId, connectionId],
    );
    const probes = await Promise.allSettled([
      store.acquireDownload(organizationId, connectionId),
      store.acquireDownload(organizationId, connectionId),
    ]);
    expect(probes.filter((probe) => probe.status === "fulfilled")).toHaveLength(1);
    expect(probes.filter((probe) => probe.status === "rejected")).toHaveLength(1);
    await store.recordDownloadResult(organizationId, connectionId, true);
  });

  it("downloads once into quarantine and requires an authorized review", async () => {
    const input = {
      organizationId,
      caseId,
      providerConnectionId: connectionId,
      mediaReferenceId,
      providerMediaId: "synthetic-media",
      declaredMimeType: "application/pdf",
      declaredSha256: createHash("sha256").update(pdf).digest("hex"),
    };
    const created = await service.download(input);
    expect(created).toMatchObject({ created: true, status: "QUARANTINED" });
    expect(objects.size).toBe(1);
    await expect(service.download(input)).resolves.toMatchObject({
      created: false,
      id: created.id,
    });
    expect(objects.size).toBe(1);
    await expect(
      store.review({
        organizationId,
        attachmentId: created.id,
        operatorUserId: "unknown",
        decision: "REVIEWED",
        correlationId: randomUUID(),
      }),
    ).rejects.toThrow("attachment_review_not_authorized");
    await store.review({
      organizationId,
      attachmentId: created.id,
      operatorUserId,
      decision: "REVIEWED",
      correlationId: randomUUID(),
    });
    const state = await pool.query(
      `SELECT status, reviewed_by_user_id,
        (SELECT count(*)::integer FROM audit_events WHERE resource_id = $1
          AND action = 'attachment.reviewed') AS audits
       FROM attachments WHERE id = $1`,
      [created.id],
    );
    expect(state.rows[0]).toEqual({
      status: "REVIEWED",
      reviewed_by_user_id: operatorUserId,
      audits: 1,
    });
  });
});
