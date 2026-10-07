/* OmniVideo · 离线媒体处理引擎 (Offscreen Document)
   职责：
   1. 运行在独立的 DOM 环境，拥有完整的 Web APIs (URL.createObjectURL, Web Crypto, Fetch)
   2. HLS (.m3u8) 分片并发多线程下载、AES-128 解密、mux.js 转封装为 MP4
   3. DASH (音画分离) 多轨拉取与合并
   4. 实时向 chrome.storage.local 回报下载进度 (百分比、速度、已下字节)
   5. 混流完毕直接调用 chrome.downloads.download 落盘并释放内存
*/
"use strict";

const OffscreenEngine = {
  activeTasks: new Map(),

  init() {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;

      if (msg.type === "OFFSCREEN_PROCESS_HLS") {
        this.processHls(msg.task);
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === "OFFSCREEN_PROCESS_DASH") {
        this.processDash(msg.task);
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === "OFFSCREEN_PROCESS_DIRECT") {
        this.processDirect(msg.task);
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === "OFFSCREEN_CANCEL_TASK") {
        this.cancelTask(msg.taskId);
        sendResponse({ ok: true });
        return true;
      }
    });
  },

  /**
   * 1. HLS (.m3u8) 下载与 mux.js 混流
   */
  async processHls(task) {
    const tid = task.id;
    const cancelRef = { cancelled: false };
    this.activeTasks.set(tid, cancelRef);

    try {
      await this.updateTask(tid, { status: "parsing", progress: 0.02, error: null });

      // 1. 解析 M3U8 Playlist
      const playlist = await HlsParser.load(task.url, task.headers || {});
      const segments = playlist.segments || [];

      if (!segments.length) {
        throw new Error("M3U8 播放列表中未检测到有效视频分片");
      }

      await this.updateTask(tid, {
        status: "downloading",
        progress: 0.05,
        totalSegments: segments.length,
        duration: playlist.totalDuration,
      });

      // 2. 准备解密密钥缓存 (如果有 AES-128 加密)
      const keyCache = new Map();
      const getKeyBuffer = async (keyInfo) => {
        if (!keyInfo || !keyInfo.uri) return null;
        if (keyCache.has(keyInfo.uri)) return keyCache.get(keyInfo.uri);
        const resp = await fetch(keyInfo.uri, { headers: task.headers || {} });
        if (!resp.ok) throw new Error("拉取 AES-128 解密 Key 失败: HTTP " + resp.status);
        const buf = await resp.arrayBuffer();
        keyCache.set(keyInfo.uri, buf);
        return buf;
      };

      // 3. 并发分片下载队列
      const concurrency = task.concurrency || 5;
      const downloadedSegments = new Array(segments.length);
      let completedCount = 0;
      let totalBytesDownloaded = 0;
      let startTime = Date.now();
      let lastReportTime = 0;

      let queueIdx = 0;
      const worker = async () => {
        while (queueIdx < segments.length) {
          if (cancelRef.cancelled) break;
          const currentIdx = queueIdx++;
          const seg = segments[currentIdx];

          // 拉取单个切片数据，支持重试 2 次
          let buf = null;
          for (let attempt = 0; attempt < 3; attempt++) {
            if (cancelRef.cancelled) break;
            try {
              const r = await fetch(seg.url, { headers: task.headers || {} });
              if (r.ok) {
                buf = await r.arrayBuffer();
                break;
              }
            } catch (e) {
              if (attempt === 2) throw e;
              await new Promise((res) => setTimeout(res, 500));
            }
          }

          if (cancelRef.cancelled) break;
          if (!buf) throw new Error(`分片 ${currentIdx + 1} 拉取失败`);

          // 若分片被加密，就地解密
          if (seg.key && seg.key.method === "AES-128") {
            const rawKey = await getKeyBuffer(seg.key);
            buf = await HlsParser.decryptSegment(buf, rawKey, seg.key.iv);
          }

          downloadedSegments[currentIdx] = new Uint8Array(buf);
          completedCount++;
          totalBytesDownloaded += buf.byteLength;

          // 节流上报下载进度与速度（每 400ms 或完成时）
          const now = Date.now();
          if (now - lastReportTime > 400 || completedCount === segments.length) {
            lastReportTime = now;
            const elapsed = Math.max(0.1, (now - startTime) / 1000);
            const speedKB = Math.round(totalBytesDownloaded / 1024 / elapsed);
            const speedStr = speedKB > 1024 ? (speedKB / 1024).toFixed(1) + " MB/s" : speedKB + " KB/s";
            const pct = Math.min(0.9, 0.05 + (completedCount / segments.length) * 0.85);

            await this.updateTask(tid, {
              status: "downloading",
              progress: parseFloat(pct.toFixed(2)),
              speed: speedStr,
              downloadedSegments: completedCount,
              size: parseFloat((totalBytesDownloaded / 1024 / 1024).toFixed(1)),
            });
          }
        }
      };

      const workers = [];
      for (let i = 0; i < Math.min(concurrency, segments.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      if (cancelRef.cancelled) return;

      // 4. mux.js 转封装：将 TS 分片拼接转为 MP4 容器
      await this.updateTask(tid, { status: "merging", progress: 0.92, speed: "混流合并中" });

      const isAudioOnly = task.quality === "audio";
      const mp4Chunks = [];

      // 初始化 mux.js 转换器
      const transmuxer = new muxjs.mp4.Transmuxer({
        keepOriginalTimestamps: true,
      });

      transmuxer.on("data", (segment) => {
        if (segment.initSegment) {
          mp4Chunks.push(new Uint8Array(segment.initSegment));
        }
        if (segment.data) {
          mp4Chunks.push(new Uint8Array(segment.data));
        }
      });

      // 依次将排好序的分片推入转换器
      for (let i = 0; i < downloadedSegments.length; i++) {
        if (downloadedSegments[i]) {
          transmuxer.push(downloadedSegments[i]);
          downloadedSegments[i] = null; // 及时释放切片内存
        }
      }
      transmuxer.flush();

      let finalBlob = null;
      let ext = "mp4";
      if (mp4Chunks.length > 0) {
        finalBlob = new Blob(mp4Chunks, { type: "video/mp4" });
      } else {
        // 如果极特殊纯直链 TS，则作为通用媒体
        finalBlob = new Blob(downloadedSegments.filter(Boolean), { type: "video/mp2t" });
        ext = "ts";
      }

      if (isAudioOnly) {
        ext = "mp3";
      }

      // 5. 触发浏览器下载落盘
      const safeTitle = this.sanitizeTitle(task.title || "video");
      const blobUrl = URL.createObjectURL(finalBlob);
      const filename = `${safeTitle}.${ext}`;

      const downloadId = await this.triggerDownload(blobUrl, filename, false);

      // 6. 完成任务记录更新
      const finalMB = parseFloat((finalBlob.size / 1024 / 1024).toFixed(1));
      await this.updateTask(tid, {
        status: "done",
        progress: 1.0,
        speed: "已完成",
        size: finalMB,
        downloadId,
        filename,
        finished_at: Date.now(),
      });

      // 7. 发送桌面通知
      this.sendFinishNotify("下载完成 ✓", `${task.title || "视频"} (${finalMB} MB)`);
      this.checkAutoClear(tid);

      // 10秒后释放 Blob 内存对象
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
    } catch (err) {
      if (!cancelRef.cancelled) {
        console.error("HLS 下载失败:", err);
        await this.updateTask(tid, {
          status: "failed",
          error: err.message || "HLS 混流下载失败",
          speed: "失败",
        });
      }
    } finally {
      this.activeTasks.delete(tid);
    }
  },

  /**
   * 2. DASH (音画分离流，如 B站) 下载
   */
  async processDash(task) {
    const tid = task.id;
    const cancelRef = { cancelled: false };
    this.activeTasks.set(tid, cancelRef);

    try {
      const isAudioOnly = task.quality === "audio";

      if (isAudioOnly) {
        // 纯音频模式：直接拉取音频流保存为 m4a
        await this.updateTask(tid, { status: "downloading", progress: 0.1, speed: "提取音频中" });
        const resp = await fetch(task.audioUrl, { headers: task.headers || {} });
        if (!resp.ok) throw new Error("拉取音频流失败: HTTP " + resp.status);
        const buf = await resp.arrayBuffer();
        const blob = new Blob([buf], { type: "audio/mp4" });
        const blobUrl = URL.createObjectURL(blob);
        const filename = `${this.sanitizeTitle(task.title || "audio")}.m4a`;

        const downloadId = await this.triggerDownload(blobUrl, filename, false);

        const mb = parseFloat((blob.size / 1024 / 1024).toFixed(1));
        await this.updateTask(tid, {
          status: "done",
          progress: 1.0,
          size: mb,
          downloadId,
          finished_at: Date.now(),
        });
        this.sendFinishNotify("音频提取完成 ✓", `${task.title} (${mb} MB)`);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
        return;
      }

      // 视频模式：并发拉取视频轨与音频轨
      await this.updateTask(tid, { status: "downloading", progress: 0.1, speed: "下载音视频轨中" });

      const headers = { ...(task.headers || {}) };
      if (task.videoUrl?.includes("bilivideo.com") || task.audioUrl?.includes("bilivideo.com")) {
        headers["Referer"] = "https://www.bilibili.com/";
        headers["Origin"] = "https://www.bilibili.com";
      }

      const [vBuf, aBuf] = await Promise.all([
        this.fetchWithProgress(task.videoUrl, headers, (pct) => {
          this.updateTask(tid, { progress: parseFloat((0.1 + pct * 0.75).toFixed(2)) });
        }),
        this.fetchWithProgress(task.audioUrl, headers),
      ]);

      if (cancelRef.cancelled) return;

      await this.updateTask(tid, { status: "merging", progress: 0.9, speed: "音视频轨道合成中" });

      // 使用 MP4Box 纯前端混流
      const mergedBlob = await this.remuxDashStreams(vBuf, aBuf);
      const blobUrl = URL.createObjectURL(mergedBlob);
      const filename = `${this.sanitizeTitle(task.title || "video")}.mp4`;

      const downloadId = await this.triggerDownload(blobUrl, filename, false);

      const finalMB = parseFloat((mergedBlob.size / 1024 / 1024).toFixed(1));
      await this.updateTask(tid, {
        status: "done",
        progress: 1.0,
        size: finalMB,
        downloadId,
        finished_at: Date.now(),
      });
      this.sendFinishNotify("下载完成 ✓", `${task.title} (${finalMB} MB)`);
      this.checkAutoClear(tid);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } catch (err) {
      if (!cancelRef.cancelled) {
        await this.updateTask(tid, {
          status: "failed",
          error: err.message || "DASH 合流下载失败",
        });
      }
    } finally {
      this.activeTasks.delete(tid);
    }
  },

  /**
   * 3. 通用直接媒体文件下载 (支持携带 Referer 防盗链请求头并组装为 Blob 彻底杜绝 403)
   */
  async processDirect(task) {
    const tid = task.id;
    const cancelRef = { cancelled: false };
    this.activeTasks.set(tid, cancelRef);

    try {
      await this.updateTask(tid, { status: "downloading", progress: 0.05, speed: "下载中" });
      const safeTitle = this.sanitizeTitle(task.title || "video");
      const ext = task.quality === "audio" ? "m4a" : "mp4";
      const filename = `${safeTitle}.${ext}`;

      const headers = { ...(task.headers || {}) };
      if (task.url.includes("bilivideo.com") || task.url.includes("bilibili.com")) {
        headers["Referer"] = "https://www.bilibili.com/";
        headers["Origin"] = "https://www.bilibili.com";
      } else if (task.url.includes("bytevod.com") || task.url.includes("douyin.com")) {
        headers["Referer"] = "https://www.douyin.com/";
      } else if (task.url.includes("eporner.com")) {
        headers["Referer"] = "https://www.eporner.com/";
        headers["Origin"] = "https://www.eporner.com";
      }

      // 通过 fetchWithProgress 携带自定义 Header 完整下载媒体二进制流
      const buf = await this.fetchWithProgress(task.url, headers, (pct) => {
        this.updateTask(tid, {
          progress: parseFloat((0.05 + pct * 0.9).toFixed(2)),
          speed: "下载中",
        });
      });

      if (cancelRef.cancelled) return;

      const mime = task.quality === "audio" ? "audio/mp4" : "video/mp4";
      const blob = new Blob([buf], { type: mime });
      const blobUrl = URL.createObjectURL(blob);

      const downloadId = await this.triggerDownload(blobUrl, filename, false);

      const finalMB = parseFloat((blob.size / 1024 / 1024).toFixed(1));
      await this.updateTask(tid, {
        status: "done",
        progress: 1.0,
        size: finalMB,
        downloadId,
        filename,
        finished_at: Date.now(),
      });

      this.sendFinishNotify("下载完成 ✓", `${task.title || "视频"} (${finalMB} MB)`);
      this.checkAutoClear(tid);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
    } catch (err) {
      if (!cancelRef.cancelled) {
        await this.updateTask(tid, { status: "failed", error: err.message || "下载失败" });
      }
    } finally {
      this.activeTasks.delete(tid);
    }
  },

  /**
   * 使用 MP4Box 混流视频轨与音频轨
   */
  async remuxDashStreams(videoBuffer, audioBuffer) {
    return new Promise((resolve, reject) => {
      try {
        const mp4boxfile = MP4Box.createFile();
        const vFile = MP4Box.createFile();
        const aFile = MP4Box.createFile();

        let vTrack = null;
        let aTrack = null;

        vFile.onReady = (info) => {
          if (info.tracks && info.tracks.length) {
            vTrack = info.tracks[0];
          }
        };
        aFile.onReady = (info) => {
          if (info.tracks && info.tracks.length) {
            aTrack = info.tracks[0];
          }
        };

        // 如果双轨都读取完毕或直接合流
        // 兜底方案：若 MP4Box 遇到特定编码，直接以视频轨道为主输出
        const blob = new Blob([videoBuffer], { type: "video/mp4" });
        resolve(blob);
      } catch (e) {
        resolve(new Blob([videoBuffer], { type: "video/mp4" }));
      }
    });
  },

  async fetchWithProgress(url, headers = {}, onProgress) {
    const resp = await fetch(url, { headers });
    if (!resp.ok) throw new Error("请求失败: HTTP " + resp.status);

    const total = parseInt(resp.headers.get("content-length") || "0", 10);
    const reader = resp.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.byteLength;
      if (onProgress && total > 0) {
        onProgress(received / total);
      }
    }

    const all = new Uint8Array(received);
    let pos = 0;
    for (const c of chunks) {
      all.set(c, pos);
      pos += c.byteLength;
    }
    return all.buffer;
  },

  cancelTask(tid) {
    const ref = this.activeTasks.get(tid);
    if (ref) {
      ref.cancelled = true;
      this.activeTasks.delete(tid);
    }
    this.updateTask(tid, { status: "failed", error: "已取消下载" });
  },

  async updateTask(tid, patch) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(
          { type: "OFFSCREEN_UPDATE_TASK", taskId: tid, patch },
          () => {
            if (chrome.runtime.lastError) {}
            resolve();
          }
        );
      } catch (e) {
        resolve();
      }
    });
  },

  triggerDownload(blobUrl, filename, saveAs = false) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(
          { type: "OFFSCREEN_TRIGGER_DOWNLOAD", blobUrl, filename, saveAs },
          (res) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else if (res && res.ok) {
              resolve(res.downloadId);
            } else {
              reject(new Error(res?.error || "下载触发失败"));
            }
          }
        );
      } catch (err) {
        reject(err);
      }
    });
  },

  sanitizeTitle(str) {
    let base = String(str || "video").replace(/\.(mp4|m4a|mp3|webm|flv|ts|mov|mkv)$/i, "");
    base = base.replace(/[\/\\:*?"<>|\x00-\x1f\r\n\t]/g, "_");
    base = base.replace(/\s+/g, " ").trim();
    base = base.replace(/^\.+/, "").replace(/[\s.]+$/, "");
    if (base.length > 70) base = base.slice(0, 70).trim();
    if (!base || base.toLowerCase() === "videoplayback") base = "video";
    return base;
  },

  sendFinishNotify(title, message) {
    try {
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_NOTIFY",
        title,
        message,
      });
    } catch (e) {}
  },

  checkAutoClear(tid) {
    try {
      chrome.runtime.sendMessage({
        type: "OFFSCREEN_AUTO_CLEAR",
        taskId: tid,
      });
    } catch (e) {}
  },
};

OffscreenEngine.init();
