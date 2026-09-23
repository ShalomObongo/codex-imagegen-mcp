import { DEVICE_CODE_TIMEOUT_MS, DEVICE_VERIFICATION_PATH, OAUTH_SCOPES } from "../constants.js";
import { ImagegenError, toImagegenError } from "../errors.js";
import { isRecord, num, readBody, sleep, snippet, str } from "../util/http.js";
import type { TokenSet } from "./store.js";

/*
 * OAuth 2.0 protocol calls against auth.openai.com, mirroring codex-rs/login exactly:
 *  - authorization-code + PKCE (browser) and OpenAI's device-code variant
 *  - refresh (JSON body, no scope) with Codex's error classification
 *  - revocation (RFC 7009 style JSON body)
 */

export interface OAuthClient {
  issuer: string;
  clientId: string;
  fetchImpl?: typeof fetch;
  userAgent?: string;
}

function doFetch(client: OAuthClient): typeof fetch {
  return client.fetchImpl ?? fetch;
}

function uaHeaders(client: OAuthClient): Record<string, string> {
  return client.userAgent ? { "user-agent": client.userAgent } : {};
}

export interface AuthorizeUrlParams {
  issuer: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
  originator: string;
  scopes?: string;
}

/** Build the /oauth/authorize URL with the same parameters (and order) Codex sends. */
export function buildAuthorizeUrl(p: AuthorizeUrlParams): string {
  const q = new URLSearchParams();
  q.set("response_type", "code");
  q.set("client_id", p.clientId);
  q.set("redirect_uri", p.redirectUri);
  q.set("scope", p.scopes ?? OAUTH_SCOPES);
  q.set("code_challenge", p.codeChallenge);
  q.set("code_challenge_method", "S256");
  q.set("id_token_add_organizations", "true");
  q.set("codex_cli_simplified_flow", "true");
  q.set("state", p.state);
  q.set("originator", p.originator);
  // URLSearchParams encodes spaces as '+'; Codex (and RFC 3986 style) uses %20.
  return `${p.issuer}/oauth/authorize?${q.toString().replace(/\+/g, "%20")}`;
}

/** Extract a readable message from an OAuth error body. */
export function describeOAuthError(json: unknown, text: string): string {
  if (isRecord(json)) {
    const desc = str(json.error_description);
    if (desc) return desc;
    if (isRecord(json.error)) {
      const m = str(json.error.message) ?? str(json.error.code);
      if (m) return m;
    }
    const e = str(json.error) ?? str(json.message) ?? str(json.detail);
    if (e) return e;
  }
  return snippet(text) || "no details";
}

/** OAuth error code: `error.code` (object form), then `error` (string form), then top-level `code`. */
export function oauthErrorCode(json: unknown): string | undefined {
  if (!isRecord(json)) return undefined;
  if (isRecord(json.error)) return str(json.error.code);
  return str(json.error) ?? str(json.code);
}

function parseTokenResponse(json: unknown): { idToken?: string; accessToken?: string; refreshToken?: string } {
  if (!isRecord(json)) return {};
  const out: { idToken?: string; accessToken?: string; refreshToken?: string } = {};
  const id = str(json.id_token);
  if (id) out.idToken = id;
  const access = str(json.access_token);
  if (access) out.accessToken = access;
  const refresh = str(json.refresh_token);
  if (refresh) out.refreshToken = refresh;
  return out;
}

export interface CodeExchange {
  code: string;
  redirectUri: string;
  codeVerifier: string;
  signal?: AbortSignal;
}

/** Exchange an authorization code for tokens (form-encoded, as Codex does). */
export async function exchangeAuthorizationCode(client: OAuthClient, p: CodeExchange): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: p.code,
    redirect_uri: p.redirectUri,
    client_id: client.clientId,
    code_verifier: p.codeVerifier,
  });
  let res: Response;
  try {
    res = await doFetch(client)(`${client.issuer}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...uaHeaders(client) },
      body: body.toString(),
      signal: p.signal ?? AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw toImagegenError(err, "network");
  }
  const { json, text } = await readBody(res);
  if (!res.ok) {
    throw new ImagegenError("login_failed", `Token exchange failed (HTTP ${res.status}): ${describeOAuthError(json, text)}`, {
      details: { status: res.status, code: oauthErrorCode(json) },
    });
  }
  const tokens = parseTokenResponse(json);
  if (!tokens.accessToken || !tokens.refreshToken) {
    throw new ImagegenError("login_failed", "Token exchange succeeded but the response is missing tokens.");
  }
  const out: TokenSet = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  if (tokens.idToken) out.idToken = tokens.idToken;
  return out;
}

const PERMANENT_REFRESH_MESSAGES: Record<string, string> = {
  refresh_token_expired: "Your sign-in has expired.",
  refresh_token_reused:
    "Your sign-in was invalidated because its refresh token was already used (another process or machine refreshed it first).",
  refresh_token_invalidated: "Your sign-in was revoked.",
};

export interface RefreshOptions {
  refreshToken: string;
  originator?: string;
  signal?: AbortSignal;
}

/**
 * Refresh tokens. OpenAI rotates refresh tokens (they are single-use), so callers MUST persist the
 * returned refresh token and serialize refreshes across processes.
 * Throws `session_expired` for permanent failures and a retryable error otherwise.
 */
export async function refreshAccessToken(client: OAuthClient, p: RefreshOptions): Promise<Partial<TokenSet>> {
  let res: Response;
  try {
    res = await doFetch(client)(`${client.issuer}/oauth/token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...uaHeaders(client),
        ...(p.originator ? { originator: p.originator } : {}),
      },
      body: JSON.stringify({ client_id: client.clientId, grant_type: "refresh_token", refresh_token: p.refreshToken }),
      signal: p.signal ?? AbortSignal.timeout(60_000),
    });
  } catch (err) {
    throw toImagegenError(err, "network");
  }
  const { json, text } = await readBody(res);
  if (!res.ok) {
    const code = oauthErrorCode(json);
    const known = code ? PERMANENT_REFRESH_MESSAGES[code] : undefined;
    const permanent = known !== undefined || res.status === 401 || (res.status === 400 && code === "invalid_grant");
    if (permanent) {
      throw new ImagegenError("session_expired", `${known ?? `Refreshing your sign-in failed (HTTP ${res.status}: ${describeOAuthError(json, text)}).`} Please sign in again.`, {
        details: { status: res.status, code, permanent: true },
      });
    }
    throw new ImagegenError("server_error", `Token refresh failed (HTTP ${res.status}): ${describeOAuthError(json, text)}`, {
      details: { status: res.status, code },
      retryable: true,
    });
  }
  const tokens = parseTokenResponse(json);
  if (!tokens.accessToken) throw new ImagegenError("server_error", "Token refresh response did not include an access token.", { retryable: true });
  return tokens;
}

