import fs from "node:fs";
import path from "node:path";
import { PACKAGE_NAME } from "../constants.js";

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function quoteArg(arg: string): string {
  return /^[\w@%+=:,./-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export type InvocationKind = "npx" | "global" | "local";

/** Figure out how this CLI was launched so hints and installers can reproduce it. */
export function detectInvocation(argv: readonly string[] = process.argv): { kind: InvocationKind; script: string } {
  const script = argv[1] ?? "";
  const real = script ? realpathOrSelf(script) : "";
  if (real.split(path.sep).includes("_npx")) return { kind: "npx", script: real };
  if (script && path.basename(script) === PACKAGE_NAME) return { kind: "global", script: real };
  return { kind: "local", script: real };
}

/** Command prefix for user-facing hints, e.g. `codex-imagegen-mcp` or `node "/abs/dist/src/cli.js"`. */
export function cliInvocation(argv: readonly string[] = process.argv): string {
  const { kind, script } = detectInvocation(argv);
  if (kind === "npx") return `npx -y ${PACKAGE_NAME}`;
  if (kind === "global" || !script.endsWith(".js")) return PACKAGE_NAME;
  return `node ${quoteArg(script)}`;
}

/** argv an MCP client should spawn to start this server over stdio. */
export function serverCommand(argv: readonly string[] = process.argv): string[] {
  const { kind, script } = detectInvocation(argv);
  if (kind === "npx") return ["npx", "-y", `${PACKAGE_NAME}@latest`, "serve"];
  if (kind === "global") return [PACKAGE_NAME, "serve"];
  return ["node", script, "serve"];
}
