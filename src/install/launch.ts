import fs from "node:fs";
import path from "node:path";
import { PACKAGE_NAME, PACKAGE_ROOT, VERSION } from "../constants.js";
import { ImagegenError } from "../errors.js";
import { envDir, pathApi, pathDirs, realpathOr, which, type InstallContext, type Scope } from "./context.js";

/**
 * How an MCP client starts the server:
 * - node:   absolute node + absolute cli.js. No PATH, shim or network needed at spawn, so it is the
 *           most robust choice for global installs (GUI apps often start without the shell PATH).
 * - npx:    `npx -y codex-imagegen-mcp@<range> serve`. Portable; the default for project files
 *           that get committed to git.
 * - global: the `codex-imagegen-mcp` command from `npm install --global`.
 * - custom: an exact command given by the user.
 */
export type LaunchMode = "node" | "npx" | "global" | "custom";
export const LAUNCH_MODES: readonly LaunchMode[] = ["node", "npx", "global", "custom"];

/** Facts about this copy of the package and the Node running it. */
export interface Runtime {
  /** Node binary to persist in configs (a stable symlink where possible). */
  node: string;
  /** Absolute path of this package's `dist/src/cli.js`, symlinks resolved. */
  script: string;
  /** True when this copy lives in npm's temporary npx cache, so absolute paths to it would break. */
  ephemeral: boolean;
  warnings: string[];
}

/** Resolved launch command, before per-client adjustments. */
export interface Launch {
  mode: LaunchMode;
  argv: string[];
  /** Environment written into entries (pinned variables + `--env`). */
  env: Record<string, string>;
  warnings: string[];
}

/** What one client's entry should contain. */
export interface ClientLaunch {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * Pick a node path that survives upgrades: the first `node` on PATH that is the binary running
 * now, without following the symlink (e.g. /opt/homebrew/bin/node rather than the versioned
 * Cellar path). fnm's per-shell paths are ephemeral and never persisted.
 */
export function stableNodePath(ctx: InstallContext, execPath = process.execPath): { node: string; warnings: string[] } {
  const p = pathApi(ctx);
  const warnings: string[] = [];
  const real = realpathOr(execPath);
  const exe = ctx.platform === "win32" ? "node.exe" : "node";
  let node: string | undefined;
  for (const dir of pathDirs(ctx)) {
    const candidate = p.join(dir, exe);
    if (candidate.includes("fnm_multishells")) continue;
    if (fs.existsSync(candidate) && realpathOr(candidate) === real) {
      node = candidate;
      break;
    }
  }
  node ??= execPath.includes("fnm_multishells") ? real : execPath;
  if (/[\\/]\.nvm[\\/]versions[\\/]node[\\/]/.test(node)) {
    warnings.push(`Node comes from nvm (${node}); re-run the installer after removing or switching that Node version.`);
  } else if (/[\\/](\.asdf|mise)[\\/]shims[\\/]/.test(node)) {
    warnings.push(`Node is a version-manager shim (${node}); it may pick a different Node in other directories.`);
  }
  return { node, warnings };
}

export function currentRuntime(ctx: InstallContext): Runtime {
  const script = realpathOr(path.join(PACKAGE_ROOT, "dist", "src", "cli.js"));
  const { node, warnings } = stableNodePath(ctx);
  return { node, script, ephemeral: script.split(/[\\/]/).includes("_npx"), warnings };
}

/** npm range written into npx commands: the current major (or minor while on 0.x). */
export function npxSpec(version = VERSION): string {
  const m = /^(\d+)\.(\d+)\.\d+$/.exec(version);
  if (!m) return `${PACKAGE_NAME}@${version}`;
  return `${PACKAGE_NAME}@${m[1] === "0" ? `0.${m[2]}` : m[1]}`;
}

/**
 * Variables some clients drop before spawning a server (Copilot CLI passes only PATH; Cline,
 * Roo and Codex use allow-lists). Pinning them keeps every client on the same data directory
 * and credentials as the terminal. Only used for global installs: project files are shared.
 */
const PINNED_ENV = ["CODEX_IMAGEGEN_HOME", "CODEX_IMAGEGEN_OUTPUT_DIR", "CODEX_IMAGEGEN_CREDENTIALS", "CODEX_HOME", "XDG_DATA_HOME"] as const;

export function pinnedEnvironment(ctx: InstallContext): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PINNED_ENV) {
    if (name === "CODEX_IMAGEGEN_CREDENTIALS") {
      const v = ctx.env[name]?.trim();
      if (v) env[name] = v;
      continue;
    }
    const raw = ctx.env[name]?.trim();
    if (!raw) continue;
    const dir = envDir(ctx, name) ?? (name.startsWith("CODEX_") ? pathApi(ctx).resolve(ctx.cwd, raw) : undefined);
    if (dir) env[name] = dir;
  }
  return env;
}

