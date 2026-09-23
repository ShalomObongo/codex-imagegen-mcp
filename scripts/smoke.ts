/**
 * End-to-end smoke test of the real package, as users get it. CI runs it on Linux, macOS and
 * Windows for every push, the release pipeline runs it on the exact tarball it is about to
 * publish, and again on the published version through npx.
 *
 *   node dist/scripts/smoke.js --tarball codex-imagegen-mcp-X.Y.Z.tgz   # global install of a tarball
 *   node dist/scripts/smoke.js --registry X.Y.Z                         # npx -y codex-imagegen-mcp@X.Y.Z
 *
 * In a throwaway home directory it:
 * - installs into 18 tools with the real CLI (19 on Windows);
 * - reads every written config back and checks it holds the planned entry;
 * - starts the server through each entry the way the tool would, with only a GUI app's PATH
 *   for GUI apps, and speaks MCP to it;
 * - runs doctor, uninstalls, and checks nothing is left behind.
 *
 * It never touches the real home directory or any real tool.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { findClient } from "../src/install/clients.js";
import type { InstallContext } from "../src/install/context.js";
import { NOT_DETECTED } from "../src/install/detect.js";
import { getIn, isPlainObject, parseConfig, sameValue, type ConfigFormat } from "../src/install/formats.js";
import { formatCommand } from "../src/install/launch.js";
import { entryArgv } from "../src/install/plan.js";

const PACKAGE = "codex-imagegen-mcp";
const WIN = process.platform === "win32";
const TOOLS = ["auth_status", "edit_image", "generate_image", "remove_background", "sign_in"];
/** Tools configured through plain files; Claude Code is left out because it would run the claude CLI. */
const CLIENTS = [
  "opencode",
  "codex",
  "gemini",
  "copilot",
  "cursor",
  "vscode",
  "claude-desktop",
  "devin",
  "zed",
  "amp",
  "goose",
  "droid",
  "qwen",
  "kiro",
  "junie",
  "auggie",
  "antigravity",
  "kilo",
  ...(WIN ? ["visual-studio"] : []),
];
/** Variables that would point the CLI or server outside the sandbox. */
const REDIRECTS = /^(XDG_\w+|CODEX_\w+|CLAUDE_CONFIG_DIR|COPILOT_HOME|GEMINI_CLI_HOME|JUNIE_HOME|VSCODE_APPDATA|CLINE_\w+|NPM_CONFIG_\w+)$/i;

class SmokeError extends Error {
  override name = "SmokeError";
}

function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new SmokeError(message);
}

// ---------------------------------------------------------------------------------------------
// Sandbox and processes
// ---------------------------------------------------------------------------------------------

interface Sandbox {
  root: string;
  home: string;
  project: string;
  env: NodeJS.ProcessEnv;
}

function pathKey(env: NodeJS.ProcessEnv): string {
  return Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
}

function makeSandbox(label: string): Sandbox {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `imagegen-smoke-${label}-`)));
  const home = path.join(root, "home");
  // Outside any checkout of this package: npx in the package's own directory runs the checkout.
  const project = path.join(home, "project");
  fs.mkdirSync(project, { recursive: true });
  // npm on Windows keeps its global prefix in %APPDATA%\npm, and npx fails if it's missing.
  fs.mkdirSync(path.join(home, "AppData", "Roaming", "npm"), { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) if (!REDIRECTS.test(key)) env[key] = value;
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    npm_config_cache: path.join(root, "npm-cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
    NO_COLOR: "1",
  });
  return { root, home, project, env };
}

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function winQuote(arg: string): string {
  return /^[\w@+=:,./\\-]+$/.test(arg) ? arg : `"${arg.replace(/"/g, '""')}"`;
}

