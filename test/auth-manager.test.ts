import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { readStoredAuth } from "../src/auth/store.js";
import { ImagegenError } from "../src/errors.js";
import { manager, seedOwnAuth, tempDir, testConfig } from "./helpers/env.js";
import { makeTokens, startMockOpenAI, type MockOpenAI } from "./helpers/mock-openai.js";

let mock: MockOpenAI;
before(async () => {
  mock = await startMockOpenAI();
});
after(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.refreshFailure = undefined;
  mock.state.refreshDelayMs = 0;
});

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

describe("own credentials", () => {
  test("a valid token is used without refreshing", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock);
    const t = mock.issue();
    await seedOwnAuth(config, t);
    const creds = await manager(config).getCredentials();
    assert.equal(creds.source, "own");
    assert.equal(creds.accessToken, t.access_token);
    assert.equal(creds.accountId, "acct-123456");
    assert.equal(mock.requestsTo("/oauth/token").length, 0);
  });

  test("an expiring token is refreshed (JSON body, no scope) and the rotated refresh token is persisted", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock);
    const t = mock.issue({ expiresIn: 60 });
    await seedOwnAuth(config, t);
    const creds = await manager(config).getCredentials();
    assert.notEqual(creds.accessToken, t.access_token);
    const [refresh] = mock.requestsTo("/oauth/token");
    assert.ok(refresh);
    assert.deepEqual(Object.keys(refresh.json).sort(), ["client_id", "grant_type", "refresh_token"]);
    assert.equal(refresh.json.grant_type, "refresh_token");
    assert.equal(refresh.json.refresh_token, t.refresh_token);
    const stored = await readStoredAuth(config.authFile);
    assert.ok(stored);
    assert.equal(stored.tokens.access_token, creds.accessToken);
    assert.notEqual(stored.tokens.refresh_token, t.refresh_token);
  });

  test("concurrent processes refresh exactly once (lock + re-read), never reusing the refresh token", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock);
    await seedOwnAuth(config, mock.issue({ expiresIn: 30 }));
    mock.state.refreshDelayMs = 150;
    const results = await Promise.all([manager(config), manager(config), manager(config)].map((m) => m.getCredentials()));
    assert.equal(mock.requestsTo("/oauth/token").length, 1);
    assert.equal(new Set(results.map((r) => r.accessToken)).size, 1);
  });

  test("a permanent refresh failure becomes session_expired with a login hint", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock);
    await seedOwnAuth(config, mock.issue({ expiresIn: -10 }));
    mock.state.refreshFailure = "reused";
    await assert.rejects(manager(config).getCredentials(), (e: unknown) => {
      assert.ok(e instanceof ImagegenError);
      assert.equal(e.kind, "session_expired");
      assert.match(e.message, /already used/);
      assert.match(e.message, /login/);
      return true;
    });
  });

  test("a transient refresh failure keeps using a still-valid token", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock);
    const t = mock.issue({ expiresIn: 120 });
    await seedOwnAuth(config, t);
    mock.state.refreshFailure = "server_error";
    const creds = await manager(config).getCredentials();
    assert.equal(creds.accessToken, t.access_token);
  });

  test("recoverFromUnauthorized forces a refresh", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock);
    const t = mock.issue();
    await seedOwnAuth(config, t);
    const m = manager(config);
    const first = await m.getCredentials();
    const next = await m.recoverFromUnauthorized(first);
    assert.ok(next);
    assert.notEqual(next.accessToken, t.access_token);
    assert.equal(mock.requestsTo("/oauth/token").length, 1);
  });

  test("saveLogin revokes the previous sign-in; logout revokes and deletes", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock);
    const old = mock.issue();
    await seedOwnAuth(config, old);
    const m = manager(config);
    const fresh = mock.issue({ email: "new@example.com" });
    const saved = await m.saveLogin({ idToken: fresh.id_token, accessToken: fresh.access_token, refreshToken: fresh.refresh_token }, "browser");
    assert.equal(saved.identity.email, "new@example.com");
    assert.equal(saved.revokedPrevious, true);
    const revoke = mock.requestsTo("/oauth/revoke");
    assert.equal(revoke[0]?.json.token, old.refresh_token);
    assert.equal(revoke[0]?.json.token_type_hint, "refresh_token");
    const out = await m.logout({ revoke: true });
    assert.deepEqual(out, { hadCredentials: true, removed: true, revoked: true });
    assert.equal(await readStoredAuth(config.authFile), undefined);
  });
});

