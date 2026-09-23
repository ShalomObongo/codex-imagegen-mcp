import jpeg from "jpeg-js";
import pngjs from "pngjs";
import { ImagegenError } from "../errors.js";

const { PNG } = pngjs;

/** 8-bit RGBA pixels, row-major. */
export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export type ImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type Rgb = [number, number, number];

function ascii(b: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...b.subarray(start, end));
}

/** Identify an image by its magic bytes (never trust file extensions). */
export function sniffImageMime(b: Uint8Array): ImageMime | undefined {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 6 && (ascii(b, 0, 6) === "GIF87a" || ascii(b, 0, 6) === "GIF89a")) return "image/gif";
  return undefined;
}

export function extensionForMime(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    default:
      return ".png";
  }
}

/** Width/height from the header only (PNG, JPEG, WebP, GIF) — no full decode. */
export function imageDimensions(b: Uint8Array): { width: number; height: number } | undefined {
  const mime = sniffImageMime(b);
  const u16le = (i: number) => (b[i] ?? 0) | ((b[i + 1] ?? 0) << 8);
  const u24le = (i: number) => u16le(i) | ((b[i + 2] ?? 0) << 16);
  const u16be = (i: number) => ((b[i] ?? 0) << 8) | (b[i + 1] ?? 0);
  const u32be = (i: number) => (((b[i] ?? 0) << 24) >>> 0) + (((b[i + 1] ?? 0) << 16) | ((b[i + 2] ?? 0) << 8) | (b[i + 3] ?? 0));
  if (mime === "image/png" && b.length >= 24) return { width: u32be(16), height: u32be(20) };
  if (mime === "image/gif" && b.length >= 10) return { width: u16le(6), height: u16le(8) };
  if (mime === "image/webp" && b.length >= 30) {
    const chunk = ascii(b, 12, 16);
    if (chunk === "VP8 ") return { width: u16le(26) & 0x3fff, height: u16le(28) & 0x3fff };
    if (chunk === "VP8L") {
      const b1 = b[21] ?? 0;
      const b2 = b[22] ?? 0;
      const b3 = b[23] ?? 0;
      const b4 = b[24] ?? 0;
      return { width: 1 + (((b2 & 0x3f) << 8) | b1), height: 1 + (((b4 & 0x0f) << 10) | (b3 << 2) | ((b2 & 0xc0) >> 6)) };
    }
    if (chunk === "VP8X") return { width: 1 + u24le(24), height: 1 + u24le(27) };
    return undefined;
  }
  if (mime === "image/jpeg") {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = b[i + 1] ?? 0;
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      const length = u16be(i + 2);
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: u16be(i + 5), width: u16be(i + 7) };
      if (length < 2) return undefined;
      i += 2 + length;
    }
  }
  return undefined;
}

export function decodeImage(bytes: Uint8Array): RgbaImage {
  const mime = sniffImageMime(bytes);
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (mime === "image/png") {
      const png = PNG.sync.read(buf);
      return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength) };
    }
    if (mime === "image/jpeg") {
      const img = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, maxMemoryUsageInMB: 1024, maxResolutionInMP: 150 });
      return { width: img.width, height: img.height, data: img.data };
    }
  } catch (err) {
    throw new ImagegenError("invalid_input", `Could not decode the image: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  throw new ImagegenError(
    "unsupported",
    `Only PNG and JPEG images can be processed locally${mime ? ` (got ${mime})` : ""}. Convert the image to PNG first.`,
  );
}

export function hasTransparency(img: RgbaImage): boolean {
  const d = img.data;
  for (let i = 3; i < d.length; i += 4) if (d[i]! < 255) return true;
  return false;
}

export function alphaStats(img: RgbaImage): { total: number; transparent: number; partial: number } {
  const d = img.data;
  let transparent = 0;
  let partial = 0;
  for (let i = 3; i < d.length; i += 4) {
    const a = d[i]!;
    if (a === 0) transparent++;
    else if (a < 255) partial++;
  }
  return { total: img.width * img.height, transparent, partial };
}

export function encodePng(img: RgbaImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength);
  return PNG.sync.write(png, { colorType: hasTransparency(img) ? 6 : 2, deflateLevel: 6 });
}

/** JPEG has no alpha: callers should flatten first (alpha is ignored here). */
export function encodeJpeg(img: RgbaImage, quality = 90): Buffer {
  const out = jpeg.encode({ data: img.data, width: img.width, height: img.height }, quality);
  return Buffer.from(out.data);
}

/** Composite over a solid color. */
export function flatten(img: RgbaImage, [br, bg, bb]: Rgb): RgbaImage {
  const src = img.data;
  const out = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i += 4) {
    const a = src[i + 3]! / 255;
    out[i] = Math.round(src[i]! * a + br * (1 - a));
    out[i + 1] = Math.round(src[i + 1]! * a + bg * (1 - a));
    out[i + 2] = Math.round(src[i + 2]! * a + bb * (1 - a));
    out[i + 3] = 255;
  }
  return { width: img.width, height: img.height, data: out };
}

/** Composite over a light checkerboard so transparency is visible in a preview. */
export function onCheckerboard(img: RgbaImage, cell = 16): RgbaImage {
  const { width, height, data: src } = img;
  const out = new Uint8Array(src.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const c = ((Math.floor(x / cell) + Math.floor(y / cell)) & 1) === 0 ? 255 : 204;
      const a = src[i + 3]! / 255;
      out[i] = Math.round(src[i]! * a + c * (1 - a));
      out[i + 1] = Math.round(src[i + 1]! * a + c * (1 - a));
      out[i + 2] = Math.round(src[i + 2]! * a + c * (1 - a));
      out[i + 3] = 255;
    }
  }
  return { width, height, data: out };
}
