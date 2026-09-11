import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRecoveryBackup } from "../../packages/operations/src/recovery-backup.js";
import { FileRecoveryJournal } from "../../packages/operations/src/recovery-journal.js";
import { restoreRecoveryBackup } from "../../packages/operations/src/recovery-restore.js";

const roots: string[] = [];
afterEach(async () =>
  Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

async function scenario() {
  const root = await mkdtemp(join(tmpdir(), "grausvera-recovery-"));
  roots.push(root);
  const objects = join(root, "primary", "objects");
  const journalRoot = join(root, "independent", "journal");
  const backupRoot = join(root, "independent", "backups");
  const encryptionKey = Buffer.alloc(32, 3);
  const journalKey = Buffer.alloc(32, 4);
  await mkdir(join(objects, "case"), { recursive: true });
  await writeFile(join(objects, "case", "object"), "object-before-loss");
  let journalNow = new Date("2026-09-11T09:59:00Z");
  const journal = new FileRecoveryJournal(journalRoot, journalKey, () => journalNow);
  await journal.append({ integrityHash: "before", actionId: "before-cutoff" });
  const times = [
    new Date("2026-09-11T10:00:00Z"),
    new Date("2026-09-11T10:00:01Z"),
    new Date("2026-09-11T10:00:02Z"),
  ];
  const backup = await createRecoveryBackup({
    backupRoot,
    objectRoot: objects,
    journalRoot,
    encryptionKey,
    journalKey,
    now: () => times.shift() ?? new Date("2026-09-11T10:00:02Z"),
    async createDatabaseSnapshot(path) {
      await writeFile(path, "database-before-loss");
    },
  });
  journalNow = new Date("2026-09-11T10:00:03Z");
  await journal.append({ integrityHash: "after", actionId: "delete-after-cutoff" });
  return { root, journalRoot, encryptionKey, journalKey, backup: backup.destination };
}

describe("isolated recovery", () => {
  it("restores database and objects, reapplies later deletions, reconciles, and measures targets", async () => {
    const value = await scenario();
    const target = join(value.root, "isolated-restore", "objects");
    const actions: string[] = [];
    const clock = [new Date("2026-09-11T10:30:00Z"), new Date("2026-09-11T10:30:12Z")];
    const result = await restoreRecoveryBackup({
      backup: value.backup,
      targetObjectRoot: target,
      independentJournalRoot: value.journalRoot,
      encryptionKey: value.encryptionKey,
      journalKey: value.journalKey,
      messagingEmitterEnabled: false,
      emailEmitterEnabled: false,
      modelsEnabled: false,
      mode: "ordinary",
      now: () => clock.shift() ?? new Date("2026-09-11T10:30:12Z"),
      async restoreDatabase(path) {
        expect(await readFile(path, "utf8")).toBe("database-before-loss");
        actions.push("database");
      },
      async reapplyDeletions(records) {
        expect(records.map((record) => record.payload.actionId)).toEqual(["delete-after-cutoff"]);
        actions.push("deletions");
      },
      async reconcile() {
        actions.push("reconcile");
      },
    });
    expect(await readFile(join(target, "case", "object"), "utf8")).toBe("object-before-loss");
    expect(actions).toEqual(["database", "deletions", "reconcile"]);
    expect(result).toMatchObject({
      meetsRpo: true,
      meetsRto: true,
      capabilitiesEnabled: false,
      rtoSeconds: 12,
    });
  });

  it("blocks before restoring when the independent journal is missing", async () => {
    const value = await scenario();
    await rm(value.journalRoot, { recursive: true });
    let restored = false;
    await expect(
      restoreRecoveryBackup({
        backup: value.backup,
        targetObjectRoot: join(value.root, "target"),
        independentJournalRoot: value.journalRoot,
        encryptionKey: value.encryptionKey,
        journalKey: value.journalKey,
        messagingEmitterEnabled: false,
        emailEmitterEnabled: false,
        modelsEnabled: false,
        mode: "disaster",
        async restoreDatabase() {
          restored = true;
        },
        async reapplyDeletions() {},
        async reconcile() {},
      }),
    ).rejects.toThrow("recovery_independent_journal_required");
    expect(restored).toBe(false);
  });

  it("distinguishes ordinary and disaster RPO without changing the recovered point", async () => {
    const value = await scenario();
    const clock = [new Date("2026-09-11T15:00:00Z"), new Date("2026-09-11T15:00:10Z")];
    const result = await restoreRecoveryBackup({
      backup: value.backup,
      targetObjectRoot: join(value.root, "disaster-target"),
      independentJournalRoot: value.journalRoot,
      encryptionKey: value.encryptionKey,
      journalKey: value.journalKey,
      messagingEmitterEnabled: false,
      emailEmitterEnabled: false,
      modelsEnabled: false,
      mode: "disaster",
      now: () => clock.shift() ?? new Date("2026-09-11T15:00:10Z"),
      async restoreDatabase() {},
      async reapplyDeletions() {},
      async reconcile() {},
    });
    expect(result).toMatchObject({
      rpoTargetSeconds: 86_400,
      rtoTargetSeconds: 86_400,
      meetsRpo: true,
      meetsRto: true,
    });
    expect(result.rpoSeconds).toBeGreaterThan(3_600);
  });

  it("refuses recovery while any external capability is enabled", async () => {
    const value = await scenario();
    await expect(
      restoreRecoveryBackup({
        backup: value.backup,
        targetObjectRoot: join(value.root, "target"),
        independentJournalRoot: value.journalRoot,
        encryptionKey: value.encryptionKey,
        journalKey: value.journalKey,
        messagingEmitterEnabled: true,
        emailEmitterEnabled: false,
        modelsEnabled: false,
        mode: "ordinary",
        async restoreDatabase() {},
        async reapplyDeletions() {},
        async reconcile() {},
      }),
    ).rejects.toThrow("recovery_capabilities_must_start_disabled");
  });
});
