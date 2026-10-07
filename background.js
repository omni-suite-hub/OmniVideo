/* OmniVideo · 纯前端后台调度中心 (Manifest V3 Service Worker)
   职责：
   1. 100% 本地纯前端运行，完全不依赖任何外部/本地 Python/FFmpeg 后端
   2. 任务持久化存储管理 (基于 chrome.storage.local 替代原 SQLite)
   3. 调度 Offscreen 引擎完成 HLS/M3U8 分片拉取、AES-128 解密与 mux.js 转封装
   4. 调度 Chrome Downloads 原生下载 API 落盘与打开文件
   5. 桌面系统通知、扩展图标动态活跃任务角标
   6. 保持原生 SidePanel 呼出与右键菜单
*/
"use strict";

// 载入纯前端流解析器与 Cobalt 开源中继 API 客户端
importScripts("core/stream-resolver.js");
importScripts("core/cobalt-api.js");

/* ---------- WebRequest 实时网络媒体流探测器 (猫抓级核心架构) ---------- */
const tabMediaPool = new Map(); // tabId -> Array of { url, type, mime, size, timestamp }

function addSniffedMedia(tabId, item) {
  if (!tabId || tabId < 0) return;
  if (!tabMediaPool.has(tabId)) {
    tabMediaPool.set(tabId, []);
  }
  const pool = tabMediaPool.get(tabId);
  if (pool.some((m) => m.url === item.url)) return;
  if (pool.length >= 40) pool.shift();
  pool.push(item);
}

if (chrome.webRequest && chrome.webRequest.onResponseStarted) {
  chrome.webRequest.onResponseStarted.addListener(
    (details) => {
      if (details.tabId < 0) return;
      const url = details.url;
      if (!url || url.startsWith("blob:") || url.startsWith("data:")) return;

      let contentType = "";
      let contentLength = 0;
      if (details.responseHeaders) {
        for (const h of details.responseHeaders) {
          const name = h.name.toLowerCase();
          if (name === "content-type") contentType = h.value.toLowerCase();
          if (name === "content-length") contentLength = parseInt(h.value, 10) || 0;
        }
      }

      // 排除静态图片、网页 HTML、脚本与样式
      if (contentType.includes("text/html") || contentType.includes("text/css") || contentType.includes("javascript")) return;
      if (/\.(jpg|jpeg|png|gif|webp|svg|css|js|woff|woff2|json|html|htm)(\?.*)?$/i.test(url)) return;
      // 排除鼠标悬停预览小片段与缩略图视频
      if (url.includes("-preview.") || url.includes("/preview.") || url.includes("/thumbs/") || url.includes("storyboard")) return;

      const isM3U8 = /\.m3u8(\?.*)?$/i.test(url) || contentType.includes("mpegurl");
      const isVideoMime = contentType.startsWith("video/");
      const isAudioMime = contentType.startsWith("audio/");
      const isMediaExt = /\.(mp4|webm|flv|f4v|mov|ts)(\?.*)?$/i.test(url);
      const isGoogleVideo = url.includes("googlevideo.com/videoplayback");
      const isBiliVideo = url.includes("bilivideo.com") || url.includes("bilivideo.cn");

      if (isM3U8 || isVideoMime || isAudioMime || isMediaExt || isGoogleVideo || isBiliVideo) {
        if (contentLength > 0 && contentLength < 20480 && !isM3U8) return;

        let type = "video";
        if (isM3U8) type = "hls";
        else if (isAudioMime || url.includes("mime=audio")) type = "audio";

        addSniffedMedia(details.tabId, {
          url,
          type,
          mime: contentType,
          size: contentLength ? parseFloat((contentLength / 1024 / 1024).toFixed(1)) : 0,
          timestamp: Date.now(),
        });
      }
    },
    { urls: ["<all_urls>"] },
    ["responseHeaders"]
  );
}

chrome.tabs.onRemoved.addListener((tabId) => tabMediaPool.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // 仅在明确跳转至非主流视频站且全量加载时清理，避免 YouTube/B站 等 SPA 内嵌刷新破坏流池
  if (changeInfo.url && !/youtube\.com|bilibili\.com|douyin\.com|eporner\.com/i.test(changeInfo.url)) {
    tabMediaPool.delete(tabId);
  }
});

/* ---------- 任务唯一 ID 生成 ---------- */
function generateTaskId() {
  return "t_" + Math.random().toString(36).substr(2, 9) + Date.now().toString(36).substr(4);
}

/* ---------- 任务存储与状态持久化 (chrome.storage.local) ---------- */
async function getStoredTasks() {
  const data = await chrome.storage.local.get("omni_tasks");
  return data.omni_tasks || [];
}

async function saveStoredTasks(tasks) {
  await chrome.storage.local.set({ omni_tasks: tasks });
  updateBadge(tasks);
}

async function updateTaskStatus(taskId, patch) {
  const tasks = await getStoredTasks();
  const idx = tasks.findIndex((t) => t.id === taskId);
  if (idx !== -1) {
    tasks[idx] = { ...tasks[idx], ...patch };
    await saveStoredTasks(tasks);
  }
}

function updateBadge(tasks) {
  try {
    const active = (tasks || []).filter((t) =>
      ["queued", "parsing", "downloading", "merging"].includes(t.status)
    );
    if (active.length > 0) {
      chrome.action.setBadgeBackgroundColor({ color: "#35e6cf" });
      chrome.action.setBadgeTextColor ? chrome.action.setBadgeTextColor({ color: "#0a0e16" }) : null;
      chrome.action.setBadgeText({ text: String(active.length) });
    } else {
      chrome.action.setBadgeText({ text: "" });
    }
  } catch (e) {}
}

