import type { RgbaImage } from "./codec.js";

/** Downscale so the longest edge is at most `maxEdge` (never upscales). */
export function resizeToFit(img: RgbaImage, maxEdge: number): RgbaImage {
  const longest = Math.max(img.width, img.height);
  if (longest <= maxEdge) return img;
  const scale = maxEdge / longest;
  return resampleArea(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
}

/**
 * Area-averaging (box) downsampler with fractional pixel coverage and premultiplied alpha, so
 * transparent pixels don't bleed dark fringes into their neighbours.
 */
export function resampleArea(img: RgbaImage, dw: number, dh: number): RgbaImage {
  const { width: sw, height: sh, data: src } = img;
  const out = new Uint8Array(dw * dh * 4);
  const xScale = sw / dw;
  const yScale = sh / dh;
  for (let dy = 0; dy < dh; dy++) {
    const sy0 = dy * yScale;
    const sy1 = sy0 + yScale;
    const iy0 = Math.floor(sy0);
    const iy1 = Math.min(sh, Math.ceil(sy1));
    for (let dx = 0; dx < dw; dx++) {
      const sx0 = dx * xScale;
      const sx1 = sx0 + xScale;
      const ix0 = Math.floor(sx0);
      const ix1 = Math.min(sw, Math.ceil(sx1));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let y = iy0; y < iy1; y++) {
        const wy = Math.min(y + 1, sy1) - Math.max(y, sy0);
        if (wy <= 0) continue;
        const row = y * sw * 4;
        for (let x = ix0; x < ix1; x++) {
          const wx = Math.min(x + 1, sx1) - Math.max(x, sx0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const i = row + x * 4;
          const wa = w * src[i + 3]!;
          r += src[i]! * wa;
          g += src[i + 1]! * wa;
          b += src[i + 2]! * wa;
          a += wa;
          wsum += w;
        }
      }
      const o = (dy * dw + dx) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
      }
      out[o + 3] = wsum > 0 ? Math.round(a / wsum) : 0;
    }
  }
  return { width: dw, height: dh, data: out };
}

/** One sliding-window box blur pass (clamped edges) along rows or columns. */
function boxBlurPass(src: Float32Array, dst: Float32Array, w: number, h: number, r: number, horizontal: boolean): void {
  const len = horizontal ? w : h;
  const lines = horizontal ? h : w;
  const stride = horizontal ? 1 : w;
  const lineStep = horizontal ? w : 1;
  const norm = 1 / (2 * r + 1);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    const at = (i: number) => src[base + Math.min(len - 1, Math.max(0, i)) * stride]!;
    let acc = 0;
    for (let i = -r; i <= r; i++) acc += at(i);
    for (let i = 0; i < len; i++) {
      dst[base + i * stride] = acc * norm;
      acc += at(i + r + 1) - at(i - r);
    }
  }
}

/** Box sizes whose 3-pass composition approximates a Gaussian of std-dev `sigma`. */
function boxesForGauss(sigma: number, n = 3): number[] {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4);
  const m = Math.round(mIdeal);
  return Array.from({ length: n }, (_, i) => (i < m ? wl : wu));
}

/** Gaussian blur (radius = std-dev, like Pillow's GaussianBlur) of a single 8-bit channel. */
export function gaussianBlurChannel(channel: Uint8Array, w: number, h: number, sigma: number): Uint8Array {
  if (sigma <= 0) return channel;
  let a: Float32Array = Float32Array.from(channel);
  let b: Float32Array = new Float32Array(a.length);
  for (const size of boxesForGauss(sigma)) {
    const r = Math.max(0, (size - 1) / 2);
    boxBlurPass(a, b, w, h, r, true);
    boxBlurPass(b, a, w, h, r, false);
  }
  const out = new Uint8Array(channel.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(a[i]!)));
  return out;
}

/** 3x3 minimum filter applied `iterations` times (erodes an alpha matte by one pixel per pass). */
export function erodeChannel(channel: Uint8Array, w: number, h: number, iterations: number): Uint8Array {
  let cur = channel;
  const tmp = new Uint8Array(channel.length);
  for (let it = 0; it < iterations; it++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const l = cur[row + Math.max(0, x - 1)]!;
        const c = cur[row + x]!;
        const r = cur[row + Math.min(w - 1, x + 1)]!;
        tmp[row + x] = Math.min(l, c, r);
      }
    }
    const next = new Uint8Array(channel.length);
    for (let y = 0; y < h; y++) {
      const up = Math.max(0, y - 1) * w;
      const row = y * w;
      const down = Math.min(h - 1, y + 1) * w;
      for (let x = 0; x < w; x++) next[row + x] = Math.min(tmp[up + x]!, tmp[row + x]!, tmp[down + x]!);
    }
    cur = next;
  }
  return cur;
}
