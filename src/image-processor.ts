/**
 * 图片处理工具
 * 读取、验证、压缩并编码图片（本地文件、远程 URL、Data URI）
 */

import axios from "axios";
import { readFile, stat } from "fs/promises";
import sharp from "sharp";
import { isUrl } from "./utils/helpers.js";
import { logger } from "./utils/logger.js";

const SUPPORTED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

const SUPPORTED_EXTENSIONS = ["jpg", "jpeg", "png", "webp", "gif"];
const DEFAULT_REMOTE_TIMEOUT_MS = 30000;

// 判断输入是否为 Data URI（data:image/png;base64,...）
function isDataUri(input: string): boolean {
  return (
    typeof input === "string" &&
    input.startsWith("data:") &&
    /;base64,/.test(input)
  );
}

// 从 Data URI 提取 mimeType
function getMimeFromDataUri(input: string): string | null {
  const match = input.match(/^data:([^;]+);base64,/i);
  return match ? match[1].toLowerCase() : null;
}

// 估算 Data URI 的原始字节大小（不含头部）
function estimateBytesFromDataUri(input: string): number {
  try {
    const base64 = input.split(",")[1] || "";
    // base64 长度 * 3/4，忽略 padding 进行近似计算
    return Math.floor((base64.length * 3) / 4);
  } catch {
    return 0;
  }
}

// 解码 Data URI，纳入统一的图片预处理流程
function decodeDataUri(input: string): { buffer: Buffer; mimeType: string } {
  const mimeType = ensureSupportedMimeType(getMimeFromDataUri(input));
  const base64 = input.split(",")[1] || "";

  if (!base64) {
    throw new Error("Invalid Data URI: missing base64 payload");
  }

  return {
    buffer: Buffer.from(base64, "base64"),
    mimeType,
  };
}

/**
 * 规范化本地图片路径（例如移除前缀符号）
 * 部分客户端使用 "@path/to/file" 引用，需要转为真实路径
 */
function normalizeImageSourcePath(source: string): string {
  if (typeof source === "string" && source.startsWith("@")) {
    const normalized = source.slice(1);
    logger.debug("Normalized @-prefixed image path", {
      original: source,
      normalized,
    });
    return normalized;
  }
  return source;
}

// 规范化 MIME 类型，移除 charset 等附加信息
function normalizeMimeType(mimeType: string | undefined | null): string | null {
  if (!mimeType) {
    return null;
  }

  return mimeType.split(";")[0].trim().toLowerCase() || null;
}

/**
 * 根据文件扩展名获取 MIME 类型
 */
function getMimeType(filePath: string): string {
  const ext = filePath.toLowerCase().split(".").pop();

  switch (ext) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    default:
      return "image/jpeg"; // 默认使用 jpeg
  }
}

// 校验 MIME 类型是否在允许范围内
function ensureSupportedMimeType(mimeType: string | null): string {
  if (!mimeType || !SUPPORTED_MIME_TYPES.includes(mimeType)) {
    throw new Error(
      `Unsupported image format: ${mimeType || "unknown"}. Supported: ${SUPPORTED_MIME_TYPES.join(
        ", "
      )}`
    );
  }

  return mimeType;
}

/**
 * 拉取远程图片并纳入统一预处理流程
 */
async function fetchRemoteImage(
  imageUrl: string,
  maxSizeMB: number = 10
): Promise<{ buffer: Buffer; mimeType: string }> {
  const maxBytes = maxSizeMB * 1024 * 1024;

  logger.info("Fetching remote image for preprocessing", { url: imageUrl });

  try {
    const response = await axios.get<ArrayBuffer>(imageUrl, {
      responseType: "arraybuffer",
      timeout: DEFAULT_REMOTE_TIMEOUT_MS,
      maxContentLength: maxBytes,
      maxBodyLength: maxBytes,
    });

    const mimeType = ensureSupportedMimeType(
      normalizeMimeType(response.headers["content-type"] as string | undefined) ||
        normalizeMimeType(getMimeType(imageUrl))
    );
    const buffer = Buffer.from(response.data);

    if (buffer.length > maxBytes) {
      throw new Error(
        `Image file too large: ${(buffer.length / (1024 * 1024)).toFixed(
          2
        )}MB (max: ${maxSizeMB}MB)`
      );
    }

    return { buffer, mimeType };
  } catch (error) {
    if (axios.isAxiosError(error)) {
      const status = error.response?.status;
      throw new Error(
        `Failed to fetch remote image (${status || "unknown"}): ${error.message}`
      );
    }

    throw error;
  }
}

