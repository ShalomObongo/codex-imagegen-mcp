import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema, type CallToolResult, type Progress } from "@modelcontextprotocol/sdk/types.js";
import { decodeImage, hasTransparency } from "../src/images/codec.js";
import { seedOwnAuth, tempDir, testConfig, testEnv } from "./helpers/env.js";
import { startMockOpenAI, testPng, type MockOpenAI } from "./helpers/mock-openai.js";

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../src/cli.js");

let mock: MockOpenAI;
let root: string;
let workspace: string;
let client: Client;

async function connect(env: Record<string, string>, cwd: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [CLI, "serve"],
    cwd,
    env: { ...getDefaultEnvironment(), ...env },
    stderr: "pipe",
  });
  const c = new Client({ name: "imagegen-test", version: "1.0.0" });
  await c.connect(transport);
  return c;
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
}

async function call(name: string, args: Record<string, unknown>, onprogress?: (p: Progress) => void): Promise<CallToolResult> {
  const options = onprogress ? { onprogress, timeout: 30_000 } : { timeout: 30_000 };
  return CallToolResultSchema.parse(await client.callTool({ name, arguments: args }, CallToolResultSchema, options));
}

before(async () => {
  mock = await startMockOpenAI();
  root = await tempDir();
  await fs.mkdir(path.join(root, "project"), { recursive: true });
  // The server resolves relative paths against its cwd, which the OS reports as a real path
  // (on macOS /var/folders/… is a symlink to /private/var/folders/…).
  workspace = await fs.realpath(path.join(root, "project"));
  const config = testConfig(root, mock);
  await seedOwnAuth(config, mock.issue({ email: "mcp@example.com" }));
  client = await connect(testEnv(root, mock), workspace);
  await client.listTools(); // caches output schemas for validation
});

after(async () => {
  await client?.close();
  await mock?.close();
});

