import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { applyAspectRatio } from "../src/generation.js";
import { parseHexColor, removeChromaKey, sampleBorderKey, toHexColor } from "../src/images/chroma.js";
import {
  alphaStats,
  decodeImage,
  encodeJpeg,
  encodePng,
  hasTransparency,
  imageDimensions,
  sniffImageMime,
  type RgbaImage,
} from "../src/images/codec.js";
import { loadImageRef } from "../src/images/inputs.js";
import { planOutputs, slugify, writeImageFile } from "../src/images/output.js";
import { buildPreview } from "../src/images/preview.js";
import { resizeToFit } from "../src/images/resize.js";
import { ImagegenError } from "../src/errors.js";
import { tempDir } from "./helpers/env.js";
import { startMockOpenAI, testPng, type MockOpenAI } from "./helpers/mock-openai.js";

function solid(w: number, h: number, [r, g, b]: [number, number, number], a = 255): RgbaImage {
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width: w, height: h, data };
}

/** Green-screen image with a red square in the middle and a 1px anti-aliased red/green edge. */
function greenScreen(): RgbaImage {
  const img = solid(40, 30, [0, 255, 0]);
  for (let y = 10; y < 20; y++) {
    for (let x = 15; x < 25; x++) {
      const i = (y * 40 + x) * 4;
      const edge = y === 10 || y === 19 || x === 15 || x === 24;
      img.data[i] = edge ? 128 : 220;
      img.data[i + 1] = edge ? 180 : 30;
      img.data[i + 2] = edge ? 20 : 30;
    }
  }
  return img;
}

describe("codec", () => {
  test("sniffs formats and reads header dimensions", () => {
    const png = testPng(33, 17);
    assert.equal(sniffImageMime(png), "image/png");
    assert.deepEqual(imageDimensions(png), { width: 33, height: 17 });
    const jpg = encodeJpeg(solid(21, 11, [10, 20, 30]));
    assert.equal(sniffImageMime(jpg), "image/jpeg");
    assert.deepEqual(imageDimensions(jpg), { width: 21, height: 11 });
    const gif = Buffer.from("GIF89a\x05\x00\x07\x00", "latin1");
    assert.equal(sniffImageMime(gif), "image/gif");
    assert.deepEqual(imageDimensions(gif), { width: 5, height: 7 });
    const webp = Buffer.alloc(30);
    webp.write("RIFF", 0, "latin1");
    webp.write("WEBP", 8, "latin1");
    webp.write("VP8X", 12, "latin1");
    webp.writeUIntLE(99, 24, 3);
    webp.writeUIntLE(49, 27, 3);
    assert.equal(sniffImageMime(webp), "image/webp");
    assert.deepEqual(imageDimensions(webp), { width: 100, height: 50 });
    assert.equal(sniffImageMime(Buffer.from("hello world")), undefined);
  });

  test("PNG round-trip keeps pixels and alpha; opaque images are written as RGB", () => {
    const img = solid(5, 4, [1, 2, 3], 128);
    const back = decodeImage(encodePng(img));
    assert.equal(back.width, 5);
    assert.deepEqual([...back.data.subarray(0, 4)], [1, 2, 3, 128]);
    assert.equal(hasTransparency(back), true);
    const opaque = encodePng(solid(5, 4, [9, 9, 9]));
    assert.equal(opaque[25], 2); // IHDR colour type: truecolour (no alpha)
    assert.deepEqual(alphaStats(back), { total: 20, transparent: 0, partial: 20 });
  });

  test("refuses to decode WebP/GIF with a clear message", () => {
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00", "latin1");
    assert.throws(() => decodeImage(gif), (e: unknown) => e instanceof ImagegenError && e.kind === "unsupported");
  });

  test("area downscale preserves aspect and averages", () => {
    const img = solid(400, 100, [200, 100, 50]);
    const small = resizeToFit(img, 100);
    assert.deepEqual([small.width, small.height], [100, 25]);
    assert.deepEqual([...small.data.subarray(0, 4)], [200, 100, 50, 255]);
    assert.equal(resizeToFit(img, 1000), img);
  });

  test("previews are small JPEGs; transparency is rendered over a checkerboard", () => {
    const preview = buildPreview(testPng(2000, 1000, true), 512);
    assert.ok(preview);
    assert.equal(preview.mimeType, "image/jpeg");
    assert.deepEqual([preview.width, preview.height], [512, 256]);
    assert.equal(preview.transparent, true);
    assert.equal(buildPreview(Buffer.from("GIF89a", "latin1")), undefined);
  });
});

