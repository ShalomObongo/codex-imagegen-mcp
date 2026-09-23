import * as clack from "@clack/prompts";
import type { LoginMethod } from "../auth/store.js";
import { SKILL_NAME, VERSION } from "../constants.js";
import { availableClients, type ClientDefinition, type ClientKind, type Detection } from "./clients.js";
import { tildify, type InstallContext, type Scope } from "./context.js";
import { Detector, NOT_DETECTED } from "./detect.js";
import { npxSpec, resolveLaunch, type LaunchMode, type Runtime } from "./launch.js";
import { applyPlan, isConfigured, planInstall, planUninstall, type ApplyResult, type Plan } from "./plan.js";
import { manualSnippets, nextSteps, renderPlan, renderResults } from "./report.js";
import type { Theme } from "./theme.js";

export interface PromptOption<T> {
  value: T;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface Spinner {
  start(message?: string): void;
  stop(message?: string): void;
  message(message: string): void;
}

/** The prompts the wizard uses: clack in a terminal, a script in tests. Cancelled prompts return a symbol. */
export interface Prompter {
  intro(title: string): void;
  outro(message: string): void;
  cancel(message: string): void;
  note(message: string, title?: string): void;
  info(message: string): void;
  success(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  message(message: string): void;
  spinner(): Spinner;
  groupMultiselect<T>(o: { message: string; options: Record<string, PromptOption<T>[]>; initialValues?: T[]; required?: boolean }): Promise<T[] | symbol>;
  multiselect<T>(o: { message: string; options: PromptOption<T>[]; initialValues?: T[]; required?: boolean }): Promise<T[] | symbol>;
  select<T>(o: { message: string; options: PromptOption<T>[]; initialValue?: T }): Promise<T | symbol>;
  confirm(o: { message: string; initialValue?: boolean }): Promise<boolean | symbol>;
}

export function clackPrompter(): Prompter {
  return {
    intro: (t) => clack.intro(t),
    outro: (m) => clack.outro(m),
    cancel: (m) => clack.cancel(m),
    note: (m, t) => clack.note(m, t),
    info: (m) => clack.log.info(m),
    success: (m) => clack.log.success(m),
    warn: (m) => clack.log.warn(m),
    error: (m) => clack.log.error(m),
    message: (m) => clack.log.message(m),
    spinner: () => clack.spinner(),
    groupMultiselect: (o) => clack.groupMultiselect({ ...o, selectableGroups: false, maxItems: 16 } as Parameters<typeof clack.groupMultiselect>[0]) as never,
    multiselect: (o) => clack.multiselect({ ...o, maxItems: 16 } as Parameters<typeof clack.multiselect>[0]) as never,
    select: (o) => clack.select(o as Parameters<typeof clack.select>[0]) as never,
    confirm: (o) => clack.confirm(o),
  };
}

const cancelled = (v: unknown): v is symbol => typeof v === "symbol";

export interface WizardEnv {
  ui: Prompter;
  ctx: InstallContext;
  runtime: () => Runtime;
  theme: Theme;
  serverName: string;
  timeoutMs: number;
  env: Record<string, string>;
  /** Is a ChatGPT sign-in usable already? `label` describes it. */
  credentials: () => Promise<{ ready: boolean; label?: string }>;
  /** Run the sign-in flow; returns a success message. */
  signIn: (method: LoginMethod, print: (text: string) => void) => Promise<string>;
  /** How to run this CLI, for hints (e.g. "codex-imagegen-mcp" or "npx -y codex-imagegen-mcp"). */
  cli: string;
  claudeCli?: string | null;
}

const GROUPS: Record<ClientKind, string> = {
  cli: "Terminal agents",
  ide: "Editors & IDEs",
  desktop: "Desktop apps",
  extension: "Editor extensions",
  manual: "Set up by hand",
};

function preselected(client: ClientDefinition, detections: ReadonlyMap<string, Detection>): boolean {
  if (!detections.get(client.id)?.found || client.preselect === false) return false;
  return !(client.supersededBy && detections.get(client.supersededBy)?.found);
}

async function survey(w: WizardEnv, clients: readonly ClientDefinition[]) {
  const detections = await new Detector(w.ctx).detectAll(clients);
  const installed = new Set<string>();
  for (const c of clients) {
    if (await isConfigured(c, w.ctx, "global", w.serverName, detections.get(c.id) ?? NOT_DETECTED)) installed.add(c.id);
  }
  return { detections, installed };
}

function toolOptions(clients: readonly ClientDefinition[], detections: ReadonlyMap<string, Detection>, installed: ReadonlySet<string>) {
  const groups: Record<string, PromptOption<string>[]> = {};
  for (const c of clients) {
    const d = detections.get(c.id);
    const status = installed.has(c.id) ? "installed" : d?.found ? `found ${d.evidence[0] ?? ""}`.trim() : "not detected";
    const extra =
      c.id === "codex"
        ? "has built-in image generation when signed in with ChatGPT"
        : c.id === "windsurf"
          ? "legacy; current builds are Devin Desktop"
          : c.manual
            ? "prints JSON to paste into its settings"
            : undefined;
    // Plain labels: clack echoes the selected labels after submitting.
    (groups[GROUPS[c.kind]] ??= []).push({ value: c.id, label: c.label, hint: extra ? `${status} · ${extra}` : status });
  }
  return groups;
}

function summarize(results: readonly ApplyResult[]) {
  const failed = results.filter((r) => !r.ok);
  return { failed, ok: results.length - failed.length };
}

/** The interactive installer. Returns the process exit code. */
export async function installWizard(w: WizardEnv): Promise<number> {
  const { ui, theme: t } = w;
  ui.intro(`${t.badge("codex-imagegen-mcp")} ${t.dim(`v${VERSION} · image generation for your coding tools, on your ChatGPT plan`)}`);

  const clients = availableClients(w.ctx);
  const spin = ui.spinner();
  spin.start("Looking for coding tools");
  const { detections, installed } = await survey(w, clients);
  const detectedCount = clients.filter((c) => detections.get(c.id)?.found).length;
  spin.stop(`Found ${detectedCount} of ${clients.length} supported tools on this machine`);

  const picked = await ui.groupMultiselect({
    message: `Where should imagegen be installed? ${t.dim("(space to toggle, enter to confirm)")}`,
    options: toolOptions(clients, detections, installed),
    initialValues: clients.filter((c) => preselected(c, detections)).map((c) => c.id),
    required: true,
  });
  if (cancelled(picked)) return abort(ui);
  const selected = clients.filter((c) => picked.includes(c.id));

  let scope: Scope = "global";
  if (selected.some((c) => c.scopes.includes("project"))) {
    const choice = await ui.select<Scope>({
      message: "Install it for",
      options: [
        { value: "global", label: "All projects", hint: "recommended: your user-level configs" },
        { value: "project", label: "This project only", hint: `config files in ${tildify(w.ctx.cwd, w.ctx)}, shareable through git` },
      ],
      initialValue: "global",
    });
    if (cancelled(choice)) return abort(ui);
    scope = choice;
  }

  let skill = false;
  if (selected.some((c) => c.skillZip || c.skills(w.ctx, scope).length > 0)) {
    const answer = await ui.confirm({ message: `Also install the ${SKILL_NAME} Agent Skill? ${t.dim("It teaches the agent how to prompt, save and iterate.")}`, initialValue: true });
    if (cancelled(answer)) return abort(ui);
    skill = answer;
  }

  const runtime = w.runtime();
  const auto = resolveLaunch({ mode: "auto", scope }, w.ctx, runtime);
  const mode = await ui.select<"auto" | LaunchMode>({
    message: "How should the tools start the server?",
    options: [
      { value: "auto", label: "Recommended", hint: auto.mode === "node" ? "absolute node path for global installs" : `npx -y ${npxSpec()} serve` },
      {
        value: "node",
        label: "Absolute node path",
        hint: runtime.ephemeral ? "not available when running through npx" : "starts fast and works in GUI apps; tied to this installation",
        disabled: runtime.ephemeral,
      },
      { value: "npx", label: "npx", hint: `npx -y ${npxSpec()} serve: portable, downloads on first use` },
      { value: "global", label: "Global command", hint: "codex-imagegen-mcp serve: needs npm install --global" },
    ],
    initialValue: "auto",
  });
  if (cancelled(mode)) return abort(ui);

  const options = {
    ctx: w.ctx,
    scope,
    clients: selected,
    serverName: w.serverName,
    launch: resolveLaunch({ mode, scope, env: w.env }, w.ctx, runtime),
    runtime,
    timeoutMs: w.timeoutMs,
    mcp: true,
    skill,
    force: false,
    detections,
    ...(w.claudeCli !== undefined ? { claudeCli: w.claudeCli } : {}),
  };
  let plan = await planInstall(options);
  ui.note(renderPlan(plan, t).join("\n"), scope === "global" ? "Review" : `Review · ${tildify(w.ctx.cwd, w.ctx)}`);
  for (const warning of plan.warnings) ui.warn(warning);

  if (plan.changes.some((c) => c.kind === "config" && c.action === "conflict")) {
    const replace = await ui.confirm({ message: `Some tools already have a different server named "${w.serverName}". Replace it?`, initialValue: false });
    if (cancelled(replace)) return abort(ui);
    if (replace) {
      plan = await planInstall({ ...options, force: true });
      ui.note(renderPlan(plan, t, { showLaunch: false }).join("\n"), "Updated plan");
    }
  }

  const pending = plan.changes.filter((c) => !["unchanged", "absent", "skip", "keep"].includes(c.action));
  let results: ApplyResult[] = [];
  if (pending.length === 0) {
    ui.success("Everything is already up to date.");
  } else {
    const go = await ui.confirm({ message: "Apply these changes?", initialValue: true });
    if (cancelled(go) || !go) return abort(ui);
    spin.start("Installing");
    results = await applyPlan(plan, (m) => spin.message(m.length > 72 ? `${m.slice(0, 71)}…` : m));
    const { failed, ok } = summarize(results);
    spin.stop(failed.length === 0 ? `Done: ${ok} change${ok === 1 ? "" : "s"} applied` : `${failed.length} change${failed.length === 1 ? "" : "s"} failed`);
    ui.note(renderResults(results, w.ctx, t).join("\n"), "Result");
  }

  for (const m of manualSnippets(plan)) ui.note(m.snippet, `${m.title}: paste into ${m.where}`);
  await offerSignIn(w);
  const steps = nextSteps(plan, results.length > 0 ? results : undefined, t);
  if (steps.length > 0) ui.note(steps.join("\n"), "Next steps");
  ui.outro(`Then ask your agent: ${t.italic(`"Generate a 16:9 hero image of a lighthouse at dusk and save it to assets/hero.png"`)}`);
  return results.some((r) => !r.ok) ? 1 : 0;
}

async function offerSignIn(w: WizardEnv): Promise<void> {
  const { ui, theme: t } = w;
  const creds = await w.credentials();
  if (creds.ready) {
    ui.success(`ChatGPT sign-in: ${creds.label ?? "ready"}`);
    return;
  }
  const method = await ui.select<LoginMethod | "later">({
    message: "Sign in with ChatGPT now? The tools need it to generate images.",
    options: [
      { value: "browser", label: "Yes, in the browser" },
      { value: "device", label: "Yes, with a device code", hint: "for remote or headless machines" },
      { value: "later", label: "Later", hint: "the agent can also call the sign_in tool" },
    ],
    initialValue: "browser",
  });
  if (cancelled(method) || method === "later") {
    ui.info(`Sign in later with ${t.bold(`${w.cli} login`)}.`);
    return;
  }
  try {
    ui.success(await w.signIn(method, (text) => ui.message(text)));
  } catch (err) {
    ui.warn(`Sign-in didn't finish (${err instanceof Error ? err.message : String(err)}). Run ${w.cli} login when you're ready.`);
  }
}

function abort(ui: Prompter): number {
  ui.cancel("Cancelled. Nothing was changed.");
  return 130;
}

/** Interactive uninstall: pick among the tools that have imagegen installed. */
export async function uninstallWizard(w: WizardEnv): Promise<number> {
  const { ui, theme: t } = w;
  ui.intro(`${t.badge("codex-imagegen-mcp")} ${t.dim("uninstall")}`);
  const clients = availableClients(w.ctx);
  const spin = ui.spinner();
  spin.start("Looking for installations");
  const detections = await new Detector(w.ctx).detectAll(clients);
  const configured: Record<Scope, ClientDefinition[]> = { global: [], project: [] };
  for (const scope of ["global", "project"] as const) {
    for (const c of clients) {
      if (await isConfigured(c, w.ctx, scope, w.serverName, detections.get(c.id) ?? NOT_DETECTED)) configured[scope].push(c);
    }
  }
  spin.stop(`Installed in ${configured.global.length} tool${configured.global.length === 1 ? "" : "s"}${configured.project.length ? ` (plus ${configured.project.length} in this project)` : ""}`);

  let scope: Scope = "global";
  if (configured.project.length > 0) {
    const choice = await ui.select<Scope>({
      message: "Remove it from",
      options: [
        { value: "global", label: "Your user config", hint: `${configured.global.length} tools`, disabled: configured.global.length === 0 },
        { value: "project", label: "This project", hint: `${tildify(w.ctx.cwd, w.ctx)}, ${configured.project.length} tools` },
      ],
      initialValue: configured.global.length > 0 ? "global" : "project",
    });
    if (cancelled(choice)) return abort(ui);
    scope = choice;
  }
  const candidates = configured[scope];
  if (candidates.length === 0) {
    ui.outro(`imagegen isn't installed in any tool${scope === "project" ? " in this project" : ""}.`);
    return 0;
  }
  const picked = await ui.multiselect({
    message: "Remove imagegen from",
    options: candidates.map((c) => ({ value: c.id, label: c.label })),
    initialValues: candidates.map((c) => c.id),
    required: true,
  });
  if (cancelled(picked)) return abort(ui);
  const skill = await ui.confirm({ message: "Also remove skill copies that no remaining tool uses?", initialValue: true });
  if (cancelled(skill)) return abort(ui);

  const plan: Plan = await planUninstall({
    ctx: w.ctx,
    scope,
    clients: candidates.filter((c) => picked.includes(c.id)),
    serverName: w.serverName,
    skill,
    force: false,
    detections,
    ...(w.claudeCli !== undefined ? { claudeCli: w.claudeCli } : {}),
  });
  ui.note(renderPlan(plan, t).join("\n"), "Review");
  const go = await ui.confirm({ message: "Remove these?", initialValue: true });
  if (cancelled(go) || !go) return abort(ui);
  spin.start("Removing");
  const results = await applyPlan(plan, (m) => spin.message(m.length > 72 ? `${m.slice(0, 71)}…` : m));
  const { failed } = summarize(results);
  spin.stop(failed.length === 0 ? "Removed" : `${failed.length} change${failed.length === 1 ? "" : "s"} failed`);
  ui.note(renderResults(results, w.ctx, t).join("\n"), "Result");
  ui.outro(`Your ChatGPT sign-in was kept; run ${w.cli} logout to remove it too.`);
  return failed.length > 0 ? 1 : 0;
}
