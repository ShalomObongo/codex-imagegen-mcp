import { parseArgs, type ParseArgsConfig } from "node:util";
import type { LoginMethod } from "../auth/store.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_SERVER_NAME, SKILL_NAME, SKILL_SOURCE_DIR, VERSION } from "../constants.js";
import { availableClients, CLIENT_REGISTRY, findClient, type ClientDefinition, type ClientKind, type Detection } from "./clients.js";
import { tildify, type InstallContext, type Scope } from "./context.js";
import { Detector, NOT_DETECTED } from "./detect.js";
import { renderSnippet } from "./formats.js";
import { adaptLaunch, describeLaunch, formatCommand, LAUNCH_MODES, resolveLaunch, type LaunchMode, type Runtime } from "./launch.js";
import { applyPlan, isConfigured, planInstall, planUninstall, type ApplyResult, type Plan } from "./plan.js";
import { manualSnippets, nextSteps, planJson, renderPlan, renderResults } from "./report.js";
import type { Theme } from "./theme.js";
import { installWizard, uninstallWizard, type Prompter, type WizardEnv } from "./wizard.js";

/** Bad arguments: printed with a usage hint, exit code 2. */
export class UsageError extends Error {
  override name = "UsageError";
}

export interface CommandEnv {
  ctx: InstallContext;
  theme: Theme;
  out: (line?: string) => void;
  err: (line: string) => void;
  /** Both stdin and stdout are terminals, so the wizard can run. */
  interactive: boolean;
  runtime: () => Runtime;
  prompter: () => Prompter;
  credentials: () => Promise<{ ready: boolean; label?: string }>;
  signIn: (method: LoginMethod, print: (text: string) => void) => Promise<string>;
  /** How to run this CLI, for hints. */
  cli: string;
  claudeCli?: string | null;
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (err) {
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

const COMMON = {
  scope: { type: "string" },
  project: { type: "boolean" },
  global: { type: "boolean" },
  name: { type: "string" },
  "dry-run": { type: "boolean" },
  json: { type: "boolean" },
  force: { type: "boolean" },
  yes: { type: "boolean", short: "y" },
  all: { type: "boolean" },
} as const;

function scopeOf(values: { scope?: string; project?: boolean; global?: boolean }): Scope {
  if (values.project && values.global) throw new UsageError("Use either --project or --global, not both.");
  const scope = values.project ? "project" : values.global ? "global" : (values.scope ?? "global");
  if (scope !== "global" && scope !== "project") throw new UsageError(`--scope must be global or project (got "${scope}").`);
  return scope;
}

function serverNameOf(name: string | undefined): string {
  const value = name ?? DEFAULT_SERVER_NAME;
  // Claude Code allows letters, digits, - and _; keep to that everywhere.
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value)) throw new UsageError(`--name must be letters, digits, "-" or "_" (got "${value}").`);
  return value;
}

function clientsOf(ids: readonly string[], ctx: InstallContext): ClientDefinition[] {
  const out: ClientDefinition[] = [];
  for (const id of ids) {
    const client = findClient(id);
    if (!client) throw new UsageError(`Unknown tool "${id}". Supported: ${availableClients(ctx).map((c) => c.id).join(", ")}.`);
    if (client.platforms && !client.platforms.includes(ctx.platform)) throw new UsageError(`${client.label} is only available on ${client.platforms.join(", ")}.`);
    if (!out.includes(client)) out.push(client);
  }
  return out;
}

function exitCode(results: readonly ApplyResult[]): number {
  return results.some((r) => !r.ok) ? 1 : 0;
}

function wizardEnv(env: CommandEnv, serverName: string, timeoutMs: number, extraEnv: Record<string, string>): WizardEnv {
  return {
    ui: env.prompter(),
    ctx: env.ctx,
    runtime: env.runtime,
    theme: env.theme,
    serverName,
    timeoutMs,
    env: extraEnv,
    credentials: env.credentials,
    signIn: env.signIn,
    cli: env.cli,
    ...(env.claudeCli !== undefined ? { claudeCli: env.claudeCli } : {}),
  };
}