describe("borrowed credentials", () => {
  test("auto mode falls back to Codex, then opencode, and never refreshes them", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock, { CODEX_IMAGEGEN_CREDENTIALS: "auto" });
    const codex = makeTokens({ email: "codex@example.com" });
    await writeJson(config.codexAuthFile, {
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: { id_token: codex.id_token, access_token: codex.access_token, refresh_token: codex.refresh_token, account_id: "acct-codex" },
      last_refresh: new Date().toISOString(),
    });
    let creds = await manager(config).getCredentials();
    assert.equal(creds.source, "codex");
    assert.equal(creds.accountId, "acct-codex");
    assert.equal(creds.identity.email, "codex@example.com");

    // Expired Codex token -> skipped; opencode (ms expiry) is used instead.
    const expired = makeTokens({ expiresIn: -60 });
    await writeJson(config.codexAuthFile, { auth_mode: "chatgpt", tokens: { access_token: expired.access_token, refresh_token: "r" }, last_refresh: new Date().toISOString() });
    const oc = makeTokens({ accountId: "acct-oc" });
    await writeJson(config.opencodeAuthFile, { openai: { type: "oauth", access: oc.access_token, refresh: "r", expires: Date.now() + 3_600_000, accountId: "acct-oc" } });
    creds = await manager(config).getCredentials();
    assert.equal(creds.source, "opencode");
    assert.equal(creds.accountId, "acct-oc");
    assert.equal(mock.requestsTo("/oauth/token").length, 0);
  });

  test("API-key Codex setups and API-key opencode entries are not usable", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock, { CODEX_IMAGEGEN_CREDENTIALS: "auto" });
    await writeJson(config.codexAuthFile, { auth_mode: "apikey", OPENAI_API_KEY: "sk-test" });
    await writeJson(config.opencodeAuthFile, { openai: { type: "api", key: "sk-test" } });
    await assert.rejects(manager(config).getCredentials(), (e: unknown) => {
      assert.ok(e instanceof ImagegenError);
      assert.equal(e.kind, "not_signed_in");
      assert.match(e.message, /apikey/);
      assert.match(e.message, /API key/);
      return true;
    });
    const reports = await manager(config).inspect();
    assert.deepEqual(
      reports.map((r) => [r.source, r.state]),
      [
        ["own", "missing"],
        ["codex", "unusable"],
        ["opencode", "unusable"],
      ],
    );
  });

  test("a 401 on a borrowed token moves on to the next source", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock, { CODEX_IMAGEGEN_CREDENTIALS: "auto" });
    const a = makeTokens();
    const b = makeTokens();
    await writeJson(config.codexAuthFile, { auth_mode: "chatgpt", tokens: { access_token: a.access_token, refresh_token: "r" }, last_refresh: new Date().toISOString() });
    await writeJson(config.opencodeAuthFile, { openai: { type: "oauth", access: b.access_token, refresh: "r", expires: Date.now() + 3_600_000 } });
    const m = manager(config);
    const first = await m.getCredentials();
    assert.equal(first.source, "codex");
    const next = await m.recoverFromUnauthorized(first);
    assert.equal(next?.source, "opencode");
    const reports = await m.inspect();
    assert.equal(reports.find((r) => r.source === "codex")?.state, "unusable");
  });

  test("pinned mode only consults that source", async () => {
    const root = await tempDir();
    const config = testConfig(root, mock, { CODEX_IMAGEGEN_CREDENTIALS: "opencode" });
    await seedOwnAuth(config, mock.issue());
    await assert.rejects(manager(config).getCredentials(), /opencode/);
    const reports = await manager(config).inspect();
    assert.equal(reports.find((r) => r.source === "own")?.state, "disabled");
  });
});
