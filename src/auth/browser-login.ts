import http from "node:http";
import type { AddressInfo } from "node:net";
import { BROWSER_LOGIN_TIMEOUT_MS, OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORTS } from "../constants.js";
import { ImagegenError, toImagegenError } from "../errors.js";
import { sleep } from "../util/http.js";
import { identityFromTokens } from "./jwt.js";
import { buildAuthorizeUrl, exchangeAuthorizationCode, type OAuthClient } from "./oauth.js";
import { errorPage, successPage } from "./pages.js";
import { createPkce, createState } from "./pkce.js";
import type { TokenSet } from "./store.js";

export interface BrowserLoginOptions extends OAuthClient {
  originator: string;
  /** Candidate callback ports. Must stay 1455/1457 for the real issuer (allow-listed redirect URIs). */
  ports?: readonly number[];
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface BrowserLogin {
  /** URL the user must open to sign in. */
  url: string;
  redirectUri: string;
  port: number;
  /** Resolves with tokens once the browser round-trip completes. */
  result: Promise<TokenSet>;
  cancel(): void;
}

function listenOnce(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      server.off("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

/** Ask a stale login server (ours or Codex's) on this port to shut down, like Codex does. */
async function requestCancel(port: number): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${port}/cancel`, { signal: AbortSignal.timeout(2_000) });
  } catch {
    /* nothing listening that understands /cancel */
  }
}

async function bindCallbackServer(server: http.Server, ports: readonly number[]): Promise<number> {
  for (const [index, port] of ports.entries()) {
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await listenOnce(server, port);
        return (server.address() as AddressInfo).port;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
        if (index === 0 && attempt === 0) await requestCancel(port);
        await sleep(200);
      }
    }
  }
  throw new ImagegenError(
    "login_failed",
    `Could not start the local sign-in callback server: port${ports.length > 1 ? "s" : ""} ${ports.join(" and ")} ${ports.length > 1 ? "are" : "is"} busy. ` +
      "Another Codex/opencode sign-in may be in progress — finish or close it, or use device-code sign-in instead.",
  );
}

function friendlyAuthorizeError(error: string, description: string): string {
  if (error === "access_denied" && description.includes("missing_codex_entitlement")) {
    return "Codex is not enabled for your ChatGPT workspace. Ask your workspace admin to enable Codex, then try again.";
  }
  if (error === "access_denied") return `Sign-in was denied${description ? `: ${description}` : "."}`;
  return `Sign-in failed: ${error}${description ? ` — ${description}` : ""}`;
}

/**
 * Start the browser (authorization code + PKCE) flow. Binds the loopback callback server first so
 * the returned URL is immediately usable; the caller decides how to show/open it.
 */
export async function startBrowserLogin(options: BrowserLoginOptions): Promise<BrowserLogin> {
  const pkce = createPkce();
  const state = createState();
  const sockets = new Set<import("node:net").Socket>();
  let resolveResult!: (t: TokenSet) => void;
  let rejectResult!: (e: unknown) => void;
  const result = new Promise<TokenSet>((resolve, reject) => {
    resolveResult = resolve;
    rejectResult = reject;
  });
  // Avoid unhandled-rejection noise if the caller never awaits (e.g. cancelled in the background).
  result.catch(() => undefined);

  let settled = false;
  let timer: NodeJS.Timeout | undefined;
  let redirectUri = "";
  let port = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);
    const html = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", connection: "close" });
      res.end(body);
    };
    if (url.pathname === OAUTH_CALLBACK_PATH) {
      if (settled) {
        html(200, errorPage("This sign-in attempt already finished. You can close this tab."));
        return;
      }
      const q = url.searchParams;
      if (q.get("state") !== state) {
        // Possibly a stale tab from an earlier attempt: reject it but keep waiting.
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8", connection: "close" });
        res.end("State mismatch");
        return;
      }
      const error = q.get("error");
      if (error) {
        const message = friendlyAuthorizeError(error, q.get("error_description") ?? "");
        html(200, errorPage(message));
        finish(new ImagegenError("login_failed", message, { details: { error } }));
        return;
      }
      const code = q.get("code");
      if (!code) {
        html(200, errorPage("The authorization code is missing from the callback."));
        finish(new ImagegenError("login_failed", "The authorization code is missing from the callback."));
        return;
      }
      exchangeAuthorizationCode(options, { code, redirectUri, codeVerifier: pkce.verifier }).then(
        (tokens) => {
          const email = identityFromTokens(tokens.idToken, tokens.accessToken).email ?? "";
          res.writeHead(302, { location: `/success?email=${encodeURIComponent(email)}`, connection: "close" });
          res.end();
          finish(undefined, tokens);
        },
        (err: unknown) => {
          const e = toImagegenError(err, "login_failed");
          html(200, errorPage(e.message));
          finish(e);
        },
      );
      return;
    }
    if (url.pathname === "/success") {
      html(200, successPage(url.searchParams.get("email") || undefined));
      return;
    }
    if (url.pathname === "/cancel") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", connection: "close" });
      res.end("Login cancelled");
      finish(new ImagegenError("login_cancelled", "Sign-in was cancelled (a newer sign-in attempt took over the callback port)."));
      return;
    }
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", connection: "close" });
    res.end("Not found");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const shutdown = () => {
    server.close();
    for (const s of sockets) s.destroy();
  };

  function finish(err?: unknown, tokens?: TokenSet) {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
    // Keep serving briefly so the browser can load /success after the redirect.
    setTimeout(shutdown, 1_500).unref();
    if (err) rejectResult(err);
    else resolveResult(tokens as TokenSet);
  }
  const onAbort = () => finish(new ImagegenError("login_cancelled", "Sign-in was cancelled."));

  port = await bindCallbackServer(server, options.ports ?? OAUTH_CALLBACK_PORTS);
  redirectUri = `http://localhost:${port}${OAUTH_CALLBACK_PATH}`;
  const timeoutMs = options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS;
  timer = setTimeout(
    () => finish(new ImagegenError("login_failed", `Timed out after ${Math.round(timeoutMs / 60_000)} minutes waiting for the browser sign-in.`)),
    timeoutMs,
  );
  timer.unref();
  if (options.signal?.aborted) onAbort();
  else options.signal?.addEventListener("abort", onAbort, { once: true });

  const url = buildAuthorizeUrl({
    issuer: options.issuer,
    clientId: options.clientId,
    redirectUri,
    codeChallenge: pkce.challenge,
    state,
    originator: options.originator,
  });
  return { url, redirectUri, port, result, cancel: onAbort };
}
