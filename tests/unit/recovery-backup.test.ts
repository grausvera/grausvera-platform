import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecoveryBackup } from "../../packages/operations/src/recovery-backup.js";
import { FileRecoveryJournal } from "../../packages/operations/src/recovery-journal.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "grausvera-backup-"));
  roots.push(root);
  const objectRoot = join(root, "primary-objects");
  const journalRoot = join(root, "independent-journal");
  await mkdir(join(objectRoot, "case"), { recursive: true });
  await writeFile(join(objectRoot, "case", "opaque-object"), "synthetic-object");
  const journalKey = Buffer.alloc(32, 7);
  await new FileRecoveryJournal(journalRoot, journalKey).append({
    integrityHash: "opaque-integrity",
    actionId: "opaque-action",
  });
  return { root, objectRoot, journalRoot, journalKey };
}

describe("recovery backup", () => {
  it("creates one encrypted, coherent set with an independently verified journal", async () => {
    const value = await fixture();
    const result = await createRecoveryBackup({
      backupRoot: join(value.root, "isolated-backups"),
      objectRoot: value.objectRoot,
      journalRoot: value.journalRoot,
      encryptionKey: Buffer.alloc(32, 8),
      journalKey: value.journalKey,
      async createDatabaseSnapshot(path) {
        await writeFile(path, "synthetic-database-dump");
      },
    });
    expect(result.manifest.database.plaintextSha256).toHaveLength(64);
    expect(result.manifest.objects.map((entry) => entry.path)).toEqual(["case/opaque-object"]);
    expect(result.manifest.journalCheckpoint).toMatch(/^1:[0-9a-f]{64}$/);
    expect(result.manifest.cadence).toEqual({
      ordinaryObjectRpoSeconds: 3600,
      disasterFullRpoSeconds: 86400,
    });
    expect(
      await readFile(join(result.destination, "objects/case/opaque-object.enc"), "utf8"),
    ).not.toContain("synthetic-object");
    await expect(readFile(join(result.destination, ".database.dump"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed and leaves no partial set when the journal cannot be trusted", async () => {
    const value = await fixture();
    await writeFile(join(value.journalRoot, "deletions.jsonl"), '{"tampered":true}\n');
    const backupRoot = join(value.root, "isolated-backups");
    await expect(
      createRecoveryBackup({
        backupRoot,
        objectRoot: value.objectRoot,
        journalRoot: value.journalRoot,
        encryptionKey: Buffer.alloc(32, 8),
        journalKey: value.journalKey,
        async createDatabaseSnapshot(path) {
          await writeFile(path, "snapshot");
        },
      }),
    ).rejects.toThrow("recovery_journal_integrity_failed");
    expect(await import("node:fs/promises").then(({ readdir }) => readdir(backupRoot))).toEqual([]);
  });

  it("rejects shared credentials and overlapping recovery storage", async () => {
    const value = await fixture();
    const shared = Buffer.alloc(32, 7);
    await expect(
      createRecoveryBackup({
        backupRoot: join(value.root, "isolated-backups"),
        objectRoot: value.objectRoot,
        journalRoot: value.journalRoot,
        encryptionKey: shared,
        journalKey: shared,
        async createDatabaseSnapshot() {},
      }),
    ).rejects.toThrow("recovery_credentials_not_independent");
    await expect(
      createRecoveryBackup({
        backupRoot: join(value.objectRoot, "backups"),
        objectRoot: value.objectRoot,
        journalRoot: value.journalRoot,
        encryptionKey: Buffer.alloc(32, 8),
        journalKey: shared,
        async createDatabaseSnapshot() {},
      }),
    ).rejects.toThrow("recovery_storage_not_independent");
  });
});