export interface LaunchRequest {
  mode: "auto" | LaunchMode;
  scope: Scope;
  /** For mode "custom". */
  command?: string[];
  env?: Record<string, string>;
}

export function resolveLaunch(req: LaunchRequest, ctx: InstallContext, runtime: Runtime): Launch {
  const mode: LaunchMode = req.mode === "auto" ? (req.scope === "project" || runtime.ephemeral ? "npx" : "node") : req.mode;
  const warnings = [...runtime.warnings];
  let argv: string[];
  switch (mode) {
    case "node":
      if (runtime.ephemeral) {
        throw new ImagegenError(
          "invalid_input",
          "This copy runs from npm's temporary npx cache, so configs can't point at it. Use --launch npx, or install the package first (npm install --global codex-imagegen-mcp).",
        );
      }
      argv = [runtime.node, runtime.script, "serve"];
      if (req.scope === "project") warnings.push("Project configs are usually committed; absolute paths only work on this machine.");
      break;
    case "npx":
      argv = ["npx", "-y", npxSpec(), "serve"];
      break;
    case "global":
      argv = [PACKAGE_NAME, "serve"];
      if (!which(ctx, PACKAGE_NAME)) warnings.push(`\`${PACKAGE_NAME}\` is not on PATH; install it with npm install --global ${PACKAGE_NAME}.`);
      break;
    case "custom":
      if (!req.command?.length) throw new ImagegenError("invalid_input", "--command needs the command to run, e.g. --command \"node /path/to/cli.js serve\".");
      argv = [...req.command];
      break;
  }
  const env = { ...(req.scope === "global" ? pinnedEnvironment(ctx) : {}), ...req.env };
  return { mode, argv, env, warnings };
}

/**
 * Adjust the launch for one client:
 * - Windows: `npx` and npm shims are .cmd files that clients can't always spawn without a shell,
 *   so wrap them as `cmd /c …` (harmless for clients that already handle .cmd).
 * - GUI apps (global scope, macOS/Linux): absolute npx/shim path, and a PATH containing node so
 *   the `#!/usr/bin/env node` shebang resolves when the app started without the shell PATH.
 */
export function adaptLaunch(launch: Launch, opts: { gui: boolean; scope: Scope }, ctx: InstallContext, runtime: Runtime): ClientLaunch {
  const [first = "node", ...rest] = launch.argv;
  let command = first;
  let args = rest;
  const env = { ...launch.env };
  if (launch.mode === "npx" || launch.mode === "global") {
    if (ctx.platform === "win32") {
      args = ["/c", command, ...args];
      command = "cmd";
    } else if (opts.gui && opts.scope === "global") {
      const p = pathApi(ctx);
      const sibling = p.join(p.dirname(runtime.node), command);
      command = which(ctx, command) ?? (fs.existsSync(sibling) ? sibling : command);
      env.PATH ??= [...new Set([p.dirname(runtime.node), "/usr/local/bin", "/usr/bin", "/bin"])].join(":");
    }
  }
  return { command, args, env };
}

function shellQuote(arg: string): string {
  return /^[\w@%+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** A readable one-line form of a command. */
export function formatCommand(argv: readonly string[]): string {
  return argv.map(shellQuote).join(" ");
}

export function describeLaunch(launch: Launch): string {
  return formatCommand(launch.argv);
}
