#!/usr/bin/env node
import { parseArgs, type ParseArgsConfig } from "node:util";
import { startBrowserLogin } from "./auth/browser-login.js";
import { startDeviceLogin } from "./auth/device-login.js";
import type { TokenSet } from "./auth/store.js";
import type { Background } from "./backend/images-client.js";
import { loadConfig } from "./config.js";
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_SERVER_NAME, PACKAGE_NAME, SKILL_SOURCE_DIR, VERSION } from "./constants.js";
import { runDoctor } from "./doctor.js";
import { describeError, ImagegenError, toImagegenError } from "./errors.js";
import { ASPECT_RATIOS, runGeneration, type AspectRatio, type GenerationRequest } from "./generation.js";
import type { OutputFormat } from "./images/output.js";
import { installOpencode, uninstallOpencode, type InstallReport } from "./install/opencode.js";
import { clientSnippet, CLIENTS, type ClientId } from "./install/snippets.js";
import { createLogger } from "./log.js";
import { runRemoveBackground } from "./remove-background.js";
import { createDeps, runStdioServer } from "./server/index.js";
import { collectStatus, formatStatus } from "./status.js";
import { formatBytes, formatSeconds } from "./util/format.js";
import { cliInvocation, serverCommand } from "./util/invocation.js";
import { openInBrowser } from "./util/open.js";

const HELP = `${PACKAGE_NAME} ${VERSION}
OpenAI Codex's image generation (gpt-image via your ChatGPT plan — no API key) as an MCP
server + Agent Skill for opencode, Claude Code, Cursor, VS Code and other MCP clients.

Usage: ${PACKAGE_NAME} <command> [options]

Setup
  install [opencode]        Add the MCP server + skill to opencode (global; --project for ./opencode.json)
      --project  --name <server>  --no-skill  --dry-run  --force  --timeout <ms>
      --command "<cmd …>"   custom launch command    --env KEY=VALUE (repeatable)
  uninstall [opencode]      Remove them again   (--project --name --keep-skill --dry-run)
  config <client>           Print the config for: ${CLIENTS.join(", ")}
  doctor                    Diagnose Node, credentials, backend reachability, opencode setup

Account
  login                     Sign in with your ChatGPT account in the browser
      --device              use a device code instead (headless/remote machines)
      --no-browser          print the URL instead of opening it
  logout                    Delete this tool's saved sign-in   (--no-revoke keeps it valid server-side)
  status                    Sign-in state, credential sources and usage   (--json, --no-usage)

Images (terminal use; the same engine as the MCP tools)
  generate <prompt…>        Generate an image; with --image it edits/uses references
      -o, --out <path>      file or directory (default: ~/.local/share/${PACKAGE_NAME}/images)
      -i, --image <ref>     input image path/URL (repeatable, max 5)
      -a, --aspect <ratio>  ${ASPECT_RATIOS.join(", ")}
      -b, --background <auto|transparent|opaque>   -n <1-4>   --format <png|jpeg>   --overwrite   --json
  remove-bg <input>         Remove a flat background locally (chroma key) -> transparent PNG
      -o, --out <path>  --key-color <#hex>  --hard  --no-despill  --tolerance <n>
      --transparent-threshold <n>  --opaque-threshold <n>  --edge-contract <n>  --edge-feather <n>  --overwrite

Server
  serve                     Run the MCP server on stdio (this is what MCP clients launch)

Environment: CODEX_IMAGEGEN_HOME, CODEX_IMAGEGEN_OUTPUT_DIR, CODEX_IMAGEGEN_CREDENTIALS
(auto|own|codex|opencode), CODEX_IMAGEGEN_TIMEOUT_MS, CODEX_IMAGEGEN_LOG_LEVEL, CODEX_HOME.
Docs: README.md and docs/ in the package.`;

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function fail(message: string, code = 1): never {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
}

function parse<T extends NonNullable<ParseArgsConfig["options"]>>(args: string[], options: T, allowPositionals = false) {
  try {
    return parseArgs({ args, options, allowPositionals, strict: true });
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}\nRun \`${PACKAGE_NAME} help\` for usage.`, 2);
  }
}

function cliDeps() {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel === "debug" ? "debug" : "warn", stderr: true });
  return createDeps(config, logger);
}

function intOption(value: string | undefined, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) fail(`--${name} must be a number between ${min} and ${max}.`, 2);
  return n;
}

function abortOnSigint(): AbortSignal {
  const controller = new AbortController();
  process.once("SIGINT", () => {
    process.stderr.write("\nCancelled.\n");
    controller.abort(new ImagegenError("cancelled", "Cancelled by user."));
  });
  return controller.signal;
}