/* ---------- 确保 Offscreen 离线处理文档就绪 ---------- */
let creatingOffscreen = null;
async function ensureOffscreenDocument() {
  const offscreenUrl = "core/offscreen.html";
  try {
    if (chrome.runtime.getContexts) {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chrome.runtime.getURL(offscreenUrl)],
      });
      if (contexts.length > 0) return;
    }
  } catch (e) {}

  if (creatingOffscreen) {
    await creatingOffscreen;
    return;
  }

  try {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: offscreenUrl,
      reasons: ["BLOBS"],
      justification: "In-browser media chunk transmuxing and download",
    });
    await creatingOffscreen;
  } catch (err) {
    // 忽略已存在异常
  } finally {
    creatingOffscreen = null;
  }
}

/* ---------- 配置 DeclarativeNetRequest 动态防盗链绕过规则 ---------- */
async function setupDNRRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: [1001, 1002, 1003, 1004],
      addRules: [
        {
          id: 1001,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
              { header: "Origin", operation: "set", value: "https://www.bilibili.com" },
            ],
          },
          condition: {
            urlFilter: "||bilivideo.com",
            resourceTypes: ["xmlhttprequest", "media", "other"],
          },
        },
        {
          id: 1002,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.bilibili.com/" },
            ],
          },
          condition: {
            urlFilter: "||bilibili.com",
            resourceTypes: ["xmlhttprequest", "media", "other"],
          },
        },
        {
          id: 1003,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.douyin.com/" },
            ],
          },
          condition: {
            urlFilter: "||bytevod.com",
            resourceTypes: ["xmlhttprequest", "media", "other"],
          },
        },
        {
          id: 1004,
          priority: 1,
          action: {
            type: "modifyHeaders",
            requestHeaders: [
              { header: "Referer", operation: "set", value: "https://www.eporner.com/" },
              { header: "Origin", operation: "set", value: "https://www.eporner.com" },
            ],
          },
          condition: {
            urlFilter: "||eporner.com",
            resourceTypes: ["xmlhttprequest", "media", "other"],
          },
        },
      ],
    });
  } catch (e) {
    console.warn("DNR 规则配置:", e);
  }
}

