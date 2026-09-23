import fs from "node:fs/promises";
import { ImagegenError } from "../errors.js";
import { readJsonFile, writeFileAtomic } from "../util/fs.js";
import { isRecord, str } from "../util/http.js";
import { identityFromTokens } from "./jwt.js";

/** Tokens returned by the OpenAI token endpoint. */
export interface TokenSet {
  idToken?: string;
  accessToken: string;
  refreshToken: string;
}

export type LoginMethod = "browser" | "device";

/**
 * On-disk format of our own credentials (`<home>/auth.json`, mode 0600). The `tokens` object uses
 * the same field names as Codex's auth.json so the format is familiar and easy to inspect.
 */
export interface StoredAuth {
  version: 1;
  auth_mode: "chatgpt";
  tokens: {
    id_token?: string;
    access_token: string;
    refresh_token: string;
    /** ChatGPT workspace/account id (from the id_token), sent as `ChatGPT-Account-ID`. */
    account_id?: string;
  };
  /** ISO-8601 time of the last login or refresh. */
  last_refresh: string;
  login_method: LoginMethod;
  created_at: string;
}

export function buildStoredAuth(tokens: TokenSet, method: LoginMethod, now = new Date()): StoredAuth {
  const identity = identityFromTokens(tokens.idToken, tokens.accessToken);
  const stored: StoredAuth = {
    version: 1,
    auth_mode: "chatgpt",
    tokens: {
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
    },
    last_refresh: now.toISOString(),
    login_method: method,
    created_at: now.toISOString(),
  };
  if (tokens.idToken) stored.tokens.id_token = tokens.idToken;
  if (identity.accountId) stored.tokens.account_id = identity.accountId;
  return stored;
}

function corrupt(file: string, why: string): ImagegenError {
  return new ImagegenError(
    "auth_failed",
    `The saved credentials at ${file} are unreadable (${why}). Sign in again to replace them.`,
  );
}

export async function readStoredAuth(file: string): Promise<StoredAuth | undefined> {
  let raw: unknown;
  try {
    raw = await readJsonFile(file);
  } catch (err) {
    throw corrupt(file, err instanceof Error ? err.message : String(err));
  }
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !isRecord(raw.tokens)) throw corrupt(file, "missing tokens");
  const accessToken = str(raw.tokens.access_token);
  const refreshToken = str(raw.tokens.refresh_token);
  if (!accessToken || !refreshToken) throw corrupt(file, "missing access or refresh token");
  const stored: StoredAuth = {
    version: 1,
    auth_mode: "chatgpt",
    tokens: { access_token: accessToken, refresh_token: refreshToken },
    last_refresh: str(raw.last_refresh) ?? new Date(0).toISOString(),
    login_method: raw.login_method === "device" ? "device" : "browser",
    created_at: str(raw.created_at) ?? str(raw.last_refresh) ?? new Date(0).toISOString(),
  };
  const idToken = str(raw.tokens.id_token);
  if (idToken) stored.tokens.id_token = idToken;
  const accountId = str(raw.tokens.account_id) ?? identityFromTokens(idToken, accessToken).accountId;
  if (accountId) stored.tokens.account_id = accountId;
  return stored;
}

export async function writeStoredAuth(file: string, auth: StoredAuth): Promise<void> {
  await writeFileAtomic(file, `${JSON.stringify(auth, null, 2)}\n`, 0o600);
}

/** Delete the credential file. Returns whether a file was removed. */
export async function deleteStoredAuth(file: string): Promise<boolean> {
  try {
    await fs.rm(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}