async function cmdLogin(args: string[]): Promise<void> {
  const { values } = parse(args, { device: { type: "boolean" }, "no-browser": { type: "boolean" } });
  const deps = cliDeps();
  const signal = abortOnSigint();
  let tokens: TokenSet;
  const method = values.device ? "device" : "browser";
  if (values.device) {
    const login = await startDeviceLogin(deps.auth.oauthClient, signal);
    out(`To sign in, open this page on any device and enter the code:\n\n    ${login.verificationUrl}\n    Code: ${login.userCode}\n`);
    out("The code expires in 15 minutes. If ChatGPT says device codes are disabled, enable");
    out("“device code authorization for Codex” in ChatGPT → Settings → Security, or use browser login.\n");
    out("Waiting for approval… (Ctrl+C to cancel)");
    tokens = await login.result;
  } else {
    const login = await startBrowserLogin({ ...deps.auth.oauthClient, originator: deps.config.originator, signal });
    const opened = !values["no-browser"] && !deps.config.noBrowser ? await openInBrowser(login.url) : false;
    out(opened ? "Opened your browser to sign in with ChatGPT. If it did not open, visit:\n" : "Open this URL in a browser on this machine to sign in with ChatGPT:\n");
    out(`  ${login.url}\n`);
    out("Waiting for you to finish signing in… (Ctrl+C to cancel; use --device on a headless machine)");
    tokens = await login.result;
  }
  const { identity, revokedPrevious } = await deps.auth.saveLogin(tokens, method);
  out(`\n✓ Signed in${identity.email ? ` as ${identity.email}` : ""}${identity.planType ? ` (ChatGPT ${identity.planType} plan)` : ""}.`);
  if (revokedPrevious) out("  The previous sign-in of this tool was revoked.");
  if (identity.planType === "free") out("  Note: Codex image generation is not available on the ChatGPT Free plan.");
  out(`  Credentials saved to ${deps.config.authFile} (readable only by you).`);
}

async function cmdLogout(args: string[]): Promise<void> {
  const { values } = parse(args, { "no-revoke": { type: "boolean" } });
  const deps = cliDeps();
  const r = await deps.auth.logout({ revoke: !values["no-revoke"] });
  if (!r.hadCredentials && !r.removed) {
    out(`Not signed in (no credentials at ${deps.config.authFile}).`);
  } else {
    out(`✓ Signed out: removed ${deps.config.authFile}${r.revoked ? " and revoked the sign-in" : values["no-revoke"] ? "" : " (revocation could not be confirmed)"}.`);
  }
  out("Borrowed Codex/opencode sign-ins are never modified; sign out of those apps separately if needed.");
}

async function cmdStatus(args: string[]): Promise<void> {
  const { values } = parse(args, { json: { type: "boolean" }, "no-usage": { type: "boolean" } });
  const deps = cliDeps();
  const report = await collectStatus(deps, { checkUsage: !values["no-usage"] });
  if (values.json) out(JSON.stringify(report, null, 2));
  else out(formatStatus(report));
  if (!report.signedIn) process.exitCode = 1;
}

async function cmdGenerate(args: string[]): Promise<void> {
  const { values, positionals } = parse(
    args,
    {
      out: { type: "string", short: "o" },
      image: { type: "string", short: "i", multiple: true },
      aspect: { type: "string", short: "a" },
      background: { type: "string", short: "b" },
      n: { type: "string", short: "n" },
      format: { type: "string" },
      overwrite: { type: "boolean" },
      json: { type: "boolean" },
    },
    true,
  );
  const prompt = positionals.join(" ").trim();
  if (!prompt) fail("Provide a prompt, e.g. `generate \"a watercolor fox\" -o fox.png`.", 2);
  const aspect = values.aspect ?? "auto";
  if (!(ASPECT_RATIOS as readonly string[]).includes(aspect)) fail(`--aspect must be one of ${ASPECT_RATIOS.join(", ")}.`, 2);
  const background = values.background ?? "auto";
  if (!["auto", "transparent", "opaque"].includes(background)) fail("--background must be auto, transparent or opaque.", 2);
  if (values.format && !["png", "jpeg"].includes(values.format)) fail("--format must be png or jpeg.", 2);
  const images = values.image ?? [];
  const req: GenerationRequest = {
    tool: images.length > 0 ? "edit_image" : "generate_image",
    prompt,
    aspectRatio: aspect as AspectRatio,
    background: background as Background,
    n: intOption(values.n, "n", 1, 4) ?? 1,
    overwrite: Boolean(values.overwrite),
    preview: false,
  };
  if (images.length > 0) req.imageRefs = images;
  if (values.out) req.outputPath = values.out;
  if (values.format) req.outputFormat = values.format as OutputFormat;
  const deps = cliDeps();
  const signal = abortOnSigint();
  if (!values.json) process.stderr.write(`${req.tool === "edit_image" ? "Editing" : "Generating"}… (usually 15-60 s)\n`);
  const result = await runGeneration(deps, req, {
    baseDir: process.cwd(),
    signal,
    onProgress: (m) => (values.json ? undefined : process.stderr.write(`${m}\n`)),
  });
  if (values.json) {
    out(JSON.stringify({ ...result, saved: result.saved.map(({ preview: _p, ...s }) => s), failures: result.failures.map((f) => ({ kind: f.kind, message: f.message })) }, null, 2));
  } else {
    for (const s of result.saved) {
      out(`✓ ${s.path}  (${s.width ?? "?"}×${s.height ?? "?"}, ${formatBytes(s.bytes)}, ${s.transparent === true || s.background === "transparent" ? "transparent" : "opaque"}, ${formatSeconds(s.elapsedMs)})`);
    }
    for (const w of result.warnings) process.stderr.write(`Warning: ${w}\n`);
    for (const f of result.failures) process.stderr.write(`✗ ${describeError(f)}\n`);
  }
  if (result.saved.length === 0) process.exitCode = 1;
}

