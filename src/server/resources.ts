import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ErrorCode, McpError, type ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { SKILL_SOURCE_DIR } from "../constants.js";
import { buildPreview } from "../images/preview.js";
import type { ToolContext } from "./context.js";

const MAX_BLOB_BYTES = 8 * 1024 * 1024;

/** SKILL.md plus references/*.md of the bundled skill, as [relativePath, absolutePath]. */
export function skillFiles(dir = SKILL_SOURCE_DIR): [string, string][] {
  const files: [string, string][] = [];
  const main = path.join(dir, "SKILL.md");
  if (fs.existsSync(main)) files.push(["SKILL.md", main]);
  const refs = path.join(dir, "references");
  if (fs.existsSync(refs)) {
    for (const name of fs.readdirSync(refs).sort()) {
      if (name.endsWith(".md")) files.push([`references/${name}`, path.join(refs, name)]);
    }
  }
  return files;
}

export function registerResources(server: McpServer, ctx: ToolContext): void {
  server.registerResource(
    "history",
    "imagegen://history",
    {
      title: "Recent images",
      description: "JSON list of the 50 most recent images generated, edited or cut out by this server (newest first), with paths and prompts.",
      mimeType: "application/json",
    },
    async (uri): Promise<ReadResourceResult> => ({
      contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(await ctx.history.list(50), null, 2) }],
    }),
  );

  server.registerResource(
    "image",
    new ResourceTemplate("imagegen://images/{id}", {
      list: async () => ({
        resources: (await ctx.history.list(25)).map((e) => ({
          uri: `imagegen://images/${e.id}`,
          name: path.basename(e.path),
          mimeType: e.mime_type,
          ...(e.prompt ? { description: e.prompt.slice(0, 160) } : {}),
        })),
      }),
    }),
    { title: "Generated image", description: "A previously saved image, by id (see imagegen://history).", mimeType: "image/png" },
    async (uri, variables): Promise<ReadResourceResult> => {
      const id = String(variables.id ?? "");
      const entry = await ctx.history.get(id);
      if (!entry) throw new McpError(ErrorCode.InvalidParams, `Unknown image id: ${id}`);
      let bytes: Buffer;
      try {
        bytes = await fsp.readFile(entry.path);
      } catch {
        throw new McpError(ErrorCode.InvalidParams, `The file for ${id} no longer exists: ${entry.path}`);
      }
      if (bytes.length <= MAX_BLOB_BYTES) {
        return { contents: [{ uri: uri.href, mimeType: entry.mime_type, blob: bytes.toString("base64") }] };
      }
      const preview = buildPreview(bytes, 2048);
      if (!preview) throw new McpError(ErrorCode.InternalError, `Image ${id} is too large to return (${bytes.length} bytes).`);
      return { contents: [{ uri: uri.href, mimeType: preview.mimeType, blob: preview.data }] };
    },
  );

  for (const [relative, absolute] of skillFiles()) {
    server.registerResource(
      `skill:${relative}`,
      `imagegen://skill/${relative}`,
      {
        title: relative === "SKILL.md" ? "imagegen skill (how to use these tools well)" : `imagegen skill: ${relative}`,
        description:
          relative === "SKILL.md"
            ? "Workflow and prompting guidance for image generation. Read this if your client does not load Agent Skills."
            : "Reference material for the imagegen skill.",
        mimeType: "text/markdown",
      },
      async (uri): Promise<ReadResourceResult> => ({
        contents: [{ uri: uri.href, mimeType: "text/markdown", text: await fsp.readFile(absolute, "utf8") }],
      }),
    );
  }
}
