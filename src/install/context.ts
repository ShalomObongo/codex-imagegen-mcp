import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type Scope = "global" | "project";

/** `path.posix` or `path.win32`. */
export type PathApi = typeof path.posix;

/**
 * Everything the installer's path logic depends on. Paths are computed from this object, never
 * from process globals, so the same tests can model macOS, Linux and Windows machines.
 */
export interface InstallContext {
  platform: NodeJS.Platform;
  /** The user's home directory. */
  home: string;
  /** Project directory for project-scoped installs. */
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export function currentContext(): InstallContext {
  return { platform: process.platform, home: os.homedir(), cwd: process.cwd(), env: process.env };
}

export function pathApi(ctx: Pick<InstallContext, "platform">): PathApi {
  return ctx.platform === "win32" ? path.win32 : path.posix;
}

/** An absolute directory from an environment variable. Relative values are ignored, as XDG requires. */
export function envDir(ctx: InstallContext, name: string): string | undefined {
  const raw = ctx.env[name]?.trim();
  if (!raw) return undefined;
  const p = pathApi(ctx);
  if (raw === "~") return ctx.home;
  if (raw.startsWith("~/") || raw.startsWith("~\\")) return p.join(ctx.home, raw.slice(2));
  return p.isAbsolute(raw) ? p.normalize(raw) : undefined;
}

export interface Locations {
  p: PathApi;
  home: (...parts: string[]) => string;
  project: (...parts: string[]) => string;
  /** `$XDG_CONFIG_HOME` or `~/.config`. Tools built on xdg-basedir (opencode, Kilo, Amp) use it on Windows too. */
  xdgConfig: string;
  /** Windows `%APPDATA%` (roaming). */
  roaming: string;
  /** Windows `%LOCALAPPDATA%`. */
  local: string;
  /** Per-user data dir of a desktop app: `~/Library/Application Support/<name>`, `%APPDATA%\<name>` or `$XDG_CONFIG_HOME/<name>`. */
  appData: (name: string) => string;
}

export function locations(ctx: InstallContext): Locations {
  const p = pathApi(ctx);
  const home = (...parts: string[]) => p.join(ctx.home, ...parts);
  const xdgConfig = envDir(ctx, "XDG_CONFIG_HOME") ?? home(".config");
  const roaming = envDir(ctx, "APPDATA") ?? home("AppData", "Roaming");
  const local = envDir(ctx, "LOCALAPPDATA") ?? home("AppData", "Local");
  const appData = (name: string) =>
    ctx.platform === "darwin"
      ? home("Library", "Application Support", name)
      : ctx.platform === "win32"
        ? p.join(roaming, name)
        : p.join(xdgConfig, name);
  return { p, home, project: (...parts: string[]) => p.join(ctx.cwd, ...parts), xdgConfig, roaming, local, appData };
}

/** Directories on PATH, in order. */
export function pathDirs(ctx: InstallContext): string[] {
  const raw = ctx.env.PATH ?? ctx.env.Path ?? "";
  return raw.split(ctx.platform === "win32" ? ";" : ":").filter(Boolean);
}

/** Find an executable on PATH (honouring PATHEXT on Windows), like `which`. */
export function which(ctx: InstallContext, name: string): string | undefined {
  const p = pathApi(ctx);
  const exts =
    ctx.platform === "win32" && !/\.[a-z0-9]+$/i.test(name)
      ? (ctx.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
      : [""];
  for (const dir of pathDirs(ctx)) {
    for (const ext of exts) {
      const candidate = p.join(dir, name + ext.toLowerCase());
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        /* keep looking */
      }
    }
  }
  return undefined;
}

export function realpathOr(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

/** `~`-relative form of a path for display. */
export function tildify(file: string, ctx: Pick<InstallContext, "home" | "platform">): string {
  const p = pathApi(ctx);
  const rel = p.relative(ctx.home, file);
  if (!rel) return "~";
  if (rel.startsWith("..") || p.isAbsolute(rel)) return file;
  return `~${p.sep}${rel}`;
}
