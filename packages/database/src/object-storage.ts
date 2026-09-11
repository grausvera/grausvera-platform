import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

export interface ObjectPort {
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}

function safePath(root: string, key: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9/_.-]*$/.test(key)) throw new Error("object_key_invalid");
  const base = resolve(root);
  const target = resolve(base, key);
  if (!target.startsWith(`${base}${sep}`)) throw new Error("object_key_invalid");
  return target;
}

export class LocalObjectPort implements ObjectPort {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = safePath(this.root, key);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes, { flag: "wx", mode: 0o600 });
  }

  async get(key: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(safePath(this.root, key)));
  }

  async remove(key: string): Promise<void> {
    await rm(safePath(this.root, key), { force: true });
  }
}

export interface S3ClientPort {
  putObject(input: {
    bucket: string;
    key: string;
    body: Uint8Array;
    contentType: string;
  }): Promise<void>;
  getObject(input: { bucket: string; key: string }): Promise<Uint8Array>;
  deleteObject(input: { bucket: string; key: string }): Promise<void>;
}

export class S3ObjectPort implements ObjectPort {
  constructor(
    private readonly client: S3ClientPort,
    private readonly bucket: string,
  ) {
    if (!bucket.trim()) throw new Error("object_bucket_invalid");
  }

  put(key: string, bytes: Uint8Array, contentType: string): Promise<void> {
    safePath("/object-root", key);
    return this.client.putObject({ bucket: this.bucket, key, body: bytes, contentType });
  }

  get(key: string): Promise<Uint8Array> {
    safePath("/object-root", key);
    return this.client.getObject({ bucket: this.bucket, key });
  }

  remove(key: string): Promise<void> {
    safePath("/object-root", key);
    return this.client.deleteObject({ bucket: this.bucket, key });
  }
}