/**
 * 读取本地或远程图片二进制数据
 */
async function loadImageBuffer(
  imageSource: string
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (isDataUri(imageSource)) {
    return decodeDataUri(imageSource);
  }

  if (isUrl(imageSource)) {
    return fetchRemoteImage(imageSource);
  }

  const buffer = await readFile(imageSource);
  const mimeType = ensureSupportedMimeType(getMimeType(imageSource));
  return { buffer, mimeType };
}

/**
 * 校验图片来源（文件或 URL）
 */
export async function validateImageSource(
  imageSource: string,
  maxSizeMB: number = 10
): Promise<void> {
  // 规范化本地路径（处理可能的前缀符号，如 "@image.png"）
  const normalizedSource = normalizeImageSourcePath(imageSource);

  if (isDataUri(normalizedSource)) {
    const mimeType = ensureSupportedMimeType(getMimeFromDataUri(normalizedSource));
    const bytes = estimateBytesFromDataUri(normalizedSource);
    const maxBytes = maxSizeMB * 1024 * 1024;

    if (bytes > maxBytes) {
      throw new Error(
        `Image file too large: ${(bytes / (1024 * 1024)).toFixed(
          2
        )}MB (max: ${maxSizeMB}MB)`
      );
    }

    logger.debug("Validated Data URI image source", { mimeType, bytes });
    return;
  }

  if (isUrl(normalizedSource)) {
    logger.debug("Image source is remote URL; validation will occur during fetch", {
      url: normalizedSource,
    });
    return;
  }

  // 校验本地文件
  try {
    const stats = await stat(normalizedSource);
    const fileSizeMB = stats.size / (1024 * 1024);

    if (fileSizeMB > maxSizeMB) {
      throw new Error(
        `Image file too large: ${fileSizeMB.toFixed(2)}MB (max: ${maxSizeMB}MB)`
      );
    }

    const ext = normalizedSource.toLowerCase().split(".").pop();

    if (!ext || !SUPPORTED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Unsupported image format: ${ext}. Supported: ${SUPPORTED_EXTENSIONS.join(
          ", "
        )}`
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Image file not found: ${normalizedSource}`);
    }
    throw error;
  }
}

/**
 * 将图片转为 base64 Data URL
 */
export async function imageToBase64(imagePath: string): Promise<string> {
  return imageToBase64WithOptions(imagePath);
}

export interface PreparedImageInput {
  imageData: string | string[];
  imageHint?: string;
}

/**
 * 将图片转为单张 base64 Data URL
 * 对文本密集场景保留更多细节
 */