describe("MCP server over stdio", () => {
  test("handshake: identity, instructions, tools, resources, prompts", async () => {
    assert.equal(client.getServerVersion()?.name, "codex-imagegen-mcp");
    assert.match(client.getInstructions() ?? "", /ChatGPT plan/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["auth_status", "edit_image", "generate_image", "remove_background", "sign_in"]);
    const gen = tools.find((t) => t.name === "generate_image");
    assert.deepEqual(gen?.inputSchema.required, ["prompt"]);
    assert.equal(gen?.annotations?.readOnlyHint, false);
    assert.ok(gen?.outputSchema);
    const { resources } = await client.listResources();
    assert.ok(resources.some((r) => r.uri === "imagegen://history"));
    assert.ok(resources.some((r) => r.uri === "imagegen://skill/SKILL.md"));
    const { prompts } = await client.listPrompts();
    assert.deepEqual(prompts.map((p) => p.name).sort(), ["edit", "generate"]);
  });

  test("generate_image saves into the workspace, returns a preview, structured content and progress", async () => {
    const progress: Progress[] = [];
    const result = await call(
      "generate_image",
      { prompt: "Use case: stylized-concept\nPrimary request: a slime", aspect_ratio: "1:1", background: "transparent", output_path: "assets/slime.png" },
      (p) => progress.push(p),
    );
    assert.notEqual(result.isError, true, text(result));
    const saved = path.join(workspace, "assets", "slime.png");
    assert.match(text(result), new RegExp(saved.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(text(result), /alpha verified/);
    assert.equal(hasTransparency(decodeImage(await fs.readFile(saved))), true);
    const image = result.content.find((c) => c.type === "image");
    assert.equal(image?.type === "image" ? image.mimeType : "", "image/jpeg");
    const sc = result.structuredContent as { images: { path: string; transparent?: boolean }[]; prompt: string };
    assert.equal(sc.images[0]?.path, saved);
    assert.equal(sc.images[0]?.transparent, true);
    assert.match(sc.prompt, /Aspect ratio: 1:1, square canvas\.$/);
    assert.ok(progress.length >= 1, "expected at least one progress notification");
    const req = mock.requestsTo("/backend-api/codex/images/generations").at(-1);
    assert.equal(req?.json.background, "transparent");
    assert.match(String(req?.headers["user-agent"]), /^codex-imagegen-mcp\//);
  });

  test("generate_image never overwrites; n=2 produces two suffixed files", async () => {
    const again = await call("generate_image", { prompt: "a slime", output_path: "assets/slime.png", include_preview: false });
    assert.match(text(again), /slime-2\.png/);
    const two = await call("generate_image", { prompt: "variants", n: 2, output_path: "assets/v.png", include_preview: false });
    const sc = two.structuredContent as { images: { path: string }[] };
    assert.deepEqual(sc.images.map((i) => path.basename(i.path)).sort(), ["v-1.png", "v-2.png"]);
    assert.equal(two.content.filter((c) => c.type === "image").length, 0);
  });

  test("edit_image sends the input as a data URL and saves the result", async () => {
    await fs.writeFile(path.join(workspace, "photo.png"), testPng(20, 20));
    const result = await call("edit_image", { images: ["photo.png"], prompt: "Image 1: make the sky pink; keep everything else", output_path: "photo-edited.png" });
    assert.notEqual(result.isError, true, text(result));
    const req = mock.requestsTo("/backend-api/codex/images/edits").at(-1);
    assert.match(req?.json.images[0].image_url, /^data:image\/png;base64,/);
    await fs.access(path.join(workspace, "photo-edited.png"));
  });

  test("tool errors are reported as isError results with next steps", async () => {
    const missing = await call("edit_image", { images: ["does-not-exist.png"], prompt: "x" });
    assert.equal(missing.isError, true);
    assert.match(text(missing), /not found/);
    mock.state.imageQueue.push({ status: 429, body: { error: { type: "usage_limit_reached", message: "limit", plan_type: "plus", resets_at: Math.floor(Date.now() / 1000) + 600 } } });
    const limited = await call("generate_image", { prompt: "x" });
    assert.equal(limited.isError, true);
    assert.match(text(limited), /usage limit/);
    assert.match(text(limited), /Do not retry/);
  });

  test("remove_background cuts out a flat backdrop locally", async () => {
    const w = 30;
    const h = 20;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < data.length; i += 4) {
      const p = i / 4;
      const inside = p % w > 10 && p % w < 20 && Math.floor(p / w) > 5 && Math.floor(p / w) < 15;
      data.set(inside ? [200, 40, 40, 255] : [0, 255, 0, 255], i);
    }
    const { encodePng } = await import("../src/images/codec.js");
    await fs.writeFile(path.join(workspace, "green.png"), encodePng({ width: w, height: h, data }));
    const before = mock.state.requests.length;
    const result = await call("remove_background", { input_path: "green.png" });
    assert.notEqual(result.isError, true, text(result));
    assert.match(text(result), /#00ff00/);
    const out = await fs.readFile(path.join(workspace, "green-transparent.png"));
    assert.equal(hasTransparency(decodeImage(out)), true);
    assert.equal(mock.state.requests.length, before, "remove_background must not touch the network");
  });

  test("auth_status reports the account, source and usage", async () => {
    const result = await call("auth_status", {});
    const t = text(result);
    assert.match(t, /Signed in: yes/);
    assert.match(t, /mcp@example\.com/);
    assert.match(t, /Codex 5-hour window: 7% used/);
  });

  test("resources: history and image blobs", async () => {
    const history = await client.readResource({ uri: "imagegen://history" });
    const first = history.contents[0];
    const entries = JSON.parse(first && "text" in first ? first.text : "[]") as { id: string; tool: string }[];
    assert.ok(entries.length >= 4);
    const image = await client.readResource({ uri: `imagegen://images/${entries[0]?.id}` });
    const blob = image.contents[0];
    assert.ok(blob && "blob" in blob && blob.blob.length > 0);
    const skill = await client.readResource({ uri: "imagegen://skill/SKILL.md" });
    const md = skill.contents[0];
    assert.match(md && "text" in md ? md.text : "", /^---\nname: imagegen/);
    await assert.rejects(client.readResource({ uri: "imagegen://images/img_nope" }), /Unknown image id/);
  });

  test("prompts expand to workflow instructions", async () => {
    const p = await client.getPrompt({ name: "generate", arguments: { description: "a hero banner for a bakery" } });
    const m = p.messages[0];
    assert.match(m?.content.type === "text" ? m.content.text : "", /a hero banner for a bakery/);
  });
});

describe("MCP server without credentials", () => {
  let bare: Client;
  let bareMock: MockOpenAI;
  before(async () => {
    bareMock = await startMockOpenAI();
    const r = await tempDir();
    bare = await connect(testEnv(r, bareMock), r);
  });
  after(async () => {
    await bare?.close();
    await bareMock?.close();
  });

  test("generate_image explains how to sign in", async () => {
    const result = CallToolResultSchema.parse(await bare.callTool({ name: "generate_image", arguments: { prompt: "x" } }));
    assert.equal(result.isError, true);
    assert.match(text(result), /Not signed in/);
    assert.match(text(result), /login/);
    assert.match(text(result), /sign_in/);
  });

  test("sign_in (device) returns the code and completes in the background", async () => {
    bareMock.state.devicePendingPolls = 1;
    const result = CallToolResultSchema.parse(await bare.callTool({ name: "sign_in", arguments: { method: "device" } }));
    assert.match(text(result), /ABCD-1234/);
    assert.match(text(result), /\/codex\/device/);
    let status = "";
    for (let i = 0; i < 50 && !/Signed in: yes/.test(status); i++) {
      await new Promise((r) => setTimeout(r, 100));
      status = text(CallToolResultSchema.parse(await bare.callTool({ name: "auth_status", arguments: { check_usage: false } })));
    }
    assert.match(status, /Signed in: yes/);
    assert.match(status, /Last sign-in attempt: succeeded/);
    const gen = CallToolResultSchema.parse(await bare.callTool({ name: "generate_image", arguments: { prompt: "after sign in", include_preview: false } }));
    assert.notEqual(gen.isError, true, text(gen));
  });
});
