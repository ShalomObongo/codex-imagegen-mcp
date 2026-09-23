import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { MAX_INPUT_IMAGES, MAX_VARIANTS } from "../constants.js";
import { describeError, ImagegenError, toImagegenError } from "../errors.js";
import { ASPECT_RATIOS, runGeneration, type GenerationRequest, type GenerationResult, type SavedImage } from "../generation.js";
import { runRemoveBackground } from "../remove-background.js";
import { collectStatus, formatStatus } from "../status.js";
import { formatBytes, formatSeconds, formatWhen } from "../util/format.js";
import { cliInvocation } from "../util/invocation.js";
import type { ToolContext } from "./context.js";
import { startProgress, type ToolExtra } from "./progress.js";

// NOTE: some clients strip JSON-Schema constraints (min/max/default) before showing tools to the
// model (opencode does for OpenAI models), so every constraint is also stated in the description.

const backgroundField = z
  .enum(["auto", "transparent", "opaque"])
  .default("auto")
  .describe(
    'Background: "transparent" returns a PNG with a real alpha channel (cutouts, sprites, icons, stickers, logos); "opaque" forces a filled background; "auto" (default) lets the service decide.',
  );

const aspectRatioField = z
  .enum(ASPECT_RATIOS)
  .default("auto")
  .describe(
    "Canvas shape: auto (default), 1:1, 4:5, 5:4, 4:3, 3:4, 3:2, 2:3, 16:9, 9:16, 21:9 or 9:21. The service chooses the exact pixel size from the prompt; this adds an explicit aspect-ratio line to it.",
  );

const nField = z
  .number()
  .int()
  .min(1)
  .max(MAX_VARIANTS)
  .default(1)
  .describe(
    `Number of variants of this same prompt, 1-${MAX_VARIANTS} (default 1). Each variant is a separate request against the user's ChatGPT image quota. For several different assets make one call per asset instead.`,
  );

const outputPathField = z
  .string()
  .optional()
  .describe(
    "Where to save: a .png/.jpg/.jpeg file path or a directory, absolute or relative to the workspace root. Omit to save in the server's image library (outside the project). Existing files are never replaced unless overwrite=true (a -2, -3… sibling is used instead); with n>1 a -1, -2… suffix is added.",
  );

const outputFormatField = z
  .enum(["png", "jpeg"])
  .optional()
  .describe("File format: png (default) or jpeg (converted locally; cannot be transparent). Inferred from output_path's extension when given.");

const overwriteField = z.boolean().default(false).describe("Replace an existing file at output_path (default false).");

const previewField = z
  .boolean()
  .default(true)
  .describe("Attach a downscaled preview so you can check the result visually (default true). Set false to save tokens.");

const savedImageSchema = z.object({
  id: z.string(),
  path: z.string(),
  mime_type: z.string(),
  bytes: z.number().int(),
  width: z.number().int().optional(),
  height: z.number().int().optional(),
  background: z.string().optional(),
  transparent: z.boolean().optional(),
});

const generationOutputShape = {
  images: z.array(savedImageSchema).describe("Saved images (full resolution)."),
  prompt: z.string().describe("The exact prompt sent to the image service."),
  elapsed_ms: z.number(),
  failures: z.array(z.string()).describe("Errors for variants that failed (partial success)."),
  warnings: z.array(z.string()),
};

function errorResult(err: ImagegenError, others: readonly ImagegenError[] = []): CallToolResult {
  const extra = others.filter((o) => o.message !== err.message).map((o) => describeError(o));
  return { isError: true, content: [{ type: "text", text: [describeError(err), ...extra].join("\n") }] };
}

function imageLine(s: SavedImage, index: number, total: number): string {
  const dims = s.width && s.height ? `${s.width}×${s.height}` : "unknown size";
  const format = s.mimeType === "image/jpeg" ? "JPEG" : "PNG";
  const bg =
    s.transparent === true
      ? "transparent background (alpha verified)"
      : s.transparent === false
        ? "OPAQUE (transparency was requested)"
        : s.background === "transparent"
          ? "transparent background"
          : "opaque background";
  return `${total > 1 ? `${index + 1}. ` : ""}${s.path} — ${dims} ${format}, ${formatBytes(s.bytes)}, ${bg} (id ${s.id})`;
}

