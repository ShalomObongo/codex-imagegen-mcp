import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { encodePng } from "../../src/images/codec.js";

export interface RecordedRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
  json?: any;
  form?: URLSearchParams;
}

export interface IssuedTokens {
  id_token: string;
  access_token: string;
  refresh_token: string;
}

export interface TokenOptions {
  email?: string;
  plan?: string;
  accountId?: string;
  /** Access token lifetime in seconds (negative = already expired). */
  expiresIn?: number;
}

export type ScriptedResponse = { status: number; body?: unknown; headers?: Record<string, string>; raw?: string };

export interface MockState {
  requests: RecordedRequest[];
  validAccessTokens: Set<string>;
  /** refresh token -> whether it was already used (rotation). */
  refreshTokens: Map<string, { used: boolean; options: TokenOptions }>;
  /** authorization code -> expected PKCE challenge + redirect uri */
  authCodes: Map<string, { challenge: string; redirectUri: string; options?: TokenOptions }>;
  /** Scripted responses for the image endpoints, consumed first-in-first-out. */
  imageQueue: ScriptedResponse[];
  imageDelayMs: number;
  /** "reused" / "server_error" make the next refresh fail. */
  refreshFailure?: "reused" | "server_error" | undefined;
  refreshDelayMs: number;
  devicePendingPolls: number;
  deviceUsercodeStatus: number;
  usage: unknown;
}

function b64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

let seq = 0;