function printPlanOrResults(env: CommandEnv, plan: Plan, results: ApplyResult[] | undefined, json: boolean): void {
  const t = env.theme;
  if (json) {
    env.out(JSON.stringify(planJson(plan, results), null, 2));
    return;
  }
  const title = `${plan.operation}${plan.scope === "project" ? ` · project ${tildify(plan.ctx.cwd, plan.ctx)}` : ""}${results ? "" : " · dry run"}`;
  env.out(`${t.badge("codex-imagegen-mcp")} ${t.dim(`v${VERSION} · ${title}`)}`);
  env.out();
  if (results) {
    if (plan.launch) env.out(`${t.dim("Launch")}  ${describeLaunch(plan.launch, plan.ctx)}\n`);
    for (const line of renderResults(results, plan.ctx, t)) env.out(line);
  } else {
    for (const line of renderPlan(plan, t)) env.out(line);
  }
  if (plan.warnings.length > 0) {
    env.out();
    for (const w of plan.warnings) env.out(`${t.warn("!")} ${w}`);
  }
  for (const m of manualSnippets(plan)) {
    env.out();
    env.out(`${t.bold(m.title)} ${t.dim(`— paste into ${m.where}:`)}`);
    env.out(m.snippet.trimEnd());
  }
  if (!results) {
    env.out();
    env.out(t.dim("Dry run: nothing was written."));
  }
}

// ---------------------------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------------------------