async function cmdRemoveBg(args: string[]): Promise<void> {
  const { values, positionals } = parse(
    args,
    {
      out: { type: "string", short: "o" },
      "key-color": { type: "string" },
      hard: { type: "boolean" },
      "no-despill": { type: "boolean" },
      tolerance: { type: "string" },
      "transparent-threshold": { type: "string" },
      "opaque-threshold": { type: "string" },
      "edge-contract": { type: "string" },
      "edge-feather": { type: "string" },
      overwrite: { type: "boolean" },
    },
    true,
  );
  const input = positionals[0];
  if (!input) fail("Provide an input image, e.g. `remove-bg sprite.png -o sprite-cutout.png`.", 2);
  const deps = cliDeps();
  const req: Parameters<typeof runRemoveBackground>[1] = {
    inputPath: input,
    softMatte: !values.hard,
    despill: !values["no-despill"],
    overwrite: Boolean(values.overwrite),
    preview: false,
  };
  if (values.out) req.outputPath = values.out;
  if (values["key-color"]) req.keyColor = values["key-color"];
  const tol = intOption(values.tolerance, "tolerance", 0, 255);
  if (tol !== undefined) req.tolerance = tol;
  const tt = intOption(values["transparent-threshold"], "transparent-threshold", 0, 255);
  if (tt !== undefined) req.transparentThreshold = tt;
  const ot = intOption(values["opaque-threshold"], "opaque-threshold", 0, 255);
  if (ot !== undefined) req.opaqueThreshold = ot;
  const ec = intOption(values["edge-contract"], "edge-contract", 0, 16);
  if (ec !== undefined) req.edgeContract = ec;
  const ef = intOption(values["edge-feather"], "edge-feather", 0, 64);
  if (ef !== undefined) req.edgeFeather = ef;
  const r = await runRemoveBackground(deps, req, { baseDir: process.cwd() });
  out(`✓ ${r.outputPath}  (${r.width}×${r.height}, key ${r.keyColor}, ${r.transparentPercent.toFixed(1)}% transparent, ${r.partialPercent.toFixed(1)}% soft edges)`);
  for (const w of r.warnings) process.stderr.write(`Warning: ${w}\n`);
}

function printReport(report: InstallReport, dryRun: boolean): void {
  if (dryRun) out("(dry run — nothing was written)");
  for (const step of report.steps) out(`✓ ${step.action}: ${step.path}`);
  for (const w of report.warnings) out(`! ${w}`);
}

