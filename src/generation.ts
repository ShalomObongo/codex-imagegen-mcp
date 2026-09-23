import type { Background, ImagesClient } from "./backend/images-client.js";
import type { RuntimeConfig } from "./config.js";
import { MAX_INPUT_IMAGES, MAX_VARIANTS } from "./constants.js";
import { ImagegenError, toImagegenError } from "./errors.js";
import type { History, HistoryTool } from "./history.js";
import { decodeImage, encodeJpeg, encodePng, flatten, hasTransparency, imageDimensions, sniffImageMime } from "./images/codec.js";
import { loadImageRef, type LoadedImage } from "./images/inputs.js";
import { newImageId, planOutputs, writeImageFile, type OutputFormat } from "./images/output.js";
import { buildPreview, type Preview } from "./images/preview.js";
import type { Logger } from "./log.js";

export const ASPECT_RATIOS = ["auto", "1:1", "4:5", "5:4", "4:3", "3:4", "3:2", "2:3", "16:9", "9:16", "21:9", "9:21"] as const;
export type AspectRatio = (typeof ASPECT_RATIOS)[number];

const ASPECT_WORDS: Record<Exclude<AspectRatio, "auto">, string> = {
  "1:1": "square",
  "4:5": "portrait (vertical)",
  "5:4": "landscape (horizontal)",
  "4:3": "landscape (horizontal)",
  "3:4": "portrait (vertical)",
  "3:2": "landscape (horizontal)",
  "2:3": "portrait (vertical)",
  "16:9": "wide landscape (horizontal)",
  "9:16": "tall portrait (vertical)",
  "21:9": "ultra-wide landscape (horizontal)",
  "9:21": "ultra-tall portrait (vertical)",
};

/**
 * The ChatGPT image service ignores the `size` parameter and derives the canvas from the prompt
 * (e.g. "9:16" produced 941x1672). So an aspect ratio is expressed as an explicit prompt line.
 */
export function applyAspectRatio(prompt: string, ratio: AspectRatio | undefined): string {
  if (!ratio || ratio === "auto") return prompt;
  return `${prompt.trimEnd()}\n\nAspect ratio: ${ratio}, ${ASPECT_WORDS[ratio]} canvas.`;
}

export interface GenerationRequest {
  tool: Extract<HistoryTool, "generate_image" | "edit_image">;
  prompt: string;
  /** Input image references; non-empty => edit endpoint. */
  imageRefs?: readonly string[];
  aspectRatio?: AspectRatio;
  background: Background;
  n: number;
  outputPath?: string;
  outputFormat?: OutputFormat;
  overwrite: boolean;
  preview: boolean;
}

export interface GenerationDeps {
  images: ImagesClient;
  history: History;
  config: RuntimeConfig;
  logger: Logger;
}

export interface SavedImage {
  id: string;
  path: string;
  mimeType: string;
  bytes: number;
  width?: number;
  height?: number;
  background?: string;
  transparent?: boolean;
  serviceSize?: string;
  serviceQuality?: string;
  requestId?: string;
  generationId?: string;
  elapsedMs: number;
  preview?: Preview;
}

export interface GenerationResult {
  saved: SavedImage[];
  failures: ImagegenError[];
  promptSent: string;
  inputs: LoadedImage[];
  warnings: string[];
  elapsedMs: number;
}