export async function installCommand(args: string[], env: CommandEnv): Promise<number> {
  const { values, positionals } = parse(args, {
    ...COMMON,
    list: { type: "boolean" },
    launch: { type: "string" },
    command: { type: "string" },
    timeout: { type: "string" },
    env: { type: "string", multiple: true },
    "no-skill": { type: "boolean" },
    "skill-only": { type: "boolean" },
  });
  if (values.list) return listCommand(env, Boolean(values.json), serverNameOf(values.name));
  const scope = scopeOf(values);
  const serverName = serverNameOf(values.name);
  const timeoutMs = values.timeout === undefined ? DEFAULT_REQUEST_TIMEOUT_MS : Number(values.timeout);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10_000 || timeoutMs > 3_600_000) throw new UsageError("--timeout must be a whole number of milliseconds between 10000 and 3600000.");
  const extraEnv: Record<string, string> = {};
  for (const pair of values.env ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new UsageError(`--env expects KEY=VALUE (got "${pair}").`);
    extraEnv[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  let mode: "auto" | LaunchMode = "auto";
  if (values.command !== undefined) mode = "custom";
  if (values.launch !== undefined) {
    if (!(["auto", ...LAUNCH_MODES] as string[]).includes(values.launch)) throw new UsageError(`--launch must be auto, node, npx or global (got "${values.launch}").`);
    if (values.command !== undefined && values.launch !== "custom") throw new UsageError("--command sets the launch command itself; drop --launch.");
    mode = values.launch as "auto" | LaunchMode;
  }
  if (values["no-skill"] && values["skill-only"]) throw new UsageError("--no-skill and --skill-only exclude each other.");

  const wantsAll = Boolean(values.all) || (Boolean(values.yes) && positionals.length === 0);
  if (positionals.length === 0 && !wantsAll) {
    if (!env.interactive || values.json || values["dry-run"]) {
      throw new UsageError(`Name the tools to install into, e.g. \`${env.cli} install opencode cursor\` (see \`${env.cli} install --list\`), use --all for every detected tool, or run it in a terminal for the interactive installer.`);
    }
    return installWizard(wizardEnv(env, serverName, timeoutMs, extraEnv));
  }

  const detector = new Detector(env.ctx);
  let clients: ClientDefinition[];
  let detections: Map<string, Detection>;
  if (wantsAll) {
    const all = availableClients(env.ctx);
    detections = await detector.detectAll(all);
    const named = new Set(clientsOf(positionals, env.ctx));
    clients = all.filter(
      (c) => named.has(c) || (detections.get(c.id)?.found && c.preselect !== false && !c.manual && !(c.supersededBy && detections.get(c.supersededBy)?.found)),
    );
    if (clients.length === 0) {
      env.err(`No supported tools were detected. Name them explicitly (\`${env.cli} install --list\`).`);
      return 1;
    }
  } else {
    clients = clientsOf(positionals, env.ctx);
    detections = await detector.detectAll(clients);
  }

  const runtime = env.runtime();
  const launch = resolveLaunch({ mode, scope, ...(values.command ? { command: values.command.trim().split(/\s+/) } : {}), env: extraEnv }, env.ctx, runtime);
  const plan = await planInstall({
    ctx: env.ctx,
    scope,
    clients,
    serverName,
    launch,
    runtime,
    timeoutMs,
    mcp: !values["skill-only"],
    skill: !values["no-skill"],
    force: Boolean(values.force),
    detections,
    ...(env.claudeCli !== undefined ? { claudeCli: env.claudeCli } : {}),
  });
  if (values["dry-run"]) {
    printPlanOrResults(env, plan, undefined, Boolean(values.json));
    return plan.changes.some((c) => c.action === "conflict" || c.action === "error") ? 1 : 0;
  }
  const results = await applyPlan(plan);
  printPlanOrResults(env, plan, results, Boolean(values.json));
  if (!values.json) {
    const steps = nextSteps(plan, results, env.theme);
    if (steps.length > 0) {
      env.out();
      env.out(env.theme.bold("Next steps"));
      for (const s of steps) env.out(`  ${s}`);
    }
    const creds = await env.credentials();
    env.out();
    env.out(creds.ready ? `${env.theme.ok("✓")} ChatGPT sign-in: ${creds.label ?? "ready"}` : `${env.theme.warn("!")} Not signed in yet: run \`${env.cli} login\` (or ask the agent to call the sign_in tool).`);
  }
  return exitCode(results);
}

// ---------------------------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------------------------

export async function uninstallCommand(args: string[], env: CommandEnv): Promise<number> {
  const { values, positionals } = parse(args, { ...COMMON, "keep-skill": { type: "boolean" } });
  const scope = scopeOf(values);
  const serverName = serverNameOf(values.name);
  if (positionals.length === 0 && !values.all) {
    if (!env.interactive || values.json || values["dry-run"]) {
      throw new UsageError(`Name the tools to remove imagegen from (e.g. \`${env.cli} uninstall cursor\`), or use --all.`);
    }
    return uninstallWizard(wizardEnv(env, serverName, DEFAULT_REQUEST_TIMEOUT_MS, {}));
  }
  const all = availableClients(env.ctx);
  const detections = await new Detector(env.ctx).detectAll(all);
  let clients = clientsOf(positionals, env.ctx);
  if (values.all) {
    for (const c of all) {
      if (!clients.includes(c) && (await isConfigured(c, env.ctx, scope, serverName, detections.get(c.id) ?? NOT_DETECTED))) clients.push(c);
    }
    if (clients.length === 0) {
      env.out(`imagegen isn't installed in any tool (${scope}).`);
      return 0;
    }
  }
  clients = clients.filter((c) => !c.manual);
  const plan = await planUninstall({
    ctx: env.ctx,
    scope,
    clients,
    serverName,
    skill: !values["keep-skill"],
    force: Boolean(values.force),
    detections,
    ...(env.claudeCli !== undefined ? { claudeCli: env.claudeCli } : {}),
  });
  if (values["dry-run"]) {
    printPlanOrResults(env, plan, undefined, Boolean(values.json));
    return 0;
  }
  const results = await applyPlan(plan);
  printPlanOrResults(env, plan, results, Boolean(values.json));
  if (!values.json) env.out(`\nYour ChatGPT sign-in was kept; run \`${env.cli} logout\` to remove it too.`);
  return exitCode(results);
}

// ---------------------------------------------------------------------------------------------
// install --list
// ---------------------------------------------------------------------------------------------

const KIND_TITLE: Record<ClientKind, string> = {
  cli: "Terminal agents",
  ide: "Editors & IDEs",
  desktop: "Desktop apps",
  extension: "Editor extensions",
  manual: "Set up by hand",
};

async function listCommand(env: CommandEnv, json: boolean, serverName: string): Promise<number> {
  const clients = availableClients(env.ctx);
  const detections = await new Detector(env.ctx).detectAll(clients);
  const rows = [];
  for (const c of clients) {
    const d = detections.get(c.id) ?? NOT_DETECTED;
    rows.push({
      client: c,
      detected: d.found,
      evidence: d.evidence,
      installed: {
        global: await isConfigured(c, env.ctx, "global", serverName, d),
        project: await isConfigured(c, env.ctx, "project", serverName, d),
      },
    });
  }
  if (json) {
    env.out(
      JSON.stringify(
        rows.map((r) => ({ id: r.client.id, name: r.client.label, kind: r.client.kind, scopes: r.client.scopes, detected: r.detected, evidence: r.evidence, installed: r.installed })),
        null,
        2,
      ),
    );
    return 0;
  }
  const t = env.theme;
  const width = Math.max(...clients.map((c) => c.label.length));
  const idWidth = Math.max(...clients.map((c) => c.id.length));
  env.out(`${t.badge("codex-imagegen-mcp")} ${t.dim(`v${VERSION} · supported tools`)}`);
  for (const kind of Object.keys(KIND_TITLE) as ClientKind[]) {
    const group = rows.filter((r) => r.client.kind === kind);
    if (group.length === 0) continue;
    env.out();
    env.out(t.bold(KIND_TITLE[kind]));
    for (const r of group) {
      const mark = r.installed.global || r.installed.project ? t.sage("✓") : r.detected ? t.ochre("●") : t.dim("○");
      const where = [r.installed.global ? "installed" : "", r.installed.project ? "installed in this project" : ""].filter(Boolean).join(", ");
      const state = where ? t.sage(where) : r.detected ? t.dim(r.evidence.join(", ")) : t.dim("not detected");
      env.out(`  ${mark} ${r.client.label.padEnd(width)}  ${t.dim(r.client.id.padEnd(idWidth))}  ${state}`);
    }
  }
  env.out();
  env.out(t.dim("✓ installed  ● detected  ○ not detected"));
  env.out(t.dim(`Install: ${env.cli} install <id…>   Interactive: ${env.cli} install`));
  return 0;
}

// ---------------------------------------------------------------------------------------------
// config <tool>: the snippet for adding it by hand
// ---------------------------------------------------------------------------------------------

export async function configCommand(args: string[], env: CommandEnv): Promise<number> {
  const { values, positionals } = parse(args, {
    name: { type: "string" },
    command: { type: "string" },
    launch: { type: "string" },
    scope: { type: "string" },
    project: { type: "boolean" },
  });
  const id = positionals[0];
  if (!id) throw new UsageError(`Usage: config <tool>. Tools: ${availableClients(env.ctx).map((c) => c.id).join(", ")}.`);
  const [client] = clientsOf([id], env.ctx);
  const scope = client!.scopes.includes(scopeOf(values)) ? scopeOf(values) : "global";
  const serverName = serverNameOf(values.name);
  const runtime = env.runtime();
  const mode = values.command ? "custom" : ((values.launch as "auto" | LaunchMode | undefined) ?? "auto");
  const launch = resolveLaunch({ mode, scope, ...(values.command ? { command: values.command.trim().split(/\s+/) } : {}) }, env.ctx, runtime);
  const clientLaunch = adaptLaunch(launch, { gui: client!.gui, scope }, env.ctx, runtime);
  const entry = client!.entry(clientLaunch, { serverName, timeoutMs: DEFAULT_REQUEST_TIMEOUT_MS });
  const detection = (await new Detector(env.ctx).detectAll([client!])).get(client!.id) ?? NOT_DETECTED;
  const specs = client!.configs(env.ctx, scope, detection);
  const t = env.theme;
  env.out(t.bold(`# ${client!.label}${scope === "project" ? " (this project)" : ""}`));
  if (client!.manual) {
    env.out(t.dim(`# Paste into ${client!.manual.where}:`));
    env.out(renderSnippet(client!.manual.format, [...client!.manual.root, serverName], entry).trimEnd());
  } else {
    const spec = specs[0] ?? client!.configs(env.ctx, scope, { ...NOT_DETECTED, hosts: [] })[0];
    if (spec) {
      env.out(t.dim(`# Add to ${spec.files.map((f) => tildify(f, env.ctx)).join(" or ")}${spec.format === "json" ? " (merge with what's there)" : ""}:`));
      env.out(renderSnippet(spec.format, [...spec.root, serverName], entry).trimEnd());
      for (const extra of specs.slice(1)) env.out(t.dim(`# Also: ${tildify(extra.files[0]!, env.ctx)}${extra.label ? ` (${extra.label})` : ""}`));
    } else {
      env.out(t.dim("# Install the extension first; its settings file lives in the editor's globalStorage."));
      env.out(renderSnippet("json", ["mcpServers", serverName], entry).trimEnd());
    }
    if (client!.id === "claude-code" && scope === "global") {
      env.out(t.dim("# Or run:"));
      env.out(formatCommand(["claude", "mcp", "add-json", "--scope", "user", serverName, JSON.stringify(entry)]));
    }
  }
  env.out(t.dim(`# Then: ${client!.restart}`));
  for (const n of client!.notes?.(scope, env.ctx) ?? []) env.out(t.dim(`# ${n}`));
  if (client!.skillZip) env.out(t.dim(`# Skill: \`${env.cli} install ${client!.id}\` writes a zip to upload in Settings › Capabilities.`));
  else if (client!.skills(env.ctx, scope).length > 0) env.out(t.dim(`# Skill: copy ${SKILL_SOURCE_DIR} into one of its skill folders as ${SKILL_NAME}/ (or let \`${env.cli} install ${client!.id}\` do it).`));
  env.out(t.dim(`# Or let the installer do all of this: ${env.cli} install ${client!.id}${scope === "project" ? " --project" : ""}`));
  return 0;
}

export const CLIENT_IDS = CLIENT_REGISTRY.map((c) => c.id);
