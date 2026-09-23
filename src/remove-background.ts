import fs from "node:fs/promises";
import path from "node:path";
import { expandHome } from "./config.js";
import { ImagegenError } from "./errors.js";
import type { History } from "./history.js";
import { removeChromaKey, parseHexColor, toHexColor, type ChromaKeyOptions } from "./images/chroma.js";
import { decodeImage, encodePng, type Rgb } from "./images/codec.js";
import { newImageId, writeImageFile } from "./images/output.js";
import { buildPreview, type Preview } from "./images/preview.js";
import type { Logger } from "./log.js";

export interface RemoveBackgroundRequest {
  inputPath: string;
  outputPath?: string;
  /** Hex color; when omitted the key is sampled from the image border. */
  keyColor?: string;
  tolerance?: number;
  softMatte: boolean;
  transparentThreshold?: number;
  opaqueThreshold?: number;
  despill: boolean;
  edgeContract?: number;
  edgeFeather?: number;
  overwrite: boolean;
  preview: boolean;
}

export interface RemoveBackgroundResult {
  id: string;
  inputPath: string;
  outputPath: string;
  width: number;
  height: number;
  bytes: number;
  keyColor: string;
  transparentPercent: number;
  partialPercent: number;
  warnings: string[];
  preview?: Preview;
}

export async function runRemoveBackground(
  deps: { history: History; logger: Logger },
  req: RemoveBackgroundRequest,
  ctx: { baseDir: string },
): Promise<RemoveBackgroundResult> {
  const inputPath = path.resolve(ctx.baseDir, expandHome(req.inputPath.trim()));
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(inputPath);
  } catch {
    throw new ImagegenError("invalid_input", `Input image not found: ${inputPath}`);
  }
  const image = decodeImage(bytes);

  let outputPath: string;
  if (req.outputPath?.trim()) {
    outputPath = path.resolve(ctx.baseDir, expandHome(req.outputPath.trim()));
    if (path.extname(outputPath).toLowerCase() !== ".png") {
      throw new ImagegenError("invalid_input", "output_path must end in .png so the alpha channel is preserved.");
    }
  } else {
    const ext = path.extname(inputPath);
    outputPath = `${inputPath.slice(0, inputPath.length - ext.length)}-transparent.png`;
  }
  if (outputPath === inputPath && !req.overwrite) {
    throw new ImagegenError("invalid_input", "output_path is the input file; pass overwrite=true to replace it.");
  }

  const options: ChromaKeyOptions = { softMatte: req.softMatte, spillCleanup: req.despill };
  if (req.keyColor?.trim()) {
    options.keyColor = parseHexColor(req.keyColor) as Rgb;
    options.autoKey = "none";
  } else {
    options.autoKey = "border";
  }
  if (req.tolerance !== undefined) options.tolerance = req.tolerance;
  if (req.transparentThreshold !== undefined) options.transparentThreshold = req.transparentThreshold;
  if (req.opaqueThreshold !== undefined) options.opaqueThreshold = req.opaqueThreshold;
  if (req.edgeContract !== undefined) options.edgeContract = req.edgeContract;
  if (req.edgeFeather !== undefined) options.edgeFeather = req.edgeFeather;

  const result = removeChromaKey(image, options);
  const png = encodePng(result.image);
  const finalPath = await writeImageFile(outputPath, png, req.overwrite);
  const warnings: string[] = [];
  const transparentPercent = (100 * result.transparent) / result.total;
  const partialPercent = (100 * result.partial) / result.total;
  if (result.keyedPixels === 0) {
    warnings.push(`No pixels matched the key color ${toHexColor(result.keyColor)}. Is the background a flat, uniform color? Pass key_color explicitly or raise tolerance.`);
  } else if (transparentPercent > 97) {
    warnings.push("Almost the whole image became transparent — the subject may be too close to the key color. Lower opaque_threshold/tolerance or pass key_color.");
  }

  const out: RemoveBackgroundResult = {
    id: newImageId(),
    inputPath,
    outputPath: finalPath,
    width: result.image.width,
    height: result.image.height,
    bytes: png.length,
    keyColor: toHexColor(result.keyColor),
    transparentPercent,
    partialPercent,
    warnings,
  };
  if (req.preview) {
    try {
      const preview = buildPreview(png);
      if (preview) out.preview = preview;
    } catch (err) {
      deps.logger.warn("preview failed", { message: err instanceof Error ? err.message : String(err) });
    }
  }
  await deps.history
    .append({
      id: out.id,
      created_at: new Date().toISOString(),
      tool: "remove_background",
      path: finalPath,
      mime_type: "image/png",
      bytes: png.length,
      width: out.width,
      height: out.height,
      inputs: [inputPath],
      background: "transparent",
    })
    .catch((err: unknown) => deps.logger.warn("history append failed", { message: String(err) }));
  return out;
}
