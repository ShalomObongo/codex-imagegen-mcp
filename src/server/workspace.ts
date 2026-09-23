import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Logger } from "../log.js";

/**
 * Resolves the directory relative paths are interpreted against: the client's first `file://`
 * root when the client supports MCP roots (opencode reports the project directory), otherwise the
 * process working directory (MCP clients usually spawn servers in the project directory). A
 * filesystem root (`/`, as some desktop apps use) falls back to the home directory.
 */
export class Workspace {
  private cached: string | undefined;

  constructor(
    private readonly server: Server,
    private readonly logger: Logger,
    private readonly cwd: string = process.cwd(),
  ) {}

  invalidate(): void {
    this.cached = undefined;
  }

  async baseDir(): Promise<string> {
    if (this.cached) return this.cached;
    let dir: string | undefined;
    if (this.server.getClientCapabilities()?.roots) {
      try {
        const { roots } = await this.server.listRoots(undefined, { timeout: 3_000 });
        const first = roots.find((r) => r.uri.startsWith("file://"));
        if (first) dir = fileURLToPath(first.uri);
      } catch (err) {
        this.logger.debug("roots/list failed; using cwd", { message: err instanceof Error ? err.message : String(err) });
      }
    }
    dir ??= this.cwd;
    if (path.parse(dir).root === dir) dir = os.homedir();
    this.cached = dir;
    return dir;
  }
}
