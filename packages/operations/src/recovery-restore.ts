import { createDecipheriv, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import type { RecoveryArtifact, RecoveryManifest } from "./recovery-backup.js";
import { readRecoveryJournal, type RecoveryJournalRecord } from "./recovery-journal.js";

function safePath(root: string, path: string) {
  const destination = resolve(root, path);
  const relation = relative(resolve(root), destination);
  if (!relation || relation === ".." || relation.startsWith(`..${sep}`)) {
    throw new Error("recovery_artifact_path_invalid");
  }
  return destination;
}

async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function decrypt(
  backup: string,
  artifact: RecoveryArtifact,
  destination: string,
  key: Buffer,
) {
  const source = safePath(backup, artifact.path);
  if ((await stat(source)).size !== artifact.encryptedBytes) {
    throw new Error("recovery_artifact_size_mismatch");
  }
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(artifact.iv, "base64"));
  decipher.setAuthTag(Buffer.from(artifact.authTag, "base64"));
  await pipeline(
    createReadStream(source),
    decipher,
    createWriteStream(destination, { mode: 0o600 }),
  );
  if ((await sha256(destination)) !== artifact.plaintextSha256) {
    throw new Error("recovery_artifact_hash_mismatch");
  }
}

function verifyManifest(manifest: RecoveryManifest, key: Buffer) {
  const { consistencyHash, ...unsigned } = manifest;
  const expected = createHmac("sha256", key).update(JSON.stringify(unsigned)).digest();
  const received = Buffer.from(consistencyHash, "hex");
  if (received.byteLength !== expected.byteLength || !timingSafeEqual(received, expected)) {
    throw new Error("recovery_manifest_integrity_failed");
  }
}

export async function restoreRecoveryBackup(input: {
  backup: string;
  targetObjectRoot: string;
  independentJournalRoot: string;
  encryptionKey: Buffer;
  journalKey: Buffer;
  messagingEmitterEnabled: boolean;
  emailEmitterEnabled: boolean;
  modelsEnabled: boolean;
  mode: "ordinary" | "disaster";
  restoreDatabase(path: string): Promise<void>;
  reapplyDeletions(records: RecoveryJournalRecord[]): Promise<void>;
  reconcile(): Promise<void>;
  now?: () => Date;
}) {
  if (input.messagingEmitterEnabled || input.emailEmitterEnabled || input.modelsEnabled) {
    throw new Error("recovery_capabilities_must_start_disabled");
  }
  if (input.encryptionKey.byteLength !== 32 || input.journalKey.byteLength !== 32) {
    throw new Error("recovery_key_invalid");
  }
  await stat(join(input.independentJournalRoot, "deletions.jsonl")).catch(() => {
    throw new Error("recovery_independent_journal_required");
  });
  const journal = await readRecoveryJournal(input.independentJournalRoot, input.journalKey);
  const started = input.now?.() ?? new Date();
  const manifest = JSON.parse(
    await readFile(join(input.backup, "manifest.json"), "utf8"),
  ) as RecoveryManifest;
  verifyManifest(manifest, input.encryptionKey);
  if (manifest.journalCheckpoint) {
    const [sequenceText, hash] = manifest.journalCheckpoint.split(":");
    const sequence = Number(sequenceText);
    if (!hash || journal[sequence - 1]?.recordHash !== hash) {
      throw new Error("recovery_independent_journal_incomplete");
    }
  }
  const cutoff = new Date(manifest.cutoffAt);
  if (Number.isNaN(cutoff.valueOf())) throw new Error("recovery_cutoff_invalid");
  const objectTarget = resolve(input.targetObjectRoot);
  await readdir(objectTarget).then(
    (entries) => {
      if (entries.length) throw new Error("recovery_target_not_empty");
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const staging = `${objectTarget}.recovery-staging`;
  await rm(staging, { recursive: true, force: true });
  await mkdir(staging, { recursive: true, mode: 0o700 });
  const database = join(staging, ".database.dump");
  try {
    await decrypt(input.backup, manifest.database, database, input.encryptionKey);
    for (const artifact of manifest.objects) {
      await decrypt(
        join(input.backup, "objects"),
        { ...artifact, path: `${artifact.path}.enc` },
        safePath(staging, artifact.path),
        input.encryptionKey,
      );
    }
    if (manifest.journal) {
      await decrypt(
        input.backup,
        manifest.journal,
        join(staging, ".journal.jsonl"),
        input.encryptionKey,
      );
    }
    await input.restoreDatabase(database);
    await rm(database, { force: true });
    await rm(join(staging, ".journal.jsonl"), { force: true });
    await rename(staging, objectTarget);
    const laterDeletions = journal.filter((record) => new Date(record.recordedAt) > cutoff);
    await input.reapplyDeletions(laterDeletions);
    await input.reconcile();
    const completed = input.now?.() ?? new Date();
    const rpoSeconds = Math.max(0, Math.ceil((started.valueOf() - cutoff.valueOf()) / 1000));
    const rtoSeconds = Math.max(0, (completed.valueOf() - started.valueOf()) / 1000);
    const rpoTargetSeconds = input.mode === "ordinary" ? 3600 : 86400;
    const rtoTargetSeconds = input.mode === "ordinary" ? 14400 : 86400;
    return {
      backupId: manifest.backupId,
      cutoffAt: manifest.cutoffAt,
      journalCheckpoint: journal.at(-1) ? `${journal.length}:${journal.at(-1)?.recordHash}` : null,
      reappliedRecords: laterDeletions.length,
      rpoSeconds,
      rtoSeconds,
      rpoTargetSeconds,
      rtoTargetSeconds,
      meetsRpo: rpoSeconds <= rpoTargetSeconds,
      meetsRto: rtoSeconds <= rtoTargetSeconds,
      capabilitiesEnabled: false as const,
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