function generationResultToTool(result: GenerationResult, req: GenerationRequest): CallToolResult {
  const verb = req.tool === "edit_image" ? "Edited" : "Generated";
  const count = result.saved.length;
  const lines = [
    `${verb} ${count} image${count === 1 ? "" : "s"} in ${formatSeconds(result.elapsedMs)} with the ChatGPT image service (your ChatGPT plan; no API key).`,
    ...result.saved.map((s, i) => imageLine(s, i, result.saved.length)),
  ];
  if (result.failures.length > 0) {
    lines.push(`${result.failures.length} of ${req.n} requests failed: ${[...new Set(result.failures.map((f) => describeError(f)))].join(" | ")}`);
  }
  for (const w of result.warnings) lines.push(`Warning: ${w}`);
  const previews = result.saved.filter((s) => s.preview);
  if (previews.length > 0) {
    lines.push(
      `${previews.length === 1 ? "A downscaled preview is" : "Downscaled previews are"} attached${previews.some((p) => p.preview?.transparent) ? " (transparent areas shown as a checkerboard)" : ""}. Check subject, composition, text and constraints before finishing.`,
    );
  }
  lines.push(
    req.outputPath
      ? "Tell the user where the file(s) were saved."
      : "Saved in the image library outside the project. If this asset belongs in the project, copy it into the workspace (or call again with output_path). Tell the user where it was saved.",
  );
  const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
  for (const s of previews) if (s.preview) content.push({ type: "image", data: s.preview.data, mimeType: s.preview.mimeType });
  return {
    content,
    structuredContent: {
      images: result.saved.map((s) => {
        const o: z.infer<typeof savedImageSchema> = { id: s.id, path: s.path, mime_type: s.mimeType, bytes: s.bytes };
        if (s.width !== undefined) o.width = s.width;
        if (s.height !== undefined) o.height = s.height;
        if (s.background) o.background = s.background;
        if (s.transparent !== undefined) o.transparent = s.transparent;
        return o;
      }),
      prompt: result.promptSent,
      elapsed_ms: result.elapsedMs,
      failures: result.failures.map((f) => f.message),
      warnings: result.warnings,
    },
  };
}

async function runGenerationTool(ctx: ToolContext, req: GenerationRequest, extra: ToolExtra): Promise<CallToolResult> {
  const progress = startProgress(extra, req.tool === "edit_image" ? "Editing image" : "Generating image");
  try {
    const baseDir = await ctx.workspace.baseDir();
    const result = await runGeneration(ctx, req, { baseDir, signal: extra.signal, onProgress: progress.update });
    if (result.saved.length === 0) {
      const [first, ...rest] = result.failures;
      return errorResult(first ?? new ImagegenError("internal", "No image was produced."), rest);
    }
    return generationResultToTool(result, req);
  } catch (err) {
    return errorResult(toImagegenError(err));
  } finally {
    progress.stop();
  }
}

