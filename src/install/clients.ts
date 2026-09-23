import { envDir, locations, type InstallContext, type Scope } from "./context.js";
import type { ConfigFormat } from "./formats.js";
import type { ClientLaunch } from "./launch.js";

/**
 * The client registry: one declarative record per coding tool, describing where its MCP config
 * lives (per scope and OS), the entry shape it expects, which skill folders it reads, how to
 * detect it and what to do after installing. Sources and confidence notes: docs/CLIENTS.md.
 */

export type ClientKind = "cli" | "ide" | "desktop" | "extension" | "manual";

export interface EntryOptions {
  serverName: string;
  /** Tool-call timeout to write, in milliseconds (converted to each client's unit). */
  timeoutMs: number;
}

export interface ConfigSpec {
  format: ConfigFormat;
  /** Candidate files in precedence order; the first one that exists is edited. */
  files: string[];
  /** File to create when none of the candidates exists (default: the first candidate). */
  createAs?: string;
  /** Key path of the servers map; the entry goes at `[...root, serverName]`. */
  root: string[];
  /** Keys written at the top of a brand-new file, e.g. `$schema`. */
  template?: Record<string, unknown>;
  /** Distinguishes several files of one client, e.g. "Cline in VS Code". */
  label?: string;
  /** Cline guards its settings file with a `<file>.lock` directory; wait while it is fresh. */
  lock?: boolean;
  /** Claude Code's user config: apply through `claude mcp add-json` when the CLI can be run. */
  claudeCli?: boolean;
}

/** A VS Code-family editor that hosts agent extensions (Cline, Zoo/Roo Code, Kilo Code). */
export interface EditorHost {
  id: string;
  label: string;
  extensionsDir: (ctx: InstallContext) => string;
  userData: (ctx: InstallContext) => string;
}

export interface DetectSpec {
  /** Executables looked up on PATH. */
  bins?: readonly string[];
  /** Files or directories whose existence counts as evidence (apps, config dirs, binaries). */
  paths?: (ctx: InstallContext) => string[];
  /** VS Code-family extension ids (lowercase), searched in every EditorHost. */
  extensions?: readonly string[];
}

export interface Detection {
  found: boolean;
  evidence: string[];
  /** Editors that have one of `detect.extensions` installed. */
  hosts: { host: EditorHost; extensionId: string }[];
}

export type SkillRootId =
  | "agents"
  | "claude"
  | "opencode"
  | "copilot"
  | "github"
  | "cursor"
  | "devin"
  | "windsurf"
  | "cline"
  | "roo"
  | "kilo"
  | "qwen"
  | "kiro"
  | "junie"
  | "augment"
  | "antigravity";

export interface ClientDefinition {
  id: string;
  label: string;
  kind: ClientKind;
  /** Desktop/GUI app: may start without the login-shell PATH, so global installs use absolute paths. */
  gui: boolean;
  scopes: readonly Scope[];
  /** Only offered on these platforms. */
  platforms?: readonly NodeJS.Platform[];
  /** Pre-select in the wizard when detected (default true). */
  preselect?: boolean;
  /** Not pre-selected when this client is detected too (it would load the same server twice). */
  supersededBy?: string;
  detect: DetectSpec;
  configs: (ctx: InstallContext, scope: Scope, detection: Detection) => ConfigSpec[];
  entry: (launch: ClientLaunch, options: EntryOptions) => Record<string, unknown>;
  /** Skill folders the client reads, most preferred first. Empty: no local skill support. */
  skills: (ctx: InstallContext, scope: Scope) => SkillRootId[];
  /** Claude Desktop: skills are uploaded as a zip in the app instead. */
  skillZip?: boolean;
  /** How the client names our tools (for hints), when known. */
  tool?: (serverName: string, tool: string) => string;
  /** What to do after installing. */
  restart: string;
  notes?: (scope: Scope, ctx: InstallContext) => string[];
  /** Clients configured only through their UI: print a snippet to paste. */
  manual?: { format: ConfigFormat; root: string[]; where: string };
}

// ---------------------------------------------------------------------------------------------
// Shared locations
// ---------------------------------------------------------------------------------------------

function vscodeUserData(ctx: InstallContext, product: string): string {
  const custom = envDir(ctx, "VSCODE_APPDATA");
  return custom ? locations(ctx).p.join(custom, product) : locations(ctx).appData(product);
}

