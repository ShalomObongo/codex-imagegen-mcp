import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AuthManager, type AuthManagerOptions } from "../../src/auth/manager.js";
import { buildStoredAuth, writeStoredAuth } from "../../src/auth/store.js";
import { loadConfig, type RuntimeConfig } from "../../src/config.js";
import { silentLogger } from "../../src/log.js";
import type { IssuedTokens, MockOpenAI } from "./mock-openai.js";

export async function tempDir(prefix = "imagegen-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Environment that points every path and URL at the temp dir and mock server. */
export function testEnv(root: string, mock: MockOpenAI, extra: Record<string, string> = {}): Record<string, string> {
  return {
    CODEX_IMAGEGEN_HOME: path.join(root, "home"),
    CODEX_IMAGEGEN_BASE_URL: `${mock.url}/backend-api/codex`,
    CODEX_IMAGEGEN_AUTH_ISSUER: mock.url,
    CODEX_IMAGEGEN_CREDENTIALS: "own",
    CODEX_IMAGEGEN_NO_BROWSER: "1",
    CODEX_IMAGEGEN_LOG_LEVEL: "debug",
    CODEX_HOME: path.join(root, "codex"),
    XDG_DATA_HOME: path.join(root, "xdg-data"),
    XDG_CONFIG_HOME: path.join(root, "xdg-config"),
    ...extra,
  };
}

export function testConfig(root: string, mock: MockOpenAI, extra: Record<string, string> = {}): RuntimeConfig {
  return loadConfig({ ...testEnv(root, mock, extra) });
}

export async function seedOwnAuth(config: RuntimeConfig, tokens: IssuedTokens): Promise<void> {
  await writeStoredAuth(
    config.authFile,
    buildStoredAuth({ idToken: tokens.id_token, accessToken: tokens.access_token, refreshToken: tokens.refresh_token }, "browser"),
  );
}

export function authOptions(config: RuntimeConfig, overrides: Partial<AuthManagerOptions> = {}): AuthManagerOptions {
  return {
    mode: config.credentialMode,
    authFile: config.authFile,
    lockFile: config.lockFile,
    codexAuthFile: config.codexAuthFile,
    opencodeAuthFile: config.opencodeAuthFile,
    oauth: { issuer: config.issuer, clientId: config.clientId, userAgent: "test-agent/1.0" },
    originator: "test",
    logger: silentLogger,
    ...overrides,
  };
}

export function manager(config: RuntimeConfig, overrides: Partial<AuthManagerOptions> = {}): AuthManager {
  return new AuthManager(authOptions(config, overrides));
}
