/**
 * 图片处理回归测试
 * 验证 Data URI 也会进入统一预处理链路，并使用自适应裁剪策略
 */

import assert from "node:assert/strict";
import sharp from "sharp";
import {
  imageToBase64Variants,
  imageToBase64WithOptions,
  prepareVisionImageInput,
} from "../src/image-processor.js";

function extractBase64Payload(dataUrl: string): Buffer {
  const payload = dataUrl.split(",")[1];
  assert.ok(payload, "Data URL should contain a base64 payload");
  return Buffer.from(payload, "base64");
}

async function createPngDataUrl(width: number, height: number): Promise<string> {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .png()
    .toBuffer();

  return `data:image/png;base64,${buffer.toString("base64")}`;
}

async function createNoisyJpegDataUrl(
  width: number,
  height: number
): Promise<string> {
  const raw = Buffer.alloc(width * height * 3);

  for (let i = 0; i < raw.length; i += 3) {
    const pixelIndex = i / 3;
    const x = pixelIndex % width;
    const y = Math.floor(pixelIndex / width);
    raw[i] = (x * 13 + y * 7) % 256;
    raw[i + 1] = (x * 5 + y * 11) % 256;
    raw[i + 2] = (x * 17 + y * 3) % 256;
  }

  const buffer = await sharp(raw, {
    raw: { width, height, channels: 3 },
  })
    .jpeg({ quality: 100 })
    .toBuffer();

  return `data:image/jpeg;base64,${buffer.toString("base64")}`;
}

async function getDimensions(dataUrl: string) {
  const metadata = await sharp(extractBase64Payload(dataUrl)).metadata();
  assert.ok(metadata.width && metadata.height, "Image metadata should exist");
  return {
    width: metadata.width!,
    height: metadata.height!,
  };
}

async function testPortraitDataUriSplit() {
  const imageDataUrl = await createPngDataUrl(1200, 3600);
  const variants = await imageToBase64Variants(imageDataUrl, {
    preferText: true,
    maxTiles: 4,
  });

  assert.equal(
    variants.length,
    4,
    "Portrait Data URI should produce overview plus 3 vertical tiles"
  );

  const full = await getDimensions(variants[0]);
  assert.deepEqual(full, { width: 1200, height: 3600 });

  for (const tile of variants.slice(1)) {
    const dimensions = await getDimensions(tile);
    assert.equal(dimensions.width, 1200, "Portrait tile should keep full width");
    assert.ok(
      dimensions.height < full.height,
      "Portrait tile height should be smaller than the overview image"
    );
  }
}

async function testLandscapeDataUriSplit() {
  const imageDataUrl = await createPngDataUrl(3600, 1200);
  const variants = await imageToBase64Variants(imageDataUrl, {
    preferText: true,
    maxTiles: 4,
  });

  assert.equal(
    variants.length,
    4,
    "Landscape Data URI should produce overview plus 3 horizontal tiles"
  );

  const full = await getDimensions(variants[0]);
  assert.deepEqual(full, { width: 3600, height: 1200 });

  for (const tile of variants.slice(1)) {
    const dimensions = await getDimensions(tile);
    assert.equal(
      dimensions.height,
      1200,
      "Landscape tile should keep full height before resize"
    );
    assert.ok(
      dimensions.width < 2000,
      "Landscape tile width should be narrower than the original wide image"
    );
  }
}

async function testAutoPreferTextForLongImage() {
  const imageDataUrl = await createNoisyJpegDataUrl(1400, 4200);
  const autoProcessed = await imageToBase64WithOptions(imageDataUrl);
  const forcedNonText = await imageToBase64WithOptions(imageDataUrl, {
    preferText: false,
  });

  const autoPayload = extractBase64Payload(autoProcessed);
  const nonTextPayload = extractBase64Payload(forcedNonText);

  assert.ok(
    autoPayload.length > nonTextPayload.length,
    "Long high-resolution image should auto-enable text-preserving compression"
  );
}

async function testPreparedImageHint() {
  const imageDataUrl = await createPngDataUrl(1200, 3600);
  const prepared = await prepareVisionImageInput(imageDataUrl, {
    preferText: true,
    maxTiles: 4,
  });

  assert.ok(Array.isArray(prepared.imageData), "Prepared image data should be multi-image");
  assert.ok(prepared.imageHint, "Multi-image input should include a reading-order hint");
  assert.match(
    prepared.imageHint,
    /image 1 is the full overview/i,
    "Hint should explain that the first image is the overview"
  );
}

async function main() {
  await testPortraitDataUriSplit();
  await testLandscapeDataUriSplit();
  await testAutoPreferTextForLongImage();
  await testPreparedImageHint();
  console.log("image-processor regression tests passed");
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