export async function imageToBase64WithOptions(
  imagePath: string,
  options?: { preferText?: boolean }
): Promise<string> {
  try {
    const normalizedPath = normalizeImageSourcePath(imagePath);
    const result = await encodeImageSource(normalizedPath, options);
    return `data:${result.mimeType};base64,${result.base64}`;
  } catch (error) {
    throw new Error(
      `Failed to process image: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

/**
 * 生成原图和多裁剪变体
 * 用于大图、长图和文本密集截图场景
 */
export async function imageToBase64Variants(
  imagePath: string,
  options?: { preferText?: boolean; maxTiles?: number }
): Promise<string[]> {
  try {
    const normalizedPath = normalizeImageSourcePath(imagePath);
    const { buffer: imageBuffer, mimeType } = await loadImageBuffer(normalizedPath);

    if (mimeType === "image/gif") {
      const full = await encodeBufferToDataUrl(
        imageBuffer,
        mimeType,
        options?.preferText
      );
      return [full];
    }

    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const preferText = await resolvePreferTextMode(
      imageBuffer,
      mimeType,
      options?.preferText
    );

    if (!width || !height) {
      const full = await encodeBufferToDataUrl(imageBuffer, mimeType, preferText);
      return [full];
    }

    const shouldSplit =
      Math.max(width, height) >= 1800 || width * height >= 3500000;

    const full = await encodeBufferToDataUrl(imageBuffer, mimeType, preferText);

    if (!shouldSplit) {
      return [full];
    }

    const cropRegions = buildCropRegions(
      width,
      height,
      Math.max(1, options?.maxTiles ?? 5)
    );

    if (cropRegions.length === 0) {
      return [full];
    }

    const tiles: string[] = [];

    for (const region of cropRegions) {
      const tileBuffer = await sharp(imageBuffer).extract(region).toBuffer();
      const tileDataUrl = await encodeBufferToDataUrl(
        tileBuffer,
        mimeType,
        preferText
      );
      tiles.push(tileDataUrl);
    }

    return [full, ...tiles];
  } catch (error) {
    throw new Error(
      `Failed to process image: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
}

/**
 * 准备适合模型理解的图片输入。
 * 多裁剪场景除了返回图片列表，还会补充阅读顺序提示，帮助模型理解每张图的角色。
 */
export async function prepareVisionImageInput(
  imagePath: string,
  options?: { preferText?: boolean; maxTiles?: number }
): Promise<PreparedImageInput> {
  const variants = await imageToBase64Variants(imagePath, options);

  if (variants.length <= 1) {
    return { imageData: variants[0] };
  }

  const metadataHint = buildImageSetHint(variants.length - 1, imagePath, options);
  return {
    imageData: variants,
    imageHint: metadataHint,
  };
}

/**
 * 统一处理图片来源并编码为 base64
 */
async function encodeImageSource(
  normalizedPath: string,
  options?: { preferText?: boolean }
): Promise<{ base64: string; mimeType: string }> {
  const { buffer, mimeType } = await loadImageBuffer(normalizedPath);
  return encodeLocalImage(buffer, mimeType, options);
}

/**
 * 编码单张图片，必要时先压缩
 */
async function encodeLocalImage(
  imageBuffer: Buffer,
  mimeType: string,
  options?: { preferText?: boolean }
): Promise<{ base64: string; mimeType: string }> {
  let buffer = imageBuffer;
  let outputMimeType = mimeType;
  const preferText = await resolvePreferTextMode(
    imageBuffer,
    mimeType,
    options?.preferText
  );

  if (buffer.length > 2 * 1024 * 1024) {
    logger.info("Compressing large image", {
      originalSize: `${(buffer.length / (1024 * 1024)).toFixed(2)}MB`,
      preferText,
    });
    const compressed = await compressImage(buffer, outputMimeType, preferText);
    buffer = compressed.buffer;
    outputMimeType = compressed.mimeType;
  }

  return {
    base64: buffer.toString("base64"),
    mimeType: outputMimeType,
  };
}

/**
 * 将图片 Buffer 编码为 Data URL
 */
async function encodeBufferToDataUrl(
  imageBuffer: Buffer,
  inputMimeType: string,
  preferText?: boolean
): Promise<string> {
  let buffer = imageBuffer;
  let mimeType = inputMimeType;

  if (buffer.length > 2 * 1024 * 1024) {
    const compressed = await compressImage(buffer, mimeType, preferText);
    buffer = compressed.buffer;
    mimeType = compressed.mimeType;
  }

  return `data:${mimeType};base64,${buffer.toString("base64")}`;
}

/**
 * 压缩图片
 */
async function compressImage(
  imageBuffer: Buffer,
  inputMimeType: string,
  preferText?: boolean
): Promise<{ buffer: Buffer; mimeType: string }> {
  if (inputMimeType === "image/gif") {
    return { buffer: imageBuffer, mimeType: inputMimeType };
  }

  const maxSize = preferText ? 3072 : 2048;
  const pipeline = sharp(imageBuffer).resize(maxSize, maxSize, {
    fit: "inside",
    withoutEnlargement: true,
  });

  if (inputMimeType === "image/png") {
    const buffer = await pipeline
      .png({ compressionLevel: preferText ? 3 : 6 })
      .toBuffer();
    return { buffer, mimeType: "image/png" };
  }

  if (inputMimeType === "image/webp") {
    const buffer = await pipeline
      .webp({ quality: preferText ? 90 : 85 })
      .toBuffer();
    return { buffer, mimeType: "image/webp" };
  }

  const buffer = await pipeline
    .jpeg({ quality: preferText ? 90 : 85 })
    .toBuffer();
  return { buffer, mimeType: "image/jpeg" };
}

/**
 * 解析最终是否启用文本优先处理。
 * - 显式传入 true / false 时尊重调用方
 * - 未显式指定时，根据图片尺寸、长宽比和格式自动判断
 */
async function resolvePreferTextMode(
  imageBuffer: Buffer,
  mimeType: string,
  preferText?: boolean
): Promise<boolean> {
  if (preferText !== undefined) {
    return preferText;
  }

  return inferTextHeavyFromImage(imageBuffer, mimeType);
}

/**
 * 根据图片自身特征推断是否更适合文本优先处理。
 * 这里保持保守，只在典型长图、截图和高分辨率文档图上自动启用。
 */
async function inferTextHeavyFromImage(
  imageBuffer: Buffer,
  mimeType: string
): Promise<boolean> {
  if (mimeType === "image/gif") {
    return false;
  }

  try {
    const metadata = await sharp(imageBuffer).metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;

    if (!width || !height) {
      return mimeType === "image/png";
    }

    const longSide = Math.max(width, height);
    const shortSide = Math.min(width, height);
    const aspectRatio = shortSide > 0 ? longSide / shortSide : 1;
    const pixelCount = width * height;
    const screenshotLikeMime =
      mimeType === "image/png" || mimeType === "image/webp";

    if (aspectRatio >= 2.2 && longSide >= 1400) {
      return true;
    }

    if (screenshotLikeMime && pixelCount >= 1_200_000 && shortSide >= 700) {
      return true;
    }

    if (pixelCount >= 2_800_000 && shortSide >= 900) {
      return true;
    }

    return false;
  } catch {
    return mimeType === "image/png";
  }
}

type CropRegion = {
  left: number;
  top: number;
  width: number;
  height: number;
};

/**
 * 为长图、宽图和接近正方形的大图生成自适应裁剪区域。
 * - 长图优先按纵向条带切分
 * - 宽图优先按横向条带切分
 * - 近似正方形的大图使用 2x2 网格
 * - 裁剪之间保留少量重叠，减少文字落在边界处被截断
 */
function buildCropRegions(
  width: number,
  height: number,
  maxTiles: number
): CropRegion[] {
  const extraTiles = Math.max(0, maxTiles - 1);
  if (extraTiles === 0) {
    return [];
  }

  const aspectRatio = width / height;
  let rows = 1;
  let cols = 1;

  if (height / width >= 1.6) {
    rows = Math.min(extraTiles, Math.max(2, Math.min(4, Math.ceil(height / width))));
  } else if (width / height >= 1.6) {
    cols = Math.min(extraTiles, Math.max(2, Math.min(4, Math.ceil(width / height))));
  } else {
    if (extraTiles >= 4) {
      rows = 2;
      cols = 2;
    } else if (extraTiles === 3) {
      if (aspectRatio >= 1) {
        cols = 3;
      } else {
        rows = 3;
      }
    } else if (extraTiles === 2) {
      if (aspectRatio >= 1) {
        cols = 2;
      } else {
        rows = 2;
      }
    }
  }

  const overlapX = cols > 1 ? Math.min(96, Math.floor(width * 0.06)) : 0;
  const overlapY = rows > 1 ? Math.min(96, Math.floor(height * 0.06)) : 0;
  const baseWidth =
    cols > 1 ? Math.ceil((width + overlapX * (cols - 1)) / cols) : width;
  const baseHeight =
    rows > 1 ? Math.ceil((height + overlapY * (rows - 1)) / rows) : height;
  const stepX = cols > 1 ? baseWidth - overlapX : width;
  const stepY = rows > 1 ? baseHeight - overlapY : height;
  const regions: CropRegion[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      if (regions.length >= extraTiles) {
        return regions;
      }

      const left =
        cols > 1 ? Math.min(col * stepX, Math.max(0, width - baseWidth)) : 0;
      const top =
        rows > 1 ? Math.min(row * stepY, Math.max(0, height - baseHeight)) : 0;

      regions.push({
        left,
        top,
        width: Math.min(baseWidth, width - left),
        height: Math.min(baseHeight, height - top),
      });
    }
  }

  return regions;
}

/**
 * 为多图输入生成阅读顺序提示。
 * 这里不暴露本地路径，只说明第 1 张为总览，其余图片按阅读方向排列。
 */
function buildImageSetHint(
  tileCount: number,
  imagePath: string,
  options?: { preferText?: boolean; maxTiles?: number }
): string {
  const normalizedPath = normalizeImageSourcePath(imagePath);
  const isData = isDataUri(normalizedPath);
  const sourceKind = isData
    ? "pasted image"
    : isUrl(normalizedPath)
      ? "remote image"
      : "local image";

  const labels = Array.from({ length: tileCount }, (_, index) => {
    const position = index + 2;
    return `image ${position} is a zoomed crop in reading order`;
  });

  const detailHint = options?.preferText
    ? "These crops preserve small text and dense details."
    : "These crops provide localized detail views.";

  return [
    `Image set note: image 1 is the full overview of the ${sourceKind}.`,
    `Images 2-${tileCount + 1} are ordered detail crops generated from the same image.`,
    "Read them as a sequence of supporting close-ups after understanding the overview.",
    detailHint,
    `Per-image role: ${labels.join("; ")}.`,
  ].join(" ");
}
