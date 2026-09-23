import { ImagegenError } from "../errors.js";
import type { Rgb, RgbaImage } from "./codec.js";
import { alphaStats } from "./codec.js";
import { erodeChannel, gaussianBlurChannel } from "./resize.js";

/*
 * TypeScript port of the Codex imagegen skill's scripts/remove_chroma_key.py (same algorithm and
 * defaults): hard key or soft matte with key-channel dominance, alpha noise floor, spill cleanup,
 * edge contraction (3x3 min filter) and feathering (Gaussian blur of alpha).
 */

export type AutoKey = "none" | "corners" | "border";

export interface ChromaKeyOptions {
  /** Key color when autoKey is "none". Default #00ff00. */
  keyColor?: Rgb;
  autoKey?: AutoKey;
  /** Hard-key per-channel tolerance, 0-255. Default 12. */
  tolerance?: number;
  softMatte?: boolean;
  transparentThreshold?: number;
  opaqueThreshold?: number;
  spillCleanup?: boolean;
  /** Shrink the matte by N pixels (0-16) before feathering. */
  edgeContract?: number;
  /** Alpha blur radius (0-64). */
  edgeFeather?: number;
}

export interface ChromaKeyResult {
  image: RgbaImage;
  keyColor: Rgb;
  /** Pixels that matched the key before contraction/feathering. */
  keyedPixels: number;
  total: number;
  transparent: number;
  partial: number;
}

const KEY_DOMINANCE_THRESHOLD = 16;
const ALPHA_NOISE_FLOOR = 8;

export function parseHexColor(raw: string): Rgb {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(raw.trim());
  if (!m?.[1]) throw new ImagegenError("invalid_input", `Key color must be a hex RGB value like #00ff00 (got "${raw}").`);
  const hex = m[1];
  return [Number.parseInt(hex.slice(0, 2), 16), Number.parseInt(hex.slice(2, 4), 16), Number.parseInt(hex.slice(4, 6), 16)];
}

export function toHexColor([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function smoothstep(v: number): number {
  const x = Math.max(0, Math.min(1, v));
  return x * x * (3 - 2 * x);
}

function spillChannels(key: Rgb): number[] {
  const keyMax = Math.max(...key);
  if (keyMax < 128) return [];
  return [0, 1, 2].filter((i) => key[i]! >= keyMax - 16 && key[i]! >= 128);
}

/** Median per channel via 256-bin histograms (averaging the two middle values like statistics.median). */
function medianColor(samples: Uint8Array[]): Rgb {
  const result: number[] = [];
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256);
    let n = 0;
    for (const s of samples) {
      for (let i = c; i < s.length; i += 3) {
        hist[s[i]!]!++;
        n++;
      }
    }
    if (n === 0) throw new ImagegenError("invalid_input", "Could not sample a background key color from the image border.");
    const valueAt = (rank: number) => {
      let seen = 0;
      for (let v = 0; v < 256; v++) {
        seen += hist[v]!;
        if (seen > rank) return v;
      }
      return 255;
    };
    const mid = Math.floor(n / 2);
    result.push(n % 2 === 1 ? valueAt(mid) : Math.round((valueAt(mid - 1) + valueAt(mid)) / 2));
  }
  return result as Rgb;
}

export function sampleBorderKey(img: RgbaImage, mode: Exclude<AutoKey, "none">): Rgb {
  const { width: w, height: h, data } = img;
  const samples: number[] = [];
  const push = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    samples.push(data[i]!, data[i + 1]!, data[i + 2]!);
  };
  if (mode === "corners") {
    const patch = Math.max(1, Math.min(w, h, 12));
    const boxes: [number, number][] = [
      [0, 0],
      [w - patch, 0],
      [0, h - patch],
      [w - patch, h - patch],
    ];
    for (const [left, top] of boxes) for (let y = top; y < top + patch; y++) for (let x = left; x < left + patch; x++) push(x, y);
  } else {
    const band = Math.max(1, Math.min(w, h, 6));
    const step = Math.max(1, Math.floor(Math.min(w, h) / 256));
    for (let x = 0; x < w; x += step) {
      for (let y = 0; y < band; y++) {
        push(x, y);
        push(x, h - 1 - y);
      }
    }
    for (let y = 0; y < h; y += step) {
      for (let x = 0; x < band; x++) {
        push(x, y);
        push(w - 1 - x, y);
      }
    }
  }
  return medianColor([Uint8Array.from(samples)]);
}

