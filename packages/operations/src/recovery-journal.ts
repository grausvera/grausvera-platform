import { createHmac } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

type JournalPayload = Record<string, unknown> & { integrityHash: string };

export interface RecoveryJournalRecord {
  sequence: number;
  recordedAt: string;
  kind: "intent" | "result";
  payload: JournalPayload;
  previousHash: string | null;
  recordHash: string;
}

function sign(key: Buffer, value: unknown): string {
  return createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
}

function validate(records: RecoveryJournalRecord[], key: Buffer) {
  let previousHash: string | null = null;
  for (const [index, record] of records.entries()) {
    const { recordHash, ...unsigned } = record;
    if (
      record.sequence !== index + 1 ||
      record.previousHash !== previousHash ||
      sign(key, unsigned) !== recordHash
    ) {
      throw new Error("recovery_journal_integrity_failed");
    }
    previousHash = recordHash;
  }
  return previousHash;
}

export class FileRecoveryJournal {
  readonly #root: string;
  readonly #key: Buffer;
  readonly #now: () => Date;

  constructor(root: string, key: Buffer, now: () => Date = () => new Date()) {
    if (key.byteLength !== 32) throw new Error("recovery_journal_key_invalid");
    this.#root = root;
    this.#key = key;
    this.#now = now;
  }

  async append(payload: JournalPayload): Promise<{ checkpoint: string }> {
    return this.#append("intent", payload);
  }

  async appendResult(payload: JournalPayload): Promise<{ checkpoint: string }> {
    return this.#append("result", payload);
  }

  async #append(kind: RecoveryJournalRecord["kind"], payload: JournalPayload) {
    await mkdir(this.#root, { recursive: true, mode: 0o700 });
    const path = join(this.#root, "deletions.jsonl");
    const existing = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const records = existing
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RecoveryJournalRecord);
    validate(records, this.#key);
    const previous = records.at(-1);
    const unsigned = {
      sequence: records.length + 1,
      recordedAt: this.#now().toISOString(),
      kind,
      payload,
      previousHash: previous?.recordHash ?? null,
    };
    const record: RecoveryJournalRecord = { ...unsigned, recordHash: sign(this.#key, unsigned) };
    await appendFile(path, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
    return { checkpoint: `${record.sequence}:${record.recordHash}` };
  }
}

export async function inspectRecoveryJournal(root: string, key: Buffer) {
  const records = await readRecoveryJournal(root, key);
  const hash = records.at(-1)?.recordHash ?? null;
  return { count: records.length, checkpoint: hash ? `${records.length}:${hash}` : null };
}

export async function readRecoveryJournal(root: string, key: Buffer) {
  const source = await readFile(join(root, "deletions.jsonl"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  const records = source
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as RecoveryJournalRecord);
  validate(records, key);
  return records;
}
