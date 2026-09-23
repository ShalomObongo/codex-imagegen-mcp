import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ImagegenError } from "../errors.js";
import { sleep } from "./http.js";

export async function ensureDir(dir: string, mode = 0o700): Promise<void> {
  await fs.mkdir(dir, { recursive: true, mode });
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Write a file atomically: write a temp file in the same directory, fsync, then rename over the
 * target. Readers (including other processes) never observe a half-written credentials file.
 */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  const handle = await fs.open(tmp, "w", mode);
  try {
    await handle.writeFile(data);
    // Set the mode before the rename (umask may have narrowed it), so the file is final the
    // moment it becomes visible and nothing else awaits after that.
    await handle.chmod(mode).catch(() => undefined);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Parse a JSON file; `undefined` if it does not exist. Throws on malformed JSON. */
export async function readJsonFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  return JSON.parse(text) as unknown;
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export interface LockOptions {
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. */
  staleMs?: number;
}

/**
 * Cross-process mutex based on an exclusively-created lock file. Used around token refresh so
 * several server processes (e.g. one per opencode project) never spend the same single-use
 * refresh token twice.
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const staleMs = options.staleMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  await ensureDir(path.dirname(lockPath));
  for (;;) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: Date.now() }));
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const stat = await fs.stat(lockPath).catch(() => undefined);
      if (!stat) continue;
      let stale = Date.now() - stat.mtimeMs > staleMs;
      if (!stale) {
        const owner = (await readJsonFile(lockPath).catch(() => undefined)) as { pid?: unknown } | undefined;
        if (typeof owner?.pid === "number" && !isPidAlive(owner.pid)) stale = true;
      }
      if (stale) {
        await fs.rm(lockPath, { force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new ImagegenError("internal", `Timed out waiting for the credentials lock (${lockPath}). If no other process is signing in, delete that file.`);
      }
      await sleep(40 + Math.floor(Math.random() * 80));
    }
  }
  try {
    return await fn();
  } finally {
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
}
