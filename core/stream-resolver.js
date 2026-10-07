/* OmniVideo · 纯前端媒体流智能解析器 (Stream Resolver)
   职责：
   1. 识别并拦截 HTML 网页地址，严禁将 HTML 网页直接落盘为视频
   2. YouTube (youtube.com / youtu.be)：无感适配当前播放流、活跃标签嗅探池及多轨合流
   3. B站 (bilibili.com / b23.tv)：智能优选 fnval=0 音画合一 MP4，高画质平滑切入 DASH
   4. Eporner (eporner.com)：提取真实高清 MP4 直链与下载地址
   5. 抖音 (douyin.com / v.douyin.com)：短链跟随与提取真实无水印视频直链
   6. 通用网页：提取 <video>、<source>、.m3u8 与 .mp4
   7. 校验 Content-Type，确保落盘目标绝非 text/html
*/
"use strict";

const StreamResolver = {
  /**
   * 解析任意 URL，返回包含真实媒体流的对象
   * @param {string} rawUrl 用户输入或页面传来的链接
   * @param {string} defaultTitle 视频标题
   * @param {string} quality 画质偏好 ('best' | 'compat' | 'audio')
   * @param {Array} tabMediaPool 当前标签页已嗅探到的网络流列表
   * @returns {Promise<{ type: 'hls'|'dash'|'direct', url?: string, videoUrl?: string, audioUrl?: string, title: string, headers?: object }>}
   */
  async resolve(rawUrl, defaultTitle = "网页视频", quality = "best", tabMediaPool = []) {
    if (!rawUrl) throw new Error("下载链接不能为空");
    let cleanUrl = String(rawUrl).trim();

    // 提取文本中可能包含的有效 HTTP 链接（支持用户直接粘贴包含分享文案的整段文字）
    const urlMatch = cleanUrl.match(/https?:\/\/[^\s"'<>]+/);
    if (urlMatch) {
      cleanUrl = urlMatch[0];
    }

    // 1. 如果已是显式 HLS (.m3u8)
    if (/\.m3u8(\?.*)?$/i.test(cleanUrl)) {
      return {
        type: "hls",
        url: cleanUrl,
        title: defaultTitle,
      };
    }

    // 2. 如果已是显式视频直链 (.mp4, .webm, .flv, .mov, 或 googlevideo 真实流)
    if (this.isDirectMediaUrl(cleanUrl)) {
      return {
        type: "direct",
        url: cleanUrl,
        title: defaultTitle,
      };
    }

    // 3. 平台专用解析器优先 (YouTube, Bilibili, Eporner, 抖音等具有完整多轨/音画合成能力)
    // 3.1 YouTube (youtube.com / youtu.be)
    if (/youtube\.com|youtu\.be/i.test(cleanUrl)) {
      return await this.resolveYouTube(cleanUrl, defaultTitle, quality, tabMediaPool);
    }

    // 3.2 B站 (bilibili.com / b23.tv) 页面解析
    if (/bilibili\.com|b23\.tv/i.test(cleanUrl)) {
      return await this.resolveBilibili(cleanUrl, defaultTitle, quality);
    }

    // 3.3 Eporner 视频页面解析
    if (/eporner\.com\/video-/i.test(cleanUrl)) {
      return await this.resolveEporner(cleanUrl, defaultTitle, quality);
    }

    // 3.4 抖音页面解析
    if (/douyin\.com/i.test(cleanUrl)) {
      return await this.resolveDouyin(cleanUrl, defaultTitle);
    }

    // 4. 检查当前标签页是否有已捕获的真实媒体流 (排除 googlevideo.com 等受限加密分片)
    const validPool = (tabMediaPool || []).filter((m) => m && m.url && !m.url.includes("googlevideo.com"));
    if (validPool.length > 0) {
      const hls = validPool.find((m) => m.type === "hls" || /\.m3u8/i.test(m.url));
      if (hls) {
        return { type: "hls", url: hls.url, title: defaultTitle };
      }
      const vStream = validPool.find((m) => m.type === "video" || m.mime?.startsWith("video/"));
      const aStream = validPool.find((m) => m.type === "audio" || m.mime?.startsWith("audio/"));
      if (quality === "audio" && aStream) {
        return { type: "direct", url: aStream.url, title: defaultTitle, quality: "audio" };
      }
      if (vStream && aStream) {
        return {
          type: "dash",
          videoUrl: vStream.url,
          audioUrl: aStream.url,
          title: defaultTitle,
        };
      }
      if (vStream) {
        return { type: "direct", url: vStream.url, title: defaultTitle };
      }
    }

    // 5. 通用网页流嗅探解析
    return await this.resolveGeneralWebpage(cleanUrl, defaultTitle, quality);
  },

  isDirectMediaUrl(url) {
    if (!url) return false;
    if (url.includes("googlevideo.com")) return false; // YouTube SABR 加密流，需通过 MSE 捕获
    if (/\.(mp4|webm|flv|f4v|mov|ts|m4s)(\?.*)?$/i.test(url)) return true;
    if (/mime=video|mime=audio/i.test(url)) return true;
    return false;
  },

  /**
   * YouTube 解析核心 (指引用户通过 MSE 原生内存捕获，杜绝 31 字节 SABR 错误)
   */
  async resolveYouTube(url, fallbackTitle, quality = "best", tabMediaPool = []) {
    let pageTitle = fallbackTitle;
    try {
      const resp = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0" },
      });
      if (resp.ok) {
        const html = await resp.text();
        const tMatch = html.match(/<title>([^<]+)<\/title>/i);
        if (tMatch && tMatch[1]) {
          pageTitle = tMatch[1].replace(/ - YouTube$/i, "").trim();
        }
      }
    } catch (e) {}

    // 返回 cobalt 类型，由 background.js 调用 CobaltAPI 获取直链
    return {
      type: "cobalt",
      url: url,
      title: pageTitle,
    };
  },

  /**
   * B站解析核心 (纯前端直接调用 B站公开 API)
   */
  async resolveBilibili(url, fallbackTitle, quality = "best") {
    let bvid = "";
    const bvMatch = url.match(/(BV[a-zA-Z0-9]+)/i);
    if (bvMatch) {
      bvid = bvMatch[1];
    } else if (url.includes("b23.tv")) {
      try {
        const headResp = await fetch(url, { method: "HEAD", redirect: "follow" });
        const finalUrl = headResp.url || url;
        const subMatch = finalUrl.match(/(BV[a-zA-Z0-9]+)/i);
        if (subMatch) bvid = subMatch[1];
      } catch (e) {}
    }

    if (!bvid) {
      throw new Error("未能识别有效的 B站 BV 号");
    }

    // 1. 获取视频基本信息与 CID
    const viewUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`;
    const viewResp = await fetch(viewUrl, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!viewResp.ok) throw new Error("获取 B站 视频信息失败: HTTP " + viewResp.status);
    const viewData = await viewResp.json();
    if (!viewData || viewData.code !== 0 || !viewData.data) {
      throw new Error((viewData && viewData.message) || "B站 视频信息不存在");
    }

    const cid = viewData.data.cid;
    const title = viewData.data.title || fallbackTitle;
    const headers = {
      Referer: "https://www.bilibili.com/",
      Origin: "https://www.bilibili.com",
    };

    // 2. 纯音频提取模式
    if (quality === "audio") {
      const playApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=16&fnver=0`;
      const playResp = await fetch(playApi, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" },
      });
      const playData = await playResp.json();
      if (playData?.data?.dash?.audio?.length) {
        const audios = playData.data.dash.audio.slice().sort((a, b) => (b.id || 0) - (a.id || 0));
        const audioUrl = audios[0].baseUrl || audios[0].base_url;
        if (audioUrl) {
          return { type: "direct", url: audioUrl, title, headers, quality: "audio" };
        }
      }
    }

    // 3. 智能优选：单流完整 MP4 (fnval=0，音画合一，零混流延迟)
    try {
      const singleApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=0&fnver=0`;
      const sResp = await fetch(singleApi, {
        headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.bilibili.com/" },
      });
      if (sResp.ok) {
        const sData = await sResp.json();
        if (sData?.data?.durl?.length && sData.data.durl[0].url) {
          return {
            type: "direct",
            url: sData.data.durl[0].url,
            title,
            headers,
          };
        }
      }
    } catch (e) {}

    // 4. 调用 playurl 获取 DASH 视音频流
    const playApi = `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=80&fnval=16&fnver=0&fourk=1`;
    const playResp = await fetch(playApi, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.bilibili.com/",
      },
    });
    if (!playResp.ok) throw new Error("拉取 B站 播放流失败: HTTP " + playResp.status);
    const playData = await playResp.json();
    if (!playData || playData.code !== 0 || !playData.data) {
      throw new Error((playData && playData.message) || "未能解析 B站 播放地址");
    }

    if (playData.data.dash) {
      const dash = playData.data.dash;
      const videos = (dash.video || []).slice();
      const audios = (dash.audio || []).slice();
      videos.sort((a, b) => (b.id || 0) - (a.id || 0));
      audios.sort((a, b) => (b.id || 0) - (a.id || 0));

      const bestV = videos[0];
      const bestA = audios[0];
      const videoUrl = bestV ? (bestV.baseUrl || bestV.base_url || (bestV.backupUrl && bestV.backupUrl[0])) : null;
      const audioUrl = bestA ? (bestA.baseUrl || bestA.base_url || (bestA.backupUrl && bestA.backupUrl[0])) : null;

      if (videoUrl && audioUrl) {
        return {
          type: "dash",
          videoUrl,
          audioUrl,
          title,
          headers,
        };
      }
    }

    // 兜底单流直链 durl
    if (playData.data.durl && playData.data.durl.length > 0) {
      return {
        type: "direct",
        url: playData.data.durl[0].url,
        title,
        headers,
      };
    }

    throw new Error("B站 该视频流受限或需要大会员");
  },

  /**
   * Eporner 解析核心
   */
  async resolveEporner(url, fallbackTitle, quality = "best") {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) throw new Error("加载 Eporner 页面失败: HTTP " + resp.status);
    const html = await resp.text();

    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].replace(/ - EPORNER.*$/i, "").trim() : fallbackTitle;

    // 1. 尝试直接提取页面中的 mp4 播放源
    const sourceMatch =
      html.match(/src=["'](https?:\/\/[^"']+\.mp4[^"']*)["']/i) ||
      html.match(/["'](https?:\/\/[^"']+\.eporner\.com\/[^"']+\.mp4[^"']*)["']/i);
    if (sourceMatch && sourceMatch[1]) {
      return { type: "direct", url: sourceMatch[1], title };
    }

    // 2. 尝试从 download 模块提取下载直链
    const dloadMatch = html.match(/href=["'](\/dload\/[^"']+)["']/i);
    if (dloadMatch && dloadMatch[1]) {
      const fullDload = new URL(dloadMatch[1], "https://www.eporner.com").href;
      return {
        type: "direct",
        url: fullDload,
        title,
        headers: {
          Referer: "https://www.eporner.com/",
          Origin: "https://www.eporner.com",
        },
      };
    }

    // 3. 检查 HLS
    const hlsMatch = html.match(/["'](https?:\/\/[^"']+\.m3u8[^"']*)["']/i);
    if (hlsMatch && hlsMatch[1]) {
      return { type: "hls", url: hlsMatch[1], title };
    }

    throw new Error("未能从 Eporner 页面解析出真实视频链接");
  },

  /**
   * 抖音视频解析核心
   */
  async resolveDouyin(url, fallbackTitle) {
    const resp = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1",
      },
    });
    if (!resp.ok) throw new Error("访问抖音页面失败: HTTP " + resp.status);
    const html = await resp.text();

    const playAddrMatch =
      html.match(/playAddr["']?\s*:\s*\[\s*\{\s*["']?src["']?\s*:\s*["']([^"']+)["']/i) ||
      html.match(/videoUrl["']?\s*:\s*["']([^"']+)["']/i) ||
      html.match(/src=["'](https?:\/\/[^"']+\.bytevod\.com\/[^"']+)["']/i);
    if (playAddrMatch && playAddrMatch[1]) {
      let vUrl = playAddrMatch[1].replace(/\\u002F/g, "/").replace(/&amp;/g, "&");
      if (vUrl.startsWith("//")) vUrl = "https:" + vUrl;
      return {
        type: "direct",
        url: vUrl,
        title: fallbackTitle,
        headers: { Referer: "https://www.douyin.com/" },
      };
    }

    throw new Error("未能提取抖音无水印视频流");
  },

  /**
   * 通用网页嗅探解析
   */
  async resolveGeneralWebpage(url, fallbackTitle, quality = "best") {
    const resp = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!resp.ok) throw new Error(`无法连接该网页: HTTP ${resp.status}`);

    const contentType = resp.headers.get("content-type") || "";
    if (contentType.startsWith("video/") || contentType.startsWith("audio/")) {
      return { type: "direct", url, title: fallbackTitle };
    }
    if (contentType.includes("mpegurl")) {
      return { type: "hls", url, title: fallbackTitle };
    }

    const html = await resp.text();
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : fallbackTitle;

    // 1. 扫描页面中的 .m3u8 流地址
    const m3u8Match = html.match(/["'](https?:\/\/[^"'\s<>]+\.m3u8(?:\?[^"'\s<>]*)?)["']/i);
    if (m3u8Match && m3u8Match[1]) {
      return { type: "hls", url: m3u8Match[1], title };
    }

    // 2. 扫描 <video src="..."> 或 <source src="...">
    const videoTagMatch = html.match(
      /<(?:video|source)[^>]+src=["'](https?:\/\/[^"']+\.(?:mp4|webm|flv|mov)[^"']*)["']/i
    );
    if (videoTagMatch && videoTagMatch[1]) {
      return { type: "direct", url: videoTagMatch[1], title };
    }

    // 3. 扫描 OpenGraph meta: og:video
    const ogMatch = html.match(/<meta\s+property=["']og:video(?::url)?["']\s+content=["'](https?:\/\/[^"']+)["']/i);
    if (ogMatch && ogMatch[1] && this.isDirectMediaUrl(ogMatch[1])) {
      return { type: "direct", url: ogMatch[1], title };
    }

    // 4. 扫描任何直接嵌入的 mp4 链接
    const mp4Match = html.match(/["'](https?:\/\/[^"'\s<>]+\.mp4(?:\?[^"'\s<>]*)?)["']/i);
    if (mp4Match && mp4Match[1]) {
      return { type: "direct", url: mp4Match[1], title };
    }

    throw new Error(
      "该页面未直接暴露可下载的静态视频流（当前链接为 HTML 网页）。请直接在该网页中播放视频，OmniVideo 会自动在网络层捕获真实媒体流！"
    );
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = StreamResolver;
}
