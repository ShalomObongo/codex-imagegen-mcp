import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import { ImagesClient } from "../src/backend/images-client.js";
import { parseRateLimitHeaders } from "../src/backend/ratelimits.js";
import { ImagegenError } from "../src/errors.js";
import { sniffImageMime } from "../src/images/codec.js";
import { silentLogger } from "../src/log.js";
import { manager, seedOwnAuth, tempDir, testConfig } from "./helpers/env.js";
import { startMockOpenAI, testPng, type MockOpenAI } from "./helpers/mock-openai.js";

let mock: MockOpenAI;
before(async () => {
  mock = await startMockOpenAI();
});
after(async () => {
  await mock.close();
});
beforeEach(() => {
  mock.state.requests.length = 0;
  mock.state.imageQueue.length = 0;
});

async function setup() {
  const root = await tempDir();
  const config = testConfig(root, mock);
  const tokens = mock.issue({ accountId: "acct-hdr" });
  await seedOwnAuth(config, tokens);
  const auth = manager(config);
  const client = new ImagesClient(auth, {
    baseUrl: config.baseUrl,
    usageUrl: config.usageUrl,
    originator: "codex-imagegen-mcp",
    userAgent: "codex-imagegen-mcp/test",
    timeoutMs: 10_000,
    logger: silentLogger,
    retryDelaysMs: [5, 5],
  });
  return { config, tokens, client };
}

describe("images client", () => {
  test("generations: Codex-identical body and auth headers; metadata parsed", async () => {
    const { client, tokens } = await setup();
    const img = await client.createImage({ prompt: "a red apple", background: "auto" });
    const [req] = mock.requestsTo("/backend-api/codex/images/generations");
    assert.ok(req);
    assert.deepEqual(req.json, { prompt: "a red apple", background: "auto", model: "gpt-image-2", quality: "auto", size: "auto" });
    assert.equal(req.headers.authorization, `Bearer ${tokens.access_token}`);
    assert.equal(req.headers["chatgpt-account-id"], "acct-hdr");
    assert.equal(req.headers.originator, "codex-imagegen-mcp");
    assert.equal(req.headers["user-agent"], "codex-imagegen-mcp/test");
    assert.equal(sniffImageMime(img.bytes), "image/png");
    assert.equal(img.size, "1536x1024");
    assert.equal(img.quality, "medium");
    assert.match(img.requestId ?? "", /^req-/);
    assert.equal(img.rateLimits?.limits.codex?.primary?.usedPercent, 7);
    assert.equal(img.credentialSource, "own");
  });

  test("edits: images are sent as data URLs", async () => {
    const { client } = await setup();
    const dataUrl = `data:image/png;base64,${testPng(8, 8).toString("base64")}`;
    await client.createImage({ prompt: "edit", background: "transparent", images: [{ dataUrl }] });
    const [req] = mock.requestsTo("/backend-api/codex/images/edits");
    assert.deepEqual(req?.json.images, [{ image_url: dataUrl }]);
    assert.equal(req?.json.background, "transparent");
  });

  test("401 triggers one credential recovery (refresh) and a retry", async () => {
    const { client } = await setup();
    mock.state.imageQueue.push({ status: 401, body: { detail: "expired" } });
    const img = await client.createImage({ prompt: "x", background: "auto" });
    assert.ok(img.bytes.length > 0);
    assert.equal(mock.requestsTo("/oauth/token").length, 1);
    assert.equal(mock.requestsTo("/backend-api/codex/images/generations").length, 2);
  });

  test("5xx is retried, then succeeds", async () => {
    const { client } = await setup();
    mock.state.imageQueue.push({ status: 502, body: { error: { message: "bad gateway" } } }, { status: 500, body: {} });
    const img = await client.createImage({ prompt: "x", background: "auto" });
    assert.ok(img.bytes.length > 0);
    assert.equal(mock.requestsTo("/backend-api/codex/images/generations").length, 3);
  });

  test("usage_limit_reached maps to usage_limit with the reset time and is not retried", async () => {
    const { client } = await setup();
    const resetsAt = Math.floor(Date.now() / 1000) + 7200;
    mock.state.imageQueue.push({
      status: 429,
      body: { error: { type: "usage_limit_reached", message: "image limit reached", resets_at: resetsAt, plan_type: "plus" } },
      headers: { "x-codex-active-limit": "image_gen", "x-image-gen-primary-used-percent": "100" },
    });
    await assert.rejects(client.createImage({ prompt: "x", background: "auto" }), (e: unknown) => {
      assert.ok(e instanceof ImagegenError);
      assert.equal(e.kind, "usage_limit");
      assert.equal(e.details.resetsAt, resetsAt);
      assert.match(e.message, /plus plan/);
      assert.match(e.message, /resets in 2h/);
      return true;
    });
    assert.equal(mock.requestsTo("/backend-api/codex/images/generations").length, 1);
  });

  test("safety rejections map to content_policy; other 400s to invalid_request", async () => {
    const { client } = await setup();
    mock.state.imageQueue.push({ status: 400, body: { error: { type: "image_generation_user_error", code: "moderation_blocked", message: "Your request was rejected by the safety system." } } });
    await assert.rejects(client.createImage({ prompt: "x", background: "auto" }), (e: unknown) => e instanceof ImagegenError && e.kind === "content_policy");
    mock.state.imageQueue.push({ status: 400, body: { error: { message: "Invalid value for background" } } });
    await assert.rejects(client.createImage({ prompt: "x", background: "auto" }), (e: unknown) => e instanceof ImagegenError && e.kind === "invalid_request");
  });

  test("Cloudflare HTML 403 is reported as blocked", async () => {
    const { client } = await setup();
    mock.state.imageQueue.push({ status: 403, raw: "<html><title>Just a moment...</title>cloudflare</html>" });
    await assert.rejects(client.createImage({ prompt: "x", background: "auto" }), (e: unknown) => e instanceof ImagegenError && e.kind === "blocked");
  });

  test("usage endpoint", async () => {
    const { client } = await setup();
    const usage = await client.getUsage();
    assert.equal(usage.planType, "plus");
    assert.equal(usage.primary?.usedPercent, 7);
    assert.equal(usage.secondary?.windowSeconds, 604800);
  });

  test("rate-limit header parsing handles multi-word limit ids", () => {
    const h = new Headers({
      "x-image-gen-primary-used-percent": "40",
      "x-image-gen-primary-window-minutes": "1440",
      "x-codex-primary-over-secondary-limit-percent": "0",
      "x-codex-secondary-reset-at": "123",
      "x-codex-credits-has-credits": "False",
    });
    const s = parseRateLimitHeaders(h);
    assert.equal(s?.limits["image-gen"]?.primary?.usedPercent, 40);
    assert.equal(s?.limits["image-gen"]?.primary?.windowMinutes, 1440);
    assert.equal(s?.limits.codex?.secondary?.resetAt, 123);
    assert.equal(s?.credits?.hasCredits, false);
    assert.equal(Object.keys(s?.limits ?? {}).length, 2);
  });
});