describe("chroma key (port of remove_chroma_key.py)", () => {
  test("auto-detects the key from the border and removes it", () => {
    const img = greenScreen();
    assert.deepEqual(sampleBorderKey(img, "border"), [0, 255, 0]);
    assert.deepEqual(sampleBorderKey(img, "corners"), [0, 255, 0]);
    const r = removeChromaKey(img, { autoKey: "border", softMatte: true, spillCleanup: true });
    assert.deepEqual(r.keyColor, [0, 255, 0]);
    const at = (x: number, y: number) => [...r.image.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)];
    assert.deepEqual(at(0, 0), [0, 0, 0, 0]);
    assert.deepEqual(at(20, 15), [220, 30, 30, 255]);
    const edge = at(15, 15);
    assert.ok(edge[3]! > 0 && edge[3]! < 255, `edge pixel should be partially transparent, got ${edge}`);
    assert.ok(edge[1]! < 180, "despill should reduce the green channel on the edge");
    assert.equal(r.keyedPixels, 40 * 30 - 100);
  });

  test("hard key uses tolerance; contract and feather adjust the matte", () => {
    const img = greenScreen();
    const hard = removeChromaKey(img, { keyColor: [0, 255, 0], tolerance: 12 });
    assert.equal(hard.transparent, 40 * 30 - 100);
    const contracted = removeChromaKey(img, { keyColor: [0, 255, 0], edgeContract: 1 });
    assert.equal(contracted.total - contracted.transparent, 64);
    const feathered = removeChromaKey(img, { keyColor: [0, 255, 0], edgeFeather: 1.5 });
    assert.ok(feathered.partial > 0);
  });

  test("validates options and colors", () => {
    assert.deepEqual(parseHexColor("#FF00aa"), [255, 0, 170]);
    assert.equal(toHexColor([255, 0, 170]), "#ff00aa");
    assert.throws(() => parseHexColor("green"), /hex RGB/);
    assert.throws(() => removeChromaKey(greenScreen(), { softMatte: true, transparentThreshold: 90, opaqueThreshold: 10 }), /lower than/);
    assert.throws(() => removeChromaKey(greenScreen(), { edgeContract: 17 }), /edge_contract/);
  });
});

describe("prompt + output planning", () => {
  test("aspect ratio becomes an explicit prompt line", () => {
    assert.equal(applyAspectRatio("a fox", "auto"), "a fox");
    assert.equal(applyAspectRatio("a fox  ", "16:9"), "a fox\n\nAspect ratio: 16:9, wide landscape (horizontal) canvas.");
    assert.match(applyAspectRatio("a fox", "9:16"), /tall portrait \(vertical\)/);
  });

  test("default paths are descriptive and dated; directories and extensions are honored", async () => {
    const root = await tempDir();
    const now = new Date(2026, 8, 23, 14, 5, 9);
    const [def] = await planOutputs({ baseDir: root, defaultDir: path.join(root, "lib"), label: "A Café hero — mug!", count: 1, now });
    assert.equal(def?.path, path.join(root, "lib", "2026-09-23", "140509-a-cafe-hero-mug.png"));
    const multi = await planOutputs({ outputPath: "assets/hero.jpg", baseDir: root, defaultDir: root, label: "x", count: 2, now });
    assert.deepEqual(multi.map((p) => [path.relative(root, p.path), p.format]), [
      [path.join("assets", "hero-1.jpg"), "jpeg"],
      [path.join("assets", "hero-2.jpg"), "jpeg"],
    ]);
    const dir = await planOutputs({ outputPath: "sprites/", baseDir: root, defaultDir: root, label: "slime", count: 1, now });
    assert.equal(dir[0]?.path, path.join(root, "sprites", "140509-slime.png"));
    const noExt = await planOutputs({ outputPath: "icon", baseDir: root, defaultDir: root, label: "x", count: 1, format: "jpeg", now });
    assert.equal(noExt[0]?.path, path.join(root, "icon.jpg"));
    await assert.rejects(planOutputs({ outputPath: "a.webp", baseDir: root, defaultDir: root, label: "x", count: 1 }), /must end in \.png/);
    await assert.rejects(planOutputs({ outputPath: "a.png", baseDir: root, defaultDir: root, label: "x", count: 1, format: "jpeg" }), /conflicts/);
    assert.equal(slugify("!!!"), "image");
  });

  test("never overwrites unless asked", async () => {
    const root = await tempDir();
    const target = path.join(root, "out", "hero.png");
    assert.equal(await writeImageFile(target, Buffer.from("1"), false), target);
    assert.equal(await writeImageFile(target, Buffer.from("2"), false), path.join(root, "out", "hero-2.png"));
    assert.equal(await writeImageFile(target, Buffer.from("3"), true), target);
    assert.equal(await fs.readFile(target, "utf8"), "3");
  });
});

describe("input loading", () => {
  let mock: MockOpenAI;
  before(async () => {
    mock = await startMockOpenAI();
  });
  after(async () => {
    await mock.close();
  });

  test("paths, data URLs and http URLs", async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, "in.png"), testPng(12, 10));
    const local = await loadImageRef("in.png", root);
    assert.equal(local.mimeType, "image/png");
    assert.equal(local.path, path.join(root, "in.png"));
    assert.deepEqual([local.width, local.height], [12, 10]);
    assert.ok(local.dataUrl.startsWith("data:image/png;base64,"));

    const fromData = await loadImageRef(local.dataUrl, root);
    assert.equal(fromData.bytes.length, local.bytes.length);

    await assert.rejects(loadImageRef(`${mock.url}/missing.png`, root), /HTTP 404/);
  });

  test("rejects missing files, non-images, GIFs and oversized inputs", async () => {
    const root = await tempDir();
    await assert.rejects(loadImageRef("nope.png", root), /not found/);
    await fs.writeFile(path.join(root, "t.txt"), "hello");
    await assert.rejects(loadImageRef("t.txt", root), /not a PNG, JPEG or WebP/);
    await fs.writeFile(path.join(root, "a.gif"), Buffer.from("GIF89a\x01\x00\x01\x00", "latin1"));
    await assert.rejects(loadImageRef("a.gif", root), /only PNG, JPEG and WebP/);
    await fs.writeFile(path.join(root, "big.png"), testPng(64, 64));
    await assert.rejects(loadImageRef("big.png", root, { maxBytes: 10 }), /the limit is/);
    await assert.rejects(loadImageRef("data:image/png,rawdata", root), /base64/);
  });
});
