import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRecoveryBackup } from "./recovery-backup.js";

const exec = promisify(execFile);
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_required`);
  return value;
};
const key = (name: string) => {
  const decoded = Buffer.from(required(name), "base64");
  if (decoded.byteLength !== 32) throw new Error(`${name}_invalid`);
  return decoded;
};

const applicationDatabaseUrl = required("DATABASE_URL");
const recoveryDatabaseUrl = required("RECOVERY_DATABASE_URL");
if (applicationDatabaseUrl === recoveryDatabaseUrl)
  throw new Error("recovery_database_credential_not_independent");
const database = new URL(recoveryDatabaseUrl);
const result = await createRecoveryBackup({
  backupRoot: process.env.RECOVERY_BACKUP_ROOT ?? ".recovery/backups",
  objectRoot: process.env.OBJECT_STORAGE_ROOT ?? ".data/objects",
  journalRoot: process.env.RECOVERY_JOURNAL_ROOT ?? ".recovery/deletion-journal",
  encryptionKey: key("RECOVERY_ENCRYPTION_KEY_BASE64"),
  journalKey: key("RECOVERY_JOURNAL_KEY_BASE64"),
  async createDatabaseSnapshot(path) {
    await exec("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${path}`], {
      env: {
        ...process.env,
        PGHOST: database.hostname,
        PGPORT: database.port || "5432",
        PGDATABASE: database.pathname.slice(1),
        PGUSER: decodeURIComponent(database.username),
        PGPASSWORD: decodeURIComponent(database.password),
      },
    });
  },
});
process.stdout.write(
  `${JSON.stringify({ event: "recovery_backup_created", backupId: result.manifest.backupId, status: "created" })}\n`,
);
