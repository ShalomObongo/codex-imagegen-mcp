import os from "node:os";
import path from "node:path";
import {
  CHATGPT_CODEX_BASE_URL,
  DEFAULT_ORIGINATOR,
  DEFAULT_REQUEST_TIMEOUT_MS,
  OAUTH_CLIENT_ID,
  OAUTH_ISSUER,
  PACKAGE_NAME,
  VERSION,
} from "./constants.js";
import type { LogLevel } from "./log.js";

export type CredentialSource = "own" | "codex" | "opencode";
export type CredentialMode = "auto" | CredentialSource;

/** Everything the server/CLI needs, resolved once from the environment. */
export interface RuntimeConfig {
  /** Data directory: credentials, history, default image output, logs. */
  home: string;
  authFile: string;
  lockFile: string;
  historyFile: string;
  logFile: string;
  /** Where images are saved when the caller does not pass an output path. */
  outputDir: string;
  /** Backend base, e.g. https://chatgpt.com/backend-api/codex */
  baseUrl: string;
  /** Quota endpoint, e.g. https://chatgpt.com/backend-api/wham/usage */
  usageUrl: string;
  issuer: string;
  clientId: string;
  originator: string;
  userAgent: string;
  credentialMode: CredentialMode;
  codexAuthFile: string;
  opencodeAuthFile: string;
  requestTimeoutMs: number;
  logLevel: LogLevel;
  /** Never try to launch a browser (for headless machines / tests). */
  noBrowser: boolean;
}

export function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function xdgDataHome(env: NodeJS.ProcessEnv): string {
  const fromEnv = env.XDG_DATA_HOME?.trim();
  return fromEnv ? expandHome(fromEnv) : path.join(os.homedir(), ".local", "share");
}

export function defaultHome(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === "win32") {
    const local = env.LOCALAPPDATA?.trim() || path.join(os.homedir(), "AppData", "Local");
    return path.join(local, PACKAGE_NAME);
  }
  return path.join(xdgDataHome(env), PACKAGE_NAME);
}

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME?.trim();
  return fromEnv ? path.resolve(expandHome(fromEnv)) : path.join(os.homedir(), ".codex");
}

export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(xdgDataHome(env), "opencode");
}

/** Derive the quota endpoint from the backend base: …/backend-api/codex -> …/backend-api/wham/usage */
export function deriveUsageUrl(baseUrl: string): string {
  return new URL("../wham/usage", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
}

function parseMode(raw: string | undefined): CredentialMode {
  const v = raw?.trim().toLowerCase();
  if (v === "own" || v === "codex" || v === "opencode" || v === "auto") return v;
  return "auto";
}

function parseLogLevel(raw: string | undefined): LogLevel {
  const v = raw?.trim().toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error" || v === "silent") return v;
  return "info";
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const n = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function truthy(raw: string | undefined): boolean {
  return raw !== undefined && /^(1|true|yes|on)$/i.test(raw.trim());
}

export function buildUserAgent(originator: string): string {
  const sanitize = (s: string) => s.replace(/[^\x20-\x7e]/g, "_");
  return sanitize(
    `${originator}/${VERSION} (${os.type()} ${os.release()}; ${os.arch()}) node/${process.versions.node}`,
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const home = env.CODEX_IMAGEGEN_HOME?.trim()
    ? path.resolve(expandHome(env.CODEX_IMAGEGEN_HOME.trim()))
    : defaultHome(env);
  const baseUrl = (env.CODEX_IMAGEGEN_BASE_URL?.trim() || CHATGPT_CODEX_BASE_URL).replace(/\/+$/, "");
  const originator = env.CODEX_IMAGEGEN_ORIGINATOR?.trim() || DEFAULT_ORIGINATOR;
  return {
    home,
    authFile: path.join(home, "auth.json"),
    lockFile: path.join(home, "auth.lock"),
    historyFile: path.join(home, "history.jsonl"),
    logFile: path.join(home, "server.log"),
    outputDir: env.CODEX_IMAGEGEN_OUTPUT_DIR?.trim()
      ? path.resolve(expandHome(env.CODEX_IMAGEGEN_OUTPUT_DIR.trim()))
      : path.join(home, "images"),
    baseUrl,
    usageUrl: env.CODEX_IMAGEGEN_USAGE_URL?.trim() || deriveUsageUrl(baseUrl),
    issuer: (env.CODEX_IMAGEGEN_AUTH_ISSUER?.trim() || OAUTH_ISSUER).replace(/\/+$/, ""),
    clientId: env.CODEX_IMAGEGEN_CLIENT_ID?.trim() || OAUTH_CLIENT_ID,
    originator,
    userAgent: buildUserAgent(originator),
    credentialMode: parseMode(env.CODEX_IMAGEGEN_CREDENTIALS),
    codexAuthFile: path.join(codexHome(env), "auth.json"),
    opencodeAuthFile: env.CODEX_IMAGEGEN_OPENCODE_AUTH_FILE?.trim()
      ? path.resolve(expandHome(env.CODEX_IMAGEGEN_OPENCODE_AUTH_FILE.trim()))
      : path.join(opencodeDataDir(env), "auth.json"),
    requestTimeoutMs: parsePositiveInt(env.CODEX_IMAGEGEN_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS),
    logLevel: parseLogLevel(env.CODEX_IMAGEGEN_LOG_LEVEL),
    noBrowser: truthy(env.CODEX_IMAGEGEN_NO_BROWSER),
  };
}
