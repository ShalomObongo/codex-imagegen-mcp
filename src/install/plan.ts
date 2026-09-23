import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { PACKAGE_NAME, SKILL_SOURCE_DIR } from "../constants.js";
import { writeFileAtomic } from "../util/fs.js";
import { sleep } from "../util/http.js";
import { availableClients, type ClientDefinition, type ConfigSpec, type Detection } from "./clients.js";
import { realpathOr, tildify, which, type InstallContext, type Scope } from "./context.js";
import { NOT_DETECTED } from "./detect.js";
import { ConfigEditError, editConfig, getIn, isPlainObject, parseConfig, renderSnippet, sameValue } from "./formats.js";
import { adaptLaunch, formatCommand, type Launch, type Runtime } from "./launch.js";
import { buildSkillZip, copySkill, planSkillRemoval, planSkills, removeSkill, skillDirState, skillZipPath } from "./skills.js";

const execFileAsync = promisify(execFile);

export const BACKUP_SUFFIX = ".codex-imagegen-mcp.bak";

export type ConfigAction = "create" | "add" | "update" | "replace" | "unchanged" | "remove" | "absent" | "conflict" | "error" | "skip";

export interface ConfigChange {
  kind: "config";
  clients: ClientDefinition[];
  spec: ConfigSpec;
  /** The file that will be edited (first existing candidate, or the one to create). */
  file: string;
  keyPath: string[];
  /** Desired entry; undefined when removing. */
  entry?: Record<string, unknown>;
  action: ConfigAction;
  reason?: string;
  /** Apply through `claude mcp …` using this executable. */
  claudeCli?: string;
}

export interface SkillChange {
  kind: "skill";
  dir: string;
  clients: ClientDefinition[];
  action: "create" | "update" | "unchanged" | "replace" | "remove" | "keep";
  reason?: string;
}

export interface LegacySkillChange {
  kind: "legacy-skill";
  dir: string;
  action: "remove";
}

export interface SkillZipChange {
  kind: "skill-zip";
  file: string;
  clients: ClientDefinition[];
  action: "create" | "update" | "unchanged";
}

export interface ManualChange {
  kind: "manual";
  clients: ClientDefinition[];
  where: string;
  snippet: string;
  action: "manual";
}

export type Change = ConfigChange | SkillChange | LegacySkillChange | SkillZipChange | ManualChange;

export interface Plan {
  operation: "install" | "uninstall";
  scope: Scope;
  serverName: string;
  clients: ClientDefinition[];
  launch?: Launch;
  changes: Change[];
  warnings: string[];
  ctx: InstallContext;
  force: boolean;
}

// ---------------------------------------------------------------------------------------------
// Reading configs
// ---------------------------------------------------------------------------------------------

export interface ConfigState {
  file: string;
  exists: boolean;
  text?: string;
  /** Our key's current value. */
  current?: unknown;
  error?: string;
}

function firstExisting(files: readonly string[]): string | undefined {
  return files.find((f) => fs.existsSync(f));
}

export async function readConfig(spec: ConfigSpec, serverName: string): Promise<ConfigState> {
  const file = firstExisting(spec.files) ?? spec.createAs ?? spec.files[0]!;
  let text: string;
  try {
    text = await fsp.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { file, exists: false };
    return { file, exists: true, error: `can't read ${file} (${code ?? String(err)})` };
  }
  try {
    const parsed = parseConfig(spec.format, text);
    const root = getIn(parsed, spec.root);
    if (root !== undefined && root !== null && !isPlainObject(root)) {
      return { file, exists: true, text, error: `"${spec.root.join(".")}" in ${file} is not an object` };
    }
    return { file, exists: true, text, current: getIn(parsed, [...spec.root, serverName]) };
  } catch (err) {
    return { file, exists: true, text, error: `can't parse ${file}: ${err instanceof Error ? err.message : String(err)}. Fix the file (or move it aside) and run the installer again` };
  }
}

function launchStrings(entry: unknown): string[] {
  if (!isPlainObject(entry)) return [];
  const out: string[] = [];
  for (const key of ["command", "args", "cmd"]) {
    const v = entry[key];
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) out.push(...v.filter((x): x is string => typeof x === "string"));
  }
  return out;
}

