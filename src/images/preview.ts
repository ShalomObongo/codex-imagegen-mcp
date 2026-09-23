import { PREVIEW_MAX_EDGE } from "../constants.js";
import { decodeImage, encodeJpeg, hasTransparency, onCheckerboard, sniffImageMime } from "./codec.js";
import { resizeToFit } from "./resize.js";

export interface Preview {
  /** base64 (no data: prefix), as MCP image content expects. */
  data: string;
  mimeType: "image/jpeg";
  width: number;
  height: number;
  /** True when the source had transparency (rendered over a checkerboard). */
  transparent: boolean;
}

/**
 * Small JPEG preview for the model to look at. Keeps tool results far below MCP stdio message
 * limits (10 MB in the TypeScript SDK) and client attachment limits, while the full-resolution
 * file stays on disk. Transparent images are shown over a checkerboard so the cutout is visible.
 */
export function buildPreview(bytes: Uint8Array, maxEdge = PREVIEW_MAX_EDGE): Preview | undefined {
  const mime = sniffImageMime(bytes);
  if (mime !== "image/png" && mime !== "image/jpeg") return undefined;
  let img = decodeImage(bytes);
  const transparent = hasTransparency(img);
  if (transparent) img = onCheckerboard(img, Math.max(8, Math.round(Math.max(img.width, img.height) / 64)));
  img = resizeToFit(img, maxEdge);
  return { data: encodeJpeg(img, 82).toString("base64"), mimeType: "image/jpeg", width: img.width, height: img.height, transparent };
}