/* ---------- 核心下发下载任务 ---------- */
async function sendDownload(url, title, quality = "best", extra = {}, tabId = null) {
  if (!url) return { ok: false, error: "下载链接不能为空" };

  const cleanUrl = String(url).trim();
  if (cleanUrl.startsWith("blob:") || cleanUrl.startsWith("mediasource:")) {
    return { ok: false, error: "不支持 blob: 内存地址，请直接在播放器或详情页下载" };
  }

  const safeTitle = (title || "网页视频").replace(/[\\/:*?"<>|\r\n\t]/g, " ").trim().slice(0, 80);

  // 1. 运行 StreamResolver 智能解析真实媒体流（拦截并转化 HTML 网页）
  let resolvedStream = null;
  const pool = tabId ? (tabMediaPool.get(tabId) || []) : [];

  if (extra && extra.videoUrl && extra.audioUrl) {
    resolvedStream = {
      type: "dash",
      videoUrl: extra.videoUrl,
      audioUrl: extra.audioUrl,
      title: safeTitle,
      headers: extra.headers,
    };
  } else if (extra && extra.url && (extra.url.includes(".m3u8") || StreamResolver.isDirectMediaUrl(extra.url))) {
    resolvedStream = {
      type: extra.url.includes(".m3u8") ? "hls" : "direct",
      url: extra.url,
      title: safeTitle,
      headers: extra.headers,
    };
  } else {
    try {
      resolvedStream = await StreamResolver.resolve(cleanUrl, safeTitle, quality, pool);
    } catch (resolveErr) {
      return { ok: false, error: resolveErr.message };
    }
  }

  if (!resolvedStream) {
    return { ok: false, error: "未能解析到可下载的媒体流" };
  }

  // 2. 严格安全门禁与智能升阶：杜绝把网页 HTML 当成视频下载；若为 googlevideo 加密流则智能升阶为全片解析
  if (resolvedStream.type === "direct" || resolvedStream.type === "dash") {
    if (resolvedStream.url && /\.(html|htm)(\?.*)?$/i.test(resolvedStream.url)) {
      return {
        ok: false,
        error: "未能解析到真实视频流（目标为 HTML 网页）。请直接在该网页中播放视频，插件会自动捕获真实流！",
      };
    }
    const isYtStream = (resolvedStream.url && resolvedStream.url.includes("googlevideo.com")) ||
                       (resolvedStream.videoUrl && resolvedStream.videoUrl.includes("googlevideo.com"));
    if (isYtStream) {
      // 智能升阶：将 googlevideo 碎片流升阶为完整的 YouTube 视频页，由本地引擎/Cobalt 高速下载全片
      const ytPageUrl = isSpecificVideoPage(cleanUrl) ? cleanUrl : ((extra && isSpecificVideoPage(extra.pageUrl)) ? extra.pageUrl : "");
      if (ytPageUrl) {
        resolvedStream = {
          type: "cobalt",
          url: ytPageUrl,
          title: safeTitle,
        };
      } else {
        return {
          ok: false,
          error: "YouTube 采用 SABR 播放器会话加密，请直接在视频播放页中点击「下载 MP4」由本地极速引擎合成高清全片！",
        };
      }
    }
  }

  const tasks = await getStoredTasks();

  // 读取用户偏好的并发线程数配置
  const settingsData = await chrome.storage.local.get("omni_settings");
  const settings = settingsData.omni_settings || {};
  const concurrency = settings.concurrency ? parseInt(settings.concurrency, 10) : 5;

  const newTask = {
    id: generateTaskId(),
    url: resolvedStream.url || cleanUrl,
    pageUrl: (extra && extra.pageUrl) || cleanUrl,
    videoUrl: resolvedStream.videoUrl || null,
    audioUrl: resolvedStream.audioUrl || null,
    type: resolvedStream.type || "direct",
    headers: resolvedStream.headers || extra?.headers || {},
    title: resolvedStream.title || safeTitle,
    quality: quality || settings.defaultQuality || "best",
    concurrency,
    status: "queued",
    progress: 0,
    speed: "准备就绪",
    size: 0,
    platform: detectPlatformName(cleanUrl),
    created_at: Date.now(),
    error: null,
    downloadId: null,
  };

  // 新任务置顶
  tasks.unshift(newTask);
  await saveStoredTasks(tasks);

  // 调度后台执行
  dispatchTaskExecution(newTask);

  notify("任务已创建", newTask.title, newTask.id);
  return { ok: true, task: newTask };
}

/* ---------- 本地 OmniGrabber 极速引擎适配器 (127.0.0.1:8090) ---------- */
const LOCAL_ENGINE_BASE = "http://127.0.0.1:8090";

async function checkLocalServer() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    const resp = await fetch(`${LOCAL_ENGINE_BASE}/api/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      return !!(data && data.ok);
    }
  } catch (e) {}
  return false;
}

async function dispatchLocalEngineTask(task) {
  // 统一采用极速管道流直入浏览器下载模式（零后端存储占用，极速落盘）
  await dispatchLocalEngineStream(task);
}

function isSpecificVideoPage(url) {
  if (!url || typeof url !== "string") return false;
  // 排除直接流媒体文件
  if (/\.(mp4|m3u8|webm|flv|f4v|mov|ts|m4s|mp3|m4a)(\?.*)?$/i.test(url)) return false;

  // Eporner: 只有单视频播放页必须含有 /video-[a-zA-Z0-9]+/ 或 /embed/
  if (url.includes("eporner.com")) {
    return /\/video-[a-zA-Z0-9]+/i.test(url) || /\/embed\/[a-zA-Z0-9]+/i.test(url);
  }
  // YouTube: /watch?v=, /shorts/, /embed/, youtu.be/
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    return url.includes("/watch?") || url.includes("/shorts/") || url.includes("/embed/") || url.includes("youtu.be/");
  }
  // Bilibili: /video/BV, /video/av, /bangumi/play/
  if (url.includes("bilibili.com") || url.includes("b23.tv")) {
    return /\/video\/(BV|av)/i.test(url) || url.includes("/bangumi/play/") || url.includes("b23.tv/");
  }
  // 抖音: /video/, /note/, v.douyin.com/
  if (url.includes("douyin.com")) {
    return /\/video\/[0-9]+/i.test(url) || /\/note\/[0-9]+/i.test(url) || url.includes("v.douyin.com/");
  }
  // Twitter / X: /status/
  if (url.includes("twitter.com") || url.includes("x.com")) {
    return /\/status\/[0-9]+/i.test(url);
  }
  // TikTok: /video/
  if (url.includes("tiktok.com")) {
    return /\/video\/[0-9]+/i.test(url) || url.includes("vt.tiktok.com/");
  }
  return false;
}

function normalizeUrl(url) {
  if (!url) return url;
  if (url.includes("eporner.com")) {
    if (url.includes("/video-")) return url;
    const m = url.match(/eporner\.com\/(?:[a-zA-Z0-9_\-]+\/)?([a-zA-Z0-9]{10,12})(?:\/|\.mp4|\?|$)/);
    if (m) return `https://www.eporner.com/video-${m[1]}/`;
  }
  return url;
}

async function getDownloadOptions(filename, url) {
  const settingsData = await chrome.storage.local.get("omni_settings");
  const settings = settingsData.omni_settings || {};
  return {
    url,
    filename: filename || "video.mp4",
    saveAs: !!settings.saveAs,
  };
}

/* 方式 A：0 磁盘实时管道流 (边拉取边封装直落用户磁盘，0 服务器磁盘占用) */
async function dispatchLocalEngineStream(task) {
  await updateTaskStatus(task.id, {
    status: "parsing",
    progress: 0.05,
    speed: "⚡ 实时解析媒体流 (0 磁盘占用)...",
  });

  const qualityMap = { best: "best", compat: "compat", audio: "audio" };
  const q = qualityMap[task.quality] || "best";

  let rawUrl = task.url;
  if (isSpecificVideoPage(task.url)) {
    rawUrl = task.url;
  } else if (isSpecificVideoPage(task.pageUrl)) {
    rawUrl = task.pageUrl;
  }
  const submitUrl = normalizeUrl(rawUrl);

  // 1. 调用 /api/resolve 获取流信息
  const resolveRes = await fetch(
    `${LOCAL_ENGINE_BASE}/api/resolve?url=${encodeURIComponent(submitUrl)}&quality=${q}`
  );
  if (!resolveRes.ok) {
    const errText = await resolveRes.text().catch(() => "");
    throw new Error(`解析流失败: ${errText.slice(0, 100) || resolveRes.statusText}`);
  }

  const resolveData = await resolveRes.json();
  const meta = resolveData.data || {};
  const mediaTitle = meta.title || task.title;
  const targetFilename = meta.filename || sanitizeFilename(mediaTitle, meta.ext || "mp4");
  const approxSize = meta.filesize_approx ? parseFloat((meta.filesize_approx / 1024 / 1024).toFixed(1)) : null;

  await updateTaskStatus(task.id, {
    status: "downloading",
    title: mediaTitle,
    progress: 0.1,
    speed: "⚡ 实时直落本地磁盘中...",
    size: approxSize,
  });

  // 2. 调用 /api/stream 通过 Chrome Downloads 直接落盘
  const streamUrl = `${LOCAL_ENGINE_BASE}/api/stream?url=${encodeURIComponent(submitUrl)}&quality=${q}`;
  const dlOpts = await getDownloadOptions(targetFilename, streamUrl);

  chrome.downloads.download(
    dlOpts,
    async (dlId) => {
      if (chrome.runtime.lastError || !dlId) {
        throw new Error(chrome.runtime.lastError?.message || "启动浏览器下载失败");
      }

      await updateTaskStatus(task.id, {
        downloadId: dlId,
        status: "downloading",
        title: mediaTitle,
        speed: "⚡ 实时落盘中",
        approxSize: approxSize,
      });

      // 跟踪 Chrome 下载真实进度
      let lastBytes = 0;
      let lastTime = Date.now();
      const pollDl = setInterval(async () => {
        try {
          const items = await chrome.downloads.search({ id: dlId });
          if (!items || !items.length) {
            clearInterval(pollDl);
            return;
          }
          const item = items[0];
          if (item.state === "complete") {
            clearInterval(pollDl);
            const finalSize = item.fileSize ? parseFloat((item.fileSize / 1024 / 1024).toFixed(1)) : approxSize;
            await updateTaskStatus(task.id, {
              status: "done",
              progress: 1.0,
              speed: "已完成",
              size: finalSize,
              downloadId: dlId,
              filePath: item.filename || null,
              finished_at: Date.now(),
            });
            notify("下载完成 ✓", `${mediaTitle} (${finalSize} MB)`, task.id);
          } else if (item.state === "interrupted") {
            clearInterval(pollDl);
            await updateTaskStatus(task.id, {
              status: "failed",
              error: item.error || "下载中断",
              speed: "失败",
            });
          } else if (item.state === "in_progress") {
            const now = Date.now();
            const timeDiff = (now - lastTime) / 1000;
            const bytesDiff = item.bytesReceived - lastBytes;
            let speedStr = "⚡ 实时落盘中";
            if (timeDiff > 0.5 && bytesDiff >= 0) {
              const speedMB = (bytesDiff / timeDiff / 1024 / 1024).toFixed(1);
              speedStr = `⚡ ${speedMB} MB/s`;
              lastBytes = item.bytesReceived;
              lastTime = now;
            }
            const total = item.totalBytes > 0 ? item.totalBytes : (meta.filesize_approx || 0);
            let prog = 0.1;
            if (total > 0) {
              prog = Math.min(parseFloat((item.bytesReceived / total).toFixed(2)), 0.99);
            }
            const curSize = parseFloat((item.bytesReceived / 1024 / 1024).toFixed(1));
            await updateTaskStatus(task.id, {
              progress: prog,
              speed: speedStr,
              size: curSize,
            });
          }
        } catch (e) {
          clearInterval(pollDl);
        }
      }, 800);
    }
  );
}

/* ---------- 调度任务分流执行 ---------- */
async function dispatchTaskExecution(task) {
  try {
    const isCobalt = task.type === "cobalt";
    const isM3U8 = task.url.includes(".m3u8") || (task.type && task.type === "hls");
    const isDash = !!(task.videoUrl && task.audioUrl);
    const hasHeaders = !!(task.headers && Object.keys(task.headers).length > 0);
    const isAntiHotlink =
      task.url.includes("bilivideo.com") ||
      task.url.includes("bilibili.com") ||
      task.url.includes("bytevod.com") ||
      task.url.includes("douyin.com") ||
      task.url.includes("eporner.com");

    // 优先检测本地 OmniGrabber 极速引擎 (127.0.0.1:8090)，若就绪则秒级满速下载并混流 (支持 YouTube, Eporner, B站, 抖音等全平台)
    const isLocalAlive = await checkLocalServer();
    if (isLocalAlive) {
      await dispatchLocalEngineTask(task);
      return;
    }

    if (isCobalt) {
      // Cobalt 开源中继：向 Cobalt API 提交 YouTube 等平台 URL，获取音画合一 MP4 直链
      await updateTaskStatus(task.id, { status: "parsing", progress: 0.05, speed: "Cobalt 解析中" });

      // 读取用户设置中的画质偏好
      const settingsData = await chrome.storage.local.get("omni_settings");
      const settings = settingsData.omni_settings || {};
      const qualityMap = { best: "1080", compat: "720", audio: "audio" };
      const cobaltQuality = qualityMap[task.quality] || settings.cobaltQuality || "1080";
      const cobaltMode = task.quality === "audio" ? "audio" : "auto";

      const result = await CobaltAPI.download(task.url, {
        videoQuality: cobaltQuality,
        downloadMode: cobaltMode,
      });

      if (!result.ok) {
        await updateTaskStatus(task.id, {
          status: "failed",
          error: `公网中继节点受限 (${result.error})。本地引擎未运行，可启动 ./run.sh start 享受 4K/8K 满速下载`,
          speed: "失败",
        });
        return;
      }

      await updateTaskStatus(task.id, { status: "downloading", progress: 0.15, speed: "下载中" });

      const ext = task.quality === "audio" ? "m4a" : "mp4";
      const safeFilename = sanitizeFilename(task.title, ext);

      const dlOpts = await getDownloadOptions(safeFilename, result.url);

      chrome.downloads.download(
        dlOpts,
        async (dlId) => {
          if (chrome.runtime.lastError) {
            // Cobalt 直链被浏览器拦截时，尝试通过 offscreen fetch 代理下载
            task.url = result.url;
            task.type = "direct";
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({ type: "OFFSCREEN_PROCESS_DIRECT", task }).catch(() => {});
          } else {
            await updateTaskStatus(task.id, {
              status: "downloading",
              downloadId: dlId,
              progress: 0.2,
            });
          }
        }
      );
    } else if (isM3U8) {
      // HLS 流式切片下载与前端混流
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_PROCESS_HLS",
        task,
      }).catch(() => {});
    } else if (isDash) {
      // DASH 视音频分离合流
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_PROCESS_DASH",
        task,
      }).catch(() => {});
    } else if (hasHeaders || isAntiHotlink) {
      // 携带防盗链 Header 的媒体流，交由 offscreen 进行 fetchWithProgress 代理下载，彻底避免 403
      await ensureOffscreenDocument();
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_PROCESS_DIRECT",
        task,
      }).catch(() => {});
    } else {
      // 直接 MP4 / WebM 单流下载
      const safeFilename = sanitizeFilename(task.title, task.quality === "audio" ? "m4a" : "mp4");
      const dlOpts = await getDownloadOptions(safeFilename, task.url);

      chrome.downloads.download(
        dlOpts,
        async (dlId) => {
          if (chrome.runtime.lastError) {
            // 如果下载受阻，交由 offscreen 代理拉取
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({ type: "OFFSCREEN_PROCESS_DIRECT", task }).catch(() => {});
          } else {
            const allTasks = await getStoredTasks();
            const target = allTasks.find((t) => t.id === task.id);
            if (target) {
              target.status = "downloading";
              target.downloadId = dlId;
              await saveStoredTasks(allTasks);
            }
          }
        }
      );
    }
  } catch (err) {
    console.error("任务调度失败:", err);
    await updateTaskStatus(task.id, {
      status: "failed",
      error: err.message || "无法启动下载",
    });
  }
}