/** Unsigned JWT with the claims OpenAI puts in ChatGPT tokens. */
export function makeJwt(claims: Record<string, unknown>): string {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(claims)}.${Buffer.from("sig").toString("base64url")}`;
}

export function makeTokens(o: TokenOptions = {}): IssuedTokens {
  seq += 1;
  const now = Math.floor(Date.now() / 1000);
  const auth = {
    chatgpt_plan_type: o.plan ?? "plus",
    chatgpt_account_id: o.accountId ?? "acct-123456",
    chatgpt_user_id: "user-1",
  };
  return {
    id_token: makeJwt({ email: o.email ?? "tester@example.com", "https://api.openai.com/auth": auth, iat: now, exp: now + 3600 }),
    access_token: makeJwt({ "https://api.openai.com/auth": auth, iat: now, exp: now + (o.expiresIn ?? 3600), jti: `at-${seq}` }),
    refresh_token: `rt-${seq}-${Math.random().toString(36).slice(2)}`,
  };
}

export function testPng(width = 64, height = 48, transparent = false): Buffer {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inside = x > width / 4 && x < (3 * width) / 4 && y > height / 4 && y < (3 * height) / 4;
      data[i] = inside ? 220 : 30;
      data[i + 1] = inside ? 40 : 90;
      data[i + 2] = inside ? 40 : 200;
      data[i + 3] = transparent && !inside ? 0 : 255;
    }
  }
  return encodePng({ width, height, data });
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export interface MockOpenAI {
  url: string;
  state: MockState;
  /** Issue tokens the mock will accept. */
  issue(options?: TokenOptions): IssuedTokens;
  requestsTo(path: string): RecordedRequest[];
  close(): Promise<void>;
}

export async function startMockOpenAI(): Promise<MockOpenAI> {
  const state: MockState = {
    requests: [],
    validAccessTokens: new Set(),
    refreshTokens: new Map(),
    authCodes: new Map(),
    imageQueue: [],
    imageDelayMs: 0,
    refreshDelayMs: 0,
    devicePendingPolls: 2,
    deviceUsercodeStatus: 200,
    usage: {
      plan_type: "plus",
      rate_limit: {
        allowed: true,
        limit_reached: false,
        primary_window: { used_percent: 7, limit_window_seconds: 18000, reset_after_seconds: 3600, reset_at: Math.floor(Date.now() / 1000) + 3600 },
        secondary_window: { used_percent: 3, limit_window_seconds: 604800, reset_after_seconds: 86400, reset_at: Math.floor(Date.now() / 1000) + 86400 },
      },
      additional_rate_limits: null,
      credits: { has_credits: false, unlimited: false, balance: "0" },
    },
  };

  const issue = (options: TokenOptions = {}): IssuedTokens => {
    const t = makeTokens(options);
    state.validAccessTokens.add(t.access_token);
    state.refreshTokens.set(t.refresh_token, { used: false, options });
    return t;
  };

  const server = http.createServer(async (req, res) => {
    const body = await readBody(req);
    const url = new URL(req.url ?? "/", "http://mock");
    const record: RecordedRequest = { method: req.method ?? "GET", path: url.pathname, headers: req.headers, body };
    const ctype = String(req.headers["content-type"] ?? "");
    if (ctype.includes("application/json") && body) {
      try {
        record.json = JSON.parse(body);
      } catch {
        /* keep raw */
      }
    }
    if (ctype.includes("application/x-www-form-urlencoded")) record.form = new URLSearchParams(body);
    state.requests.push(record);

    const send = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
      const text = typeof payload === "string" ? payload : JSON.stringify(payload);
      res.writeHead(status, { "content-type": typeof payload === "string" ? "text/html" : "application/json", ...headers });
      res.end(text);
    };
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer /, "");

    // ---------------------------------------------------------------- OAuth
    if (url.pathname === "/oauth/token" && record.form?.get("grant_type") === "authorization_code") {
      const code = record.form.get("code") ?? "";
      const expected = state.authCodes.get(code);
      const verifier = record.form.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (!expected || expected.challenge !== challenge || expected.redirectUri !== record.form.get("redirect_uri")) {
        return send(400, { error: "invalid_grant", error_description: "bad code, verifier or redirect_uri" });
      }
      state.authCodes.delete(code);
      return send(200, issue(expected.options));
    }
    if (url.pathname === "/oauth/token" && record.json?.grant_type === "refresh_token") {
      if (state.refreshDelayMs) await new Promise((r) => setTimeout(r, state.refreshDelayMs));
      if (state.refreshFailure === "server_error") return send(502, { error: { message: "upstream" } });
      const entry = state.refreshTokens.get(record.json.refresh_token);
      if (state.refreshFailure === "reused" || !entry || entry.used) {
        return send(401, { error: { code: "refresh_token_reused", message: "Your refresh token has already been used." } });
      }
      entry.used = true;
      // A refreshed token gets a normal lifetime (the original may have been issued nearly expired).
      return send(200, issue({ ...entry.options, expiresIn: 3600 }));
    }
    if (url.pathname === "/oauth/revoke") return send(200, {});
    if (url.pathname === "/api/accounts/deviceauth/usercode") {
      if (state.deviceUsercodeStatus !== 200) return send(state.deviceUsercodeStatus, { error: "not_found" });
      return send(200, { device_auth_id: "dev-1", user_code: "ABCD-1234", interval: "0" });
    }
    if (url.pathname === "/api/accounts/deviceauth/token") {
      if (state.devicePendingPolls > 0) {
        state.devicePendingPolls -= 1;
        return send(403, { error: "authorization_pending" });
      }
      const verifier = "device-verifier-123";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      state.authCodes.set("device-code-1", { challenge, redirectUri: `${baseUrl}/deviceauth/callback` });
      return send(200, { authorization_code: "device-code-1", code_challenge: challenge, code_verifier: verifier });
    }

    // -------------------------------------------------------------- backend
    const isImages = url.pathname === "/backend-api/codex/images/generations" || url.pathname === "/backend-api/codex/images/edits";
    if (isImages || url.pathname === "/backend-api/wham/usage") {
      if (!state.validAccessTokens.has(bearer)) return send(401, { detail: "Could not parse your authentication token." });
    }
    if (url.pathname === "/backend-api/wham/usage") return send(200, state.usage);
    if (isImages) {
      if (state.imageDelayMs) await new Promise((r) => setTimeout(r, state.imageDelayMs));
      const scripted = state.imageQueue.shift();
      if (scripted) {
        if (scripted.raw !== undefined) {
          res.writeHead(scripted.status, { "content-type": "text/html", ...scripted.headers });
          return res.end(scripted.raw);
        }
        return send(scripted.status, scripted.body ?? {}, scripted.headers);
      }
      const transparent = record.json?.background === "transparent";
      return send(
        200,
        {
          created: Math.floor(Date.now() / 1000),
          background: transparent ? "transparent" : "opaque",
          data: [{ b64_json: testPng(64, 48, transparent).toString("base64"), generation_id: `gen-${state.requests.length}` }],
          output_format: "png",
          quality: "medium",
          size: "1536x1024",
          usage: { input_tokens: 10, output_tokens: 600, total_tokens: 610 },
        },
        {
          "x-codex-imagegen-request-id": `req-${state.requests.length}`,
          "x-codex-plan-type": "plus",
          "x-codex-primary-used-percent": "7",
          "x-codex-primary-window-minutes": "300",
          "x-codex-primary-reset-at": String(Math.floor(Date.now() / 1000) + 3600),
        },
      );
    }
    return send(404, { error: "not found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: baseUrl,
    state,
    issue,
    requestsTo: (p) => state.requests.filter((r) => r.path === p),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
