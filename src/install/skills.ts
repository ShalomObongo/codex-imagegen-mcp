import fs from "node:fs/promises";
import path from "node:path";
import { LEGACY_SKILL_NAMES, PACKAGE_NAME, SKILL_NAME, SKILL_SOURCE_DIR, VERSION } from "../constants.js";
import { createZip } from "../util/zip.js";
import { SKILL_ROOTS, skillRootDir, type ClientDefinition, type SkillRootId } from "./clients.js";
import { envDir, locations, realpathOr, type InstallContext, type Scope } from "./context.js";

/** Marker written into every skill folder we install, so we never touch a user's own skill. */
export const SKILL_MARKER = ".codex-imagegen-mcp.json";

async function lexists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function sameContents(source: string, target: string): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([listFiles(source), listFiles(target)]);
    const theirs = b.filter((f) => f !== SKILL_MARKER);
    if (a.length !== theirs.length || a.some((f, i) => f !== theirs[i])) return false;
    for (const f of a) {
      const [x, y] = await Promise.all([fs.readFile(path.join(source, f)), fs.readFile(path.join(target, f))]);
      if (!x.equals(y)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function isOurSkill(dir: string): Promise<boolean> {
  return lexists(path.join(dir, SKILL_MARKER));
}

export type SkillDirState = "missing" | "current" | "outdated" | "foreign";

export async function skillDirState(dir: string, source = SKILL_SOURCE_DIR): Promise<SkillDirState> {
  if (!(await lexists(dir))) return "missing";
  if (!(await isOurSkill(dir))) return "foreign";
  return (await sameContents(source, dir)) ? "current" : "outdated";
}

/** Replace `dir` with a fresh copy of the bundled skill plus our marker. */
export async function copySkill(dir: string, source = SKILL_SOURCE_DIR): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(dir), { recursive: true });
  await fs.cp(source, dir, { recursive: true });
  const marker = { installedBy: PACKAGE_NAME, version: VERSION, installedAt: new Date().toISOString() };
  await fs.writeFile(path.join(dir, SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
}

/** Remove a skill folder, but only one we installed. */
export async function removeSkill(dir: string): Promise<boolean> {
  if (!(await isOurSkill(dir))) return false;
  await fs.rm(dir, { recursive: true, force: true });
  return true;
}

/** Skill folders a client reads in this scope, most preferred first. */
export function skillRootsOf(client: ClientDefinition, ctx: InstallContext, scope: Scope): SkillRootId[] {
  return client.skills(ctx, scope).filter((id) => skillRootDir(id, ctx, scope) !== undefined);
}

function scopeRoots(ctx: InstallContext, scope: Scope): SkillRootId[] {
  return (Object.keys(SKILL_ROOTS) as SkillRootId[]).filter((id) => skillRootDir(id, ctx, scope) !== undefined);
}

export interface SkillCopy {
  dir: string;
  root: SkillRootId;
  /** Selected clients that read this copy. */
  clients: ClientDefinition[];
  action: "create" | "update" | "unchanged" | "replace";
}

export interface SkillPlan {
  copies: SkillCopy[];
  /** Folders from earlier releases (old skill name) that carry our marker. */
  legacy: string[];
  /** Clients whose every skill folder holds someone else's skill of the same name. */
  blocked: { client: ClientDefinition; dirs: string[] }[];
  warnings: string[];
}

/**
 * Decide where the skill goes: the fewest folders that every selected client reads. Copies we
 * installed earlier are kept (and refreshed), then folders are added greedily by how many
 * remaining clients they cover, preferring the shared `.agents/skills`. Folders holding someone
 * else's skill of the same name are never used unless `force`.
 */
export async function planSkills(ctx: InstallContext, scope: Scope, clients: readonly ClientDefinition[], options: { force: boolean; source?: string }): Promise<SkillPlan> {
  const p = locations(ctx).p;
  const source = options.source ?? SKILL_SOURCE_DIR;
  const all = scopeRoots(ctx, scope);
  const dir = (id: SkillRootId) => p.join(skillRootDir(id, ctx, scope)!, SKILL_NAME);
  const real = new Map(all.map((id) => [id, realpathOr(skillRootDir(id, ctx, scope)!)] as const));
  const state = new Map<SkillRootId, SkillDirState>();
  for (const id of all) state.set(id, await skillDirState(dir(id), source));

  const rootsOf = new Map(clients.map((c) => [c, skillRootsOf(c, ctx, scope)] as const));
  const wanted = clients.filter((c) => c.scopes.includes(scope) && (rootsOf.get(c)?.length ?? 0) > 0);
  const reads = (c: ClientDefinition, id: SkillRootId) => (rootsOf.get(c) ?? []).some((r) => real.get(r) === real.get(id));

  const chosen: SkillRootId[] = [];
  const choose = (id: SkillRootId) => {
    if (!chosen.some((c) => real.get(c) === real.get(id))) chosen.push(id);
  };
  for (const id of all) if (state.get(id) === "current" || state.get(id) === "outdated") choose(id);

  const blockedRoot = (id: SkillRootId) => state.get(id) === "foreign" && !options.force;
  const plan: SkillPlan = { copies: [], legacy: [], blocked: [], warnings: [] };
  let uncovered = wanted.filter((c) => !chosen.some((id) => reads(c, id)));
  while (uncovered.length > 0) {
    const candidates = [...new Set(uncovered.flatMap((c) => rootsOf.get(c) ?? []))].filter((id) => !blockedRoot(id));
    if (candidates.length === 0) {
      for (const c of uncovered) plan.blocked.push({ client: c, dirs: (rootsOf.get(c) ?? []).map(dir) });
      break;
    }
    const score = (id: SkillRootId) => uncovered.filter((c) => reads(c, id)).length;
    // How early the folder appears in the clients' own preference lists (lower is better).
    const preference = (id: SkillRootId) =>
      Math.min(
        ...uncovered.map((c) => {
          const i = (rootsOf.get(c) ?? []).indexOf(id);
          return i < 0 ? Number.POSITIVE_INFINITY : i;
        }),
      );
    candidates.sort((a, b) => score(b) - score(a) || Number(b === "agents") - Number(a === "agents") || preference(a) - preference(b));
    const best = candidates[0]!;
    choose(best);
    uncovered = uncovered.filter((c) => !reads(c, best));
  }

  for (const id of chosen) {
    const s = state.get(id)!;
    plan.copies.push({
      dir: dir(id),
      root: id,
      clients: wanted.filter((c) => reads(c, id)),
      action: s === "missing" ? "create" : s === "current" ? "unchanged" : s === "outdated" ? "update" : "replace",
    });
  }

  // Identical copies in two folders a tool reads are harmless; someone else's skill of the same
  // name next to ours is worth knowing about.
  const shadowed = new Map<string, ClientDefinition[]>();
  for (const c of wanted) {
    const foreign = (rootsOf.get(c) ?? []).filter((id) => state.get(id) === "foreign" && !chosen.includes(id)).map(dir);
    if (foreign.length > 0 && chosen.some((id) => reads(c, id))) shadowed.set(foreign.join(", "), [...(shadowed.get(foreign.join(", ")) ?? []), c]);
  }
  for (const [dirs, readers] of shadowed) {
    plan.warnings.push(`${readers.map((c) => c.label).join(", ")} will also see another skill named ${SKILL_NAME} at ${dirs}; remove or rename it to avoid confusion.`);
  }

  const seen = new Set<string>();
  for (const id of all) {
    for (const name of LEGACY_SKILL_NAMES) {
      const legacy = p.join(skillRootDir(id, ctx, scope)!, name);
      const key = realpathOr(legacy);
      if (!seen.has(key) && (await isOurSkill(legacy))) {
        seen.add(key);
        plan.legacy.push(legacy);
      }
    }
  }
  return plan;
}

export interface SkillRemovalPlan {
  remove: string[];
  /** Our copies kept because a client that stays installed reads them. */
  keep: { dir: string; clients: ClientDefinition[] }[];
}

/** Our skill copies in this scope, minus the ones still read by `remaining` clients. */
export async function planSkillRemoval(ctx: InstallContext, scope: Scope, remaining: readonly ClientDefinition[]): Promise<SkillRemovalPlan> {
  const p = locations(ctx).p;
  const plan: SkillRemovalPlan = { remove: [], keep: [] };
  const seen = new Set<string>();
  for (const id of scopeRoots(ctx, scope)) {
    const rootReal = realpathOr(skillRootDir(id, ctx, scope)!);
    for (const name of [SKILL_NAME, ...LEGACY_SKILL_NAMES]) {
      const d = p.join(skillRootDir(id, ctx, scope)!, name);
      if (seen.has(realpathOr(d)) || !(await isOurSkill(d))) continue;
      seen.add(realpathOr(d));
      const readers =
        name === SKILL_NAME
          ? remaining.filter((c) => skillRootsOf(c, ctx, scope).some((r) => realpathOr(skillRootDir(r, ctx, scope)!) === rootReal))
          : [];
      if (readers.length > 0) plan.keep.push({ dir: d, clients: readers });
      else plan.remove.push(d);
    }
  }
  return plan;
}

/** Where the Claude Desktop upload archive is written: the package's data directory. */
export function skillZipPath(ctx: InstallContext): string {
  const L = locations(ctx);
  const home =
    envDir(ctx, "CODEX_IMAGEGEN_HOME") ??
    (ctx.platform === "win32" ? L.p.join(L.local, PACKAGE_NAME) : L.p.join(envDir(ctx, "XDG_DATA_HOME") ?? L.home(".local", "share"), PACKAGE_NAME));
  return L.p.join(home, `${SKILL_NAME}-skill.zip`);
}

/** The skill as a zip with a top-level `imagegen-mcp/` folder (the layout Claude's upload expects). */
export async function buildSkillZip(source = SKILL_SOURCE_DIR): Promise<Buffer> {
  const files = await listFiles(source);
  const entries = await Promise.all(files.map(async (f) => ({ name: `${SKILL_NAME}/${f}`, data: await fs.readFile(path.join(source, f)) })));
  return createZip(entries);
}

/** Read `name:` from a SKILL.md frontmatter block. */
export async function skillNameOf(skillFile: string): Promise<string | undefined> {
  try {
    const head = (await fs.readFile(skillFile, "utf8")).slice(0, 4096);
    const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1];
    return fm ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm)?.[1]?.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** Every folder directly under `roots` whose SKILL.md frontmatter name is `name`. */
export async function findSkillsNamed(name: string, roots: readonly string[]): Promise<string[]> {
  const found = new Map<string, string>();
  for (const root of new Set(roots)) {
    let entries: string[];
    try {
      entries = await fs.readdir(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const d = path.join(root, entry);
      if ((await skillNameOf(path.join(d, "SKILL.md"))) === name && !found.has(realpathOr(d))) found.set(realpathOr(d), d);
    }
  }
  return [...found.values()];
}