/* ---------- 文件名规范化与非法字符清洗 (杜绝 videoplayback 无后缀及特殊符号) ---------- */
function sanitizeFilename(name, ext = "mp4") {
  if (!name) name = "video";
  // 去除多余的文件类型拓展名，避免形如 xxx.mp4.mp4
  let base = String(name).replace(/\.(mp4|m4a|mp3|webm|flv|ts|mov|mkv)$/i, "");
  // 清洗文件系统非法字符及控制符
  base = base.replace(/[\/\\:*?"<>|\x00-\x1f]/g, "_");
  // 规范化多重空白
  base = base.replace(/\s+/g, " ").trim();
  // 去除开头的点或末尾的点/空格
  base = base.replace(/^\.+/, "").replace(/[\s.]+$/, "");
  // 长度安全截断 (避免超长文件名造成 Chrome 抛错或截断为 videoplayback)
  if (base.length > 70) base = base.slice(0, 70).trim();
  if (!base || base.toLowerCase() === "videoplayback") base = "video";

  const safeExt = String(ext || "mp4").replace(/^\.+/, "") || "mp4";
  return `${base}.${safeExt}`;
}

/* ---------- 核心安全防护：原生下载拦截器，确保 100% 具备正确的 .mp4/.m4a 扩展名 ---------- */
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    (async () => {
      try {
        const tasks = await getStoredTasks();
        const task = tasks.find(
          (t) => t.downloadId === item.id || t.url === item.url || (t.videoUrl && t.videoUrl === item.url)
        );

        let isAudio =
          (task && task.quality === "audio") ||
          (item.mime && item.mime.startsWith("audio/")) ||
          (item.url && item.url.includes("mime=audio"));
        let defaultExt = isAudio ? "m4a" : "mp4";

        let rawName = (task && task.title) || item.filename || "video";
        if (/^videoplayback(\.|$)/i.test(rawName)) {
          rawName = (task && task.title) || "YouTube_Video";
        }

        const cleanName = sanitizeFilename(rawName, defaultExt);
        suggest({
          filename: cleanName,
          conflictAction: "uniquify",
        });
      } catch (e) {
        let fallback = item.filename || "video.mp4";
        if (!/\.(mp4|m4a|mp3|webm|flv|ts|mov)$/i.test(fallback)) {
          fallback += ".mp4";
        }
        suggest({ filename: fallback, conflictAction: "uniquify" });
      }
    })();
    return true; // 异步支持
  });
}

