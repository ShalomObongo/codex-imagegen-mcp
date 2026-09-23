import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { RootsListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { AuthManager, authOptionsFromConfig } from "../auth/manager.js";
import { ImagesClient } from "../backend/images-client.js";
import { loadConfig, type RuntimeConfig } from "../config.js";
import { PACKAGE_NAME, VERSION } from "../constants.js";
import { History } from "../history.js";
import { createLogger, type Logger } from "../log.js";
import type { ServerDeps } from "./context.js";
import { SERVER_INSTRUCTIONS } from "./instructions.js";
import { LoginCoordinator } from "./login-coordinator.js";
import { registerPrompts } from "./prompts.js";
import { registerResources } from "./resources.js";
import { registerTools } from "./tools.js";
import { Workspace } from "./workspace.js";

export function createDeps(config: RuntimeConfig, logger: Logger, fetchImpl?: typeof fetch): ServerDeps {
  const auth = new AuthManager(authOptionsFromConfig(config, logger, fetchImpl));
  const imagesOptions: ConstructorParameters<typeof ImagesClient>[1] = {
    baseUrl: config.baseUrl,
    usageUrl: config.usageUrl,
    originator: config.originator,
    userAgent: config.userAgent,
    timeoutMs: config.requestTimeoutMs,
    logger,
  };
  if (fetchImpl) imagesOptions.fetchImpl = fetchImpl;
  const images = new ImagesClient(auth, imagesOptions);
  return {
    config,
    logger,
    auth,
    images,
    history: new History(config.historyFile),
    login: new LoginCoordinator({ config, auth, logger }),
  };
}

/** Build the MCP server (transport-agnostic, so tests can connect it in-memory). */
export function createImagegenServer(deps: ServerDeps): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, title: "Codex ImageGen", version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  const workspace = new Workspace(server.server, deps.logger);
  server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => workspace.invalidate());
  const ctx = { ...deps, workspace };
  registerTools(server, ctx);
  registerResources(server, ctx);
  registerPrompts(server);
  return server;
}

/** Entry point for `serve`: stdio transport with graceful shutdown. */
export async function runStdioServer(): Promise<void> {
  // stdout carries the protocol; make sure nothing else (e.g. a dependency) can write to it.
  console.log = console.error;
  console.info = console.error;
  console.debug = console.error;

  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, file: config.logFile, stderr: true });
  const deps = createDeps(config, logger);
  const server = createImagegenServer(deps);
  const transport = new StdioServerTransport();

  let closing = false;
  const shutdown = async (reason: string, code = 0) => {
    if (closing) return;
    closing = true;
    logger.info("shutting down", { reason });
    deps.login.cancel();
    setTimeout(() => process.exit(code), 2_000).unref();
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    process.exit(code);
  };
  server.server.onerror = (err) => logger.warn("protocol error", { message: err.message });
  server.server.onclose = () => void shutdown("transport closed");
  // The SDK transport does not react to stdin EOF; MCP clients stop servers by closing stdin.
  process.stdin.once("end", () => void shutdown("stdin ended"));
  process.stdin.once("close", () => void shutdown("stdin closed"));
  process.stdout.on("error", (err: NodeJS.ErrnoException) => void shutdown(`stdout ${err.code ?? err.message}`, err.code === "EPIPE" ? 0 : 1));
  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    logger.error("uncaught exception", { message: err.stack ?? err.message });
    void shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.error("unhandled rejection", { message: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason) });
  });

  await server.connect(transport);
  logger.info("server started", { version: VERSION, pid: process.pid, mode: config.credentialMode, home: config.home, baseUrl: config.baseUrl });
}
