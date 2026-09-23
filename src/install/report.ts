import { SKILL_NAME } from "../constants.js";
import type { ClientDefinition } from "./clients.js";
import { tildify, type InstallContext } from "./context.js";
import { describeLaunch } from "./launch.js";
import type { ApplyResult, Change, Plan } from "./plan.js";
import type { Theme } from "./theme.js";

/**
 * Text rendering of plans and results, shared by the wizard (inside clack notes) and the
 * non-interactive command output.
 */

type Tone = "add" | "change" | "same" | "remove" | "warn" | "error" | "info";

const PLAN_VERB: Record<string, [string, Tone]> = {
  create: ["create", "add"],
  add: ["add", "add"],
  update: ["update", "change"],
  replace: ["replace", "warn"],
  unchanged: ["up to date", "same"],
  remove: ["remove", "remove"],
  absent: ["not installed", "same"],
  keep: ["keep", "same"],
  conflict: ["conflict", "warn"],
  error: ["error", "error"],
  skip: ["skip", "same"],
  manual: ["paste", "info"],
};

const RESULT_TONE: Record<string, Tone> = {
  created: "add",
  added: "add",
  installed: "add",
  updated: "change",
  replaced: "warn",
  unchanged: "same",
  removed: "remove",
  absent: "same",
  kept: "same",
  skip: "same",
  conflict: "warn",
  error: "error",
  manual: "info",
};

const SYMBOL: Record<Tone, string> = { add: "+", change: "~", same: "·", remove: "-", warn: "!", error: "✗", info: "›" };

function paint(theme: Theme, tone: Tone, s: string): string {
  switch (tone) {
    case "add":
      return theme.ok(s);
    case "change":
      return theme.ochre(s);
    case "remove":
      return theme.rust(s);
    case "warn":
      return theme.warn(s);
    case "error":
      return theme.error(s);
    case "info":
      return theme.sage(s);
    default:
      return theme.dim(s);
  }
}

export const clientNames = (clients: readonly ClientDefinition[]) => clients.map((c) => c.label).join(", ");

/** Paths show as `./…` only in project plans; global plans use `~/…`. */
export function displayContext(plan: Plan): Pick<InstallContext, "home" | "platform"> & { cwd?: string } {
  return plan.scope === "project" ? plan.ctx : { home: plan.ctx.home, platform: plan.ctx.platform };
}

function target(change: Change, ctx: Pick<InstallContext, "home" | "platform"> & { cwd?: string }): string {
  switch (change.kind) {
    case "config":
      return change.file ? tildify(change.file, ctx) : "";
    case "skill":
    case "legacy-skill":
      return tildify(change.dir, ctx);
    case "skill-zip":
      return tildify(change.file, ctx);
    case "manual":
      return change.where;
  }
}

function group(change: Change): string {
  if (change.kind === "config" || change.kind === "manual") return clientNames(change.clients);
  return `Agent Skill (${SKILL_NAME})`;
}

function note(change: Change): string | undefined {
  switch (change.kind) {
    case "config":
      return [change.spec.label, change.claudeCli ? "via claude mcp" : undefined, change.reason].filter(Boolean).join(" · ") || undefined;
    case "skill":
      return change.reason ?? (change.clients.length > 0 ? `for ${clientNames(change.clients)}` : undefined);
    case "legacy-skill":
      return "copy from an earlier release (old name)";
    case "skill-zip":
      return `upload in ${clientNames(change.clients)}: Settings › Capabilities › Skills`;
    case "manual":
      return "JSON shown below";
  }
}

function row(theme: Theme, tone: Tone, verb: string, what: string, extra?: string): string {
  const head = paint(theme, tone, `${SYMBOL[tone]} ${verb.padEnd(13)}`);
  if (!what) return `  ${head} ${extra ? theme.dim(extra) : ""}`;
  if (!extra) return `  ${head} ${what}`;
  // Keep lines short enough for an 80-column box; long notes go on their own line.
  if (what.length + extra.length > 60) return `  ${head} ${what}\n  ${" ".repeat(16)}${theme.dim(extra)}`;
  return `  ${head} ${what}  ${theme.dim(extra)}`;
}