function editorHost(id: string, label: string, dotDir: string, product: string): EditorHost {
  return {
    id,
    label,
    extensionsDir: (ctx) => locations(ctx).home(dotDir, "extensions"),
    userData: (ctx) => vscodeUserData(ctx, product),
  };
}

export const EDITOR_HOSTS: readonly EditorHost[] = [
  editorHost("vscode", "VS Code", ".vscode", "Code"),
  editorHost("vscode-insiders", "VS Code Insiders", ".vscode-insiders", "Code - Insiders"),
  editorHost("vscodium", "VSCodium", ".vscode-oss", "VSCodium"),
  editorHost("cursor", "Cursor", ".cursor", "Cursor"),
  editorHost("windsurf", "Windsurf", ".windsurf", "Windsurf"),
  editorHost("kiro", "Kiro", ".kiro", "Kiro"),
];

const claudeDir = (ctx: InstallContext) => envDir(ctx, "CLAUDE_CONFIG_DIR") ?? locations(ctx).home(".claude");
const copilotHome = (ctx: InstallContext) => envDir(ctx, "COPILOT_HOME") ?? locations(ctx).home(".copilot");
const devinDir = (ctx: InstallContext) => {
  const L = locations(ctx);
  return ctx.platform === "win32" ? L.p.join(L.roaming, "devin") : L.p.join(L.xdgConfig, "devin");
};
const junieHome = (ctx: InstallContext) => envDir(ctx, "JUNIE_HOME") ?? locations(ctx).home(".junie");
/** Cline resolves its home from HOME first (even on Windows), then the OS home. */
const clineDir = (ctx: InstallContext) => {
  const L = locations(ctx);
  const explicit = envDir(ctx, "CLINE_DIR");
  if (explicit) return explicit;
  const home = ctx.env.HOME?.trim() && ctx.env.HOME.trim() !== "~" ? ctx.env.HOME.trim() : ctx.home;
  return L.p.join(home, ".cline");
};

export const SKILL_ROOTS: Record<SkillRootId, { global?: (ctx: InstallContext) => string; project?: (ctx: InstallContext) => string }> = {
  agents: { global: (c) => locations(c).home(".agents", "skills"), project: (c) => locations(c).project(".agents", "skills") },
  claude: { global: (c) => locations(c).p.join(claudeDir(c), "skills"), project: (c) => locations(c).project(".claude", "skills") },
  opencode: {
    global: (c) => locations(c).p.join(locations(c).xdgConfig, "opencode", "skills"),
    project: (c) => locations(c).project(".opencode", "skills"),
  },
  copilot: { global: (c) => locations(c).p.join(copilotHome(c), "skills") },
  github: { project: (c) => locations(c).project(".github", "skills") },
  cursor: { global: (c) => locations(c).home(".cursor", "skills"), project: (c) => locations(c).project(".cursor", "skills") },
  devin: { global: (c) => locations(c).p.join(devinDir(c), "skills"), project: (c) => locations(c).project(".devin", "skills") },
  windsurf: { global: (c) => locations(c).home(".codeium", "windsurf", "skills"), project: (c) => locations(c).project(".windsurf", "skills") },
  cline: { global: (c) => locations(c).p.join(clineDir(c), "skills"), project: (c) => locations(c).project(".cline", "skills") },
  roo: { global: (c) => locations(c).home(".roo", "skills"), project: (c) => locations(c).project(".roo", "skills") },
  kilo: {
    global: (c) => locations(c).p.join(locations(c).xdgConfig, "kilo", "skills"),
    project: (c) => locations(c).project(".kilo", "skills"),
  },
  qwen: { global: (c) => locations(c).home(".qwen", "skills"), project: (c) => locations(c).project(".qwen", "skills") },
  kiro: { global: (c) => locations(c).home(".kiro", "skills"), project: (c) => locations(c).project(".kiro", "skills") },
  junie: { global: (c) => locations(c).p.join(junieHome(c), "skills"), project: (c) => locations(c).project(".junie", "skills") },
  augment: { global: (c) => locations(c).home(".augment", "skills"), project: (c) => locations(c).project(".augment", "skills") },
  antigravity: { global: (c) => locations(c).home(".gemini", "config", "skills") },
};

