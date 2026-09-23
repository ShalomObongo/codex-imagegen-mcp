import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "../config.js";
import { ImagegenError } from "../errors.js";
import { ensureDir } from "../util/fs.js";

export type OutputFormat = "png" | "jpeg";

export interface PlannedOutput {
  path: string;
  format: OutputFormat;
}

export function newImageId(): string {
  return `img_${randomBytes(6).toString("hex")}`;
}

export function slugify(text: string, maxLength = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength)
    .replace(/-+$/g, "");
  return slug || "image";
}

function formatFromExtension(ext: string): OutputFormat | undefined {
  const e = ext.toLowerCase();
  if (e === ".png") return "png";
  if (e === ".jpg" || e === ".jpeg") return "jpeg";
  return undefined;
}

function extensionFor(format: OutputFormat): string {
  return format === "jpeg" ? ".jpg" : ".png";
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export interface PlanOptions {
  /** Caller-requested destination: a file path or a directory (existing, or ending in a separator). */
  outputPath?: string;
  /** Directory relative paths resolve against (the workspace root). */
  baseDir: string;
  /** Used when no outputPath is given. */
  defaultDir: string;
  /** Text used to build a descriptive default file name. */
  label: string;
  count: number;
  format?: OutputFormat;
  now?: Date;
}

/** Decide where each output goes (collisions are resolved at write time by `writeImageFile`). */
export async function planOutputs(o: PlanOptions): Promise<PlannedOutput[]> {
  const now = o.now ?? new Date();
  const stamp = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const suffix = (i: number) => (o.count > 1 ? `-${i + 1}` : "");
  const generatedName = (i: number, format: OutputFormat) => `${stamp}-${slugify(o.label)}${suffix(i)}${extensionFor(format)}`;

  if (!o.outputPath || !o.outputPath.trim()) {
    const format = o.format ?? "png";
    const dir = path.join(o.defaultDir, day);
    return Array.from({ length: o.count }, (_, i) => ({ path: path.join(dir, generatedName(i, format)), format }));
  }

  const raw = o.outputPath.trim();
  const resolved = path.resolve(o.baseDir, expandHome(raw));
  const endsWithSep = /[\\/]$/.test(raw);
  const isDir = endsWithSep || (await fs.stat(resolved).then((s) => s.isDirectory()).catch(() => false));
  if (isDir) {
    const format = o.format ?? "png";
    return Array.from({ length: o.count }, (_, i) => ({ path: path.join(resolved, generatedName(i, format)), format }));
  }

  const ext = path.extname(resolved);
  let format: OutputFormat;
  let base = resolved;
  if (!ext) {
    format = o.format ?? "png";
  } else {
    const fromExt = formatFromExtension(ext);
    if (!fromExt) {
      throw new ImagegenError("invalid_input", `output_path must end in .png, .jpg or .jpeg (got "${ext}").`);
    }
    if (o.format && o.format !== fromExt) {
      throw new ImagegenError("invalid_input", `output_format "${o.format}" conflicts with the "${ext}" extension of output_path.`);
    }
    format = fromExt;
    base = resolved.slice(0, -ext.length);
  }
  const extension = ext || extensionFor(format);
  return Array.from({ length: o.count }, (_, i) => ({ path: `${base}${suffix(i)}${extension}`, format }));
}

/**
 * Write image bytes. Without `overwrite`, an existing file is never replaced: a sibling name such
 * as `hero-2.png` is chosen instead (exclusive create, so concurrent writers can't collide).
 */
export async function writeImageFile(target: string, data: Uint8Array, overwrite: boolean): Promise<string> {
  await ensureDir(path.dirname(target), 0o755);
  if (overwrite) {
    await fs.writeFile(target, data, { mode: 0o644 });
    return target;
  }
  const ext = path.extname(target);
  const stem = target.slice(0, target.length - ext.length);
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? target : `${stem}-${n}${ext}`;
    try {
      await fs.writeFile(candidate, data, { flag: "wx", mode: 0o644 });
      return candidate;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }
  }
  throw new ImagegenError("internal", `Could not find a free file name next to ${target}.`);
}
