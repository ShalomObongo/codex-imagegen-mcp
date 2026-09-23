import fs from "node:fs/promises";
import path from "node:path";
import { ensureDir } from "./util/fs.js";
import { isRecord, str } from "./util/http.js";

export type HistoryTool = "generate_image" | "edit_image" | "remove_background";

/** One saved image. Appended to `<home>/history.jsonl`. */
export interface HistoryEntry {
  id: string;
  created_at: string;
  tool: HistoryTool;
  path: string;
  mime_type: string;
  bytes: number;
  width?: number;
  height?: number;
  prompt?: string;
  inputs?: string[];
  background?: string;
  service_size?: string;
  service_quality?: string;
  request_id?: string;
  generation_id?: string;
  elapsed_ms?: number;
  credential_source?: string;
}

const MAX_ENTRIES_READ = 2000;

export class History {
  constructor(private readonly file: string) {}

  get path(): string {
    return this.file;
  }

  async append(entry: HistoryEntry): Promise<void> {
    await ensureDir(path.dirname(this.file));
    await fs.appendFile(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
  }

  /** Newest first. Malformed lines are skipped. */
  async list(limit = 50): Promise<HistoryEntry[]> {
    let text: string;
    try {
      text = await fs.readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const lines = text.split("\n").filter(Boolean).slice(-MAX_ENTRIES_READ);
    const entries: HistoryEntry[] = [];
    for (let i = lines.length - 1; i >= 0 && entries.length < limit; i--) {
      try {
        const v: unknown = JSON.parse(lines[i]!);
        if (isRecord(v) && str(v.id) && str(v.path)) entries.push(v as unknown as HistoryEntry);
      } catch {
        /* skip */
      }
    }
    return entries;
  }

  async get(id: string): Promise<HistoryEntry | undefined> {
    return (await this.list(MAX_ENTRIES_READ)).find((e) => e.id === id);
  }
}
