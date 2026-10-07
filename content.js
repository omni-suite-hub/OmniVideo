/* OmniVideo · 网页端内容嗅探与交互脚本 (v2.1 增强胶囊版)
   功能：
   1. 播放器悬浮全能胶囊：一键下载、画质切换、音频提取(MP3)、高保真截图、画中画、突破倍速、循环播放、复制链接
   2. 网页视频列表卡片智能识别与微型悬浮下载按钮
   3. 网页右侧吸边胶囊：吸附在右侧边缘，点击一键唤起右侧下载边栏
   4. 为侧边栏与弹窗提供全量页面视频嗅探数据
*/
(function () {
  "use strict";

  // 彻底清理旧版本残留的失效胶囊、悬浮条与监听器
  document.querySelectorAll(".omni-player-capsule, .omni-side-capsule, .omni-inpage-toast, .omni-card-capsule").forEach((el) => el.remove());
  document.querySelectorAll("video").forEach((v) => delete v.dataset.omniAttached);
  if (window.__omniVideoObserver) {
    try { window.__omniVideoObserver.disconnect(); } catch (e) {}
  }
  window.__omniVideoInjected = true;

  /* ---------- MSE 内存捕获引擎与录制器状态同步 ---------- */
  let mseState = {
    totalBytes: 0,
    videoCount: 0,
    audioCount: 0,
    videoMime: "",
    audioMime: "",
    isComplete: false,
    sizeFormatted: "0 KB",
  };
  let isFastBuffering = false;
  let isRecording = false;

  // 立即查询网页原生层 MSE 状态 (若已有缓冲切片立即可见)
  window.postMessage({ type: "OMNI_MSE_QUERY" }, "*");

  /* ---------- 胶囊显示与隐藏全局配置 ---------- */
  let omniSettings = {
    showSideCapsule: true,
    showCardCapsule: true,
    showPlayerCapsule: true,
  };

  function applyCapsuleVisibility() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.toggle("omni-hide-side-capsule", omniSettings.showSideCapsule === false);
    root.classList.toggle("omni-hide-card-capsule", omniSettings.showCardCapsule === false);
    root.classList.toggle("omni-hide-player-capsule", omniSettings.showPlayerCapsule === false);
  }

  // 初始启动加载偏好设置
  if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
    chrome.storage.local.get("omni_settings", (res) => {
      if (res && res.omni_settings) {
        omniSettings = { ...omniSettings, ...res.omni_settings };
        applyCapsuleVisibility();
      }
    });

    // 实时监听设置变更 (用户在设置切换开关时多标签页瞬间生效)
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.omni_settings) {
        const newSettings = changes.omni_settings.newValue || {};
        omniSettings = { ...omniSettings, ...newSettings };
        applyCapsuleVisibility();

        if (omniSettings.showSideCapsule !== false) {
          attachSideCapsule();
        }
        if (omniSettings.showCardCapsule !== false || omniSettings.showPlayerCapsule !== false) {
          scheduleScan();
        }
      }
    });
  }

  /* ---------- 正则规则 ---------- */
  const VIDEO_LINK_PATTERNS = [
    /bilibili\.com\/video\/[a-zA-Z0-9]+/i,
    /b23\.tv\/[a-zA-Z0-9]+/i,
    /youtube\.com\/watch\?v=[^&]+/i,
    /youtu\.be\/[^?&]+/i,
    /youtube\.com\/shorts\/[^?&]+/i,
    /douyin\.com\/(?:video|note)\/\d+/i,
    /iesdouyin\.com\/share\/video\/\d+/i,
    /v\.douyin\.com\/[a-zA-Z0-9]+/i,
    /eporner\.com\/video-[a-zA-Z0-9]+/i,
    /twitter\.com\/\w+\/status\/\d+/i,
    /x\.com\/\w+\/status\/\d+/i,
    /\.(mp4|webm|m3u8|flv|mov)(\?.*)?$/i,
  ];

  const CARD_SELECTORS = [
    ".bili-video-card", ".video-card", ".feed-card", ".bili-grid-item", ".rank-item",
    ".bili-feed-card", ".video-page-card-small", ".bili-movie-card",
    "ytd-rich-item-renderer", "ytd-rich-grid-media", "ytd-video-renderer", "ytd-grid-video-renderer",
    "ytd-compact-video-renderer", "ytd-reel-item-renderer", "ytd-playlist-video-renderer",
    "ytd-video-preview", "#video-preview", "#inline-preview-player", "ytd-inline-preview-renderer", "ytd-thumbnail",
    ".mb", ".mbcontent", ".video-box",
    ".aweme-item", "[data-e2e='feed-item']", "[data-e2e='user-post-item']",
    ".video-item", ".card-video", ".media-card", ".post-video"
  ];

  /* ---------- 辅助工具函数 ---------- */
  function showToast(title, message) {
    const old = document.querySelector(".omni-inpage-toast");
    if (old) old.remove();

    const toast = document.createElement("div");
    toast.className = "omni-inpage-toast";
    toast.innerHTML = `
      <div class="omni-toast-icon">✓</div>
      <div class="omni-toast-body">
        <div class="omni-toast-title">${escapeHtml(title || "提示")}</div>
        <div class="omni-toast-text">${escapeHtml(message || "")}</div>
      </div>
    `;
    document.documentElement.appendChild(toast);

    setTimeout(() => {
      if (toast && toast.parentElement) {
        toast.style.transition = "opacity 0.25s ease, transform 0.25s ease";
        toast.style.opacity = "0";
        toast.style.transform = "translateY(10px)";
        setTimeout(() => toast.remove(), 260);
      }
    }, 2500);
  }

  function escapeHtml(str) {
    return String(str || "").replace(/[&<>"']/g, (m) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  }

  const GENERIC_UI_WORDS = new Set([
    "quality", "hd", "720p", "1080p", "4k", "settings", "play", "pause", "volume",
    "sound", "download", "share", "more", "menu", "video", "eporner", "undefined", "null"
  ]);

  function cleanTitle(str) {
    if (!str) return "";
    let res = String(str)
      .replace(/⚡\s*下载/g, "")
      .replace(/✓\s*已添加/g, "")
      .replace(/^\s*\d{1,2}:\d{2}(?::\d{2})?\s*/, "")
      .replace(/\s*\d{1,2}:\d{2}(?::\d{2})?\s*$/, "")
      .replace(/ - YouTube$/i, "")
      .replace(/_哔哩哔哩_bilibili$/i, "")
      .replace(/[\r\n\t]+/g, " ")
      .trim();
    if (GENERIC_UI_WORDS.has(res.toLowerCase())) {
      return "";
    }
    return res;
  }

  /* ---------- 扩展上下文长连接守卫 (瞬间感知扩展更新，优雅退出杜绝失效报错) ---------- */
  let isContextDead = false;
  let observer = null;
  let timer = null;

  function handleContextInvalidated() {
    if (isContextDead) return;
    isContextDead = true;

    // 1. 立即断开 MutationObserver，彻底停止任何后续扫描
    try {
      if (window.__omniVideoObserver) {
        window.__omniVideoObserver.disconnect();
      }
      if (observer) {
        observer.disconnect();
      }
    } catch (e) {}

    // 2. 清理调度计时器
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }

    // 3. 将页面上所有的胶囊按钮转为醒目的刷新恢复提示
    document.querySelectorAll(".omni-player-capsule .btn-quick-dl").forEach((btn) => {
      btn.classList.remove("omni-sent");
      btn.innerHTML = "<span>🔄 扩展已更新 (点击刷新)</span>";
      btn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        location.reload();
      };
    });

    showReloadToast();
  }


  // 全局拦截未捕获的上下文失效错误，防止进入 Chrome 错误面板
  window.addEventListener("error", (e) => {
    if (e && e.message && e.message.includes("Extension context invalidated")) {
      e.preventDefault();
      e.stopPropagation();
      handleContextInvalidated();
    }
  });

  function isExtensionValid() {
    if (isContextDead) return false;
    try {
      if (typeof chrome === "undefined" || !chrome) {
        isContextDead = true;
        return false;
      }
      return Boolean(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      handleContextInvalidated();
      return false;
    }
  }

  function showReloadToast() {
    const old = document.querySelector(".omni-inpage-toast");
    if (old) old.remove();

    const toast = document.createElement("div");
    toast.className = "omni-inpage-toast";
    toast.style.cursor = "pointer";
    toast.innerHTML = `
      <div class="omni-toast-icon">🔄</div>
      <div class="omni-toast-body">
        <div class="omni-toast-title">扩展已更新</div>
        <div class="omni-toast-text">请点击此处刷新网页以恢复连接</div>
      </div>
    `;
    toast.onclick = () => location.reload();
    document.documentElement.appendChild(toast);
    setTimeout(() => { if (toast.parentElement) toast.remove(); }, 6000);
  }

  function safeSendMessage(msg, callback) {
    if (isContextDead || !isExtensionValid()) {
      showReloadToast();
      if (callback) callback({ ok: false, error: "扩展已更新，请刷新网页" });
      return;
    }
    try {
      let done = false;
      const timeoutTimer = setTimeout(() => {
        if (!done) {
          done = true;
          if (callback) callback({ ok: false, error: "后台响应超时" });
        }
      }, 5000);

      chrome.runtime.sendMessage(msg, (res) => {
        if (done) return;
        done = true;
        clearTimeout(timeoutTimer);

        try {
          if (chrome.runtime && chrome.runtime.lastError) {
            const errMsg = chrome.runtime.lastError.message || "";
            if (errMsg.includes("invalidated")) {
              showReloadToast();
            }
            if (callback) callback({ ok: false, error: errMsg });
            return;
          }
          if (callback) callback(res || { ok: false });
        } catch (err) {
          showReloadToast();
          if (callback) callback({ ok: false, error: "扩展已更新，请刷新网页" });
        }
      });
    } catch (e) {
      showReloadToast();
      if (callback) callback({ ok: false, error: e?.message || "扩展上下文失效" });
    }
  }

  function resolveDownloadUrl(rawUrl) {
    if (!rawUrl) return window.location.href;
    const str = String(rawUrl).trim();
    if (str.startsWith("blob:") || str.startsWith("mediasource:") || !str.startsWith("http")) {
      const canonical = document.querySelector("link[rel='canonical']");
      if (canonical && canonical.href) return canonical.href;
      const ogUrl = document.querySelector("meta[property='og:url']");
      if (ogUrl && ogUrl.content) return ogUrl.content;
      return window.location.href;
    }
    return str;
  }

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

  /* ---------- 媒体流提取与平台解析 (B站/YouTube/DASH/HLS) ---------- */
  function extractBilibiliPlayInfo() {
    try {
      const scripts = document.querySelectorAll("script");
      for (const s of scripts) {
        const txt = s.textContent || "";
        if (txt.includes("window.__playinfo__")) {
          const match = txt.match(/window\.__playinfo__\s*=\s*(\{[\s\S]+?\})(?:;|\n|$)/);
          if (match) {
            return JSON.parse(match[1]);
          }
        }
      }
    } catch (e) {}
    return null;
  }

  function getMediaStreams(url) {
    // 1. B站页面提取 DASH 流
    const isBili = /bilibili\.com\/video/i.test(url || location.href);
    if (isBili) {
      const playinfo = extractBilibiliPlayInfo();
      if (playinfo && playinfo.data) {
        const dash = playinfo.data.dash;
        if (dash) {
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
              videoUrl,
              audioUrl,
              headers: {
                Referer: "https://www.bilibili.com/",
                Origin: "https://www.bilibili.com",
              },
            };
          }
        }
        if (playinfo.data.durl && playinfo.data.durl.length) {
          return {
            url: playinfo.data.durl[0].url,
            headers: { Referer: "https://www.bilibili.com/" },
          };
        }
      }
    }

    // 2. 通用流媒体嗅探 (从 Performance entries 中抓取 M3U8 / HLS 真实媒体流)
    if (window.performance && typeof window.performance.getEntriesByType === "function") {
      try {
        const resources = window.performance.getEntriesByType("resource");
        let m3u8Url = null;

        for (let i = resources.length - 1; i >= 0; i--) {
          const u = resources[i].name;
          if (!u || u.startsWith("blob:") || u.startsWith("data:")) continue;

          if (/\.m3u8(\?.*)?$/i.test(u) && !m3u8Url) {
            m3u8Url = u;
            break;
          }
        }

        if (m3u8Url) {
          return { url: m3u8Url, type: "hls" };
        }
      } catch (e) {}
    }

    return {};
  }

  function isSpecificVideoPage(url) {
    if (!url || typeof url !== "string") return false;
    if (/\.(mp4|m3u8|webm|flv|f4v|mov|ts|m4s|mp3|m4a)(\?.*)?$/i.test(url)) return false;
    if (url.includes("eporner.com")) return /\/video-[a-zA-Z0-9]+/i.test(url) || /\/embed\/[a-zA-Z0-9]+/i.test(url);
    if (url.includes("youtube.com") || url.includes("youtu.be")) return url.includes("/watch?") || url.includes("/shorts/") || url.includes("/embed/") || url.includes("youtu.be/");
    if (url.includes("bilibili.com") || url.includes("b23.tv")) return /\/video\/(BV|av)/i.test(url) || url.includes("/bangumi/play/") || url.includes("b23.tv/");
    if (url.includes("douyin.com")) return /\/video\/[0-9]+/i.test(url) || /\/note\/[0-9]+/i.test(url) || url.includes("v.douyin.com/");
    if (url.includes("twitter.com") || url.includes("x.com")) return /\/status\/[0-9]+/i.test(url);
    if (url.includes("tiktok.com")) return /\/video\/[0-9]+/i.test(url) || url.includes("vt.tiktok.com/");
    return false;
  }

  function triggerDownload(url, title, quality = "best", onDone) {
    const pageUrl = location.href;
    const finalUrl = resolveDownloadUrl(url);
    const finalTitle = (title || document.title || "网页视频").trim().replace(/[\r\n\t]+/g, " ");
    const extra = getMediaStreams(finalUrl);

    // 智能决策下载目标：
    // 1. 如果 finalUrl 本身就是具体的视频播放页或直接媒体流，优先使用 finalUrl（如点击卡片胶囊）
    // 2. 如果 finalUrl 为空或 blob 地址，且当前页面是具体的单视频播放页，则使用 pageUrl
    // 3. 避免在列表/标签页（如 /tag/、/channel/）上将分类页链接错误作为视频下载
    let downloadUrl = finalUrl;
    if (!downloadUrl || downloadUrl.startsWith("blob:")) {
      if (isSpecificVideoPage(pageUrl)) {
        downloadUrl = pageUrl;
      } else {
        downloadUrl = extra.url || (extra.videoUrl ? extra.videoUrl : finalUrl);
      }
    } else if (isSpecificVideoPage(finalUrl)) {
      downloadUrl = finalUrl;
    } else if (isSpecificVideoPage(pageUrl)) {
      downloadUrl = pageUrl;
    }

    const effectivePageUrl = isSpecificVideoPage(finalUrl) ? finalUrl : (isSpecificVideoPage(pageUrl) ? pageUrl : "");

    safeSendMessage(
      {
        type: "sendDownload",
        url: downloadUrl,
        pageUrl: effectivePageUrl,
        title: finalTitle,
        quality: quality || "best",
        extra,
      },
      (res) => {
        if (res && res.ok) {
          const typeMap = { best: "最高画质", compat: "兼容格式", audio: "MP3音频" };
          showToast(`已提交 (${typeMap[quality] || "视频"})`, finalTitle);
          if (onDone) onDone(true);
        } else {
          const err = (res && res.error) || "下载启动失败";
          showToast("提交失败", err);
          if (onDone) onDone(false);
        }
      }
    );
  }

  /* ---------- 智能获取视频播放器最外层根容器 (杜绝 YouTube/B站等内置遮罩卡片阻挡) ---------- */
  function getPlayerContainer(video) {
    if (!video) return null;
    const playerRoot = video.closest(
      "#movie_player, .html5-video-player, " +
      ".bpx-player-container, .bilibili-player-area, #bilibili-player, " +
      ".xgplayer, xg-player, " +
      ".dplayer, " +
      ".artplayer-app, .art-video-player, " +
      ".video-js, " +
      "[data-player-container], .player-container, .video-player"
    );
    if (playerRoot) return playerRoot;

    // 向上追溯到具有播放器特征的外层有效父级
    let curr = video.parentElement;
    let best = curr;
    while (curr && curr !== document.body && curr !== document.documentElement) {
      const cls = (curr.className || "").toString().toLowerCase();
      const id = (curr.id || "").toString().toLowerCase();
      if (cls.includes("player") || id.includes("player") || cls.includes("video-wrap") || cls.includes("media-container")) {
        best = curr;
      }
      curr = curr.parentElement;
    }
    return best || video.parentElement;
  }

  /* ---------- 1. 播放器超级悬浮胶囊 / 小卡片精简胶囊分流挂载 ---------- */
  function isBigVideoPlayer(video) {
    if (!video) return false;

    // 1. 如果明确处于卡片、缩略图或列表浮动预览容器内部，绝对属于小卡片/小预览
    const inCardOrPreview = video.closest(
      "#inline-preview-player, ytd-inline-preview-renderer, ytd-video-preview, #video-preview, " +
      "ytd-thumbnail, ytd-rich-grid-media, .bili-video-card, .video-card, .feed-card, " +
      CARD_SELECTORS.join(", ")
    );
    if (inCardOrPreview) return false;

    const rect = video.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;

    // 2. 常规横屏/大播放器尺寸判断（正常主播放器至少 540x280）
    if (rect.width >= 540 && rect.height >= 280) {
      return true;
    }

    // 3. 竖屏专用播放器页（如 YouTube Shorts、TikTok、抖音的独立主播放页）
    const isShortsOrVerticalPage = (
      location.pathname.includes("/shorts/") ||
      location.pathname.includes("/video/") ||
      location.host.includes("tiktok.com") ||
      location.host.includes("douyin.com")
    );
    if (isShortsOrVerticalPage && rect.height >= 500 && rect.width >= 260) {
      return true;
    }

    return false;
  }

  function attachPlayerCapsules() {
    const videos = document.querySelectorAll("video");
    videos.forEach((v) => {
      const rect = v.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 50) return;

      const isBig = isBigVideoPlayer(v);

      if (!isBig) {
        if (omniSettings.showCardCapsule === false) return;
        // 小卡片、小窗预览、推荐列表小视频等，使用精简版微型胶囊
        // 首先清理误挂或残留的完整大胶囊
        const existingFullCapsule = v.parentElement?.querySelector(".omni-player-capsule") || v.closest(CARD_SELECTORS.join(", "))?.querySelector(".omni-player-capsule");
        if (existingFullCapsule) {
          existingFullCapsule.remove();
        }

        // 挂载或确保挂载精简版胶囊
        attachSmallCardCapsuleForVideo(v);
        return;
      }

      // 真正的大视频播放器，挂载完整版超级胶囊
      if (omniSettings.showPlayerCapsule === false) return;
      attachBigPlayerCapsule(v);
    });
  }

  function attachSmallCardCapsuleForVideo(video) {
    if (!video) return;

    // 确定最适合挂载小胶囊的容器：浮动预览窗、卡片缩略图外壳或卡片容器
    const container = video.closest(
      "ytd-video-preview, #video-preview, #inline-preview-player, ytd-inline-preview-renderer, " +
      "ytd-thumbnail, .bili-video-card, .video-card, .feed-card, " +
      CARD_SELECTORS.join(", ")
    ) || video.parentElement;

    if (!container) return;
    // 如果该容器或其外层卡片已存在小胶囊，绝不重复生成第二个遮挡视频
    if (container.querySelector(".omni-card-capsule")) return;
    const outerCard = video.closest(CARD_SELECTORS.join(", "));
    if (outerCard && outerCard.querySelector(".omni-card-capsule")) return;

    // 提取视频链接与标题
    let targetUrl = "";
    let title = "";

    // 1. 尝试从容器内部或相邻结构提取 a 标签链接
    const linkEl = container.querySelector(
      "a[href*='/watch'], a[href*='/shorts/'], a[href*='/video/BV'], a#thumbnail, a#video-title-link, a.bili-video-card__info--tit, a[href]"
    );
    if (linkEl) {
      try {
        targetUrl = new URL(linkEl.getAttribute("href"), location.href).href;
      } catch (e) {}
    }

    // 2. 尝试从父级卡片追溯
    if (!targetUrl) {
      const outerCard = video.closest(CARD_SELECTORS.join(", "));
      if (outerCard) {
        const outerLink = outerCard.querySelector(
          "a[href*='/watch'], a[href*='/shorts/'], a[href*='/video/BV'], a#thumbnail, a#video-title-link, a[href]"
        );
        if (outerLink) {
          try {
            targetUrl = new URL(outerLink.getAttribute("href"), location.href).href;
          } catch (e) {}
        }
      }
    }

    // 3. 兜底尝试视频源或当前页面
    if (!targetUrl && video.src && !video.src.startsWith("blob:")) {
      targetUrl = video.src;
    }
    if (!targetUrl && isSpecificVideoPage(location.href)) {
      targetUrl = location.href;
    }

    // 提取标题
    const titleEl = container.querySelector("h3, h2, h4, .title, .video-title, #video-title, a[title]");
    if (titleEl) {
      title = titleEl.getAttribute("title") || titleEl.textContent || "";
    }
    if (!title) {
      const img = container.querySelector("img[alt]");
      if (img) title = img.getAttribute("alt") || "";
    }

    mountCardCapsule(container, targetUrl, title);
  }

  function attachBigPlayerCapsule(v) {
    const parent = getPlayerContainer(v);
    if (!parent) return;
    if (parent.querySelector(".omni-player-capsule")) return;
    if (v.dataset.omniAttached) return;

    v.dataset.omniAttached = "true";

    // 清理 parent 内部可能残留的卡片微型胶囊，杜绝双胶囊重叠
    const existingCards = parent.querySelectorAll(".omni-card-capsule");
    existingCards.forEach((c) => c.remove());

      const pStyle = window.getComputedStyle(parent);
      if (pStyle.position === "static") {
        parent.style.position = "relative";
      }

      const initialBtnText = `⚡ 下载 MP4`;

      // 构建超级胶囊
      const capsule = document.createElement("div");
      capsule.className = "omni-player-capsule";

      capsule.innerHTML = `
        <!-- 拖拽手柄 -->
        <span class="omni-capsule-drag-handle" title="按住可拖拽移动位置">⠿</span>

        <!-- 核心下载按钮 -->
        <button class="omni-capsule-btn primary btn-quick-dl" title="一键下载当前视频">
          <span>${initialBtnText}</span>
        </button>

        <span class="omni-capsule-sep"></span>

        <!-- 截图按钮 -->
        <button class="omni-capsule-btn btn-screenshot" title="截取当前帧高清图片 (PNG)">
          <span>📸 截图</span>
        </button>

        <!-- 画中画按钮 -->
        <button class="omni-capsule-btn btn-pip" title="开启/退出画中画悬浮窗">
          <span>🪟 画中画</span>
        </button>

        <span class="omni-capsule-sep"></span>

        <!-- 更多扩展菜单 -->
        <div class="omni-capsule-menu-wrap">
          <button class="omni-capsule-btn btn-more" title="更多画质与播放选项">
            <span>⋯</span>
          </button>
          
          <div class="omni-capsule-dropdown">
            <div class="omni-menu-sec-title">下载清晰度</div>
            <button class="omni-menu-item opt-dl-best">
              <span class="menu-icon">🔥</span><span>最高画质 (4K / 1080P)</span>
            </button>
            <button class="omni-menu-item opt-dl-compat">
              <span class="menu-icon">⚡</span><span>标准兼容 (1080P H.264)</span>
            </button>
            <button class="omni-menu-item opt-dl-audio">
              <span class="menu-icon">🎵</span><span>提取纯音频 (MP3)</span>
            </button>

            <div class="omni-menu-sec-title">倍速播放</div>
            <div class="omni-speed-row">
              <span class="omni-speed-chip" data-speed="1.0">1.0x</span>
              <span class="omni-speed-chip" data-speed="1.25">1.25</span>
              <span class="omni-speed-chip" data-speed="1.5">1.5x</span>
              <span class="omni-speed-chip" data-speed="2.0">2.0x</span>
              <span class="omni-speed-chip" data-speed="3.0">3.0x</span>
            </div>

            <div class="omni-menu-sec-title">快捷工具</div>
            <button class="omni-menu-item opt-copy-link">
              <span class="menu-icon">🔗</span><span>复制视频链接</span>
            </button>
            <button class="omni-menu-item opt-loop-play">
              <span class="menu-icon">🔁</span><span>循环播放 (当前: 关)</span>
            </button>
            <button class="omni-menu-item opt-open-panel">
              <span class="menu-icon">📋</span><span>打开下载管理面板</span>
            </button>
          </div>
        </div>
      `;

      // 事件绑定
      const getTargetUrl = () => location.href || v.currentSrc || v.src;
      const getPageTitle = () => (document.querySelector("h1")?.textContent || document.title || "").trim();

      // 1. 快捷下载 (一键极速下载 MP4)
      const quickBtn = capsule.querySelector(".btn-quick-dl");
      quickBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (!isExtensionValid()) {
          showReloadToast();
          return;
        }

        quickBtn.classList.add("omni-sent");
        quickBtn.innerHTML = "<span>⏳ 解析中…</span>";

        let finished = false;
        const resetBtn = (html = "<span>⚡ 下载 MP4</span>") => {
          if (finished) return;
          finished = true;
          quickBtn.classList.remove("omni-sent");
          quickBtn.innerHTML = html;
        };

        // 5秒超时兜底保护
        setTimeout(() => {
          if (!finished) resetBtn("<span>⚡ 下载 MP4</span>");
        }, 5000);

        triggerDownload(location.href, getPageTitle(), "best", (ok) => {
          if (ok) {
            resetBtn("<span>✓ 已添加下载</span>");
            setTimeout(() => {
              quickBtn.innerHTML = "<span>⚡ 下载 MP4</span>";
            }, 2500);
          } else {
            resetBtn("<span>! 下载失败</span>");
            setTimeout(() => {
              quickBtn.innerHTML = "<span>⚡ 下载 MP4</span>";
            }, 3000);
          }
        });
      });

      // 2. 视频截图功能 (截取当前帧)
      const snapBtn = capsule.querySelector(".btn-screenshot");
      snapBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        captureFrame(v, getPageTitle());
      });

      // 3. 画中画 (PiP)
      const pipBtn = capsule.querySelector(".btn-pip");
      pipBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        togglePictureInPicture(v);
      });

      // 4. 更多菜单点击切换保持与防失焦控制
      const moreBtn = capsule.querySelector(".btn-more");
      const dropdown = capsule.querySelector(".omni-capsule-dropdown");
      moreBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        dropdown.classList.toggle("open");
        capsule.classList.toggle("open", dropdown.classList.contains("open"));
      });
      dropdown.addEventListener("click", () => {
        dropdown.classList.remove("open");
        capsule.classList.remove("open");
      });
      document.addEventListener("click", (e) => {
        if (!capsule.contains(e.target)) {
          dropdown.classList.remove("open");
          capsule.classList.remove("open");
        }
      });

      // MSE 专属控制
      capsule.querySelector(".opt-fast-buffer")?.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        window.postMessage({ type: "OMNI_MSE_START_FAST_BUFFER" }, "*");
        showToast("极速缓冲已启动 ⏬", "正在自动跳转缓冲尾快速加载全片切片");
      });

      capsule.querySelector(".opt-recorder")?.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (!isRecording) {
          window.postMessage({ type: "OMNI_RECORDER_START", title: getPageTitle() }, "*");
        } else {
          window.postMessage({ type: "OMNI_RECORDER_STOP" }, "*");
        }
      });

      capsule.querySelector(".opt-export-video")?.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        window.postMessage({ type: "OMNI_MSE_DIRECT_DOWNLOAD", title: getPageTitle(), which: "video" }, "*");
      });

      capsule.querySelector(".opt-export-audio")?.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        window.postMessage({ type: "OMNI_MSE_DIRECT_DOWNLOAD", title: getPageTitle(), which: "audio" }, "*");
      });

      capsule.querySelector(".opt-clear-mse")?.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        window.postMessage({ type: "OMNI_MSE_CLEAR" }, "*");
        showToast("缓存已重置", "MSE 内存分片已清空");
      });

      capsule.querySelector(".opt-dl-best").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        triggerDownload(getTargetUrl(), getPageTitle(), "best");
      });
      capsule.querySelector(".opt-dl-compat").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        triggerDownload(getTargetUrl(), getPageTitle(), "compat");
      });
      capsule.querySelector(".opt-dl-audio").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        triggerDownload(getTargetUrl(), getPageTitle(), "audio");
      });

      // 倍速调节
      capsule.querySelectorAll(".omni-speed-chip").forEach((chip) => {
        chip.addEventListener("click", (e) => {
          e.preventDefault(); e.stopPropagation();
          const speed = parseFloat(chip.dataset.speed) || 1.0;
          v.playbackRate = speed;
          capsule.querySelectorAll(".omni-speed-chip").forEach((c) => c.classList.remove("active"));
          chip.classList.add("active");
          showToast("倍速调节", `已设置为 ${speed}x 播放`);
        });
      });

      // 循环播放
      const loopBtn = capsule.querySelector(".opt-loop-play");
      loopBtn.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        v.loop = !v.loop;
        loopBtn.querySelector("span:last-child").textContent = `循环播放 (当前: ${v.loop ? "开" : "关"})`;
        showToast("循环播放", v.loop ? "已开启单视频循环" : "已关闭循环");
      });

      // 复制链接
      capsule.querySelector(".opt-copy-link").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        const pureUrl = resolveDownloadUrl(getTargetUrl());
        navigator.clipboard.writeText(pureUrl).then(() => {
          showToast("复制成功", pureUrl);
        }).catch(() => {
          showToast("复制失败", "未能写入剪贴板");
        });
      });

      // 打开右侧下载面板
      capsule.querySelector(".opt-open-panel").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        safeSendMessage({ type: "openSidePanel" });
      });

      // 5. 鼠标进出播放器区域显示/隐藏控制 (离开播放器立即隐藏，播放中空闲 3 秒自动淡出)
      let hideTimer = null;
      const showCapsule = () => {
        capsule.classList.add("omni-active");
        if (hideTimer) clearTimeout(hideTimer);
        if (!v.paused) {
          hideTimer = setTimeout(() => {
            if (!capsule.matches(":hover") && !capsule.querySelector(".open")) {
              capsule.classList.remove("omni-active");
            }
          }, 3000);
        }
      };

      const hideCapsule = () => {
        if (hideTimer) clearTimeout(hideTimer);
        if (!capsule.querySelector(".open") && !capsule.classList.contains("is-dragging")) {
          capsule.classList.remove("omni-active");
        }
      };

      parent.addEventListener("mousemove", showCapsule, { passive: true });
      parent.addEventListener("mouseenter", showCapsule, { passive: true });
      parent.addEventListener("mouseleave", hideCapsule, { passive: true });

      capsule.addEventListener("mouseenter", () => {
        if (hideTimer) clearTimeout(hideTimer);
        capsule.classList.add("omni-active");
      });
      capsule.addEventListener("mouseleave", () => {
        showCapsule();
      });

      parent.appendChild(capsule);
      makeDraggable(capsule, capsule.querySelector(".omni-capsule-drag-handle"), parent);
  }

  /* ---------- 胶囊拖拽引擎 (支持自由拖拽与边缘贴靠保护) ---------- */
  function makeDraggable(capsule, handle, container) {
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;
    let hasMoved = false;

    const onMouseDown = (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".omni-capsule-dropdown")) return;

      const parentEl = container || capsule.parentElement || document.body;
      const cRect = capsule.getBoundingClientRect();
      const pRect = parentEl.getBoundingClientRect();

      startX = e.clientX;
      startY = e.clientY;
      startLeft = cRect.left - pRect.left;
      startTop = cRect.top - pRect.top;
      hasMoved = false;

      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!hasMoved && Math.hypot(dx, dy) < 4) return;

        if (!hasMoved) {
          hasMoved = true;
          capsule.classList.add("is-dragging");
          document.body.style.userSelect = "none";
        }

        const curPRect = parentEl.getBoundingClientRect();
        const maxLeft = Math.max(0, curPRect.width - capsule.offsetWidth);
        const maxTop = Math.max(0, curPRect.height - capsule.offsetHeight);

        const newLeft = Math.min(Math.max(0, startLeft + dx), maxLeft);
        const newTop = Math.min(Math.max(0, startTop + dy), maxTop);

        capsule.style.setProperty("left", `${newLeft}px`, "important");
        capsule.style.setProperty("top", `${newTop}px`, "important");
        capsule.style.setProperty("right", "auto", "important");
        capsule.style.setProperty("bottom", "auto", "important");
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        document.body.style.userSelect = "";

        if (hasMoved) {
          capsule.classList.remove("is-dragging");
          const captureClick = (clickEvent) => {
            clickEvent.stopPropagation();
            clickEvent.preventDefault();
            window.removeEventListener("click", captureClick, true);
          };
          window.addEventListener("click", captureClick, true);
        }
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    };

    if (handle) {
      handle.addEventListener("mousedown", onMouseDown);
    }
    capsule.addEventListener("mousedown", (e) => {
      if (e.target === capsule || e.target.classList.contains("omni-capsule-sep")) {
        onMouseDown(e);
      }
    });
  }

  /* 截取当前视频帧并保存为 PNG */
  function captureFrame(video, title) {
    try {
      const w = video.videoWidth || video.clientWidth;
      const h = video.videoHeight || video.clientHeight;
      if (!w || !h) {
        showToast("截图失败", "视频画面未就绪");
        return;
      }
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(video, 0, 0, w, h);

      canvas.toBlob((blob) => {
        if (!blob) {
          showToast("截图失败", "画面渲染导出失败");
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const curSec = Math.floor(video.currentTime || 0);
        const safeTitle = (title || "视频").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40);
        a.download = `${safeTitle}_${curSec}s.png`;
        a.href = url;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 3000);
        showToast("截图已保存 ✓", `${w}x${h} PNG 图片`);
      }, "image/png");
    } catch (e) {
      showToast("截图受限", "视频源受跨域安全策略保护，无法直接读取画面");
    }
  }

  /* 画中画切换 */
  function togglePictureInPicture(video) {
    if (document.pictureInPictureElement === video) {
      document.exitPictureInPicture().catch(() => {});
    } else if (video.requestPictureInPicture) {
      video.requestPictureInPicture().catch((err) => {
        showToast("画中画受限", err.message || "浏览器或播放器不支持");
      });
    } else {
      showToast("不支持", "当前浏览器暂未开启画中画 API");
    }
  }

  /* ---------- 2. 网页右侧吸附悬浮胶囊 (吸在右边) ---------- */
  function attachSideCapsule() {
    if (omniSettings.showSideCapsule === false) return;
    if (document.querySelector(".omni-side-capsule")) return;

    const capsule = document.createElement("div");
    capsule.className = "omni-side-capsule";
    capsule.title = "OmniVideo: 点击在浏览器右侧打开下载面板";
    capsule.innerHTML = `
      <span>⚡ OmniVideo</span>
      <span class="side-count" id="omniSideCount">0</span>
    `;

    capsule.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();

      capsule.style.transform = "translateY(-50%) scale(0.93)";
      setTimeout(() => {
        capsule.style.transform = "translateY(-50%) scale(1)";
      }, 150);

      safeSendMessage({ type: "openSidePanel" }, (res) => {
        if (res && res.ok) {
          showToast("OmniVideo", "已展开右侧下载面板");
        } else {
          showToast("OmniVideo", "请点击右上角插件图标查看");
        }
      });
    });

    document.documentElement.appendChild(capsule);
  }

  function updateSideCapsuleCount(count) {
    const el = document.getElementById("omniSideCount");
    if (el) {
      el.textContent = String(count || 0);
      el.style.display = count > 0 ? "inline-block" : "none";
    }
  }

  /* ---------- 3. 视频列表卡片识别与微型下载按钮 ---------- */
  function attachCardBadges() {
    if (omniSettings.showCardCapsule === false) return;
    CARD_SELECTORS.forEach((sel) => {
      document.querySelectorAll(sel).forEach((card) => {
        // 绝对跳过非预览的独立主播放器容器内部的元素
        const isMainPlayer = card.closest("#movie_player, .bpx-player-container, .xgplayer, .dplayer, .video-js, [data-player-container], .omni-player-capsule");
        const isPreviewOrCard = card.closest("#inline-preview-player, ytd-inline-preview-renderer, ytd-video-preview, #video-preview, ytd-thumbnail, .bili-video-card");
        if (isMainPlayer && !isPreviewOrCard) {
          return;
        }
        if (card.querySelector(".omni-card-capsule")) return;
        mountCardCapsule(card);
      });
    });

    const allLinks = document.querySelectorAll("a[href]");
    allLinks.forEach((a) => {
      // 绝对跳过主播放器内部的所有链接 (如 YouTube 播放器顶部标题、频道头像、片尾推荐等)
      const isMainPlayer = a.closest("#movie_player, .bpx-player-container, .xgplayer, .dplayer, .video-js, [data-player-container], .omni-player-capsule");
      const isPreviewOrCard = a.closest("#inline-preview-player, ytd-inline-preview-renderer, ytd-video-preview, #video-preview, ytd-thumbnail, .bili-video-card");
      if (isMainPlayer && !isPreviewOrCard) {
        return;
      }
      // 如果外层卡片已经挂载了胶囊，绝不在子链接 a 标签上重复挂载
      const parentCard = a.closest(CARD_SELECTORS.join(", "));
      if (parentCard && parentCard.querySelector(".omni-card-capsule")) return;

      const href = a.getAttribute("href");
      if (!href) return;
      let fullUrl = "";
      try {
        fullUrl = new URL(href, location.href).href;
      } catch (e) {
        return;
      }

      const isVideoLink = VIDEO_LINK_PATTERNS.some((p) => p.test(fullUrl));
      if (!isVideoLink) return;

      const hasThumb = a.querySelector("img, picture, svg") || a.classList.contains("thumb") || a.classList.contains("picture");
      if (hasThumb && !a.dataset.omniCardAttached) {
        mountCardCapsule(a, fullUrl);
      }
    });
  }

  /* ---------- 全局单例卡片下拉菜单传送门 (挂载在 body，彻底免疫一切父级 overflow: hidden 裁剪) ---------- */
  let activeCardTarget = null;
  let cardCloseTimer = null;

  function getSharedCardDropdown() {
    let el = document.getElementById("omni-card-portal-dropdown");
    if (!el) {
      el = document.createElement("div");
      el.id = "omni-card-portal-dropdown";
      el.className = "omni-card-dropdown";
      el.innerHTML = `
        <button class="omni-card-opt opt-card-best">
          <span>🔥 最高画质 (Best)</span>
        </button>
        <button class="omni-card-opt opt-card-compat">
          <span>⚡ 兼容格式 (H.264)</span>
        </button>
        <button class="omni-card-opt opt-card-audio">
          <span>🎵 纯音频 (MP3)</span>
        </button>
        <button class="omni-card-opt opt-card-copy">
          <span>🔗 复制纯净链接</span>
        </button>
        <button class="omni-card-opt opt-card-panel">
          <span>📌 打开侧边栏</span>
        </button>
      `;
      (document.body || document.documentElement).appendChild(el);

      el.addEventListener("mouseenter", () => {
        if (cardCloseTimer) {
          clearTimeout(cardCloseTimer);
          cardCloseTimer = null;
        }
      });

      el.addEventListener("mouseleave", () => {
        closeSharedCardDropdown(true);
      });

      el.querySelector(".opt-card-best").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (activeCardTarget) {
          triggerDownload(activeCardTarget.targetUrl, activeCardTarget.title, "best");
        }
        closeSharedCardDropdown(false);
      });

      el.querySelector(".opt-card-compat").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (activeCardTarget) {
          triggerDownload(activeCardTarget.targetUrl, activeCardTarget.title, "compat");
        }
        closeSharedCardDropdown(false);
      });

      el.querySelector(".opt-card-audio").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (activeCardTarget) {
          triggerDownload(activeCardTarget.targetUrl, activeCardTarget.title, "audio");
        }
        closeSharedCardDropdown(false);
      });

      el.querySelector(".opt-card-copy").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        if (activeCardTarget) {
          const pure = resolveDownloadUrl(activeCardTarget.targetUrl);
          navigator.clipboard.writeText(pure).then(() => {
            showToast("复制成功", pure);
          }).catch(() => {
            showToast("复制失败", pure);
          });
        }
        closeSharedCardDropdown(false);
      });

      el.querySelector(".opt-card-panel").addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        safeSendMessage({ type: "openSidePanel" });
        closeSharedCardDropdown(false);
      });

      window.addEventListener("scroll", () => closeSharedCardDropdown(false), { passive: true });
      document.addEventListener("click", (e) => {
        if (!el.contains(e.target) && (!activeCardTarget || !activeCardTarget.triggerBtn.contains(e.target))) {
          closeSharedCardDropdown(false);
        }
      });
    }
    return el;
  }

  function openSharedCardDropdown(triggerBtn, targetUrl, title) {
    if (cardCloseTimer) {
      clearTimeout(cardCloseTimer);
      cardCloseTimer = null;
    }
    activeCardTarget = { targetUrl, title, triggerBtn };
    const dropdown = getSharedCardDropdown();

    if (dropdown.parentElement !== (document.body || document.documentElement)) {
      (document.body || document.documentElement).appendChild(dropdown);
    }

    dropdown.style.display = "flex";
    dropdown.classList.add("open");

    const rect = triggerBtn.getBoundingClientRect();
    const dropdownWidth = 170;
    const dropdownHeight = 170;

    let left = rect.right - dropdownWidth;
    if (left < 8) left = 8;
    if (left + dropdownWidth > window.innerWidth - 8) {
      left = window.innerWidth - dropdownWidth - 8;
    }

    const spaceBelow = window.innerHeight - rect.bottom;
    let top = 0;
    if (spaceBelow < dropdownHeight && rect.top > dropdownHeight) {
      top = rect.top - dropdownHeight - 4;
    } else {
      top = rect.bottom + 4;
    }

    dropdown.style.top = `${Math.round(top)}px`;
    dropdown.style.left = `${Math.round(left)}px`;
  }

  function closeSharedCardDropdown(delay = false) {
    if (delay) {
      if (cardCloseTimer) clearTimeout(cardCloseTimer);
      cardCloseTimer = setTimeout(() => {
        const dropdown = document.getElementById("omni-card-portal-dropdown");
        if (dropdown) {
          dropdown.style.display = "none";
          dropdown.classList.remove("open");
        }
        activeCardTarget = null;
      }, 200);
    } else {
      if (cardCloseTimer) clearTimeout(cardCloseTimer);
      const dropdown = document.getElementById("omni-card-portal-dropdown");
      if (dropdown) {
        dropdown.style.display = "none";
        dropdown.classList.remove("open");
      }
      activeCardTarget = null;
    }
  }

  function mountCardCapsule(container, explicitUrl, explicitTitle) {
    if (!container) return;
    if (omniSettings.showCardCapsule === false) return;
    if (container.tagName === "VIDEO") {
      container = container.parentElement || container;
    }
    if (container.querySelector(".omni-card-capsule")) return;

    // 检查外层卡片是否已经拥有小胶囊（保证一张卡片绝对只有一个微型胶囊，绝不多层叠加）
    const ancestorCard = container.closest(CARD_SELECTORS.join(", "));
    if (ancestorCard && ancestorCard !== container && ancestorCard.querySelector(".omni-card-capsule")) {
      return;
    }

    // 1. 如果该容器处于真正的独立大播放器内部（且并非卡片/预览），坚决不挂载卡片胶囊
    const inCardOrPreview = container.closest(
      "#inline-preview-player, ytd-inline-preview-renderer, ytd-video-preview, #video-preview, " +
      "ytd-thumbnail, ytd-rich-grid-media, .bili-video-card, .video-card, .feed-card, " +
      CARD_SELECTORS.join(", ")
    );
    if (!inCardOrPreview) {
      if (container.closest("#movie_player, .bpx-player-container, .bilibili-player-area, #bilibili-player, .xgplayer, .dplayer, .artplayer-app, .video-js, [data-player-container], .omni-player-capsule")) {
        return;
      }
    }

    // 2. 清理可能误挂的大播放器胶囊，杜绝双胶囊
    const oldBig = container.querySelector(".omni-player-capsule");
    if (oldBig) {
      oldBig.remove();
    }

    let targetUrl = explicitUrl || "";
    if (!targetUrl) {
      const link = container.querySelector("a[href*='/watch'], a[href*='/shorts/'], a[href*='/video/BV'], a#thumbnail, a#video-title-link, a.bili-video-card__info--tit, a[href]");
      if (link) {
        const href = link.getAttribute("href");
        try {
          targetUrl = new URL(href, location.href).href;
        } catch (e) {}
      }
    }
    if (!targetUrl) {
      const v = container.querySelector("video");
      if (v && v.src && !v.src.startsWith("blob:")) {
        targetUrl = v.src;
      }
    }
    if (!targetUrl && isSpecificVideoPage(location.href)) {
      targetUrl = location.href;
    }

    if (!targetUrl) return;

    const isValidVideo = VIDEO_LINK_PATTERNS.some((p) => p.test(targetUrl)) || isSpecificVideoPage(targetUrl) || (targetUrl.startsWith("http") && !targetUrl.includes("javascript:"));
    if (!isValidVideo) return;

    container.dataset.omniCardAttached = "true";

    const cStyle = window.getComputedStyle(container);
    if (cStyle.position === "static") {
      container.style.position = "relative";
    }

    let title = explicitTitle || "";
    if (!title) {
      const titleEl = container.querySelector("h3, h2, h4, .title, .video-title, .bili-video-card__info--tit, #video-title, a[title]");
      if (titleEl) {
        title = titleEl.getAttribute("title") || titleEl.textContent || "";
      }
      if (!title) {
        const img = container.querySelector("img[alt]");
        if (img) title = img.getAttribute("alt") || "";
      }
    }
    title = cleanTitle(title) || cleanTitle(document.querySelector("h1")?.textContent || document.title || "");

    // 构建卡片悬浮超级微型胶囊
    const cardCapsule = document.createElement("div");
    cardCapsule.className = "omni-card-capsule";
    cardCapsule.innerHTML = `
      <button class="omni-card-btn primary btn-card-dl" title="一键下载当前视频 (最高画质)">
        <span>⚡ 下载</span>
      </button>
      <button class="omni-card-btn btn-card-mp3" title="一键提取纯音频 (MP3)">
        <span>🎵 MP3</span>
      </button>
      <button class="omni-card-btn btn-card-more">⋯</button>
    `;

    // 1. 快捷下载最高画质
    const dlBtn = cardCapsule.querySelector(".btn-card-dl");
    dlBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      dlBtn.classList.add("omni-sent");
      dlBtn.innerHTML = "<span>✓ 已添加</span>";
      triggerDownload(targetUrl, title, "best", (ok) => {
        if (!ok) {
          dlBtn.classList.remove("omni-sent");
          dlBtn.innerHTML = "<span>⚡ 下载</span>";
        }
      });
    });

    // 2. 快捷提取 MP3
    const mp3Btn = cardCapsule.querySelector(".btn-card-mp3");
    mp3Btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      mp3Btn.classList.add("omni-sent");
      mp3Btn.innerHTML = "<span>✓ 音频中</span>";
      triggerDownload(targetUrl, title, "audio", (ok) => {
        if (!ok) {
          mp3Btn.classList.remove("omni-sent");
          mp3Btn.innerHTML = "<span>🎵 MP3</span>";
        }
      });
    });

    // 3. 卡片更多菜单：通过全局传送门展开，彻底免疫 overflow: hidden 裁剪与浏览器原生 Tooltip 遮挡
    const cardMoreBtn = cardCapsule.querySelector(".btn-card-more");
    cardMoreBtn.addEventListener("mouseenter", () => {
      openSharedCardDropdown(cardMoreBtn, targetUrl, title);
    });
    cardMoreBtn.addEventListener("mouseleave", () => {
      closeSharedCardDropdown(true);
    });
    cardMoreBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      openSharedCardDropdown(cardMoreBtn, targetUrl, title);
    });

    container.appendChild(cardCapsule);
  }

  const setupCardBadge = mountCardCapsule;

  /* ---------- 4. 全局嗅探数据（供右侧面板展示） ---------- */
  function sniffPageVideos() {
    const results = [];
    const seenUrls = new Set();

    const add = (url, title, source, thumb) => {
      if (!url) return;
      let full = "";
      try {
        full = new URL(url, location.href).href;
      } catch (e) {
        return;
      }
      if (full.startsWith("blob:") || full.startsWith("mediasource:") || seenUrls.has(full)) {
        return;
      }
      seenUrls.add(full);
      results.push({
        url: full,
        title: cleanTitle(title).slice(0, 100) || "未命名视频",
        platform: detectPlatformName(full),
        source: source || "list",
        thumbnail: thumb || "",
      });
    };

    const isHomePage = /^(https?:\/\/[^\/]+\/?)$/i.test(location.href) ||
                       /^(https?:\/\/(?:www\.)?(?:bilibili|youtube|douyin)\.com\/?(?:\?.*)?)$/i.test(location.href);

    document.querySelectorAll("video, audio").forEach((v) => {
      const src = v.currentSrc || v.src;
      const pageTitle = cleanTitle(document.querySelector("h1")?.textContent || document.title || "");
      if (src && !src.startsWith("blob:") && !src.startsWith("data:")) {
        add(src, pageTitle, "player");
      } else {
        // 当视频为 blob: 内存地址时，通过真实流提取器获取实际网络媒体流
        const extra = getMediaStreams(location.href);
        if (extra.url && !extra.url.startsWith("blob:") && !extra.url.startsWith("http://" + location.host) && !extra.url.startsWith("https://" + location.host)) {
          add(extra.url, `${pageTitle} [流媒体]`, "player");
        } else if (extra.videoUrl) {
          add(extra.videoUrl, `${pageTitle} [高清流]`, "player");
        }
      }

      // 扫描子 <source> 标签
      v.querySelectorAll("source[src]").forEach((s) => {
        const sSrc = s.getAttribute("src");
        if (sSrc) add(sSrc, pageTitle, "source");
      });
    });

    // 嗅探页面性能监控中的网络媒体流 (HLS / M3U8 / MP4 直链，排除 googlevideo SABR 碎片)
    if (window.performance && typeof window.performance.getEntriesByType === "function") {
      try {
        const resources = window.performance.getEntriesByType("resource");
        const pageTitle = cleanTitle(document.querySelector("h1")?.textContent || document.title || "");
        for (const r of resources) {
          const u = r.name;
          if (!u || u.startsWith("blob:") || u.startsWith("data:") || u.includes("googlevideo.com")) continue;
          if (/\.m3u8(\?.*)?$/i.test(u)) {
            add(u, `${pageTitle} [HLS流]`, "network");
          } else if (/\.(mp4|webm|flv)(\?.*)?$/i.test(u)) {
            if (!/favicon|\.svg|\.png|\.jpg/i.test(u)) {
              add(u, `${pageTitle} [媒体直链]`, "network");
            }
          }
        }
      } catch (e) {}
    }

    // 若检测到 YouTube 播放器或已产生 MSE 内存捕获，在列表顶部呈现高优先级「内存切片」下载项
    if (mseState.totalBytes > 0 || /youtube\.com|youtu\.be/i.test(location.href)) {
      const pageTitle = cleanTitle(document.querySelector("h1")?.textContent || document.title || "YouTube 视频");
      const sizeTag = mseState.totalBytes > 0 ? ` (已捕获 ${mseState.sizeFormatted})` : " (待缓冲)";
      results.unshift({
        url: location.href,
        title: `${pageTitle}${sizeTag}`,
        platform: "YouTube",
        source: "mse",
        thumbnail: "",
        isMse: true,
      });
    }

    document.querySelectorAll("a[href]").forEach((a) => {
      let href = "";
      try {
        href = new URL(a.getAttribute("href"), location.href).href;
      } catch (e) {
        return;
      }

      if (VIDEO_LINK_PATTERNS.some((p) => p.test(href))) {
        let t = a.getAttribute("title") || a.textContent || "";
        let thumb = "";
        const img = a.querySelector("img");
        if (img) {
          t = t || img.getAttribute("alt") || "";
          thumb = img.src || "";
        }
        add(href, cleanTitle(t), "link", thumb);
      }
    });

    updateSideCapsuleCount(results.length);
    return results;
  }

  /* ---------- 5. 调度与事件循环 ---------- */
  timer = null;
  function runScan() {
    if (!isExtensionValid()) {
      if (observer) observer.disconnect();
      return;
    }
    window.postMessage({ type: "OMNI_MSE_QUERY" }, "*");
    attachPlayerCapsules();
    attachCardBadges();
    attachSideCapsule();
    sniffPageVideos();
  }

  function scheduleScan() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(runScan, 400);
  }

  observer = new MutationObserver(() => {
    scheduleScan();
  });
  window.__omniVideoObserver = observer;
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: false,
  });

  /* ---------- 6. 监听 MSE 引擎 (world: "MAIN") 与录制器广播 ---------- */
  window.addEventListener("message", (event) => {
    if (!event.data || !event.data.type) return;

    if (event.data.type === "OMNI_MSE_STATUS") {
      mseState = event.data;
      // 保持胶囊主按钮文案统一为 "⚡ 下载 MP4"
      document.querySelectorAll(".omni-player-capsule .btn-quick-dl").forEach((btn) => {
        if (!btn.classList.contains("omni-sent")) {
          btn.innerHTML = `<span>⚡ 下载 MP4</span>`;
        }
      });
    }

    if (event.data.type === "OMNI_MSE_AUTO_BUFFER_PROGRESS") {
      isFastBuffering = true;
      document.querySelectorAll(".omni-player-capsule .btn-quick-dl").forEach((btn) => {
        btn.innerHTML = `<span>⏬ 缓冲中 ${event.data.percent}%</span>`;
      });
    }

    if (event.data.type === "OMNI_MSE_AUTO_BUFFER_DONE") {
      isFastBuffering = false;
      document.querySelectorAll(".omni-player-capsule .btn-quick-dl").forEach((btn) => {
        btn.classList.remove("omni-sent");
        btn.innerHTML = `<span>⚡ 下载 MP4</span>`;
        if (event.data.totalBytes > 0) {
          showToast("缓冲就绪 ✓", `已捕获 ${event.data.sizeFormatted}，点击即可立即下载保存！`);
        } else {
          showToast("提示", "未获取到缓冲分片，请播放视频几秒后再次点击");
        }
      });
    }

    if (event.data.type === "OMNI_MSE_DOWNLOAD_RESULT") {
      if (event.data.success) {
        showToast("下载已发起 ✓", `${event.data.title} (${event.data.sizeFormatted})`);
        safeSendMessage({
          type: "recordMseTask",
          title: event.data.title,
          size: (event.data.totalBytes / 1024 / 1024).toFixed(1),
          status: "done",
        });
      } else {
        showToast("暂无可下载切片", "请先播放视频几秒以捕获媒体数据");
      }
    }

    if (event.data.type === "OMNI_RECORDER_STARTED") {
      isRecording = true;
      showToast("实时录制中 🎥", "正在录制播放器音画，点击菜单可停止录制并保存");
      document.querySelectorAll(".recorder-label").forEach((el) => {
        el.textContent = "⏹️ 停止录制并保存";
      });
    }

    if (event.data.type === "OMNI_RECORDER_DONE") {
      isRecording = false;
      showToast("录制已保存 ✓", `${event.data.title} (${event.data.sizeFormatted})`);
      document.querySelectorAll(".recorder-label").forEach((el) => {
        el.textContent = "实时画音录制 (合一视频)";
      });
      safeSendMessage({
        type: "recordMseTask",
        title: `${event.data.title}_录制`,
        size: event.data.sizeFormatted.replace(/[^0-9.]/g, ""),
        status: "done",
      });
    }

    if (event.data.type === "OMNI_RECORDER_ERROR") {
      isRecording = false;
      showToast("录制异常", event.data.message || "无法捕获视频流");
      document.querySelectorAll(".recorder-label").forEach((el) => {
        el.textContent = "实时画音录制 (合一视频)";
      });
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "sniff") {
      runScan();
      const list = sniffPageVideos();
      sendResponse({
        ok: true,
        pageUrl: location.href,
        pageTitle: document.title,
        found: list.slice(0, 100),
      });
      return false;
    }

    if (msg && msg.type === "TRIGGER_MSE_DOWNLOAD") {
      window.postMessage(
        {
          type: "OMNI_MSE_DIRECT_DOWNLOAD",
          title: msg.title || document.title,
          which: "all",
        },
        "*"
      );
      sendResponse({ ok: true });
      return false;
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => setTimeout(runScan, 300));
  } else {
    setTimeout(runScan, 300);
  }
})();