function validate(o: Required<Omit<ChromaKeyOptions, "keyColor">>): void {
  const bad = (msg: string) => new ImagegenError("invalid_input", msg);
  if (o.tolerance < 0 || o.tolerance > 255) throw bad("tolerance must be between 0 and 255.");
  if (o.transparentThreshold < 0 || o.transparentThreshold > 255) throw bad("transparent_threshold must be between 0 and 255.");
  if (o.opaqueThreshold < 0 || o.opaqueThreshold > 255) throw bad("opaque_threshold must be between 0 and 255.");
  if (o.softMatte && o.transparentThreshold >= o.opaqueThreshold) throw bad("transparent_threshold must be lower than opaque_threshold.");
  if (o.edgeFeather < 0 || o.edgeFeather > 64) throw bad("edge_feather must be between 0 and 64.");
  if (o.edgeContract < 0 || o.edgeContract > 16 || !Number.isInteger(o.edgeContract)) throw bad("edge_contract must be an integer between 0 and 16.");
}

export function removeChromaKey(input: RgbaImage, options: ChromaKeyOptions = {}): ChromaKeyResult {
  const o = {
    autoKey: options.autoKey ?? "none",
    tolerance: options.tolerance ?? 12,
    softMatte: options.softMatte ?? false,
    transparentThreshold: options.transparentThreshold ?? 12,
    opaqueThreshold: options.opaqueThreshold ?? 96,
    spillCleanup: options.spillCleanup ?? false,
    edgeContract: options.edgeContract ?? 0,
    edgeFeather: options.edgeFeather ?? 0,
  };
  validate(o);
  const key: Rgb = o.autoKey !== "none" ? sampleBorderKey(input, o.autoKey) : (options.keyColor ?? [0, 255, 0]);
  const spill = spillChannels(key);
  const nonSpill = [0, 1, 2].filter((i) => !spill.includes(i));
  const keyMax = Math.max(...key);
  const { width: w, height: h } = input;
  const src = input.data;
  const out = new Uint8Array(src.length);
  let keyed = 0;

  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    const rgb: Rgb = [src[i]!, src[i + 1]!, src[i + 2]!];
    const alphaIn = src[i + 3]!;
    const distance = Math.max(Math.abs(rgb[0] - key[0]), Math.abs(rgb[1] - key[1]), Math.abs(rgb[2] - key[2]));

    let dominance = 0;
    let nonKeyStrength = 0;
    if (spill.length > 0) {
      const keyStrength = Math.min(...spill.map((c) => rgb[c]!));
      nonKeyStrength = nonSpill.length > 0 ? Math.max(...nonSpill.map((c) => rgb[c]!)) : 0;
      dominance = keyStrength - nonKeyStrength;
    }
    const keyLike = distance <= 32 || spill.length === 0 || dominance >= KEY_DOMINANCE_THRESHOLD;

    let alpha: number;
    if (o.softMatte && keyLike) {
      let soft: number;
      if (distance <= o.transparentThreshold) soft = 0;
      else if (distance >= o.opaqueThreshold) soft = 255;
      else soft = clamp255(255 * smoothstep((distance - o.transparentThreshold) / (o.opaqueThreshold - o.transparentThreshold)));
      let dom = 255;
      if (spill.length > 0 && dominance > 0) {
        const denominator = Math.max(1, keyMax - nonKeyStrength);
        dom = clamp255((1 - Math.min(1, dominance / denominator)) * 255);
      }
      alpha = Math.min(soft, dom);
    } else {
      alpha = distance <= o.tolerance ? 0 : 255;
    }
    alpha = Math.round(alpha * (alphaIn / 255));
    if (alpha > 0 && alpha <= ALPHA_NOISE_FLOOR) alpha = 0;

    if (alpha === 0) {
      keyed++;
      continue; // out stays (0,0,0,0)
    }
    let [r, g, b] = rgb;
    if (o.spillCleanup && keyLike && alpha < 252 && spill.length > 0 && nonSpill.length > 0) {
      const cap = Math.max(0, Math.max(...nonSpill.map((c) => rgb[c]!)) - 1);
      const channels: Rgb = [r, g, b];
      for (const c of spill) if (channels[c]! > cap) channels[c] = cap;
      [r, g, b] = channels;
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = alpha;
  }

  let image: RgbaImage = { width: w, height: h, data: out };
  if (o.edgeContract > 0 || o.edgeFeather > 0) {
    let alpha: Uint8Array = new Uint8Array(w * h);
    for (let p = 0; p < w * h; p++) alpha[p] = out[p * 4 + 3]!;
    if (o.edgeContract > 0) alpha = erodeChannel(alpha, w, h, o.edgeContract);
    if (o.edgeFeather > 0) alpha = gaussianBlurChannel(alpha, w, h, o.edgeFeather);
    const data = new Uint8Array(out);
    for (let p = 0; p < w * h; p++) data[p * 4 + 3] = alpha[p]!;
    image = { width: w, height: h, data };
  }
  const stats = alphaStats(image);
  return { image, keyColor: key, keyedPixels: keyed, ...stats };
}