function isOurScript(file: string): boolean {
  if (!/cli\.js$/.test(file)) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(file, "..", "..", "..", "package.json"), "utf8")) as { name?: unknown };
    return pkg.name === PACKAGE_NAME;
  } catch {
    return false;
  }
}

/** Whether an existing entry launches this package (so we may update or remove it). */
export function isOurEntry(entry: unknown): boolean {
  return launchStrings(entry).some((s) => s.includes(PACKAGE_NAME) || isOurScript(s));
}

/** The argv an entry launches, across the entry shapes in the registry. */
export function entryArgv(entry: unknown): string[] {
  if (!isPlainObject(entry)) return [];
  const cmd = entry.command ?? entry.cmd;
  if (Array.isArray(cmd)) return cmd.filter((x): x is string => typeof x === "string");
  const args = Array.isArray(entry.args) ? entry.args.filter((x): x is string => typeof x === "string") : [];
  return typeof cmd === "string" ? [cmd, ...args] : [];
}

/** Whether an entry is switched off (`enabled: false` or `disabled: true`, depending on the client). */
export function entryDisabled(entry: unknown): boolean {
  return isPlainObject(entry) && (entry.enabled === false || entry.disabled === true);
}

function describeEntry(entry: unknown): string {
  const argv = launchStrings(entry);
  if (argv.length > 0) return formatCommand(argv);
  if (isPlainObject(entry) && typeof entry.url === "string") return entry.url;
  return "unknown command";
}

/** The `claude` executable, if it can be run without a shell (npm's .cmd shims can't on Windows). */
export function findClaudeCli(ctx: InstallContext): string | undefined {
  const bin = which(ctx, "claude");
  if (!bin) return undefined;
  if (ctx.platform === "win32" && !/\.exe$/i.test(bin)) return undefined;
  return bin;
}

// ---------------------------------------------------------------------------------------------
// Planning
// ---------------------------------------------------------------------------------------------

export interface InstallOptions {
  ctx: InstallContext;
  scope: Scope;
  clients: readonly ClientDefinition[];
  serverName: string;
  launch: Launch;
  runtime: Runtime;
  timeoutMs: number;
  mcp: boolean;
  skill: boolean;
  force: boolean;
  detections: ReadonlyMap<string, Detection>;
  /** Override `claude` CLI discovery (tests). `null` disables it. */
  claudeCli?: string | null;
  skillSource?: string;
}

