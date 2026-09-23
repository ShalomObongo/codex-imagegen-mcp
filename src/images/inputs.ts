import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expandHome } from "../config.js";
import { MAX_INPUT_IMAGE_BYTES } from "../constants.js";
import { ImagegenError, toImagegenError } from "../errors.js";
import { formatBytes } from "../util/format.js";
import { anySignal } from "../util/http.js";
import { imageDimensions, sniffImageMime, type ImageMime } from "./codec.js";

/** Formats the image endpoints accept as inputs. */
const ACCEPTED: ReadonlySet<ImageMime> = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface LoadedImage {
  bytes: Buffer;
  mimeType: ImageMime;
  /** Display label: the resolved path, the URL, or "data URL". */
  label: string;
  path?: string;
  width?: number;
  height?: number;
  dataUrl: string;
}

export interface LoadOptions {
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  maxBytes?: number;
}

function finish(bytes: Buffer, label: string, maxBytes: number, filePath?: string): LoadedImage {
  if (bytes.length === 0) throw new ImagegenError("invalid_input", `Input image ${label} is empty.`);
  if (bytes.length > maxBytes) {
    throw new ImagegenError(
      "invalid_input",
      `Input image ${label} is ${formatBytes(bytes.length)}; the limit is ${formatBytes(maxBytes)}. Downscale or recompress it first.`,
    );
  }
  const mimeType = sniffImageMime(bytes);
  if (!mimeType) throw new ImagegenError("invalid_input", `Input ${label} is not a PNG, JPEG or WebP image.`);
  if (!ACCEPTED.has(mimeType)) {
    throw new ImagegenError("unsupported", `Input ${label} is ${mimeType}; only PNG, JPEG and WebP are accepted. Convert it to PNG first.`);
  }
  const loaded: LoadedImage = { bytes, mimeType, label, dataUrl: `data:${mimeType};base64,${bytes.toString("base64")}` };
  if (filePath) loaded.path = filePath;
  const dims = imageDimensions(bytes);
  if (dims) {
    loaded.width = dims.width;
    loaded.height = dims.height;
  }
  return loaded;
}

/**
 * Load an input image reference: a local path (absolute, `~/…`, or relative to `baseDir`),
 * a `file://` URL, an `http(s)://` URL, or a `data:image/…;base64,…` URL.
 */
export async function loadImageRef(ref: string, baseDir: string, options: LoadOptions = {}): Promise<LoadedImage> {
  const maxBytes = options.maxBytes ?? MAX_INPUT_IMAGE_BYTES;
  const value = ref.trim();
  if (!value) throw new ImagegenError("invalid_input", "Empty image reference.");

  if (/^data:/i.test(value)) {
    const m = /^data:([^;,]*)((?:;[^;,]*)*),(.*)$/is.exec(value);
    if (!m || !/;base64/i.test(m[2] ?? "")) {
      throw new ImagegenError("invalid_input", "Data URLs must be base64-encoded (data:image/png;base64,…).");
    }
    return finish(Buffer.from(m[3] ?? "", "base64"), "data URL", maxBytes);
  }

  if (/^https?:\/\//i.test(value)) {
    const fetchImpl = options.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(value, { signal: anySignal(options.signal, AbortSignal.timeout(60_000)) ?? null, redirect: "follow" });
    } catch (err) {
      throw toImagegenError(err, "network");
    }
    if (!res.ok) throw new ImagegenError("invalid_input", `Could not download ${value} (HTTP ${res.status}).`);
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (declared > maxBytes) {
      await res.body?.cancel().catch(() => undefined);
      throw new ImagegenError("invalid_input", `Image at ${value} is ${formatBytes(declared)}; the limit is ${formatBytes(maxBytes)}.`);
    }
    return finish(Buffer.from(await res.arrayBuffer()), value, maxBytes);
  }

  const localPath = /^file:\/\//i.test(value) ? fileURLToPath(value) : path.resolve(baseDir, expandHome(value));
  let stat;
  try {
    stat = await fs.stat(localPath);
  } catch {
    throw new ImagegenError("invalid_input", `Input image not found: ${localPath}`);
  }
  if (!stat.isFile()) throw new ImagegenError("invalid_input", `Input image is not a file: ${localPath}`);
  if (stat.size > maxBytes) {
    throw new ImagegenError(
      "invalid_input",
      `Input image ${localPath} is ${formatBytes(stat.size)}; the limit is ${formatBytes(maxBytes)}. Downscale or recompress it first.`,
    );
  }
  return finish(await fs.readFile(localPath), localPath, maxBytes, localPath);
}