export function registerTools(server: McpServer, ctx: ToolContext): void {
  server.registerTool(
    "generate_image",
    {
      title: "Generate image",
      description:
        "Generate a new raster image (photo, illustration, texture, sprite, mockup, icon, product shot…) from a text prompt, using the user's ChatGPT plan — the same image service as OpenAI Codex's built-in image tool, no API key. Saves the full-resolution file and returns its path plus a preview. The service chooses resolution and quality; steer orientation with aspect_ratio or in the prompt. Use background=\"transparent\" for assets that need real alpha. Typically takes 15-60 s.",
      inputSchema: {
        prompt: z
          .string()
          .min(1)
          .max(32000)
          .describe("Full image description. Structure it: use case, subject, style/medium, composition, lighting, palette, exact text in quotes, constraints/avoid."),
        aspect_ratio: aspectRatioField,
        background: backgroundField,
        n: nField,
        output_path: outputPathField,
        output_format: outputFormatField,
        overwrite: overwriteField,
        include_preview: previewField,
      },
      outputSchema: generationOutputShape,
      annotations: { title: "Generate image", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const req: GenerationRequest = {
        tool: "generate_image",
        prompt: args.prompt,
        aspectRatio: args.aspect_ratio,
        background: args.background,
        n: args.n,
        overwrite: args.overwrite,
        preview: args.include_preview,
      };
      if (args.output_path) req.outputPath = args.output_path;
      if (args.output_format) req.outputFormat = args.output_format;
      return runGenerationTool(ctx, req, extra);
    },
  );

  server.registerTool(
    "edit_image",
    {
      title: "Edit image",
      description: `Edit or transform existing images, or create a new image guided by reference images, using the user's ChatGPT plan (no API key). Pass 1-${MAX_INPUT_IMAGES} images; refer to them in the prompt as Image 1, Image 2… (Image 1 is the primary edit target). State exactly what must change AND what must stay unchanged. Good for background replacement or removal, object removal/insertion, restyling, relighting, text localization, compositing and sketch-to-render. The input file is never modified; the result is saved as a new file.`,
      inputSchema: {
        images: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_INPUT_IMAGES)
          .describe(`1-${MAX_INPUT_IMAGES} input images: local file paths (absolute, ~/…, or relative to the workspace root), http(s) URLs, or data:image/…;base64 URLs. PNG, JPEG or WebP, up to 15 MB each.`),
        prompt: z
          .string()
          .min(1)
          .max(32000)
          .describe('Edit instructions, e.g. "Image 1: replace only the sky with a warm sunset; keep the building, people and framing unchanged."'),
        aspect_ratio: aspectRatioField,
        background: backgroundField,
        n: nField,
        output_path: outputPathField,
        output_format: outputFormatField,
        overwrite: overwriteField,
        include_preview: previewField,
      },
      outputSchema: generationOutputShape,
      annotations: { title: "Edit image", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args, extra) => {
      const req: GenerationRequest = {
        tool: "edit_image",
        prompt: args.prompt,
        imageRefs: args.images,
        aspectRatio: args.aspect_ratio,
        background: args.background,
        n: args.n,
        overwrite: args.overwrite,
        preview: args.include_preview,
      };
      if (args.output_path) req.outputPath = args.output_path;
      if (args.output_format) req.outputFormat = args.output_format;
      return runGenerationTool(ctx, req, extra);
    },
  );

  server.registerTool(
    "remove_background",
    {
      title: "Remove flat background (chroma key)",
      description:
        "Locally remove a flat, solid-color background from a PNG/JPEG and save a transparent PNG — no network, no quota. Use for images with a uniform backdrop (e.g. generated \"on a flat pure #00ff00 background\"), or to clean up a cutout. The key color is sampled from the image border unless key_color is given. Prefer background=\"transparent\" on generate_image/edit_image when creating new assets.",
      inputSchema: {
        input_path: z.string().min(1).describe("PNG or JPEG to process (absolute or relative to the workspace root)."),
        output_path: z.string().optional().describe("Destination .png (default: <input>-transparent.png next to the input). Never overwrites unless overwrite=true."),
        key_color: z.string().optional().describe("Background color to remove as hex, e.g. #00ff00. Default: auto-detected from the image border."),
        soft_matte: z.boolean().default(true).describe("Smooth alpha ramp for anti-aliased edges (default true). false = hard key using tolerance."),
        despill: z.boolean().default(true).describe("Remove key-color fringe/spill on edge pixels (default true)."),
        tolerance: z.number().int().min(0).max(255).optional().describe("Hard-key per-channel tolerance 0-255 (default 12; used when soft_matte=false)."),
        transparent_threshold: z.number().min(0).max(255).optional().describe("Soft matte: color distance at or below which pixels become fully transparent (default 12)."),
        opaque_threshold: z.number().min(0).max(255).optional().describe("Soft matte: color distance at or above which pixels stay fully opaque (default 96)."),
        edge_contract: z.number().int().min(0).max(16).optional().describe("Shrink the matte by this many pixels before feathering, 0-16 (default 0)."),
        edge_feather: z.number().min(0).max(64).optional().describe("Blur radius for softened alpha edges, 0-64 (default 0)."),
        overwrite: overwriteField,
        include_preview: previewField,
      },
      annotations: { title: "Remove flat background", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      try {
        const baseDir = await ctx.workspace.baseDir();
        const req: Parameters<typeof runRemoveBackground>[1] = {
          inputPath: args.input_path,
          softMatte: args.soft_matte,
          despill: args.despill,
          overwrite: args.overwrite,
          preview: args.include_preview,
        };
        if (args.output_path) req.outputPath = args.output_path;
        if (args.key_color) req.keyColor = args.key_color;
        if (args.tolerance !== undefined) req.tolerance = args.tolerance;
        if (args.transparent_threshold !== undefined) req.transparentThreshold = args.transparent_threshold;
        if (args.opaque_threshold !== undefined) req.opaqueThreshold = args.opaque_threshold;
        if (args.edge_contract !== undefined) req.edgeContract = args.edge_contract;
        if (args.edge_feather !== undefined) req.edgeFeather = args.edge_feather;
        const r = await runRemoveBackground(ctx, req, { baseDir });
        const lines = [
          `Saved transparent PNG: ${r.outputPath} — ${r.width}×${r.height}, ${formatBytes(r.bytes)} (id ${r.id}).`,
          `Removed key color ${r.keyColor}: ${r.transparentPercent.toFixed(1)}% fully transparent, ${r.partialPercent.toFixed(1)}% soft edge pixels.`,
          ...r.warnings.map((w) => `Warning: ${w}`),
        ];
        if (r.preview) lines.push("Preview attached (transparent areas shown as a checkerboard).");
        const content: CallToolResult["content"] = [{ type: "text", text: lines.join("\n") }];
        if (r.preview) content.push({ type: "image", data: r.preview.data, mimeType: r.preview.mimeType });
        return { content };
      } catch (err) {
        return errorResult(toImagegenError(err));
      }
    },
  );

  server.registerTool(
    "auth_status",
    {
      title: "Sign-in and quota status",
      description:
        "Show whether image generation is signed in, which ChatGPT account/plan and credential source is used, and the current usage-limit windows. Costs no image quota. Call this when a tool reports an auth or quota problem, or after sign_in.",
      inputSchema: {
        check_usage: z.boolean().default(true).describe("Also fetch current usage/quota from ChatGPT (default true)."),
      },
      annotations: { title: "Sign-in status", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args, extra) => {
      try {
        const options: Parameters<typeof collectStatus>[1] = { checkUsage: args.check_usage, signal: extra.signal };
        const pending = ctx.login.pendingLogin;
        if (pending) options.pendingLogin = pending;
        const last = ctx.login.lastOutcome;
        if (last) options.lastLogin = last;
        const report = await collectStatus(ctx, options);
        return { content: [{ type: "text", text: formatStatus(report) }] };
      } catch (err) {
        return errorResult(toImagegenError(err));
      }
    },
  );

  server.registerTool(
    "sign_in",
    {
      title: "Sign in with ChatGPT",
      description:
        "Start signing this image server in to the user's ChatGPT account (required once before generating, unless an existing Codex/opencode ChatGPT sign-in is detected). Returns a link (browser method) or a code (device method) that the USER must open or enter — relay it verbatim. Sign-in completes in the background; afterwards call auth_status to confirm.",
      inputSchema: {
        method: z
          .enum(["browser", "device"])
          .default("browser")
          .describe('"browser" (default): the user opens a link on THIS machine (redirects to localhost:1455). "device": the user enters a code at auth.openai.com/codex/device from any device — use for remote/headless machines.'),
        open_browser: z.boolean().default(true).describe("Try to open the link in the local browser automatically (browser method; default true)."),
        force: z.boolean().default(false).describe("Start a new sign-in even if already signed in (e.g. to switch accounts). Default false."),
      },
      annotations: { title: "Sign in", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        if (!args.force) {
          const own = (await ctx.auth.inspect()).find((s) => s.source === "own");
          if (own && (own.state === "ready" || own.state === "refreshable")) {
            const who = own.identity?.email ? ` as ${own.identity.email}` : "";
            return { content: [{ type: "text", text: `Already signed in${who}. Pass force=true to sign in again (for example with a different account).` }] };
          }
        }
        const { info, reused, browserOpened } = await ctx.login.start(args.method, { openBrowser: args.open_browser });
        const expires = info.expiresAt ? ` It expires ${formatWhen(info.expiresAt)}.` : "";
        const text =
          info.method === "device"
            ? [
                `${reused ? "A device-code sign-in is already in progress." : "Device-code sign-in started."} Ask the user to open ${info.url} on any device, sign in to ChatGPT and enter this code: ${info.userCode ?? "?"}${expires}`,
                "(If ChatGPT says device codes are disabled, enable “device code authorization for Codex” in ChatGPT → Settings → Security, or use method=\"browser\".)",
                "When the user has approved it, call auth_status to confirm.",
              ].join("\n")
            : [
                `${reused ? "A browser sign-in is already in progress." : "Browser sign-in started."} Ask the user to open this link and sign in with their ChatGPT account:`,
                info.url,
                `${browserOpened ? "(It was also opened in the default browser on this machine.) " : ""}The browser must run on the same machine as this server, because the sign-in redirects to http://localhost:1455.${expires}`,
                `On a remote or headless machine use method="device", or run \`${cliInvocation()} login --device\` in a terminal.`,
                "When the user has finished, call auth_status to confirm.",
              ].join("\n");
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return errorResult(toImagegenError(err, "login_failed"));
      }
    },
  );
}