/** Revoke a token (best effort). Returns whether the server acknowledged it. */
export async function revokeToken(
  client: OAuthClient,
  token: string,
  hint: "refresh_token" | "access_token",
): Promise<boolean> {
  try {
    const body: Record<string, string> = { token, token_type_hint: hint };
    if (hint === "refresh_token") body.client_id = client.clientId;
    const res = await doFetch(client)(`${client.issuer}/oauth/revoke`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...uaHeaders(client) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Device code (OpenAI variant): usercode -> user approves at /codex/device -> poll token endpoint,
// which returns an authorization code plus a server-generated PKCE pair -> normal code exchange.
// ------------------------------------------------------------------------------------------------

export interface DeviceCode {
  deviceAuthId: string;
  userCode: string;
  intervalMs: number;
  verificationUrl: string;
  expiresAt: number;
}

export async function requestDeviceCode(client: OAuthClient, signal?: AbortSignal): Promise<DeviceCode> {
  let res: Response;
  try {
    res = await doFetch(client)(`${client.issuer}/api/accounts/deviceauth/usercode`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...uaHeaders(client) },
      body: JSON.stringify({ client_id: client.clientId }),
      signal: signal ?? AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw toImagegenError(err, "network");
  }
  const { json, text } = await readBody(res);
  if (res.status === 404) {
    throw new ImagegenError(
      "login_failed",
      "Device-code sign-in is not enabled for this account. Enable it in ChatGPT → Settings → Security (device code authorization for Codex), or use the browser sign-in instead.",
      { details: { status: 404 } },
    );
  }
  if (!res.ok || !isRecord(json)) {
    throw new ImagegenError("login_failed", `Could not start device-code sign-in (HTTP ${res.status}): ${describeOAuthError(json, text)}`, {
      details: { status: res.status },
    });
  }
  const deviceAuthId = str(json.device_auth_id);
  const userCode = str(json.user_code) ?? str(json.usercode);
  if (!deviceAuthId || !userCode) throw new ImagegenError("login_failed", "Device-code response is missing the device id or user code.");
  const intervalSeconds = num(json.interval) ?? 5;
  return {
    deviceAuthId,
    userCode,
    intervalMs: Math.max(1, intervalSeconds) * 1000,
    verificationUrl: `${client.issuer}${DEVICE_VERIFICATION_PATH}`,
    expiresAt: Date.now() + DEVICE_CODE_TIMEOUT_MS,
  };
}

export interface DeviceAuthorization {
  authorizationCode: string;
  codeVerifier: string;
}

/** Poll until the user approves (403/404 = still pending). */
export async function pollDeviceAuthorization(
  client: OAuthClient,
  device: DeviceCode,
  signal?: AbortSignal,
): Promise<DeviceAuthorization> {
  for (;;) {
    if (Date.now() > device.expiresAt) {
      throw new ImagegenError("login_failed", "Device-code sign-in timed out after 15 minutes. Start again.");
    }
    let res: Response;
    try {
      res = await doFetch(client)(`${client.issuer}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json", ...uaHeaders(client) },
        body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
        signal: signal ?? AbortSignal.timeout(30_000),
      });
    } catch (err) {
      const e = toImagegenError(err, "network");
      if (e.kind === "cancelled") throw new ImagegenError("login_cancelled", "Device-code sign-in was cancelled.");
      // Transient network trouble while polling: keep going until the code expires.
      await sleep(device.intervalMs, signal);
      continue;
    }
    const { json, text } = await readBody(res);
    if (res.ok && isRecord(json)) {
      const authorizationCode = str(json.authorization_code);
      const codeVerifier = str(json.code_verifier);
      if (!authorizationCode || !codeVerifier) throw new ImagegenError("login_failed", "Device authorization response is missing the authorization code.");
      return { authorizationCode, codeVerifier };
    }
    if (res.status === 403 || res.status === 404) {
      await sleep(Math.min(device.intervalMs, Math.max(0, device.expiresAt - Date.now())), signal);
      continue;
    }
    throw new ImagegenError("login_failed", `Device-code sign-in failed (HTTP ${res.status}): ${describeOAuthError(json, text)}`, {
      details: { status: res.status },
    });
  }
}

export function deviceRedirectUri(issuer: string): string {
  return `${issuer}/deviceauth/callback`;
}
