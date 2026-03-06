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

    if (isDataUri(normalizedPath)) {
      return normalizedPath;
    }

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

    if (isDataUri(normalizedPath)) {
      return [normalizedPath];
    }

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

    if (!width || !height) {
      const full = await encodeBufferToDataUrl(
        imageBuffer,
        mimeType,
        options?.preferText
      );
      return [full];
    }

    const shouldSplit =
      Math.max(width, height) >= 1800 || width * height >= 3500000;

    const full = await encodeBufferToDataUrl(
      imageBuffer,
      mimeType,
      options?.preferText
    );

    if (!shouldSplit) {
      return [full];
    }

    const rows = 2;
    const cols = 2;
    const tileWidth = Math.floor(width / cols);
    const tileHeight = Math.floor(height / rows);
    const tiles: string[] = [];

    for (let row = 0; row < rows; row += 1) {
      for (let col = 0; col < cols; col += 1) {
        const left = col * tileWidth;
        const top = row * tileHeight;
        const currentWidth = col === cols - 1 ? width - left : tileWidth;
        const currentHeight = row === rows - 1 ? height - top : tileHeight;
        const tileBuffer = await sharp(imageBuffer)
          .extract({ left, top, width: currentWidth, height: currentHeight })
          .toBuffer();
        const tileDataUrl = await encodeBufferToDataUrl(
          tileBuffer,
          mimeType,
          options?.preferText
        );
        tiles.push(tileDataUrl);
      }
    }

    const maxTiles = Math.max(1, options?.maxTiles ?? 5);
    return [full, ...tiles].slice(0, maxTiles);
  } catch (error) {
    throw new Error(
      `Failed to process image: ${
        error instanceof Error ? error.message : "Unknown error"
      }`
    );
  }
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

  if (buffer.length > 2 * 1024 * 1024) {
    logger.info("Compressing large image", {
      originalSize: `${(buffer.length / (1024 * 1024)).toFixed(2)}MB`,
      preferText: !!options?.preferText,
    });
    const compressed = await compressImage(
      buffer,
      outputMimeType,
      options?.preferText
    );
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
