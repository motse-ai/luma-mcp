/**
 * 阿里云 Qwen VL 客户端
 * OpenAI 兼容接口
 * 文档: https://help.aliyun.com/zh/model-studio/vision
 */

import axios, { AxiosInstance } from "axios";
import type { LumaConfig } from "./config.js";
import { buildImageContent, type VisionClient } from "./vision-client.js";
import { logger } from "./utils/logger.js";

export class QwenClient implements VisionClient {
  private client: AxiosInstance;
  private model: string;
  private maxTokens: number;
  private temperature: number;

  constructor(config: LumaConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens;
    this.temperature = config.temperature;

    this.client = axios.create({
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 180000,
    });
  }

  /**
   * 分析图片
   */
  async analyzeImage(
    imageDataUrl: string | string[],
    prompt: string,
    enableThinking?: boolean
  ): Promise<string> {
    try {
      const requestBody: Record<string, unknown> = {
        model: this.model,
        messages: [
          {
            role: "user",
            content: [
              ...buildImageContent(imageDataUrl),
              {
                type: "text",
                text: prompt,
              },
            ],
          },
        ],
        max_tokens: this.maxTokens,
        temperature: this.temperature,
        stream: false,
      };

      if (enableThinking !== false) {
        requestBody.extra_body = {
          enable_thinking: true,
          thinking_budget: 81920,
        };
      }

      logger.info("Calling Qwen3-VL API", {
        model: this.model,
        thinking: !!requestBody.extra_body,
        imageCount: Array.isArray(imageDataUrl) ? imageDataUrl.length : 1,
      });

      const response = await this.client.post("/chat/completions", requestBody);

      if (!response.data?.choices?.[0]?.message?.content) {
        throw new Error("Invalid response format from Qwen API");
      }

      const result = response.data.choices[0].message.content;
      const usage = response.data.usage;

      logger.info("Qwen3-VL API call successful", {
        tokens: usage?.total_tokens || 0,
        model: response.data.model,
      });

      return result;
    } catch (error) {
      logger.error("Qwen3-VL API call failed", {
        error: error instanceof Error ? error.message : String(error),
      });

      if (axios.isAxiosError(error)) {
        const errorMessage =
          error.response?.data?.error?.message || error.message;
        throw new Error(`Qwen API error: ${errorMessage}`);
      }
      throw error;
    }
  }

  /**
   * 获取模型名称
   */
  getModelName(): string {
    return `Qwen (${this.model})`;
  }
}