/* ---------- 监听原生下载事件 (针对直链下载同步进度) ---------- */
chrome.downloads.onChanged.addListener(async (delta) => {
  if (!delta || !delta.id) return;
  const tasks = await getStoredTasks();
  const t = tasks.find((item) => item.downloadId === delta.id);
  if (!t) return;

  if (delta.state) {
    if (delta.state.current === "complete") {
      t.status = "done";
      t.progress = 1.0;
      t.speed = "已完成";
      t.finished_at = Date.now();
      if (delta.fileSize && delta.fileSize.current) {
        t.size = parseFloat((delta.fileSize.current / 1024 / 1024).toFixed(1));
      }
      notify("下载完成 ✓", `${t.title}${t.size ? " (" + t.size + "MB)" : ""}`, t.id);

      // 若用户启用了自动清理已完成任务
      const settingsData = await chrome.storage.local.get("omni_settings");
      if (settingsData.omni_settings && settingsData.omni_settings.autoClearDone) {
        setTimeout(async () => {
          let currentTasks = await getStoredTasks();
          currentTasks = currentTasks.filter((item) => item.id !== t.id);
          await saveStoredTasks(currentTasks);
        }, 3000);
      }
    } else if (delta.state.current === "interrupted") {
      t.status = "failed";
      t.error = delta.error ? delta.error.current : "下载中断";
      t.speed = "失败";
    }
    await saveStoredTasks(tasks);
  }
});

/* ---------- 平台与协议识别 ---------- */
function detectPlatformName(url) {
  if (/bilibili\.com|b23\.tv/i.test(url)) return "B站";
  if (/youtube\.com|youtu\.be/i.test(url)) return "YouTube";
  if (/douyin\.com|iesdouyin/i.test(url)) return "抖音";
  if (/eporner\.com/i.test(url)) return "Eporner";
  if (/twitter\.com|x\.com/i.test(url)) return "X/Twitter";
  if (/\.m3u8/i.test(url)) return "HLS";
  if (/\.(mp4|webm)/i.test(url)) return "MP4直链";
  return "网页视频";
}

/* ---------- 系统桌面通知 ---------- */
function notify(title, message, taskId) {
  try {
    chrome.notifications.create("omni-" + (taskId || Date.now()), {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: "OmniVideo · " + title,
      message: String(message),
      priority: 1,
    });
  } catch (e) {}
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id);
  const taskId = id.replace(/^omni-/, "");
  const tasks = await getStoredTasks();
  const target = tasks.find((t) => t.id === taskId);
  if (target && target.downloadId) {
    chrome.downloads.show(target.downloadId);
  }
});

/* ---------- 右键菜单 (Context Menus) ---------- */
const MENU_IDS = {
  PAGE: "omni_menu_page",
  LINK: "omni_menu_link",
  VIDEO: "omni_menu_video",
};

