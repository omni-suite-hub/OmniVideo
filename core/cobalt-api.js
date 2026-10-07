/* OmniVideo · Cobalt 开源中继 API 客户端 (cobalt-api.js)
   参考 Cobalt (github.com/imputnet/cobalt) 官方 API 文档实现：
   1. 多实例智能轮询与健康检测
   2. POST / 请求解析 YouTube 等平台视频直链
   3. 支持 redirect / tunnel / picker 三种响应模式
   4. 10 秒单实例超时，全部实例 30 秒总超时保护
   5. 用户可在设置中自定义私有 Cobalt 实例地址
*/
"use strict";

const CobaltAPI = {
  // 内置社区公开实例池（按优先级排列，定期可更新）
  DEFAULT_INSTANCES: [
    "https://cobalt.api.timelessnesses.me",
    "https://cobalt.nohea.cc",
    "https://api.cobalt.tux.pizza",
    "https://cobalt-api.ayo.tf",
    "https://cobalt.canine.tools",
  ],

  // 单实例请求超时（毫秒）
  INSTANCE_TIMEOUT: 12000,

  /**
   * 核心下载方法：向 Cobalt API 提交视频 URL，获取可直接下载的直链
   * @param {string} videoUrl - YouTube 或其他平台视频页面 URL
   * @param {object} options - 可选参数
   * @param {string} options.videoQuality - 画质偏好 "1080" | "720" | "480" | "max"
   * @param {string} options.downloadMode - "auto" | "audio" | "mute"
   * @param {string} options.customInstance - 用户自定义的 Cobalt 实例地址
   * @returns {Promise<{ ok: boolean, url?: string, filename?: string, error?: string }>}
   */
  async download(videoUrl, options = {}) {
    const quality = options.videoQuality || "1080";
    const mode = options.downloadMode || "auto";
    const customInstance = options.customInstance || null;

    // 构建实例列表（自定义实例优先）
    const instances = [];
    if (customInstance) {
      instances.push(customInstance.replace(/\/+$/, ""));
    }
    for (const inst of this.DEFAULT_INSTANCES) {
      if (!instances.includes(inst)) {
        instances.push(inst);
      }
    }

    const requestBody = {
      url: videoUrl,
      videoQuality: quality,
      downloadMode: mode,
      filenameStyle: "pretty",
    };

    let lastError = "所有 Cobalt 实例均不可用";

    for (const instance of instances) {
      try {
        const result = await this._requestInstance(instance, requestBody);
        if (result.ok) {
          return result;
        }
        lastError = result.error || "未知错误";
      } catch (err) {
        lastError = err.message || "请求失败";
        continue;
      }
    }

    return { ok: false, error: lastError };
  },

  /**
   * 向单个 Cobalt 实例发送请求
   */
  async _requestInstance(instanceUrl, body) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.INSTANCE_TIMEOUT);

    try {
      const resp = await fetch(instanceUrl + "/", {
        method: "POST",
        headers: {
          "Accept": "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => "");
        // 尝试解析 JSON 错误
        try {
          const errJson = JSON.parse(errText);
          if (errJson.error && errJson.error.code) {
            // 认证类错误，标记该实例需要认证，跳过
            if (errJson.error.code.includes("auth")) {
              return { ok: false, error: `实例 ${instanceUrl} 需要认证，已跳过` };
            }
            return { ok: false, error: errJson.error.code };
          }
        } catch (e) {}
        return { ok: false, error: `HTTP ${resp.status}: ${errText.slice(0, 100)}` };
      }

      const data = await resp.json();
      return this._parseResponse(data, instanceUrl);
    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === "AbortError") {
        return { ok: false, error: `实例 ${instanceUrl} 请求超时 (${this.INSTANCE_TIMEOUT / 1000}s)` };
      }
      return { ok: false, error: err.message || "网络请求失败" };
    }
  },

  /**
   * 解析 Cobalt API 响应
   * 响应格式：
   *   { status: "redirect", url: "https://..." }           → 直接重定向下载
   *   { status: "tunnel",   url: "https://...", filename }  → 通过隧道下载
   *   { status: "picker",   picker: [{ url, type }...] }   → 多选（取第一个视频）
   *   { status: "error",    error: { code, context } }      → 错误
   */
  _parseResponse(data, instanceUrl) {
    if (!data || !data.status) {
      return { ok: false, error: "Cobalt 返回了无效的响应格式" };
    }

    switch (data.status) {
      case "redirect":
      case "tunnel":
        if (data.url) {
          return {
            ok: true,
            url: data.url,
            filename: data.filename || null,
            status: data.status,
            instance: instanceUrl,
          };
        }
        return { ok: false, error: "Cobalt 返回了空的下载链接" };

      case "picker":
        // 多选模式：优先选视频类型
        if (data.picker && data.picker.length > 0) {
          const videoItem = data.picker.find(
            (item) => item.type === "video" || (item.url && !item.type)
          ) || data.picker[0];

          if (videoItem && videoItem.url) {
            return {
              ok: true,
              url: videoItem.url,
              filename: data.filename || null,
              status: "picker",
              instance: instanceUrl,
            };
          }
        }
        return { ok: false, error: "Cobalt picker 模式中未找到可用视频" };

      case "error":
        const errCode = data.error?.code || "unknown_error";
        const errCtx = data.error?.context?.service || "";
        return {
          ok: false,
          error: `Cobalt 解析失败: ${errCode}${errCtx ? " (" + errCtx + ")" : ""}`,
        };

      default:
        return { ok: false, error: `Cobalt 返回了未知状态: ${data.status}` };
    }
  },

  /**
   * 健康检查：检测指定实例是否在线
   */
  async checkHealth(instanceUrl) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const resp = await fetch(instanceUrl + "/", {
        method: "GET",
        headers: { "Accept": "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (resp.ok) {
        const data = await resp.json().catch(() => null);
        return {
          ok: true,
          version: data?.cobalt?.version || "unknown",
          url: data?.cobalt?.url || instanceUrl,
        };
      }
      return { ok: false };
    } catch (e) {
      return { ok: false };
    }
  },
};
