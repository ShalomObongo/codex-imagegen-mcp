import { readJsonFile } from "../util/fs.js";
import { isRecord, num, str } from "../util/http.js";
import { identityFromTokens, jwtExpiryMs, type ChatGptIdentity } from "./jwt.js";

/*
 * Read-only access to ChatGPT sign-ins that other tools already maintain on this machine.
 * We NEVER refresh or write these: refresh tokens are single-use, so refreshing a borrowed token
 * would silently sign the other tool out. When a borrowed access token expires we simply stop
 * using it (the owning tool refreshes it the next time it runs).
 */

export interface BorrowedCredential {
  source: "codex" | "opencode";
  file: string;
  accessToken: string;
  accountId?: string;
  identity: ChatGptIdentity;
  expiresAt?: number;
}

export type BorrowResult = { ok: true; credential: BorrowedCredential } | { ok: false; reason: string; missing: boolean };

async function load(file: string): Promise<{ ok: true; value: unknown } | { ok: false; reason: string; missing: boolean }> {
  try {
    const value = await readJsonFile(file);
    if (value === undefined) return { ok: false, reason: "not signed in (file not found)", missing: true };
    return { ok: true, value };
  } catch (err) {
    return { ok: false, reason: `unreadable (${err instanceof Error ? err.message : String(err)})`, missing: false };
  }
}

/** Codex CLI / Codex desktop app: $CODEX_HOME/auth.json (file credential store only). */
export async function readCodexCredential(file: string): Promise<BorrowResult> {
  const loaded = await load(file);
  if (!loaded.ok) return loaded;
  const raw = loaded.value;
  if (!isRecord(raw)) return { ok: false, reason: "unrecognized format", missing: false };
  const mode = str(raw.auth_mode);
  const tokens = isRecord(raw.tokens) ? raw.tokens : undefined;
  if (mode && mode !== "chatgpt") {
    return { ok: false, reason: `Codex is signed in with "${mode}", not a ChatGPT account`, missing: false };
  }
  if (!tokens) {
    const why = str(raw.OPENAI_API_KEY) ? "Codex is signed in with an API key, not a ChatGPT account" : "no ChatGPT tokens";
    return { ok: false, reason: why, missing: false };
  }
  const accessToken = str(tokens.access_token);
  if (!accessToken) return { ok: false, reason: "no access token", missing: false };
  // Codex only sends auth headers when last_refresh is present; mirror that sanity check.
  if (!str(raw.last_refresh)) return { ok: false, reason: "incomplete sign-in (no last_refresh)", missing: false };
  const idToken = str(tokens.id_token);
  const identity = identityFromTokens(idToken, accessToken);
  const credential: BorrowedCredential = { source: "codex", file, accessToken, identity };
  const accountId = str(tokens.account_id) ?? identity.accountId;
  if (accountId) credential.accountId = accountId;
  const expiresAt = jwtExpiryMs(accessToken);
  if (expiresAt !== undefined) credential.expiresAt = expiresAt;
  return { ok: true, credential };
}

/** opencode "ChatGPT Plus/Pro" OAuth: ~/.local/share/opencode/auth.json -> { openai: { type: "oauth", ... } } */
export async function readOpencodeCredential(file: string): Promise<BorrowResult> {
  const loaded = await load(file);
  if (!loaded.ok) return loaded;
  const raw = loaded.value;
  if (!isRecord(raw)) return { ok: false, reason: "unrecognized format", missing: false };
  const entry = raw.openai;
  if (!isRecord(entry)) return { ok: false, reason: "no OpenAI sign-in (run `opencode auth login` → OpenAI → ChatGPT)", missing: true };
  if (entry.type !== "oauth") return { ok: false, reason: "opencode's OpenAI provider uses an API key, not a ChatGPT sign-in", missing: false };
  const accessToken = str(entry.access);
  if (!accessToken) return { ok: false, reason: "no access token", missing: false };
  const identity = identityFromTokens(undefined, accessToken);
  const credential: BorrowedCredential = { source: "opencode", file, accessToken, identity };
  const accountId = str(entry.accountId) ?? identity.accountId;
  if (accountId) credential.accountId = accountId;
  const expires = num(entry.expires);
  const jwtExp = jwtExpiryMs(accessToken);
  const expiresAt = expires !== undefined && jwtExp !== undefined ? Math.min(expires, jwtExp) : (expires ?? jwtExp);
  if (expiresAt !== undefined) credential.expiresAt = expiresAt;
  return { ok: true, credential };
}