async function cmdInstall(args: string[]): Promise<void> {
  const { values, positionals } = parse(
    args,
    {
      project: { type: "boolean" },
      name: { type: "string" },
      "no-skill": { type: "boolean" },
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      timeout: { type: "string" },
      command: { type: "string" },
      env: { type: "string", multiple: true },
    },
    true,
  );
  const client = (positionals[0] ?? "opencode") as ClientId;
  const serverName = values.name ?? DEFAULT_SERVER_NAME;
  const command = values.command ? values.command.trim().split(/\s+/) : serverCommand();
  if (client !== "opencode") {
    if (!CLIENTS.includes(client)) fail(`Unknown client "${client}". Known: ${CLIENTS.join(", ")}.`, 2);
    out(`Automatic install is implemented for opencode. For ${client}, add this configuration:\n`);
    printSnippet(client, serverName, command);
    return;
  }
  const environment: Record<string, string> = {};
  for (const pair of values.env ?? []) {
    const eq = pair.indexOf("=");
    if (eq <= 0) fail(`--env expects KEY=VALUE (got "${pair}").`, 2);
    environment[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  const dryRun = Boolean(values["dry-run"]);
  const report = await installOpencode({
    scope: values.project ? "project" : "global",
    projectDir: process.cwd(),
    serverName,
    command,
    environment,
    timeoutMs: intOption(values.timeout, "timeout", 10_000, 3_600_000) ?? DEFAULT_REQUEST_TIMEOUT_MS,
    installSkill: !values["no-skill"],
    dryRun,
    force: Boolean(values.force),
  });
  printReport(report, dryRun);
  out(`\nServer command: ${command.join(" ")}`);
  const deps = cliDeps();
  const status = await collectStatus(deps, { checkUsage: false });
  out(
    status.active
      ? `Credentials: ready (${status.active.label}${status.active.identity?.email ? `, ${status.active.identity.email}` : ""}).`
      : `Credentials: not signed in yet — run \`${cliInvocation()} login\` (or ask the agent to call the sign_in tool).`,
  );
  out(`\nNext: restart opencode, then check \`opencode mcp list\` shows "${serverName}" as connected.`);
  out(`Tools appear as ${serverName}_generate_image, ${serverName}_edit_image, ${serverName}_remove_background, ${serverName}_auth_status, ${serverName}_sign_in.`);
}

async function cmdUninstall(args: string[]): Promise<void> {
  const { values, positionals } = parse(
    args,
    { project: { type: "boolean" }, name: { type: "string" }, "keep-skill": { type: "boolean" }, "dry-run": { type: "boolean" } },
    true,
  );
  const client = positionals[0] ?? "opencode";
  if (client !== "opencode") fail(`Automatic uninstall is implemented for opencode only; remove the "${values.name ?? DEFAULT_SERVER_NAME}" entry from ${client}'s config manually.`, 2);
  const dryRun = Boolean(values["dry-run"]);
  const report = await uninstallOpencode({
    scope: values.project ? "project" : "global",
    projectDir: process.cwd(),
    serverName: values.name ?? DEFAULT_SERVER_NAME,
    dryRun,
    keepSkill: Boolean(values["keep-skill"]),
  });
  printReport(report, dryRun);
  out(`Your sign-in was kept; run \`${cliInvocation()} logout\` to remove it too.`);
}

function printSnippet(client: ClientId, serverName: string, command: string[]): void {
  const s = clientSnippet(client, serverName, command);
  out(`# ${s.title}\n# ${s.location}\n`);
  out(s.body);
  for (const n of s.notes) out(`\n# ${n}`);
}

async function cmdConfig(args: string[]): Promise<void> {
  const { values, positionals } = parse(args, { name: { type: "string" }, command: { type: "string" } }, true);
  const client = positionals[0] as ClientId | undefined;
  if (!client || !CLIENTS.includes(client)) fail(`Usage: config <client>. Clients: ${CLIENTS.join(", ")}.`, 2);
  printSnippet(client, values.name ?? DEFAULT_SERVER_NAME, values.command ? values.command.trim().split(/\s+/) : serverCommand());
  out(`\n# Skill source: ${SKILL_SOURCE_DIR}`);
}

async function cmdDoctor(args: string[]): Promise<void> {
  const { values } = parse(args, { name: { type: "string" } });
  const deps = cliDeps();
  const checks = await runDoctor(deps, { serverName: values.name ?? DEFAULT_SERVER_NAME, projectDir: process.cwd() });
  const mark = { ok: "✓", warn: "!", fail: "✗" } as const;
  for (const c of checks) out(`${mark[c.status]} ${c.name}: ${c.detail}`);
  if (checks.some((c) => c.status === "fail")) process.exitCode = 1;
}

async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  switch (command) {
    case undefined:
      if (!process.stdin.isTTY) return runStdioServer();
      out(HELP);
      out(`\nTip: MCP clients start this with \`${serverCommand().join(" ")}\`.`);
      return;
    case "serve":
      return runStdioServer();
    case "login":
      return cmdLogin(rest);
    case "logout":
      return cmdLogout(rest);
    case "status":
      return cmdStatus(rest);
    case "generate":
      return cmdGenerate(rest);
    case "remove-bg":
    case "remove-background":
      return cmdRemoveBg(rest);
    case "install":
      return cmdInstall(rest);
    case "uninstall":
      return cmdUninstall(rest);
    case "config":
      return cmdConfig(rest);
    case "doctor":
      return cmdDoctor(rest);
    case "help":
    case "--help":
    case "-h":
      out(HELP);
      return;
    case "version":
    case "--version":
    case "-v":
      out(VERSION);
      return;
    default:
      fail(`Unknown command "${command}". Run \`${PACKAGE_NAME} help\`.`, 2);
  }
}

main(process.argv.slice(2)).catch((err: unknown) => {
  const e = toImagegenError(err);
  process.stderr.write(`Error: ${describeError(e)}\n`);
  process.exit(e.kind === "cancelled" || e.kind === "login_cancelled" ? 130 : 1);
});