/** Changes grouped under client (or skill) headings. */
export function renderPlan(plan: Plan, theme: Theme, options: { showLaunch?: boolean } = {}): string[] {
  const lines: string[] = [];
  if (options.showLaunch !== false && plan.launch) lines.push(`${theme.dim("Launch")}  ${describeLaunch(plan.launch, plan.ctx)}`, "");
  const groups = new Map<string, { clients: readonly ClientDefinition[]; changes: Change[] }>();
  for (const change of plan.changes) {
    const g = groups.get(group(change)) ?? { clients: change.kind === "config" || change.kind === "manual" ? change.clients : [], changes: [] };
    g.changes.push(change);
    groups.set(group(change), g);
  }
  for (const [heading, { clients, changes }] of groups) {
    lines.push(theme.bold(heading));
    for (const change of changes) {
      const [verb, tone] = PLAN_VERB[change.action] ?? [change.action, "info"];
      lines.push(row(theme, tone, verb, target(change, displayContext(plan)), note(change)));
    }
    if (plan.operation === "install") for (const c of clients) for (const n of c.notes?.(plan.scope, plan.ctx) ?? []) lines.push(`    ${theme.dim(n)}`);
  }
  if (plan.changes.length === 0) lines.push(theme.dim("Nothing to do."));
  return lines;
}

export function renderResults(results: readonly ApplyResult[], ctx: Pick<InstallContext, "home" | "platform"> & { cwd?: string }, theme: Theme): string[] {
  const lines: string[] = [];
  let heading = "";
  for (const r of results) {
    const g = group(r.change);
    if (g !== heading) {
      lines.push(theme.bold(g));
      heading = g;
    }
    const outcome = r.outcome.replace(/ via claude mcp$/, "");
    const tone = RESULT_TONE[outcome] ?? (r.ok ? "info" : "error");
    const extra = [r.outcome.endsWith("via claude mcp") ? "via claude mcp" : undefined, r.detail, r.backup ? `backup: ${tildify(r.backup, ctx)}` : undefined]
      .filter(Boolean)
      .join(" · ");
    lines.push(row(theme, tone, outcome, target(r.change, ctx), extra || note(r.change)));
  }
  return lines;
}

/** What to do after installing, one line per client that changed. */
export function nextSteps(plan: Plan, results: readonly ApplyResult[] | undefined, theme: Theme): string[] {
  const touched = new Set<ClientDefinition>();
  for (const r of results ?? plan.changes.map((change) => ({ change, ok: true, outcome: change.action }))) {
    if (!r.ok) continue;
    if (r.change.kind === "config" && !["unchanged", "absent", "skip", "conflict", "error"].includes(r.outcome)) r.change.clients.forEach((c) => touched.add(c));
    if (r.change.kind === "skill-zip" || r.change.kind === "manual") r.change.clients.forEach((c) => touched.add(c));
  }
  const width = Math.max(0, ...[...touched].map((c) => c.label.length));
  return [...touched].map((c) => `${theme.bold(c.label.padEnd(width))}  ${c.restart}`);
}

export function manualSnippets(plan: Plan): { title: string; where: string; snippet: string }[] {
  return plan.changes.flatMap((c) => (c.kind === "manual" ? [{ title: clientNames(c.clients), where: c.where, snippet: c.snippet }] : []));
}

/** Machine-readable summary for --json. */
export function planJson(plan: Plan, results?: readonly ApplyResult[]) {
  const describe = (change: Change) => ({
    kind: change.kind,
    clients: "clients" in change ? change.clients.map((c) => c.id) : [],
    path: change.kind === "config" || change.kind === "skill-zip" ? change.file : change.kind === "manual" ? undefined : change.dir,
    action: change.action,
    ...(change.kind === "config" && change.reason ? { reason: change.reason } : {}),
    ...(change.kind === "config" && change.entry && plan.operation === "install" ? { entry: change.entry } : {}),
    ...(change.kind === "manual" ? { where: change.where, snippet: change.snippet } : {}),
  });
  return {
    operation: plan.operation,
    scope: plan.scope,
    serverName: plan.serverName,
    ...(plan.launch ? { launch: { mode: plan.launch.mode, argv: plan.launch.argv } } : {}),
    changes: plan.changes.map(describe),
    warnings: plan.warnings,
    ...(results
      ? { results: results.map((r) => ({ ...describe(r.change), ok: r.ok, outcome: r.outcome, ...(r.detail ? { detail: r.detail } : {}), ...(r.backup ? { backup: r.backup } : {}) })) }
      : {}),
  };
}