/** Run a command; on Windows through cmd.exe, because npm, npx and npm's shims are .cmd files. */
function run(command: string, args: readonly string[], o: { env: NodeJS.ProcessEnv; cwd: string; timeoutMs?: number }): Run {
  const common = { env: o.env, cwd: o.cwd, encoding: "utf8" as const, timeout: o.timeoutMs ?? 300_000, maxBuffer: 64 * 1024 * 1024 };
  const r = WIN
    ? spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${[command, ...args].map(winQuote).join(" ")}"`], { ...common, windowsVerbatimArguments: true })
    : spawnSync(command, args, common);
  if (r.error) throw new SmokeError(`${command} ${args.join(" ")}: ${r.error.message}`);
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function must(r: Run, what: string): Run {
  if (r.code !== 0) throw new SmokeError(`${what} exited with ${r.code}\n${(r.stderr || r.stdout).trim().slice(-3000)}`);
  return r;
}

interface Cli {
  command: string;
  prefix: string[];
  label: string;
}

function installTarball(sb: Sandbox, tarball: string): Cli {
  const prefix = path.join(sb.root, "npm-global");
  must(run("npm", ["install", "--global", "--prefix", prefix, path.resolve(tarball)], { env: sb.env, cwd: sb.project, timeoutMs: 600_000 }), "npm install --global");
  const bin = WIN ? prefix : path.join(prefix, "bin");
  const key = pathKey(sb.env);
  sb.env[key] = [bin, sb.env[key]].filter(Boolean).join(path.delimiter);
  const command = path.join(bin, WIN ? `${PACKAGE}.cmd` : PACKAGE);
  expect(fs.existsSync(command), `npm install --global didn't create ${command}`);
  return { command, prefix: [], label: "global install" };
}

// ---------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------

interface ConfigResult {
  kind: string;
  clients: string[];
  path: string;
  key: string[];
  entry: Record<string, unknown>;
  ok: boolean;
  outcome: string;
}

interface Launch {
  argv: string[];
  env: Record<string, string>;
  gui: boolean;
  clients: string[];
}

function envOf(entry: Record<string, unknown>): Record<string, string> {
  const env = entry.env ?? entry.environment ?? entry.envs;
  return isPlainObject(env) ? (Object.fromEntries(Object.entries(env).map(([k, v]) => [k, String(v)])) as Record<string, string>) : {};
}

/** One launch per distinct command and environment; which tools share it is kept for messages. */
function launchesOf(configs: readonly ConfigResult[]): Launch[] {
  const launches = new Map<string, Launch>();
  for (const c of configs) {
    const argv = entryArgv(c.entry);
    const env = envOf(c.entry);
    const gui = c.clients.some((id) => findClient(id)?.gui);
    const key = JSON.stringify([argv, env, gui]);
    const launch = launches.get(key) ?? { argv, env, gui, clients: [] };
    launch.clients.push(...c.clients);
    launches.set(key, launch);
  }
  return [...launches.values()];
}

function textOf(result: object): string {
  const raw = (result as { content?: unknown }).content;
  const content = Array.isArray(raw) ? (raw as { type?: string; text?: string }[]) : [];
  return content.map((c) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
}

/** Start the server the way the tools would, and check it speaks MCP. */
async function handshake(launch: Launch, sb: Sandbox, expectVersion: string | undefined): Promise<string> {
  expect(launch.argv.length > 0, `${launch.clients.join(", ")}: the entry has no command`);
  // A GUI app started from the Dock or Start menu has only a basic PATH on macOS and Linux.
  const base: NodeJS.ProcessEnv =
    launch.gui && !WIN ? { HOME: sb.home, TMPDIR: os.tmpdir(), LANG: "en_US.UTF-8", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" } : { ...sb.env };
  const env = Object.fromEntries(Object.entries({ ...base, ...launch.env }).filter((e): e is [string, string] => typeof e[1] === "string"));
  const transport = new StdioClientTransport({ command: launch.argv[0]!, args: launch.argv.slice(1), env, cwd: sb.project, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-4000);
  });
  const client = new Client({ name: "codex-imagegen-mcp-smoke", version: "1.0.0" });
  const what = `${launch.clients.join(", ")} (${formatCommand(launch.argv)})`;
  try {
    // A cold npx start on Windows can take a minute.
    await client.connect(transport, { timeout: 240_000 });
    const info = client.getServerVersion();
    expect(info?.name === PACKAGE, `${what}: the server identified itself as ${info?.name}`);
    if (expectVersion) expect(info.version === expectVersion, `${what}: started version ${info.version}, expected ${expectVersion}`);
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    expect(sameValue(tools, TOOLS), `${what}: tools are ${tools.join(", ")}`);
    const skill = await client.readResource({ uri: "imagegen://skill/SKILL.md" });
    const first = skill.contents[0];
    const md = first && "text" in first && typeof first.text === "string" ? first.text : "";
    expect(/^---\r?\nname: imagegen-mcp\r?\n/.test(md), `${what}: imagegen://skill/SKILL.md is not the imagegen-mcp skill`);
    const status = await client.callTool({ name: "auth_status", arguments: { check_usage: false } });
    expect(status.isError !== true && /Signed in: no/.test(textOf(status)), `${what}: auth_status said ${textOf(status).split("\n")[0]}`);
    return info.version;
  } catch (err) {
    if (err instanceof SmokeError) throw err;
    throw new SmokeError(`${what}: ${err instanceof Error ? err.message : String(err)}${stderr ? `\n--- server stderr ---\n${stderr.trim()}` : ""}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------------------------

function formatOf(file: string): ConfigFormat {
  return file.endsWith(".toml") ? "toml" : /\.ya?ml$/.test(file) ? "yaml" : "json";
}

function readEntry(c: ConfigResult): unknown {
  return getIn(parseConfig(formatOf(c.path), fs.readFileSync(c.path, "utf8")), c.key);
}

/** Releases before 0.2.1 don't report the key path in --json; work it out from the registry. */
function withKey(c: ConfigResult, sb: Sandbox, serverName = "imagegen"): ConfigResult {
  if (Array.isArray(c.key) && c.key.length > 0) return c;
  const ctx: InstallContext = { platform: process.platform, home: sb.home, cwd: sb.project, env: sb.env };
  for (const id of c.clients) {
    const spec = findClient(id)?.configs(ctx, "global", NOT_DETECTED).find((sp) => sp.files.some((f) => path.resolve(f) === path.resolve(c.path)));
    if (spec) return { ...c, key: [...spec.root, serverName] };
  }
  throw new SmokeError(`can't tell where the entry lives in ${c.path}`);
}

interface Report {
  label: string;
  tools: number;
  launches: number;
  seconds: number;
}

async function scenario(cli: Cli, sb: Sandbox, o: { launch: string; expectMode: string; version: string; serverVersion?: string }): Promise<Report> {
  const started = Date.now();
  const label = `${cli.label} · launch ${o.expectMode}`;
  const step = (message: string) => console.log(`  ${message}`);
  const cliRun = (args: string[], timeoutMs?: number) => run(cli.command, [...cli.prefix, ...args], { env: sb.env, cwd: sb.project, ...(timeoutMs ? { timeoutMs } : {}) });
  console.log(`\n▸ ${label}`);

  const version = must(cliRun(["--version"], 600_000), "--version").stdout.trim().split(/\r?\n/).at(-1);
  expect(version === o.version, `--version printed ${version}, expected ${o.version}`);
  step(`--version: ${version}`);

  const list = JSON.parse(must(cliRun(["install", "--list", "--json"]), "install --list").stdout) as { id: string }[];
  expect(list.length >= 20 && list.some((t) => t.id === "cursor"), `install --list returned ${list.length} tools`);
  expect(/"mcpServers"/.test(must(cliRun(["config", "cursor"]), "config cursor").stdout), "config cursor printed no mcpServers snippet");
  step(`install --list: ${list.length} tools; config cursor prints a snippet`);

  const installed = JSON.parse(must(cliRun(["install", ...CLIENTS, "--launch", o.launch, "--json"]), "install").stdout) as {
    launch: { mode: string; argv: string[] };
    results: (ConfigResult & { detail?: string })[];
  };
  expect(installed.launch.mode === o.expectMode, `the installer chose launch mode ${installed.launch.mode}, expected ${o.expectMode}`);
  const failed = installed.results.filter((r) => !r.ok);
  expect(failed.length === 0, `install failed for ${failed.map((r) => `${r.clients.join(", ")}: ${r.outcome} ${r.detail ?? ""}`).join("; ")}`);
  const configs = installed.results.filter((r) => r.kind === "config").map((r) => withKey(r, sb));
  const skills = installed.results.filter((r) => r.kind === "skill").map((r) => r.path);
  for (const id of CLIENTS) expect(configs.some((c) => c.clients.includes(id)), `nothing was installed for ${id}`);
  for (const c of configs) {
    expect(c.outcome === "created", `${c.path}: ${c.outcome}, expected created (the sandbox starts empty)`);
    expect(sameValue(readEntry(c), c.entry), `${c.path} doesn't hold the planned entry at ${c.key.join(".")}`);
  }
  expect(skills.length > 0, "no skill copies were installed");
  for (const dir of skills) expect(fs.existsSync(path.join(dir, "SKILL.md")), `${dir}/SKILL.md is missing`);
  step(`install: ${configs.length} config files verified on disk, ${skills.length} skill copies (launch: ${formatCommand(installed.launch.argv)})`);

  const launches = launchesOf(configs);
  for (const launch of launches) {
    const v = await handshake(launch, sb, o.serverVersion);
    step(`MCP ✓ ${formatCommand(launch.argv)}${Object.keys(launch.env).length ? ` + env ${Object.keys(launch.env).join(",")}` : ""}${launch.gui ? " (GUI PATH)" : ""} → ${v}, for ${launch.clients.length} tools`);
  }

  // doctor's exit code reflects sign-in and network checks; here only the installations matter.
  const doctor = cliRun(["doctor"], 180_000).stdout;
  for (const id of CLIENTS) {
    const name = findClient(id)!.label;
    expect(doctor.includes(`✓ ${name}:`), `doctor doesn't report ${name} as installed:\n${doctor}`);
  }
  step(`doctor: all ${CLIENTS.length} installations check out`);

  const removed = JSON.parse(must(cliRun(["uninstall", "--all", "--json"]), "uninstall --all").stdout) as { results: { ok: boolean; kind: string; path: string; outcome: string }[] };
  const notRemoved = removed.results.filter((r) => !r.ok);
  expect(notRemoved.length === 0, `uninstall failed: ${notRemoved.map((r) => `${r.path}: ${r.outcome}`).join("; ")}`);
  for (const c of configs) expect(readEntry(c) === undefined, `${c.path} still has ${c.key.join(".")} after uninstall`);
  for (const dir of skills) expect(!fs.existsSync(dir), `${dir} is still there after uninstall`);
  step("uninstall --all: every entry and skill copy removed");

  return { label, tools: CLIENTS.length, launches: launches.length, seconds: Math.round((Date.now() - started) / 1000) };
}

function summarize(reports: readonly Report[]): void {
  const lines = reports.map((r) => `✓ ${r.label}: ${r.tools} tools installed, read back, started over MCP (${r.launches} distinct launch commands), doctor, uninstalled · ${r.seconds}s`);
  console.log(`\n${lines.join("\n")}`);
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    const table = ["| Smoke test | Tools | Launch commands | Time |", "|---|---|---|---|", ...reports.map((r) => `| ✅ ${r.label} (${process.platform}) | ${r.tools} | ${r.launches} | ${r.seconds}s |`)];
    fs.appendFileSync(summary, `${table.join("\n")}\n\n`);
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      tarball: { type: "string" },
      registry: { type: "string" },
      version: { type: "string" },
      launch: { type: "string" },
      "server-version": { type: "string" },
      keep: { type: "boolean" },
    },
    strict: true,
  });
  const sandboxes: Sandbox[] = [];
  const reports: Report[] = [];
  try {
    if (values.tarball) {
      const name = /codex-imagegen-mcp-(.+)\.tgz$/.exec(path.basename(values.tarball))?.[1];
      const version = values.version ?? name;
      expect(version, `pass --version: can't read it from ${values.tarball}`);
      for (const launch of (values.launch ?? "node,global").split(",")) {
        const sb = makeSandbox(launch);
        sandboxes.push(sb);
        const cli = installTarball(sb, values.tarball);
        reports.push(await scenario(cli, sb, { launch, expectMode: launch, version, serverVersion: values["server-version"] ?? version }));
      }
    } else if (values.registry) {
      const version = values.registry.replace(/^v/, "");
      const sb = makeSandbox("npx");
      sandboxes.push(sb);
      const cli: Cli = { command: "npx", prefix: ["-y", `${PACKAGE}@${version}`], label: `npx ${PACKAGE}@${version}` };
      const serverVersion = values["server-version"] === "any" ? undefined : (values["server-version"] ?? version);
      reports.push(await scenario(cli, sb, { launch: values.launch ?? "auto", expectMode: "npx", version, ...(serverVersion ? { serverVersion } : {}) }));
    } else {
      console.error("Usage: smoke.js --tarball codex-imagegen-mcp-X.Y.Z.tgz [--launch node,global] | --registry X.Y.Z [--server-version any]");
      return 2;
    }
    summarize(reports);
    return 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n✗ ${message}`);
    if (process.env.GITHUB_ACTIONS) console.error(`::error title=Smoke test failed::${message.split("\n")[0]}`);
    values.keep = true;
    return 1;
  } finally {
    for (const sb of sandboxes) {
      if (values.keep) console.error(`(sandbox kept at ${sb.root})`);
      else fs.rmSync(sb.root, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}

process.exitCode = await main();