/** Directory of a skill root for a scope, if the root exists in that scope. */
export function skillRootDir(id: SkillRootId, ctx: InstallContext, scope: Scope): string | undefined {
  return SKILL_ROOTS[id][scope]?.(ctx);
}

// ---------------------------------------------------------------------------------------------
// Entry shapes
// ---------------------------------------------------------------------------------------------

const envOf = (l: ClientLaunch, key = "env") => (Object.keys(l.env).length > 0 ? { [key]: { ...l.env } } : {});
const stdio = (l: ClientLaunch) => ({ command: l.command, args: [...l.args], ...envOf(l) });
const seconds = (ms: number) => Math.max(1, Math.ceil(ms / 1000));
/** opencode and Kilo: one `command` array, `environment`, and a per-request timeout in ms. */
const opencodeEntry = (l: ClientLaunch, o: EntryOptions) => ({
  type: "local",
  command: [l.command, ...l.args],
  enabled: true,
  timeout: o.timeoutMs,
  ...envOf(l, "environment"),
});

const json = (files: string[], root: string[], extra: Partial<ConfigSpec> = {}): ConfigSpec => ({ format: "json", files, root, ...extra });
const always =
  (...ids: SkillRootId[]) =>
  () =>
    ids;

function apps(ctx: InstallContext, spec: { mac?: string[]; win?: string[]; linux?: string[] }): string[] {
  const L = locations(ctx);
  if (ctx.platform === "darwin") return (spec.mac ?? []).flatMap((a) => [`/Applications/${a}`, L.home("Applications", a)]);
  if (ctx.platform === "win32") return (spec.win ?? []).map((a) => L.p.join(L.local, "Programs", a));
  return spec.linux ?? [];
}

function vscodeFamily(id: string, label: string, product: string, bin: string, app: { mac: string; win: string; linux: string[] }): ClientDefinition {
  return {
    id,
    label,
    kind: "ide",
    gui: true,
    scopes: ["global", "project"],
    detect: {
      bins: [bin],
      paths: (ctx) => [...apps(ctx, { mac: [app.mac], win: [app.win], linux: app.linux }), vscodeUserData(ctx, product)],
    },
    configs: (ctx, scope) =>
      scope === "global"
        ? [json([locations(ctx).p.join(vscodeUserData(ctx, product), "User", "mcp.json")], ["servers"])]
        : [json([locations(ctx).project(".vscode", "mcp.json")], ["servers"])],
    entry: (l) => ({ type: "stdio", ...stdio(l) }),
    skills: always("agents", "claude", "copilot", "github"),
    restart: `In ${label}, run "MCP: List Servers", start imagegen and trust it when asked.`,
    notes: (scope) => (scope === "global" ? ["Written to the default profile; other VS Code profiles keep their own mcp.json."] : []),
  };
}

// ---------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------