let isSettingUpMenus = false;
function setupMenus() {
  if (!chrome.contextMenus || isSettingUpMenus) return;
  isSettingUpMenus = true;

  chrome.contextMenus.removeAll(() => {
    if (chrome.runtime.lastError) {}

    const items = [
      { id: MENU_IDS.PAGE, title: "OmniVideo: 下载当前页面视频", contexts: ["page"] },
      { id: MENU_IDS.LINK, title: "OmniVideo: 下载此链接中的视频", contexts: ["link"] },
      { id: MENU_IDS.VIDEO, title: "OmniVideo: 下载此视频", contexts: ["video"] },
    ];

    for (const item of items) {
      chrome.contextMenus.create(item, () => {
        if (chrome.runtime.lastError) {}
      });
    }
    isSettingUpMenus = false;
  });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  let targetUrl = "";
  let title = tab ? tab.title : "";

  if (info.menuItemId === MENU_IDS.VIDEO) {
    targetUrl = info.srcUrl && !info.srcUrl.startsWith("blob:") ? info.srcUrl : tab?.url;
  } else if (info.menuItemId === MENU_IDS.LINK) {
    targetUrl = info.linkUrl;
  } else if (info.menuItemId === MENU_IDS.PAGE) {
    targetUrl = tab?.url;
  }

  if (targetUrl) {
    sendDownload(targetUrl, title, "best");
  }
});