export async function planInstall(o: InstallOptions): Promise<Plan> {
  const plan: Plan = {
    operation: "install",
    scope: o.scope,
    serverName: o.serverName,
    clients: [...o.clients],
    launch: o.launch,
    changes: [],
    warnings: [...o.launch.warnings],
    ctx: o.ctx,
    force: o.force,
  };
  const claude = o.claudeCli === null ? undefined : (o.claudeCli ?? findClaudeCli(o.ctx));
  const byTarget = new Map<string, ConfigChange>();

  for (const client of o.clients) {
    const launch = adaptLaunch(o.launch, { gui: client.gui, scope: o.scope }, o.ctx, o.runtime);
    const entry = client.entry(launch, { serverName: o.serverName, timeoutMs: o.timeoutMs });
    if (client.manual) {
      if (o.mcp) {
        plan.changes.push({ kind: "manual", clients: [client], where: client.manual.where, snippet: renderSnippet(client.manual.format, [...client.manual.root, o.serverName], entry), action: "manual" });
      }
      continue;
    }
    if (!o.mcp) continue;
    if (!client.scopes.includes(o.scope)) {
      plan.changes.push(skipChange(client, `${client.label} only supports ${client.scopes.join(" and ")} installs`));
      continue;
    }
    const specs = client.configs(o.ctx, o.scope, o.detections.get(client.id) ?? NOT_DETECTED);
    if (specs.length === 0) {
      plan.changes.push(skipChange(client, `${client.label} was not found in any editor; install the extension first`));
      continue;
    }
    for (const spec of specs) {
      const keyPath = [...spec.root, o.serverName];
      const state = await readConfig(spec, o.serverName);
      const key = `${realpathOr(state.file)}\u0000${keyPath.join("\u0000")}`;
      const shared = byTarget.get(key);
      if (shared) {
        // e.g. VS Code and VS Code Insiders both use .vscode/mcp.json in a project.
        if (sameValue(shared.entry, entry)) shared.clients.push(client);
        else plan.warnings.push(`${client.label} needs a different entry in ${state.file} than ${shared.clients[0]!.label}; only ${shared.clients[0]!.label}'s is written.`);
        continue;
      }
      const change: ConfigChange = { kind: "config", clients: [client], spec, file: state.file, keyPath, entry, action: "create" };
      if (state.error) {
        change.action = "error";
        change.reason = state.error;
      } else if (!state.exists) change.action = "create";
      else if (state.current === undefined) change.action = "add";
      else if (sameValue(state.current, entry)) change.action = "unchanged";
      else if (isOurEntry(state.current)) change.action = "update";
      else if (o.force) change.action = "replace";
      else {
        change.action = "conflict";
        change.reason = `"${o.serverName}" there already runs something else (${describeEntry(state.current)}); pass --name to use another name, or --force to replace it`;
      }
      if (spec.claudeCli && claude && ["create", "add", "update", "replace"].includes(change.action)) change.claudeCli = claude;
      byTarget.set(key, change);
      plan.changes.push(change);
    }
  }

  if (o.skill) {
    const skills = await planSkills(o.ctx, o.scope, o.clients, { force: o.force, ...(o.skillSource ? { source: o.skillSource } : {}) });
    for (const copy of skills.copies) plan.changes.push({ kind: "skill", dir: copy.dir, clients: copy.clients, action: copy.action });
    for (const b of skills.blocked) {
      plan.warnings.push(`No skill for ${b.client.label}: its skill folders already contain another skill with the same name (${b.dirs.join(", ")}). Use --force to replace it.`);
    }
    for (const dir of skills.legacy) plan.changes.push({ kind: "legacy-skill", dir, action: "remove" });
    plan.warnings.push(...skills.warnings);
    const zipClients = o.clients.filter((c) => c.skillZip && c.scopes.includes(o.scope));
    if (zipClients.length > 0) {
      const file = skillZipPath(o.ctx);
      const fresh = await buildSkillZip(o.skillSource ?? SKILL_SOURCE_DIR);
      const existing = await fsp.readFile(file).catch(() => undefined);
      plan.changes.push({ kind: "skill-zip", file, clients: zipClients, action: !existing ? "create" : existing.equals(fresh) ? "unchanged" : "update" });
    }
  }

  const ids = new Set(o.clients.map((c) => c.id));
  if (ids.has("devin") && ids.has("windsurf")) plan.warnings.push("Devin Desktop imports the legacy Windsurf config, so selecting both can show imagegen twice.");
  if (o.scope === "project" && ids.has("copilot")) {
    const mcpJson = path.join(o.ctx.cwd, ".mcp.json");
    const state = await readConfig({ format: "json", files: [mcpJson], root: ["mcpServers"] }, o.serverName);
    if (state.current !== undefined || ids.has("claude-code")) {
      plan.warnings.push("Copilot CLI prefers .mcp.json over .github/mcp.json, so it will use the Claude Code entry there (without Copilot's longer timeout).");
    }
  }
  return plan;
}

function skipChange(client: ClientDefinition, reason: string): ConfigChange {
  return { kind: "config", clients: [client], spec: { format: "json", files: [], root: [] }, file: "", keyPath: [], action: "skip", reason };
}

export interface UninstallOptions {
  ctx: InstallContext;
  scope: Scope;
  clients: readonly ClientDefinition[];
  serverName: string;
  /** Remove our skill copies that no remaining client uses. */
  skill: boolean;
  force: boolean;
  detections: ReadonlyMap<string, Detection>;
  claudeCli?: string | null;
}

/** Whether a client currently has our server configured in this scope. */
export async function isConfigured(client: ClientDefinition, ctx: InstallContext, scope: Scope, serverName: string, detection: Detection): Promise<boolean> {
  if (client.manual || !client.scopes.includes(scope)) return false;
  for (const spec of client.configs(ctx, scope, detection)) {
    const state = await readConfig(spec, serverName);
    if (state.current !== undefined && isOurEntry(state.current)) return true;
  }
  return false;
}

