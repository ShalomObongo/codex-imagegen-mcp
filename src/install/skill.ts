import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SKILL_NAME, SKILL_SOURCE_DIR, VERSION } from "../constants.js";
import { pathExists } from "../util/fs.js";

/** Marker written into skill directories we install, so we never delete a user's own skill. */
export const SKILL_MARKER = ".codex-imagegen-mcp.json";

export type SkillInstallAction = "installed" | "updated" | "unchanged" | "skipped";

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(path.join(dir, entry.name), rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

async function sameContents(a: string, b: string): Promise<boolean> {
  try {
    const [fa, fb] = await Promise.all([listFiles(a), listFiles(b)]);
    const filtered = fb.filter((f) => f !== SKILL_MARKER);
    if (fa.length !== filtered.length || fa.some((f, i) => f !== filtered[i])) return false;
    for (const f of fa) {
      const [x, y] = await Promise.all([fs.readFile(path.join(a, f)), fs.readFile(path.join(b, f))]);
      if (!x.equals(y)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function isOurSkill(dir: string): Promise<boolean> {
  return pathExists(path.join(dir, SKILL_MARKER));
}

/** Copy the bundled skill into `targetDir` (replacing an older copy we installed). */
export async function installSkillDir(
  targetDir: string,
  options: { force: boolean; dryRun: boolean; source?: string },
): Promise<{ action: SkillInstallAction; warning?: string }> {
  const source = options.source ?? SKILL_SOURCE_DIR;
  const exists = await pathExists(targetDir);
  if (exists && !(await isOurSkill(targetDir)) && !options.force) {
    return {
      action: "skipped",
      warning: `${targetDir} already exists and was not installed by codex-imagegen-mcp; left untouched (use --force to replace it).`,
    };
  }
  if (exists && (await sameContents(source, targetDir))) return { action: "unchanged" };
  if (!options.dryRun) {
    if (exists) await fs.rm(targetDir, { recursive: true, force: true });
    await fs.mkdir(path.dirname(targetDir), { recursive: true });
    await fs.cp(source, targetDir, { recursive: true });
    await fs.writeFile(
      path.join(targetDir, SKILL_MARKER),
      `${JSON.stringify({ installedBy: "codex-imagegen-mcp", version: VERSION, source, installedAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  return { action: exists ? "updated" : "installed" };
}

export async function removeSkillDir(targetDir: string, options: { dryRun: boolean }): Promise<"removed" | "not-ours" | "missing"> {
  if (!(await pathExists(targetDir))) return "missing";
  if (!(await isOurSkill(targetDir))) return "not-ours";
  if (!options.dryRun) await fs.rm(targetDir, { recursive: true, force: true });
  return "removed";
}

/** Read `name:` from a SKILL.md frontmatter block. */
export async function skillNameOf(skillFile: string): Promise<string | undefined> {
  try {
    const head = (await fs.readFile(skillFile, "utf8")).slice(0, 4096);
    const fm = /^---\s*\r?\n([\s\S]*?)\r?\n---/.exec(head)?.[1];
    const name = fm ? /^name:\s*["']?([^"'\r\n]+?)["']?\s*$/m.exec(fm)?.[1] : undefined;
    return name?.trim();
  } catch {
    return undefined;
  }
}

/** Find every SKILL.md under `roots` (max depth 4) whose frontmatter name is `name`. */
export async function findSkillsNamed(name: string, roots: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 4) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const full = path.join(dir, e.name);
      if (e.isFile() && e.name === "SKILL.md") {
        if ((await skillNameOf(full)) === name) found.push(path.dirname(full));
      } else if (e.isDirectory() || e.isSymbolicLink()) {
        await walk(full, depth + 1);
      }
    }
  };
  for (const root of new Set(roots)) await walk(root, 0);
  return [...new Set(found)];
}

/** Directories opencode scans for skills (global + project, per opencode's skill loader). */
export function opencodeSkillRoots(configDir: string, projectDir?: string): string[] {
  const home = os.homedir();
  const roots = [
    path.join(home, ".claude", "skills"),
    path.join(home, ".agents", "skills"),
    path.join(configDir, "skill"),
    path.join(configDir, "skills"),
    path.join(home, ".opencode", "skill"),
    path.join(home, ".opencode", "skills"),
  ];
  if (projectDir) {
    roots.push(
      path.join(projectDir, ".claude", "skills"),
      path.join(projectDir, ".agents", "skills"),
      path.join(projectDir, ".opencode", "skill"),
      path.join(projectDir, ".opencode", "skills"),
    );
  }
  return roots;
}

export { SKILL_NAME };