/* ---------- 运行时消息通道 ---------- */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return;

  // 1. 同步优先处理 openSidePanel，保留浏览器严格要求的 user gesture
  if (msg.type === "openSidePanel") {
    if (chrome.sidePanel && typeof chrome.sidePanel.open === "function") {
      const tabId = sender && sender.tab && sender.tab.id;
      const windowId = sender && sender.tab && sender.tab.windowId;
      const options = tabId ? { tabId } : (windowId ? { windowId } : {});

      chrome.sidePanel.open(options)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => {
          if (windowId && options.tabId) {
            chrome.sidePanel.open({ windowId })
              .then(() => sendResponse({ ok: true }))
              .catch((e2) => sendResponse({ ok: false, error: e2?.message || err?.message }));
          } else {
            sendResponse({ ok: false, error: err?.message || String(err) });
          }
        });
      return true;
    } else {
      sendResponse({ ok: false, error: "sidePanel API 不支持" });
      return false;
    }
  }

  // 2. 纯前端下载与状态指令处理
  (async () => {
    try {
      switch (msg.type) {
      case "getState":
        sendResponse({
          ok: true,
          mode: "standalone",
          server: "本地纯前端独立引擎",
          isStandalone: true,
          version: "3.0.0",
        });
        break;

      case "health":
        sendResponse({
          ok: true,
          online: true,
          standalone: true,
          engine: "Offscreen WebCrypto/Mux Transmuxer",
        });
        break;

      case "getSettings": {
        const store = await chrome.storage.local.get("omni_settings");
        const defaultSettings = {
          concurrency: 5,
          defaultQuality: "best",
          autoClearDone: false,
          showSideCapsule: true,
          showCardCapsule: true,
          showPlayerCapsule: true,
        };
        sendResponse({
          ok: true,
          settings: { ...defaultSettings, ...(store.omni_settings || {}) },
        });
        break;
      }

      case "saveSettings": {
        const store = await chrome.storage.local.get("omni_settings");
        const merged = { ...(store.omni_settings || {}), ...(msg.settings || {}) };
        await chrome.storage.local.set({ omni_settings: merged });
        sendResponse({ ok: true });
        break;
      }

      case "getTasks": {
        const page = parseInt(msg.page || 1, 10);
        const pageSize = parseInt(msg.pageSize || 10, 10);
        let all = await getStoredTasks();

        // 自动巡检：若有处于下载/混流/转码中或缺少本地路径的任务，尝试向 Chrome Downloads 及本地引擎对齐真实状态与文件路径
        let changed = false;

        // 1. 优先对齐 Chrome Downloads 原生下载状态
        for (const t of all) {
          if (t.downloadId && chrome.downloads && chrome.downloads.search) {
            try {
              const dItems = await chrome.downloads.search({ id: t.downloadId });
              if (dItems && dItems[0]) {
                const di = dItems[0];
                if (di.filename && di.filename !== t.filePath) {
                  t.filePath = di.filename;
                  changed = true;
                }
                if (di.state === "complete") {
                  if (t.status !== "done") {
                    t.status = "done";
                    t.progress = 1.0;
                    t.speed = "已完成";
                    t.finished_at = t.finished_at || Date.now();
                    if (di.fileSize) t.size = parseFloat((di.fileSize / 1024 / 1024).toFixed(1));
                    t.error = null;
                    changed = true;
                  }
                } else if (di.state === "in_progress") {
                  if (t.status !== "downloading" || t.error) {
                    t.status = "downloading";
                    t.error = null;
                    changed = true;
                  }
                  if (di.totalBytes > 0) {
                    const newProg = parseFloat((di.bytesReceived / di.totalBytes).toFixed(2));
                    if (newProg !== t.progress) {
                      t.progress = newProg;
                      changed = true;
                    }
                    t.size = parseFloat((di.totalBytes / 1024 / 1024).toFixed(1));
                    t.speed = `下载中 ${Math.round(t.progress * 100)}%`;
                  } else if (di.bytesReceived > 0) {
                    const curMB = parseFloat((di.bytesReceived / 1024 / 1024).toFixed(1));
                    t.size = curMB;
                    if (t.approxSize && t.approxSize > 0) {
                      const calcProg = Math.min(0.99, parseFloat((curMB / t.approxSize).toFixed(2)));
                      if (calcProg !== t.progress) {
                        t.progress = calcProg;
                        changed = true;
                      }
                      t.speed = `⚡ 实时落盘中 ${Math.round(t.progress * 100)}% (${curMB} MB)`;
                    } else {
                      t.speed = `⚡ 实时落盘中 (${curMB} MB)`;
                    }
                  }
                } else if (di.state === "interrupted") {
                  if (t.status !== "failed") {
                    t.status = "failed";
                    t.error = di.error ? `下载中断: ${di.error}` : "浏览器下载已中断";
                    t.speed = "失败";
                    changed = true;
                  }
                }
              }
            } catch (e) {}
          }
        }



        if (changed) {
          await saveStoredTasks(all);
        }

        const start = (page - 1) * pageSize;
        const paged = all.slice(start, start + pageSize);
        sendResponse({
          ok: true,
          data: {
            tasks: paged,
            total: all.length,
            page,
            page_size: pageSize,
          },
        });
        break;
      }

      case "sendDownload": {
        const tabId = (sender && sender.tab) ? sender.tab.id : (msg.tabId || null);
        const res = await sendDownload(msg.url, msg.title, msg.quality, msg.extra, tabId);
        sendResponse(res);
        break;
      }

      case "recordMseTask": {
        const tasks = await getStoredTasks();
        const tid = msg.taskId || generateTaskId();
        const existingIdx = tasks.findIndex(
          (t) => t.id === tid || (t.title === msg.title && t.status === "downloading")
        );

        if (existingIdx !== -1) {
          tasks[existingIdx] = {
            ...tasks[existingIdx],
            status: msg.status || "done",
            progress: msg.status === "done" ? 1.0 : (msg.progress || 0.5),
            size: parseFloat(msg.size || tasks[existingIdx].size || 0),
            speed: msg.status === "done" ? "已完成" : "内存捕获中",
            finished_at: msg.status === "done" ? Date.now() : null,
          };
        } else {
          const newTask = {
            id: tid,
            url: msg.url || (sender && sender.tab ? sender.tab.url : ""),
            title: msg.title || "网页视频",
            status: msg.status || "done",
            progress: msg.status === "done" ? 1.0 : 0.5,
            speed: msg.status === "done" ? "已完成" : "内存捕获中",
            size: parseFloat(msg.size || 0),
            platform: msg.platform || "YouTube",
            created_at: Date.now(),
            finished_at: msg.status === "done" ? Date.now() : null,
          };
          tasks.unshift(newTask);
        }
        await saveStoredTasks(tasks);
        if (msg.status === "done") {
          notify("下载完成 ✓", `${msg.title || "视频"} (${msg.size || 0} MB)`, tid);
        }
        sendResponse({ ok: true });
        break;
      }

      case "getTabMedia": {
        const tabId = msg.tabId || (sender && sender.tab ? sender.tab.id : null);
        sendResponse({ ok: true, media: tabMediaPool.get(tabId) || [] });
        break;
      }

      case "retryTask": {
        const tasks = await getStoredTasks();
        const target = tasks.find((t) => t.id === msg.id);
        if (target) {
          target.status = "queued";
          target.progress = 0;
          target.error = null;
          target.created_at = Date.now();
          target.speed = "重新准备中";
          target.downloadId = null;
          target.serverTid = null;
          await saveStoredTasks(tasks);
          dispatchTaskExecution(target);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: "任务不存在" });
        }
        break;
      }

      case "deleteTask": {
        let tasks = await getStoredTasks();
        tasks = tasks.filter((t) => t.id !== msg.id);
        await saveStoredTasks(tasks);
        // 通知 offscreen 取消正在进行的任务
        chrome.runtime.sendMessage({ type: "OFFSCREEN_CANCEL_TASK", taskId: msg.id }).catch(() => {});
        sendResponse({ ok: true });
        break;
      }

      case "clearDone": {
        let tasks = await getStoredTasks();
        tasks = tasks.filter((t) => !["done", "failed"].includes(t.status));
        await saveStoredTasks(tasks);
        sendResponse({ ok: true });
        break;
      }

      case "openFile": {
        const tasks = await getStoredTasks();
        let target = tasks.find((t) => t.id === msg.id);
        if (!target) {
          sendResponse({ ok: false, error: "未找到该任务记录" });
          break;
        }

        const isServerAlive = await checkLocalServer();

        // 0. 若有 downloadId，先查询 Chrome Downloads 获取用户磁盘真实文件路径
        if (target.downloadId && chrome.downloads && chrome.downloads.search) {
          try {
            const dItems = await chrome.downloads.search({ id: target.downloadId });
            if (dItems && dItems[0] && dItems[0].filename) {
              target.filePath = dItems[0].filename;
              await updateTaskStatus(target.id, { filePath: dItems[0].filename });
            }
          } catch (e) {}
        }

        // 1. 优先通过本地引擎通用 open-local 进行 macOS 访达原生高亮定位
        if (target.filePath && isServerAlive) {
          try {
            const resp = await fetch(`${LOCAL_ENGINE_BASE}/api/open-local`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: target.filePath, action: "locate" }),
            });
            if (resp.ok) {
              sendResponse({ ok: true, message: "已在访达 (Finder) 中定位" });
              break;
            }
          } catch (e) {}
        }

        // 4. 尝试通过 Chrome Downloads API 定位
        let showSuccess = false;
        if (target.downloadId) {
          try {
            chrome.downloads.show(target.downloadId);
            showSuccess = true;
          } catch (e) {}
        }

        // 5. 尝试在 Chrome 下载记录中按标题模糊匹配定位
        if (!showSuccess && chrome.downloads && chrome.downloads.search) {
          try {
            const q = (target.title || "").slice(0, 16).trim();
            const items = await chrome.downloads.search({ query: [q] });
            if (items && items[0] && items[0].id) {
              chrome.downloads.show(items[0].id);
              showSuccess = true;
            }
          } catch (e) {}
        }

        if (showSuccess) {
          sendResponse({ ok: true, message: "已在访达 (Finder) 中定位" });
        } else {
          sendResponse({ ok: false, error: "未找到本地已落盘文件，请检查系统下载目录" });
        }
        break;
      }

      case "playFile": {
        const tasks = await getStoredTasks();
        let target = tasks.find((t) => t.id === msg.id);
        if (!target) {
          sendResponse({ ok: false, error: "未找到该任务记录" });
          break;
        }

        const isServerAlive = await checkLocalServer();

        // 0. 若有 downloadId，先查询 Chrome Downloads 获取用户磁盘真实文件路径
        if (target.downloadId && chrome.downloads && chrome.downloads.search) {
          try {
            const dItems = await chrome.downloads.search({ id: target.downloadId });
            if (dItems && dItems[0]) {
              if (dItems[0].state === "in_progress") {
                sendResponse({ ok: false, error: "文件仍在下载中，请等待下载完成后再播放" });
                break;
              }
              if (dItems[0].state === "interrupted") {
                sendResponse({ ok: false, error: "文件下载已中断，请点击重试" });
                break;
              }
              if (dItems[0].filename) {
                target.filePath = dItems[0].filename;
                await updateTaskStatus(target.id, { filePath: dItems[0].filename });
              }
            }
          } catch (e) {}
        }

        // 1. 优先通过本地引擎通用 open-local 系统级直接调用 macOS 默认播放器打开
        if (target.filePath && isServerAlive) {
          try {
            const resp = await fetch(`${LOCAL_ENGINE_BASE}/api/open-local`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ path: target.filePath, action: "play" }),
            });
            if (resp.ok) {
              sendResponse({ ok: true, message: "已在系统默认播放器中打开" });
              break;
            }
          } catch (e) {}
        }

        // 4. 尝试通过 Chrome Downloads API 打开
        let playSuccess = false;
        if (target.downloadId) {
          try {
            chrome.downloads.open(target.downloadId);
            playSuccess = true;
          } catch (e) {
            try {
              chrome.downloads.show(target.downloadId);
              playSuccess = true;
            } catch (e2) {}
          }
        }

        // 5. 尝试在 Chrome 下载记录中按标题匹配打开
        if (!playSuccess && chrome.downloads && chrome.downloads.search) {
          try {
            const q = (target.title || "").slice(0, 16).trim();
            const items = await chrome.downloads.search({ query: [q] });
            if (items && items[0] && items[0].id) {
              try {
                chrome.downloads.open(items[0].id);
                playSuccess = true;
              } catch (e) {
                chrome.downloads.show(items[0].id);
                playSuccess = true;
              }
            }
          } catch (e) {}
        }

        // 6. 兜底：若有下载 URL，则在浏览器新标签页打开
        if (!playSuccess && target.downloadUrl) {
          chrome.tabs.create({ url: target.downloadUrl, active: true });
          playSuccess = true;
        }

        if (playSuccess) {
          sendResponse({ ok: true, message: "已启动播放" });
        } else {
          sendResponse({ ok: false, error: "未找到本地可播放视频文件，请重试下载" });
        }
        break;
      }

      case "OFFSCREEN_UPDATE_TASK": {
        if (msg.taskId && msg.patch) {
          await updateTaskStatus(msg.taskId, msg.patch);
        }
        sendResponse({ ok: true });
        break;
      }

      case "OFFSCREEN_TRIGGER_DOWNLOAD": {
        const dlOpts = await getDownloadOptions(msg.filename, msg.blobUrl);
        if (msg.saveAs !== undefined) dlOpts.saveAs = !!msg.saveAs;
        chrome.downloads.download(dlOpts, (dlId) => {
          if (chrome.runtime.lastError || !dlId) {
            sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "下载失败" });
          } else {
            sendResponse({ ok: true, downloadId: dlId });
          }
        });
        break;
      }

      case "OFFSCREEN_NOTIFY": {
        notify(msg.title || "下载完成 ✓", msg.message || "");
        sendResponse({ ok: true });
        break;
      }

      case "OFFSCREEN_AUTO_CLEAR": {
        if (msg.taskId) {
          const settingsData = await chrome.storage.local.get("omni_settings");
          if (settingsData.omni_settings && settingsData.omni_settings.autoClearDone) {
            setTimeout(async () => {
              const all = await getStoredTasks();
              const remaining = all.filter((t) => t.id !== msg.taskId);
              await saveStoredTasks(remaining);
            }, 3000);
          }
        }
        sendResponse({ ok: true });
        break;
      }

      default:
        sendResponse({ ok: false, error: "unknown message: " + msg.type });
    }
  } catch (err) {
    console.error("后台消息响应异常:", err);
    sendResponse({ ok: false, error: err.message || "后台处理异常" });
  }
})();

  return true; // 异步支持
});

