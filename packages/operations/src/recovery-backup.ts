import { createCipheriv, createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { inspectRecoveryJournal } from "./recovery-journal.js";

export interface RecoveryArtifact {
  path: string;
  plaintextSha256: string;
  encryptedBytes: number;
  iv: string;
  authTag: string;
}

export interface RecoveryManifest {
  schemaVersion: 1;
  backupId: string;
  startedAt: string;
  cutoffAt: string;
  completedAt: string;
  cadence: { ordinaryObjectRpoSeconds: 3600; disasterFullRpoSeconds: 86400 };
  database: RecoveryArtifact;
  objects: RecoveryArtifact[];
  journal: RecoveryArtifact | null;
  journalCheckpoint: string | null;
  consistencyHash: string;
}

async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function encrypt(source: string, destination: string, key: Buffer, logicalPath: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  await mkdir(resolve(destination, ".."), { recursive: true, mode: 0o700 });
  await pipeline(createReadStream(source), cipher, createWriteStream(destination, { mode: 0o600 }));
  return {
    path: logicalPath,
    plaintextSha256: await sha256(source),
    encryptedBytes: (await stat(destination)).size,
    iv: iv.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  } satisfies RecoveryArtifact;
}

async function files(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    },
  );
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error("recovery_object_symlink_forbidden");
      return entry.isDirectory() ? files(path) : [path];
    }),
  );
  return nested.flat().sort();
}

function inside(child: string, parent: string) {
  const path = relative(resolve(parent), resolve(child));
  return path !== "" && !path.startsWith(`..${sep}`) && path !== "..";
}

export async function createRecoveryBackup(input: {
  backupRoot: string;
  objectRoot: string;
  journalRoot: string;
  encryptionKey: Buffer;
  journalKey: Buffer;
  createDatabaseSnapshot(path: string): Promise<void>;
  now?: () => Date;
}) {
  if (input.encryptionKey.byteLength !== 32) throw new Error("recovery_encryption_key_invalid");
  if (input.encryptionKey.equals(input.journalKey))
    throw new Error("recovery_credentials_not_independent");
  if (
    [input.objectRoot, input.journalRoot].some(
      (root) => inside(input.backupRoot, root) || inside(root, input.backupRoot),
    )
  ) {
    throw new Error("recovery_storage_not_independent");
  }
  const now = input.now ?? (() => new Date());
  const backupId = `${now().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
  const staging = join(input.backupRoot, `.staging-${backupId}`);
  const destination = join(input.backupRoot, backupId);
  const databasePlain = join(staging, ".database.dump");
  const startedAt = now().toISOString();
  await mkdir(staging, { recursive: true, mode: 0o700 });
  try {
    await input.createDatabaseSnapshot(databasePlain);
    const cutoffAt = now().toISOString();
    const database = await encrypt(
      databasePlain,
      join(staging, "database.dump.enc"),
      input.encryptionKey,
      "database.dump.enc",
    );
    await rm(databasePlain, { force: true });
    const objects: RecoveryArtifact[] = [];
    for (const source of await files(input.objectRoot)) {
      const objectPath = relative(input.objectRoot, source);
      objects.push(
        await encrypt(
          source,
          join(staging, "objects", `${objectPath}.enc`),
          input.encryptionKey,
          objectPath,
        ),
      );
    }
    const journalState = await inspectRecoveryJournal(input.journalRoot, input.journalKey);
    const journalSource = join(input.journalRoot, "deletions.jsonl");
    const journal = journalState.count
      ? await encrypt(
          journalSource,
          join(staging, "journal.jsonl.enc"),
          input.encryptionKey,
          "journal.jsonl.enc",
        )
      : null;
    const completedAt = now().toISOString();
    const unsigned = {
      schemaVersion: 1 as const,
      backupId,
      startedAt,
      cutoffAt,
      completedAt,
      cadence: { ordinaryObjectRpoSeconds: 3600 as const, disasterFullRpoSeconds: 86400 as const },
      database,
      objects,
      journal,
      journalCheckpoint: journalState.checkpoint,
    };
    const manifest: RecoveryManifest = {
      ...unsigned,
      consistencyHash: createHmac("sha256", input.encryptionKey)
        .update(JSON.stringify(unsigned))
        .digest("hex"),
    };
    const handle = await open(join(staging, "manifest.json"), "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`);
    await handle.close();
    await mkdir(input.backupRoot, { recursive: true, mode: 0o700 });
    await rename(staging, destination);
    return { destination, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}