export interface GenerationContext {
  baseDir: string;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

function validate(req: GenerationRequest): void {
  if (!req.prompt.trim()) throw new ImagegenError("invalid_input", "prompt must not be empty.");
  if (!Number.isInteger(req.n) || req.n < 1 || req.n > MAX_VARIANTS) {
    throw new ImagegenError("invalid_input", `n must be an integer between 1 and ${MAX_VARIANTS}.`);
  }
  const refs = req.imageRefs ?? [];
  if (req.tool === "edit_image" && refs.length === 0) throw new ImagegenError("invalid_input", "edit_image needs at least one input image.");
  if (refs.length > MAX_INPUT_IMAGES) throw new ImagegenError("invalid_input", `At most ${MAX_INPUT_IMAGES} input images are supported.`);
  const jpegRequested = req.outputFormat === "jpeg" || /\.jpe?g$/i.test(req.outputPath ?? "");
  if (req.background === "transparent" && jpegRequested) {
    throw new ImagegenError("invalid_input", "JPEG cannot store transparency: use a .png output for background=\"transparent\".");
  }
}

/** Convert the service's bytes to the requested container, if needed. */
function encodeFor(bytes: Buffer, format: OutputFormat): { data: Buffer; mimeType: string; warning?: string } {
  const mime = sniffImageMime(bytes) ?? "image/png";
  if (format === "png" && mime === "image/png") return { data: bytes, mimeType: mime };
  if (format === "jpeg" && mime === "image/jpeg") return { data: bytes, mimeType: mime };
  const img = decodeImage(bytes);
  if (format === "jpeg") {
    const flattened = hasTransparency(img) ? flatten(img, [255, 255, 255]) : img;
    return { data: encodeJpeg(flattened, 92), mimeType: "image/jpeg" };
  }
  return { data: encodePng(img), mimeType: "image/png" };
}

/**
 * Generate or edit images: load inputs, fire `n` concurrent requests, save each result as soon as
 * it arrives (so partial success is kept), record history, and build previews.
 */
export async function runGeneration(deps: GenerationDeps, req: GenerationRequest, ctx: GenerationContext): Promise<GenerationResult> {
  validate(req);
  const started = Date.now();
  const inputs = await Promise.all((req.imageRefs ?? []).map((ref) => loadImageRef(ref, ctx.baseDir, ctx.signal ? { signal: ctx.signal } : {})));
  const promptSent = applyAspectRatio(req.prompt, req.aspectRatio);
  const planOptions: Parameters<typeof planOutputs>[0] = {
    baseDir: ctx.baseDir,
    defaultDir: deps.config.outputDir,
    label: req.prompt,
    count: req.n,
  };
  if (req.outputPath) planOptions.outputPath = req.outputPath;
  if (req.outputFormat) planOptions.format = req.outputFormat;
  const plans = await planOutputs(planOptions);

  const warnings: string[] = [];
  const saved: SavedImage[] = [];
  const failures: ImagegenError[] = [];
  let completed = 0;

  await Promise.all(
    plans.map(async (plan, index) => {
      try {
        const requestOptions: { signal?: AbortSignal } = {};
        if (ctx.signal) requestOptions.signal = ctx.signal;
        const created = await deps.images.createImage(
          { prompt: promptSent, background: req.background, images: inputs.map((i) => ({ dataUrl: i.dataUrl })) },
          requestOptions,
        );
        const encoded = encodeFor(created.bytes, plan.format);
        const finalPath = await writeImageFile(plan.path, encoded.data, req.overwrite);
        const image: SavedImage = {
          id: newImageId(),
          path: finalPath,
          mimeType: encoded.mimeType,
          bytes: encoded.data.length,
          elapsedMs: created.elapsedMs,
        };
        const dims = imageDimensions(encoded.data);
        if (dims) {
          image.width = dims.width;
          image.height = dims.height;
        }
        if (created.background) image.background = created.background;
        if (created.size) image.serviceSize = created.size;
        if (created.quality) image.serviceQuality = created.quality;
        if (created.requestId) image.requestId = created.requestId;
        if (created.generationId) image.generationId = created.generationId;
        if (req.background === "transparent") {
          try {
            image.transparent = hasTransparency(decodeImage(encoded.data));
          } catch {
            /* leave undefined */
          }
          if (image.transparent === false) {
            warnings.push(
              `${finalPath} came back fully opaque although a transparent background was requested. Try again, or generate on a flat solid-color backdrop and use remove_background.`,
            );
          }
        }
        if (req.preview) {
          try {
            const preview = buildPreview(encoded.data);
            if (preview) image.preview = preview;
          } catch (err) {
            deps.logger.warn("preview failed", { message: err instanceof Error ? err.message : String(err) });
          }
        }
        saved[index] = image;
        const entry: Parameters<History["append"]>[0] = {
          id: image.id,
          created_at: new Date().toISOString(),
          tool: req.tool,
          path: finalPath,
          mime_type: image.mimeType,
          bytes: image.bytes,
          prompt: promptSent,
          elapsed_ms: created.elapsedMs,
          credential_source: created.credentialSource,
        };
        if (image.width !== undefined) entry.width = image.width;
        if (image.height !== undefined) entry.height = image.height;
        if (inputs.length > 0) entry.inputs = inputs.map((i) => i.label);
        if (image.background) entry.background = image.background;
        if (image.serviceSize) entry.service_size = image.serviceSize;
        if (image.serviceQuality) entry.service_quality = image.serviceQuality;
        if (image.requestId) entry.request_id = image.requestId;
        if (image.generationId) entry.generation_id = image.generationId;
        await deps.history.append(entry).catch((err: unknown) => deps.logger.warn("history append failed", { message: String(err) }));
      } catch (err) {
        failures[index] = toImagegenError(err);
      } finally {
        completed++;
        if (req.n > 1) ctx.onProgress?.(`${completed}/${req.n} images finished`);
      }
    }),
  );

  return {
    saved: saved.filter(Boolean),
    failures: failures.filter(Boolean),
    promptSent,
    inputs,
    warnings,
    elapsedMs: Date.now() - started,
  };
}