export const CLIENT_REGISTRY: readonly ClientDefinition[] = [
  {
    id: "opencode",
    label: "OpenCode",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: {
      bins: ["opencode"],
      paths: (ctx) => [locations(ctx).home(".opencode", "bin", ctx.platform === "win32" ? "opencode.exe" : "opencode"), locations(ctx).p.join(locations(ctx).xdgConfig, "opencode")],
    },
    configs: (ctx, scope) => {
      const L = locations(ctx);
      const dir = scope === "global" ? L.p.join(L.xdgConfig, "opencode") : ctx.cwd;
      return [
        json([L.p.join(dir, "opencode.jsonc"), L.p.join(dir, "opencode.json")], ["mcp"], {
          createAs: L.p.join(dir, "opencode.json"),
          template: { $schema: "https://opencode.ai/config.json" },
        }),
      ];
    },
    entry: opencodeEntry,
    skills: always("agents", "claude", "opencode"),
    tool: (s, t) => `${s}_${t}`,
    restart: "Restart OpenCode, then check that `opencode mcp list` shows imagegen as connected.",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: {
      bins: ["claude"],
      paths: (ctx) => [claudeDir(ctx), locations(ctx).p.join(envDir(ctx, "CLAUDE_CONFIG_DIR") ?? ctx.home, ".claude.json")],
    },
    configs: (ctx, scope) =>
      scope === "global"
        ? [json([locations(ctx).p.join(envDir(ctx, "CLAUDE_CONFIG_DIR") ?? ctx.home, ".claude.json")], ["mcpServers"], { claudeCli: true })]
        : [json([locations(ctx).project(".mcp.json")], ["mcpServers"])],
    entry: (l) => ({ type: "stdio", command: l.command, args: [...l.args], env: { ...l.env } }),
    skills: always("claude"),
    tool: (s, t) => `mcp__${s}__${t}`,
    restart: "Start a new Claude Code session; `claude mcp list` should show imagegen.",
    notes: (scope) => (scope === "project" ? ["Claude Code asks you to approve servers from .mcp.json the first time."] : []),
  },
  {
    id: "codex",
    label: "Codex (CLI, IDE, app)",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    preselect: false,
    detect: {
      bins: ["codex"],
      paths: (ctx) => [envDir(ctx, "CODEX_HOME") ?? locations(ctx).home(".codex"), ...apps(ctx, { mac: ["Codex.app"] })],
    },
    configs: (ctx, scope) =>
      scope === "global"
        ? [{ format: "toml", files: [locations(ctx).p.join(envDir(ctx, "CODEX_HOME") ?? locations(ctx).home(".codex"), "config.toml")], root: ["mcp_servers"] }]
        : [{ format: "toml", files: [locations(ctx).project(".codex", "config.toml")], root: ["mcp_servers"] }],
    entry: (l, o) => ({ ...stdio(l), startup_timeout_sec: 60, tool_timeout_sec: seconds(o.timeoutMs) }),
    skills: always("agents"),
    tool: (s, t) => `mcp__${s}__${t}`,
    restart: "Start a new Codex session; `codex mcp list` should show imagegen.",
    notes: (scope) => [
      "Codex signed in with ChatGPT already has built-in image generation; this is mainly for API-key setups.",
      ...(scope === "project" ? ["Codex reads .codex/config.toml only in trusted projects."] : []),
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: { bins: ["gemini"], paths: (ctx) => [locations(ctx).p.join(envDir(ctx, "GEMINI_CLI_HOME") ?? ctx.home, ".gemini")] },
    configs: (ctx, scope) =>
      scope === "global"
        ? [json([locations(ctx).p.join(envDir(ctx, "GEMINI_CLI_HOME") ?? ctx.home, ".gemini", "settings.json")], ["mcpServers"])]
        : [json([locations(ctx).project(".gemini", "settings.json")], ["mcpServers"])],
    entry: stdio,
    skills: always("agents"),
    tool: (s, t) => `mcp_${s}_${t}`,
    restart: "Restart Gemini CLI (or run /mcp reload).",
    notes: (scope) => (scope === "project" ? ["Gemini CLI connects project servers only in trusted folders."] : []),
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: { bins: ["copilot"], paths: (ctx) => [copilotHome(ctx)] },
    configs: (ctx, scope) =>
      scope === "global"
        ? [json([locations(ctx).p.join(copilotHome(ctx), "mcp-config.json")], ["mcpServers"])]
        : [json([locations(ctx).project(".github", "mcp.json")], ["mcpServers"])],
    entry: (l, o) => ({ type: "local", ...stdio(l), tools: ["*"], timeout: o.timeoutMs }),
    // Copilot skips ~/.agents/skills when COPILOT_HOME is set, and stopped reading ~/.claude/skills in 1.0.36.
    skills: (ctx, scope) =>
      scope === "project" ? ["agents", "github", "claude"] : envDir(ctx, "COPILOT_HOME") ? ["copilot"] : ["agents", "copilot"],
    tool: (s, t) => `${s}-${t}`,
    restart: "Run /mcp reload in Copilot CLI, or restart it.",
    notes: (scope) =>
      scope === "project" ? ["Copilot CLI reads .github/mcp.json in trusted folders; a .mcp.json next to it takes precedence."] : [],
  },
  {
    id: "cursor",
    label: "Cursor",
    kind: "ide",
    gui: true,
    scopes: ["global", "project"],
    detect: {
      bins: ["cursor", "cursor-agent"],
      paths: (ctx) => [...apps(ctx, { mac: ["Cursor.app"], win: ["cursor/Cursor.exe"], linux: ["/usr/share/cursor", "/opt/Cursor"] }), locations(ctx).home(".cursor")],
    },
    configs: (ctx, scope) => [json([scope === "global" ? locations(ctx).home(".cursor", "mcp.json") : locations(ctx).project(".cursor", "mcp.json")], ["mcpServers"])],
    entry: (l) => ({ type: "stdio", ...stdio(l) }),
    skills: always("agents", "claude", "cursor"),
    restart: "Restart Cursor, then make sure imagegen is enabled under Settings › MCP.",
    notes: () => ["Cursor's terminal agent (cursor-agent) stops tool calls after 60 s; image calls usually take 15-60 s."],
  },
  vscodeFamily("vscode", "VS Code", "Code", "code", {
    mac: "Visual Studio Code.app",
    win: "Microsoft VS Code/Code.exe",
    linux: ["/usr/share/code", "/snap/bin/code"],
  }),
  vscodeFamily("vscode-insiders", "VS Code Insiders", "Code - Insiders", "code-insiders", {
    mac: "Visual Studio Code - Insiders.app",
    win: "Microsoft VS Code Insiders/Code - Insiders.exe",
    linux: ["/usr/share/code-insiders"],
  }),
  vscodeFamily("vscodium", "VSCodium", "VSCodium", "codium", { mac: "VSCodium.app", win: "VSCodium/VSCodium.exe", linux: ["/usr/share/codium"] }),
  {
    id: "claude-desktop",
    label: "Claude Desktop",
    kind: "desktop",
    gui: true,
    scopes: ["global"],
    detect: {
      paths: (ctx) => [...apps(ctx, { mac: ["Claude.app"] }), ...(ctx.platform === "win32" ? [locations(ctx).p.join(locations(ctx).local, "AnthropicClaude")] : []), locations(ctx).appData("Claude")],
    },
    configs: (ctx) => [json([locations(ctx).p.join(locations(ctx).appData("Claude"), "claude_desktop_config.json")], ["mcpServers"])],
    entry: stdio,
    skills: () => [],
    skillZip: true,
    restart: "Quit Claude Desktop completely (not just the window) and open it again.",
    notes: (_scope, ctx) => (ctx.platform === "linux" ? ["Claude Desktop has no official Linux build; this is the path community builds use."] : []),
  },
  {
    id: "devin",
    label: "Devin Desktop (ex-Windsurf)",
    kind: "ide",
    gui: true,
    scopes: ["global", "project"],
    detect: {
      bins: ["devin"],
      paths: (ctx) => [...apps(ctx, { mac: ["Devin.app"], win: ["Devin/Devin.exe"] }), devinDir(ctx)],
    },
    configs: (ctx, scope) => [
      json([scope === "global" ? locations(ctx).p.join(devinDir(ctx), "mcp_config.json") : locations(ctx).project(".devin", "mcp_config.json")], ["mcpServers"]),
    ],
    entry: stdio,
    skills: always("agents", "devin"),
    restart: "Restart Devin Desktop.",
    notes: () => ["Devin also imports MCP servers from other tools' configs; if imagegen appears twice, turn one off."],
  },
  {
    id: "windsurf",
    label: "Windsurf (legacy)",
    kind: "ide",
    gui: true,
    scopes: ["global"],
    supersededBy: "devin",
    detect: {
      paths: (ctx) => [...apps(ctx, { mac: ["Windsurf.app"], win: ["Windsurf/Windsurf.exe"] }), locations(ctx).home(".codeium", "windsurf")],
    },
    configs: (ctx) => [json([locations(ctx).home(".codeium", "windsurf", "mcp_config.json")], ["mcpServers"])],
    entry: stdio,
    skills: always("windsurf"),
    restart: "Restart Windsurf.",
    notes: () => ["Windsurf is now Devin Desktop; for current versions choose Devin Desktop instead."],
  },
  {
    id: "zed",
    label: "Zed",
    kind: "ide",
    gui: true,
    scopes: ["global", "project"],
    detect: {
      bins: ["zed"],
      paths: (ctx) => [
        ...apps(ctx, { mac: ["Zed.app", "Zed Preview.app"], win: ["Zed/Zed.exe"], linux: [locations(ctx).home(".local", "zed.app")] }),
        zedDir(ctx),
      ],
    },
    configs: (ctx, scope) => [
      json([scope === "global" ? locations(ctx).p.join(zedDir(ctx), "settings.json") : locations(ctx).project(".zed", "settings.json")], ["context_servers"]),
    ],
    entry: (l, o) => ({ ...stdio(l), timeout: seconds(o.timeoutMs) }),
    skills: always("agents"),
    restart: "Zed applies settings immediately; check the server under Agent › Settings.",
  },
  {
    id: "cline",
    label: "Cline",
    kind: "extension",
    gui: true,
    scopes: ["global"],
    detect: { bins: ["cline"], extensions: ["saoudrizwan.claude-dev"], paths: (ctx) => [clineDir(ctx)] },
    configs: (ctx, _scope, detection) => {
      const L = locations(ctx);
      const shared =
        envDir(ctx, "CLINE_MCP_SETTINGS_PATH") ??
        L.p.join(envDir(ctx, "CLINE_DATA_DIR") ?? L.p.join(clineDir(ctx), "data"), "settings", "cline_mcp_settings.json");
      return [
        json([shared], ["mcpServers"], { label: "Cline (shared settings)", lock: true }),
        // The legacy extension bundle still reads the editor's globalStorage copy.
        ...detection.hosts.map(({ host, extensionId }) =>
          json([L.p.join(host.userData(ctx), "User", "globalStorage", extensionId, "settings", "cline_mcp_settings.json")], ["mcpServers"], {
            label: `Cline in ${host.label}`,
          }),
        ),
      ];
    },
    entry: (l, o) => ({ ...stdio(l), disabled: false, timeout: seconds(o.timeoutMs) }),
    skills: always("agents", "cline"),
    restart: "Start a new Cline task (reload the editor window if imagegen doesn't appear).",
  },
  {
    id: "zoo",
    label: "Zoo Code / Roo Code",
    kind: "extension",
    gui: true,
    scopes: ["global", "project"],
    detect: { extensions: ["zoocodeorganization.zoo-code", "rooveterinaryinc.roo-cline"], paths: (ctx) => [locations(ctx).home(".roo")] },
    configs: (ctx, scope, detection) =>
      scope === "project"
        ? [json([locations(ctx).project(".roo", "mcp.json")], ["mcpServers"])]
        : detection.hosts.map(({ host, extensionId }) =>
            json([locations(ctx).p.join(host.userData(ctx), "User", "globalStorage", extensionId, "settings", "mcp_settings.json")], ["mcpServers"], {
              label: `${extensionId.startsWith("zoo") ? "Zoo Code" : "Roo Code"} in ${host.label}`,
            }),
          ),
    entry: (l, o) => ({ ...stdio(l), disabled: false, timeout: seconds(o.timeoutMs) }),
    skills: always("agents", "roo"),
    restart: "The extension reloads its MCP settings automatically.",
    notes: (scope) => (scope === "global" ? ["Roo Code shut down in May 2026; Zoo Code continues it with the same settings."] : []),
  },
  {
    id: "kilo",
    label: "Kilo Code",
    kind: "extension",
    gui: true,
    scopes: ["global", "project"],
    detect: {
      bins: ["kilo"],
      extensions: ["kilocode.kilo-code"],
      paths: (ctx) => [locations(ctx).p.join(locations(ctx).xdgConfig, "kilo"), locations(ctx).home(".kilocode")],
    },
    configs: (ctx, scope) => {
      const L = locations(ctx);
      const dir = scope === "global" ? L.p.join(L.xdgConfig, "kilo") : ctx.cwd;
      return [
        json([L.p.join(dir, "kilo.jsonc"), L.p.join(dir, "kilo.json")], ["mcp"], {
          createAs: L.p.join(dir, "kilo.json"),
          template: { $schema: "https://app.kilo.ai/config.json" },
        }),
      ];
    },
    entry: opencodeEntry,
    skills: always("agents", "claude", "kilo"),
    tool: (s, t) => `${s}_${t}`,
    restart: "Reload the editor window (Developer: Reload Window) or restart the Kilo CLI.",
  },
  {
    id: "amp",
    label: "Amp",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: { bins: ["amp"], paths: (ctx) => [locations(ctx).p.join(locations(ctx).xdgConfig, "amp")] },
    configs: (ctx, scope) => {
      const L = locations(ctx);
      const dir = scope === "global" ? L.p.join(L.xdgConfig, "amp") : L.project(".amp");
      return [json([L.p.join(dir, "settings.jsonc"), L.p.join(dir, "settings.json")], ["amp.mcpServers"], { createAs: L.p.join(dir, "settings.json") })];
    },
    entry: stdio,
    skills: always("agents", "claude"),
    restart: "Restart Amp.",
    notes: (scope) => (scope === "project" ? ["Amp asks you to approve MCP servers from workspace settings."] : []),
  },
  {
    id: "goose",
    label: "Goose",
    kind: "cli",
    gui: true,
    scopes: ["global"],
    detect: { bins: ["goose"], paths: (ctx) => [...apps(ctx, { mac: ["Goose.app"] }), gooseDir(ctx)] },
    configs: (ctx) => [{ format: "yaml", files: [locations(ctx).p.join(gooseDir(ctx), "config.yaml")], root: ["extensions"] }],
    entry: (l, o) => ({
      enabled: true,
      type: "stdio",
      name: o.serverName,
      description: "Generate and edit images with your ChatGPT plan (codex-imagegen-mcp)",
      cmd: l.command,
      args: [...l.args],
      envs: { ...l.env },
      timeout: seconds(o.timeoutMs),
    }),
    skills: always("agents", "claude"),
    restart: "Start a new Goose session (restart Goose Desktop).",
  },
  {
    id: "droid",
    label: "Factory Droid",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: { bins: ["droid"], paths: (ctx) => [locations(ctx).home(".factory")] },
    configs: (ctx, scope) => [json([scope === "global" ? locations(ctx).home(".factory", "mcp.json") : locations(ctx).project(".factory", "mcp.json")], ["mcpServers"])],
    entry: (l, o) => ({ type: "stdio", ...stdio(l), disabled: false, timeout: o.timeoutMs, connectTimeout: 60_000 }),
    skills: always("agents"),
    restart: "Droid reloads mcp.json automatically.",
  },
  {
    id: "qwen",
    label: "Qwen Code",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: { bins: ["qwen"], paths: (ctx) => [locations(ctx).home(".qwen")] },
    configs: (ctx, scope) => [json([scope === "global" ? locations(ctx).home(".qwen", "settings.json") : locations(ctx).project(".qwen", "settings.json")], ["mcpServers"])],
    entry: stdio,
    skills: always("qwen"),
    restart: "Restart Qwen Code.",
  },
  {
    id: "kiro",
    label: "Kiro",
    kind: "ide",
    gui: true,
    scopes: ["global", "project"],
    detect: {
      bins: ["kiro", "kiro-cli"],
      paths: (ctx) => [...apps(ctx, { mac: ["Kiro.app"], win: ["Kiro/Kiro.exe"] }), locations(ctx).home(".kiro")],
    },
    configs: (ctx, scope) => [
      json([scope === "global" ? locations(ctx).home(".kiro", "settings", "mcp.json") : locations(ctx).project(".kiro", "settings", "mcp.json")], ["mcpServers"]),
    ],
    entry: (l) => ({ ...stdio(l), disabled: false }),
    skills: always("kiro"),
    restart: "Kiro reloads MCP settings automatically; check its MCP panel.",
  },
  {
    id: "junie",
    label: "JetBrains Junie",
    kind: "cli",
    gui: true,
    scopes: ["global", "project"],
    detect: { bins: ["junie"], paths: (ctx) => [junieHome(ctx)] },
    configs: (ctx, scope) => [
      json([scope === "global" ? locations(ctx).p.join(junieHome(ctx), "mcp", "mcp.json") : locations(ctx).project(".junie", "mcp", "mcp.json")], ["mcpServers"]),
    ],
    entry: stdio,
    skills: always("agents", "junie"),
    restart: "Restart Junie (or reopen its tool window in the IDE).",
  },
  {
    id: "auggie",
    label: "Augment (Auggie CLI)",
    kind: "cli",
    gui: false,
    scopes: ["global", "project"],
    detect: { bins: ["auggie"], paths: (ctx) => [locations(ctx).home(".augment")] },
    configs: (ctx, scope) => [
      json([scope === "global" ? locations(ctx).home(".augment", "settings.json") : locations(ctx).project(".augment", "settings.json")], ["mcpServers"]),
    ],
    entry: stdio,
    skills: always("agents", "claude", "augment"),
    restart: "Restart Auggie.",
  },
  {
    id: "antigravity",
    label: "Google Antigravity",
    kind: "ide",
    gui: true,
    scopes: ["global", "project"],
    detect: {
      bins: ["agy"],
      paths: (ctx) => [...apps(ctx, { mac: ["Antigravity.app"], win: ["Antigravity/Antigravity.exe"] }), locations(ctx).home(".gemini", "config")],
    },
    configs: (ctx, scope) =>
      scope === "global"
        ? [
            json([locations(ctx).home(".gemini", "config", "mcp_config.json"), locations(ctx).home(".gemini", "antigravity", "mcp_config.json")], ["mcpServers"], {
              createAs: locations(ctx).home(".gemini", "config", "mcp_config.json"),
            }),
          ]
        : [json([locations(ctx).project(".agents", "mcp_config.json")], ["mcpServers"])],
    entry: stdio,
    skills: (_ctx, scope) => (scope === "global" ? ["antigravity"] : ["agents"]),
    restart: "Restart Antigravity (or refresh MCP Store › Manage).",
    notes: () => ["Antigravity's MCP file is lightly documented; if imagegen is missing, check MCP Store › Manage › View raw config."],
  },
  {
    id: "visual-studio",
    label: "Visual Studio",
    kind: "ide",
    gui: true,
    scopes: ["global"],
    platforms: ["win32"],
    detect: {
      paths: (ctx) => {
        const L = locations(ctx);
        const pf = envDir(ctx, "ProgramFiles") ?? "C:\\Program Files";
        return [L.p.join(pf, "Microsoft Visual Studio", "2022"), L.p.join(pf, "Microsoft Visual Studio", "18")];
      },
    },
    configs: (ctx) => [json([locations(ctx).home(".mcp.json")], ["servers"])],
    entry: (l) => ({ type: "stdio", ...stdio(l) }),
    skills: () => [],
    restart: "Restart Visual Studio, then enable imagegen in Copilot Chat's tool list.",
  },
  {
    id: "jetbrains-ai",
    label: "JetBrains AI Assistant",
    kind: "manual",
    gui: true,
    scopes: ["global"],
    detect: { paths: (ctx) => [locations(ctx).appData("JetBrains")] },
    configs: () => [],
    entry: stdio,
    skills: () => [],
    manual: { format: "json", root: ["mcpServers"], where: "Settings › Tools › AI Assistant › Model Context Protocol (MCP) › Add › As JSON" },
    restart: "Paste the JSON below into AI Assistant's MCP settings.",
  },
];

function zedDir(ctx: InstallContext): string {
  const L = locations(ctx);
  if (ctx.platform === "win32") return L.p.join(L.roaming, "Zed");
  if (ctx.platform === "darwin") return L.home(".config", "zed");
  return L.p.join(L.xdgConfig, "zed");
}

function gooseDir(ctx: InstallContext): string {
  const L = locations(ctx);
  return ctx.platform === "win32" ? L.p.join(L.roaming, "Block", "goose", "config") : L.p.join(L.xdgConfig, "goose");
}

/** Clients offered on this platform. */
export function availableClients(ctx: Pick<InstallContext, "platform">): ClientDefinition[] {
  return CLIENT_REGISTRY.filter((c) => !c.platforms || c.platforms.includes(ctx.platform));
}

export function findClient(id: string): ClientDefinition | undefined {
  const needle = id.trim().toLowerCase();
  return CLIENT_REGISTRY.find((c) => c.id === needle) ?? CLIENT_REGISTRY.find((c) => CLIENT_ALIASES[needle] === c.id);
}

/** Alternative names accepted on the command line. */
export const CLIENT_ALIASES: Record<string, string> = {
  claude: "claude-code",
  "claude-cli": "claude-code",
  "gemini-cli": "gemini",
  "copilot-cli": "copilot",
  "github-copilot": "copilot",
  code: "vscode",
  "vs-code": "vscode",
  insiders: "vscode-insiders",
  codium: "vscodium",
  roo: "zoo",
  "roo-code": "zoo",
  "zoo-code": "zoo",
  "kilo-code": "kilo",
  factory: "droid",
  "factory-droid": "droid",
  "qwen-code": "qwen",
  "kiro-cli": "kiro",
  augment: "auggie",
  jetbrains: "jetbrains-ai",
  "devin-desktop": "devin",
  vs: "visual-studio",
};