export async function planUninstall(o: UninstallOptions): Promise<Plan> {
  const plan: Plan = { operation: "uninstall", scope: o.scope, serverName: o.serverName, clients: [...o.clients], changes: [], warnings: [], ctx: o.ctx, force: o.force };
  const claude = o.claudeCli === null ? undefined : (o.claudeCli ?? findClaudeCli(o.ctx));
  const seen = new Set<string>();
  for (const client of o.clients) {
    if (client.manual || !client.scopes.includes(o.scope)) continue;
    for (const spec of client.configs(o.ctx, o.scope, o.detections.get(client.id) ?? NOT_DETECTED)) {
      const keyPath = [...spec.root, o.serverName];
      const state = await readConfig(spec, o.serverName);
      const key = `${realpathOr(state.file)}\u0000${keyPath.join("\u0000")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const change: ConfigChange = { kind: "config", clients: [client], spec, file: state.file, keyPath, action: "remove" };
      if (state.error) {
        change.action = "error";
        change.reason = state.error;
      } else if (state.current === undefined) change.action = "absent";
      else if (!isOurEntry(state.current) && !o.force) {
        change.action = "conflict";
        change.reason = `"${o.serverName}" there runs something else (${describeEntry(state.current)}); left untouched (use --force to remove it anyway)`;
      }
      if (spec.claudeCli && claude && change.action === "remove") change.claudeCli = claude;
      plan.changes.push(change);
    }
  }
  if (o.skill) {
    const leaving = new Set(o.clients.map((c) => c.id));
    const remaining: ClientDefinition[] = [];
    for (const c of availableClients(o.ctx)) {
      if (!leaving.has(c.id) && (await isConfigured(c, o.ctx, o.scope, o.serverName, o.detections.get(c.id) ?? NOT_DETECTED))) remaining.push(c);
    }
    const skills = await planSkillRemoval(o.ctx, o.scope, remaining);
    for (const dir of skills.remove) plan.changes.push({ kind: "skill", dir, clients: [], action: "remove" });
    for (const k of skills.keep) {
      plan.changes.push({ kind: "skill", dir: k.dir, clients: k.clients, action: "keep", reason: `still used by ${k.clients.map((c) => c.label).join(", ")}` });
    }
  }
  return plan;
}

// ---------------------------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------------------------

export interface ApplyResult {
  change: Change;
  ok: boolean;
  /** What actually happened, e.g. "created", "updated", "unchanged", "skipped". */
  outcome: string;
  detail?: string;
  backup?: string;
}

/** Cline guards its settings with a `<file>.lock` directory; wait (up to 10 s) while it is fresh. */
async function waitForLock(file: string): Promise<void> {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 10_000;
  for (;;) {
    const stat = await fsp.stat(lock).catch(() => undefined);
    if (!stat || Date.now() - stat.mtimeMs > 10_000 || Date.now() > deadline) return;
    await sleep(200);
  }
}

async function runClaude(bin: string, args: string[], ctx: InstallContext): Promise<void> {
  await execFileAsync(bin, args, { env: ctx.env, cwd: ctx.cwd, timeout: 60_000, windowsHide: true });
}

const OUTCOME: Record<string, string> = { create: "created", add: "added", update: "updated", replace: "replaced", remove: "removed" };

async function applyConfig(change: ConfigChange, plan: Plan): Promise<ApplyResult> {
  const install = plan.operation === "install";
  if (["unchanged", "absent", "skip", "conflict", "error"].includes(change.action)) {
    return { change, ok: change.action === "unchanged" || change.action === "absent" || change.action === "skip", outcome: change.action, ...(change.reason ? { detail: change.reason } : {}) };
  }
  // Re-read: the file may have changed since the plan was shown.
  const state = await readConfig(change.spec, plan.serverName);
  if (state.error) return { change, ok: false, outcome: "error", detail: state.error };
  const desired = install ? change.entry : undefined;
  if (sameValue(state.current, desired)) return { change, ok: true, outcome: install ? "unchanged" : "absent" };
  if (state.current !== undefined && !isOurEntry(state.current) && !plan.force && !sameValue(state.current, change.entry)) {
    return { change, ok: false, outcome: "conflict", detail: `"${plan.serverName}" in ${state.file} changed since the preview and now runs something else; left untouched` };
  }

  let note: string | undefined;
  if (change.claudeCli) {
    try {
      if (state.current !== undefined) await runClaude(change.claudeCli, ["mcp", "remove", "--scope", "user", plan.serverName], plan.ctx);
      if (desired) await runClaude(change.claudeCli, ["mcp", "add-json", "--scope", "user", plan.serverName, JSON.stringify(desired)], plan.ctx);
      const after = await readConfig(change.spec, plan.serverName);
      if (sameValue(after.current, desired)) return { change, ok: true, outcome: `${OUTCOME[change.action] ?? change.action} via claude mcp` };
      note = "the claude CLI ran but the entry didn't match, so the file was edited directly";
    } catch (err) {
      note = `claude mcp failed (${(err as Error).message.split("\n")[0]}), so the file was edited directly`;
    }
  }

  if (change.spec.lock) await waitForLock(state.file);
  // Write through a symlinked config (dotfile managers) so the link itself survives.
  const target = fs.lstatSync(state.file, { throwIfNoEntry: false })?.isSymbolicLink() ? realpathOr(state.file) : state.file;
  let fresh: string | undefined;
  try {
    fresh = await fsp.readFile(target, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  let next: string;
  try {
    next = editConfig(change.spec.format, fresh, change.keyPath, desired, change.spec.template);
  } catch (err) {
    if (err instanceof ConfigEditError) return { change, ok: false, outcome: "error", detail: `${state.file}: ${err.message}` };
    throw err;
  }
  let backup: string | undefined;
  let mode = 0o644;
  if (fresh !== undefined) {
    backup = `${target}${BACKUP_SUFFIX}`;
    await fsp.copyFile(target, backup);
    mode = (await fsp.stat(target)).mode & 0o777;
  } else {
    await fsp.mkdir(path.dirname(target), { recursive: true });
  }
  await writeFileAtomic(target, next, mode);
  return { change, ok: true, outcome: OUTCOME[change.action] ?? change.action, ...(backup ? { backup } : {}), ...(note ? { detail: note } : {}) };
}

export type ProgressHook = (message: string) => void;

export async function applyPlan(plan: Plan, onProgress?: ProgressHook, skillSource = SKILL_SOURCE_DIR): Promise<ApplyResult[]> {
  const results: ApplyResult[] = [];
  const run = async (change: Change, fn: () => Promise<ApplyResult>) => {
    try {
      results.push(await fn());
    } catch (err) {
      results.push({ change, ok: false, outcome: "error", detail: err instanceof Error ? err.message : String(err) });
    }
  };
  for (const change of plan.changes) {
    if (change.kind !== "config") continue;
    onProgress?.(`${change.clients.map((c) => c.label).join(", ")}: ${tildify(change.file, plan.ctx)}`);
    await run(change, () => applyConfig(change, plan));
  }
  let skillInstalled = false;
  for (const change of plan.changes) {
    if (change.kind !== "skill") continue;
    onProgress?.(`Skill: ${tildify(change.dir, plan.ctx)}`);
    await run(change, async () => {
      if (change.action === "keep") return { change, ok: true, outcome: "kept", ...(change.reason ? { detail: change.reason } : {}) };
      if (change.action === "remove") return { change, ok: true, outcome: (await removeSkill(change.dir)) ? "removed" : "absent" };
      const state = await skillDirState(change.dir, skillSource);
      if (state === "foreign" && !plan.force) return { change, ok: false, outcome: "conflict", detail: `${change.dir} holds a different skill; left untouched` };
      if (state === "current") {
        skillInstalled = true;
        return { change, ok: true, outcome: "unchanged" };
      }
      await copySkill(change.dir, skillSource);
      skillInstalled = true;
      return { change, ok: true, outcome: state === "missing" ? "installed" : state === "foreign" ? "replaced" : "updated" };
    });
  }
  for (const change of plan.changes) {
    if (change.kind === "legacy-skill") {
      // Only retire old copies once the new skill is in place.
      if (plan.operation === "install" && !skillInstalled) continue;
      await run(change, async () => ({ change, ok: true, outcome: (await removeSkill(change.dir)) ? "removed" : "absent" }));
    } else if (change.kind === "skill-zip") {
      await run(change, async () => {
        if (change.action === "unchanged") return { change, ok: true, outcome: "unchanged" };
        await writeFileAtomic(change.file, await buildSkillZip(skillSource), 0o644);
        return { change, ok: true, outcome: change.action === "create" ? "created" : "updated" };
      });
    } else if (change.kind === "manual") {
      results.push({ change, ok: true, outcome: "manual" });
    }
  }
  return results;
}
