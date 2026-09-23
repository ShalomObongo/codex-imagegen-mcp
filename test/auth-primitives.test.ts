import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, test } from "node:test";
import { decodeJwtPayload, identityFromTokens, jwtExpiryMs } from "../src/auth/jwt.js";
import { buildAuthorizeUrl, oauthErrorCode } from "../src/auth/oauth.js";
import { createPkce, createState } from "../src/auth/pkce.js";
import { buildStoredAuth, deleteStoredAuth, readStoredAuth, writeStoredAuth } from "../src/auth/store.js";
import { ImagegenError } from "../src/errors.js";
import { withFileLock } from "../src/util/fs.js";
import { makeJwt, makeTokens } from "./helpers/mock-openai.js";
import { tempDir } from "./helpers/env.js";

describe("jwt", () => {
  test("decodes payloads and ignores garbage", () => {
    assert.deepEqual(decodeJwtPayload(makeJwt({ a: 1 })), { a: 1 });
    assert.equal(decodeJwtPayload("not-a-jwt"), undefined);
    assert.equal(decodeJwtPayload("a.!!!.c"), undefined);
    assert.equal(decodeJwtPayload(undefined), undefined);
  });

  test("reads ChatGPT identity claims, falling back to the access token", () => {
    const t = makeTokens({ email: "me@example.com", plan: "pro", accountId: "acct-9" });
    const id = identityFromTokens(t.id_token, t.access_token);
    assert.equal(id.email, "me@example.com");
    assert.equal(id.planType, "pro");
    assert.equal(id.accountId, "acct-9");
    assert.equal(id.isFedramp, false);
    const accessOnly = identityFromTokens(undefined, t.access_token);
    assert.equal(accessOnly.planType, "pro");
    assert.equal(accessOnly.email, undefined);
    const profileEmail = identityFromTokens(makeJwt({ "https://api.openai.com/profile": { email: "p@example.com" } }));
    assert.equal(profileEmail.email, "p@example.com");
    const fedramp = identityFromTokens(makeJwt({ "https://api.openai.com/auth": { chatgpt_account_is_fedramp: true } }));
    assert.equal(fedramp.isFedramp, true);
  });

  test("expiry in milliseconds", () => {
    assert.equal(jwtExpiryMs(makeJwt({ exp: 1_700_000_000 })), 1_700_000_000_000);
    assert.equal(jwtExpiryMs(makeJwt({})), undefined);
  });
});

describe("pkce + authorize url", () => {
  test("S256 challenge matches the verifier", () => {
    const { verifier, challenge } = createPkce();
    assert.equal(verifier.length, 86);
    assert.equal(challenge, createHash("sha256").update(verifier).digest("base64url"));
    assert.notEqual(createState(), createState());
  });

  test("authorize URL carries Codex's parameters in order, spaces as %20", () => {
    const url = buildAuthorizeUrl({
      issuer: "https://auth.openai.com",
      clientId: "app_X",
      redirectUri: "http://localhost:1455/auth/callback",
      codeChallenge: "CH",
      state: "ST",
      originator: "codex-imagegen-mcp",
    });
    assert.ok(url.startsWith("https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_X&redirect_uri="));
    assert.ok(url.includes("scope=openid%20profile%20email%20offline_access"));
    const q = new URL(url).searchParams;
    assert.deepEqual([...q.keys()], [
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "code_challenge",
      "code_challenge_method",
      "id_token_add_organizations",
      "codex_cli_simplified_flow",
      "state",
      "originator",
    ]);
    assert.equal(q.get("redirect_uri"), "http://localhost:1455/auth/callback");
    assert.equal(q.get("code_challenge_method"), "S256");
    assert.equal(q.get("codex_cli_simplified_flow"), "true");
  });

  test("OAuth error codes are read like Codex does", () => {
    assert.equal(oauthErrorCode({ error: { code: "refresh_token_reused" } }), "refresh_token_reused");
    assert.equal(oauthErrorCode({ error: "invalid_grant" }), "invalid_grant");
    assert.equal(oauthErrorCode({ code: "x" }), "x");
    assert.equal(oauthErrorCode("nope"), undefined);
  });
});

describe("credential store", () => {
  test("round-trips with 0600 permissions and derives the account id", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "nested", "auth.json");
    const t = makeTokens({ accountId: "acct-77" });
    await writeStoredAuth(file, buildStoredAuth({ idToken: t.id_token, accessToken: t.access_token, refreshToken: t.refresh_token }, "device"));
    const back = await readStoredAuth(file);
    assert.ok(back);
    assert.equal(back.tokens.account_id, "acct-77");
    assert.equal(back.login_method, "device");
    if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    assert.equal(await deleteStoredAuth(file), true);
    assert.equal(await deleteStoredAuth(file), false);
    assert.equal(await readStoredAuth(file), undefined);
  });

  test("corrupt files raise an actionable error", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "auth.json");
    await fs.writeFile(file, "{ not json");
    await assert.rejects(readStoredAuth(file), (e: unknown) => e instanceof ImagegenError && e.kind === "auth_failed" && /Sign in again/.test(e.message));
    await fs.writeFile(file, JSON.stringify({ tokens: { access_token: "a" } }));
    await assert.rejects(readStoredAuth(file), /missing access or refresh token/);
  });
});

describe("file lock", () => {
  test("serializes concurrent critical sections", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "x.lock");
    let active = 0;
    let maxActive = 0;
    const order: number[] = [];
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        withFileLock(lock, async () => {
          active++;
          maxActive = Math.max(maxActive, active);
          await new Promise((r) => setTimeout(r, 5));
          order.push(i);
          active--;
        }),
      ),
    );
    assert.equal(maxActive, 1);
    assert.equal(order.length, 8);
    await assert.rejects(fs.stat(lock));
  });

  test("breaks a stale lock left by a dead process", async () => {
    const dir = await tempDir();
    const lock = path.join(dir, "x.lock");
    await fs.writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
    let ran = false;
    await withFileLock(lock, async () => {
      ran = true;
    }, { timeoutMs: 2000 });
    assert.equal(ran, true);
  });
});
