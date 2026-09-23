import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { startBrowserLogin } from "../src/auth/browser-login.js";
import { startDeviceLogin } from "../src/auth/device-login.js";
import { ImagegenError } from "../src/errors.js";
import { startMockOpenAI, type MockOpenAI } from "./helpers/mock-openai.js";

let mock: MockOpenAI;
before(async () => {
  mock = await startMockOpenAI();
});
after(async () => {
  await mock.close();
});

const client = () => ({ issuer: mock.url, clientId: "app_test", userAgent: "test/1.0" });

/** The callback server binds 127.0.0.1; the redirect URI says localhost (as Codex's does). */
const loopback = (uri: string) => uri.replace("://localhost:", "://127.0.0.1:");

describe("browser sign-in (authorization code + PKCE)", () => {
  test("completes the round-trip and rejects a mismatched state without aborting", async () => {
    const login = await startBrowserLogin({ ...client(), originator: "test-originator", ports: [0] });
    const authorize = new URL(login.url);
    assert.equal(`${authorize.origin}${authorize.pathname}`, `${mock.url}/oauth/authorize`);
    assert.equal(authorize.searchParams.get("redirect_uri"), login.redirectUri);
    assert.match(login.redirectUri, /^http:\/\/localhost:\d+\/auth\/callback$/);
    assert.equal(authorize.searchParams.get("originator"), "test-originator");
    const state = authorize.searchParams.get("state") ?? "";
    mock.state.authCodes.set("code-1", { challenge: authorize.searchParams.get("code_challenge") ?? "", redirectUri: login.redirectUri, options: { email: "browser@example.com" } });

    const bad = await fetch(`${loopback(login.redirectUri)}?code=code-1&state=wrong`);
    assert.equal(bad.status, 400);

    const ok = await fetch(`${loopback(login.redirectUri)}?code=code-1&state=${encodeURIComponent(state)}`, { redirect: "manual" });
    assert.equal(ok.status, 302);
    assert.match(ok.headers.get("location") ?? "", /^\/success\?email=browser%40example\.com/);
    const tokens = await login.result;
    assert.ok(tokens.accessToken && tokens.refreshToken && tokens.idToken);

    const exchange = mock.requestsTo("/oauth/token").at(-1);
    assert.equal(exchange?.form?.get("grant_type"), "authorization_code");
    assert.equal(exchange?.form?.get("client_id"), "app_test");

    const success = await fetch(`${loopback(login.redirectUri.replace("/auth/callback", "/success"))}?email=browser%40example.com`);
    assert.match(await success.text(), /browser@example\.com/);
  });

  test("an authorize error is surfaced with a friendly message", async () => {
    const login = await startBrowserLogin({ ...client(), originator: "t", ports: [0] });
    const state = new URL(login.url).searchParams.get("state") ?? "";
    const res = await fetch(`${loopback(login.redirectUri)}?error=access_denied&error_description=missing_codex_entitlement&state=${encodeURIComponent(state)}`);
    assert.match(await res.text(), /not enabled/);
    await assert.rejects(login.result, (e: unknown) => e instanceof ImagegenError && e.kind === "login_failed" && /Codex is not enabled/.test(e.message));
  });

  test("a failed code exchange fails the login", async () => {
    const login = await startBrowserLogin({ ...client(), originator: "t", ports: [0] });
    const state = new URL(login.url).searchParams.get("state") ?? "";
    await fetch(`${loopback(login.redirectUri)}?code=unknown-code&state=${encodeURIComponent(state)}`);
    await assert.rejects(login.result, /Token exchange failed \(HTTP 400\)/);
  });

  test("cancel() and /cancel stop the login", async () => {
    const a = await startBrowserLogin({ ...client(), originator: "t", ports: [0] });
    a.cancel();
    await assert.rejects(a.result, (e: unknown) => e instanceof ImagegenError && e.kind === "login_cancelled");
    const b = await startBrowserLogin({ ...client(), originator: "t", ports: [0] });
    await fetch(loopback(b.redirectUri.replace("/auth/callback", "/cancel")));
    await assert.rejects(b.result, /cancelled/);
  });

  test("times out", async () => {
    const login = await startBrowserLogin({ ...client(), originator: "t", ports: [0], timeoutMs: 50 });
    await assert.rejects(login.result, /Timed out/);
  });
});

describe("device-code sign-in", () => {
  test("polls through pending responses and exchanges with the device redirect URI", async () => {
    mock.state.devicePendingPolls = 2;
    const login = await startDeviceLogin(client());
    assert.equal(login.userCode, "ABCD-1234");
    assert.equal(login.verificationUrl, `${mock.url}/codex/device`);
    const tokens = await login.result;
    assert.ok(tokens.accessToken);
    assert.equal(mock.requestsTo("/api/accounts/deviceauth/token").length, 3);
    const exchange = mock.requestsTo("/oauth/token").at(-1);
    assert.equal(exchange?.form?.get("redirect_uri"), `${mock.url}/deviceauth/callback`);
    assert.equal(exchange?.form?.get("code_verifier"), "device-verifier-123");
  });

  test("404 on usercode explains how to enable device codes", async () => {
    mock.state.deviceUsercodeStatus = 404;
    try {
      await assert.rejects(startDeviceLogin(client()), /Settings → Security/);
    } finally {
      mock.state.deviceUsercodeStatus = 200;
    }
  });
});