/* ---------- 启动初始化 ---------- */
async function init() {
  await setupDNRRules();
  const tasks = await getStoredTasks();
  updateBadge(tasks);

  // 配置点击扩展图标直接在右侧打开 SidePanel
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
}

// 兼容 action 点击直接展开右侧边栏
if (chrome.action && chrome.action.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    if (chrome.sidePanel && chrome.sidePanel.open && tab && tab.id) {
      chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
    }
  });
}

chrome.runtime.onInstalled.addListener(async () => {
  setupMenus();
  init();

  // 扩展安装或刷新时，自动重连所有已打开的网页标签
  if (chrome.scripting && chrome.scripting.executeScript) {
    try {
      const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
      for (const t of tabs) {
        if (t.id && t.url && !t.url.startsWith("chrome://")) {
          chrome.scripting.insertCSS({
            target: { tabId: t.id },
            files: ["content.css"],
          }).catch(() => {});

          chrome.scripting.executeScript({
            target: { tabId: t.id },
            world: "MAIN",
            files: ["core/mse-catcher.js"],
          }).catch(() => {});

          chrome.scripting.executeScript({
            target: { tabId: t.id },
            files: ["content.js"],
          }).catch(() => {});
        }
      }
    } catch (e) {}
  }
});

chrome.runtime.onStartup.addListener(() => {
  init();
});

init();
