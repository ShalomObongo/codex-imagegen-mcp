import type { AuthManager } from "../auth/manager.js";
import type { ImagesClient } from "../backend/images-client.js";
import type { RuntimeConfig } from "../config.js";
import type { History } from "../history.js";
import type { Logger } from "../log.js";
import type { LoginCoordinator } from "./login-coordinator.js";
import type { Workspace } from "./workspace.js";

/** Long-lived dependencies shared by every tool handler. */
export interface ServerDeps {
  config: RuntimeConfig;
  logger: Logger;
  auth: AuthManager;
  images: ImagesClient;
  history: History;
  login: LoginCoordinator;
}

/** Per-connection context. */
export interface ToolContext extends ServerDeps {
  workspace: Workspace;
}
