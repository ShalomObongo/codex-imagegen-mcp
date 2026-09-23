import fs from "node:fs/promises";
import { locations, tildify, which, type InstallContext } from "./context.js";
import { EDITOR_HOSTS, type ClientDefinition, type Detection, type EditorHost } from "./clients.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Extension ids installed in one editor. `extensions.json` is authoritative; folders listed in
 * `.obsolete` were uninstalled but not deleted yet. Falls back to `<publisher>.<name>-<version>`
 * folder names.
 */
export async function installedExtensions(ctx: InstallContext, host: EditorHost): Promise<Set<string>> {
  const dir = host.extensionsDir(ctx);
  const p = locations(ctx).p;
  const obsoleteRaw = await readJson(p.join(dir, ".obsolete"));
  const obsolete = typeof obsoleteRaw === "object" && obsoleteRaw !== null ? (obsoleteRaw as Record<string, unknown>) : {};
  const ids = new Set<string>();
  const list = await readJson(p.join(dir, "extensions.json"));
  if (Array.isArray(list)) {
    for (const item of list as { identifier?: { id?: unknown }; relativeLocation?: unknown }[]) {
      const id = item?.identifier?.id;
      const location = typeof item?.relativeLocation === "string" ? item.relativeLocation : undefined;
      if (typeof id === "string" && !(location && obsolete[location])) ids.add(id.toLowerCase());
    }
    return ids;
  }
  try {
    for (const name of await fs.readdir(dir)) {
      if (obsolete[name]) continue;
      const m = /^(.+?)-\d+\.\d+\.\d+/.exec(name);
      if (m) ids.add(m[1]!.toLowerCase());
    }
  } catch {
    /* editor not installed */
  }
  return ids;
}

/** Advisory detection: whether a tool looks installed, with the evidence found. */
export class Detector {
  private readonly extensions = new Map<string, Promise<Set<string>>>();

  constructor(private readonly ctx: InstallContext) {}

  private extensionsOf(host: EditorHost): Promise<Set<string>> {
    let found = this.extensions.get(host.id);
    if (!found) {
      found = installedExtensions(this.ctx, host);
      this.extensions.set(host.id, found);
    }
    return found;
  }

  async detect(client: ClientDefinition): Promise<Detection> {
    const evidence: string[] = [];
    for (const bin of client.detect.bins ?? []) {
      if (which(this.ctx, bin)) evidence.push(`${bin} on PATH`);
    }
    for (const p of client.detect.paths?.(this.ctx) ?? []) {
      if (await exists(p)) evidence.push(tildify(p, this.ctx));
    }
    const hosts: Detection["hosts"] = [];
    for (const extensionId of client.detect.extensions ?? []) {
      for (const host of EDITOR_HOSTS) {
        if ((await this.extensionsOf(host)).has(extensionId)) {
          hosts.push({ host, extensionId });
          evidence.push(`extension in ${host.label}`);
        }
      }
    }
    return { found: evidence.length > 0, evidence: [...new Set(evidence)], hosts };
  }

  async detectAll(clients: readonly ClientDefinition[]): Promise<Map<string, Detection>> {
    const results = await Promise.all(clients.map(async (c) => [c.id, await this.detect(c)] as const));
    return new Map(results);
  }
}

export const NOT_DETECTED: Detection = { found: false, evidence: [], hosts: [] };
