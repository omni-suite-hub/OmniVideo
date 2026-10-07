/* OmniVideo · 核心 MSE 内存捕获引擎 (MediaSource Buffer Catcher)
   参考猫抓 (Cat-Catch) 核心架构：
   1. 运行在页面 MAIN 原生作用域，全量代理 window.MediaSource 与 SourceBuffer 原型链
   2. 拦截 addSourceBuffer 与 appendBuffer，直接捕获播放器已解码/分发的原始音视频切片 ArrayBuffer
   3. 彻底根除 YouTube 等平台直链下载导致的「sabr.malformed_config (31字节)」与 403 权限错误
   4. 支持安全自动缓冲至全片及在网页原生上下文中直接组装 Blob 触发下载落盘
   5. 内置与猫抓一致的「实时视频录制器 (MediaRecorder + captureStream)」音画同步录制
*/
(function () {
  "use strict";

  if (window.__omniMseCatcherInjected) return;
  window.__omniMseCatcherInjected = true;

  // 0. 强制优先协商通用 MP4 (H.264/AVC1 + AAC) 流媒体模式 (参考 h264ify 行业标准架构)
  // 屏蔽 webm, vp9, vp8, av01 等专有编码能力嗅探，促使 YouTube 播放器自动回退并直接分发高兼容度的 MP4 (avc1/mp4a) 流
  try {
    const isYouTube = /(?:youtube\.com|youtu\.be)/i.test(window.location.hostname);
    if (isYouTube) {
      if (typeof window.MediaSource !== "undefined" && window.MediaSource.isTypeSupported) {
        const origIsTypeSupported = window.MediaSource.isTypeSupported.bind(window.MediaSource);
        window.MediaSource.isTypeSupported = function (type) {
          if (typeof type === "string") {
            const lower = type.toLowerCase();
            if (
              lower.includes("webm") ||
              lower.includes("vp9") ||
              lower.includes("vp8") ||
              lower.includes("vp09") ||
              lower.includes("av01") ||
              lower.includes("av1")
            ) {
              return false;
            }
          }
          return origIsTypeSupported(type);
        };
      }

      if (typeof window.HTMLMediaElement !== "undefined" && window.HTMLMediaElement.prototype.canPlayType) {
        const origCanPlayType = window.HTMLMediaElement.prototype.canPlayType;
        window.HTMLMediaElement.prototype.canPlayType = function (type) {
          if (typeof type === "string") {
            const lower = type.toLowerCase();
            if (
              lower.includes("webm") ||
              lower.includes("vp9") ||
              lower.includes("vp8") ||
              lower.includes("vp09") ||
              lower.includes("av01") ||
              lower.includes("av1")
            ) {
              return "";
            }
          }
          return origCanPlayType.call(this, type);
        };
      }

      if (window.navigator && window.navigator.mediaCapabilities && window.navigator.mediaCapabilities.decodingInfo) {
        const origDecodingInfo = window.navigator.mediaCapabilities.decodingInfo.bind(window.navigator.mediaCapabilities);
        window.navigator.mediaCapabilities.decodingInfo = function (config) {
          if (config && config.video && config.video.contentType) {
            const lower = config.video.contentType.toLowerCase();
            if (
              lower.includes("webm") ||
              lower.includes("vp9") ||
              lower.includes("vp8") ||
              lower.includes("vp09") ||
              lower.includes("av01") ||
              lower.includes("av1")
            ) {
              return Promise.resolve({
                supported: false,
                smooth: false,
                powerEfficient: false,
              });
            }
          }
          return origDecodingInfo(config);
        };
      }
    }
  } catch (err) {
    console.warn("[OmniVideo] Codec preference injector error:", err);
  }

  const CatchData = {
    enable: true,
    videoChunks: [],
    audioChunks: [],
    videoMime: "",
    audioMime: "",
    totalBytes: 0,
    isComplete: false,
    autoBuffering: false,
    autoBufferTimer: null,
  };

  window.__omniCatchData = CatchData;

  // 1. 直接代理 SourceBuffer 原型链上的 appendBuffer (确保无论何时实例被创建均能 100% 拦截切片)
  if (typeof window.SourceBuffer !== "undefined" && window.SourceBuffer.prototype.appendBuffer) {
    const originalAppendBuffer = window.SourceBuffer.prototype.appendBuffer;

    window.SourceBuffer.prototype.appendBuffer = function (buffer) {
      try {
        if (CatchData.enable && buffer) {
          let byteLen = buffer.byteLength || 0;
          if (byteLen > 0) {
            let copy;
            if (buffer.slice) {
              copy = buffer.slice(0);
            } else if (buffer.buffer) {
              copy = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
            } else {
              copy = new Uint8Array(buffer).buffer;
            }

            // 识别音视频分流
            const isAudio = this.__omniIsAudio || (this.__omniMime && this.__omniMime.includes("audio"));
            const targetList = isAudio ? CatchData.audioChunks : CatchData.videoChunks;

            targetList.push(copy);
            CatchData.totalBytes += byteLen;

            notifyProgress();
          }
        }
      } catch (err) {
        console.warn("[OmniVideo MSE] appendBuffer 捕获异常:", err);
      }

      return originalAppendBuffer.call(this, buffer);
    };
  }

  // 2. 代理 MediaSource 原生 API
  if (typeof window.MediaSource !== "undefined" && window.MediaSource.prototype.addSourceBuffer) {
    const originalAddSourceBuffer = window.MediaSource.prototype.addSourceBuffer;

    window.MediaSource.prototype.addSourceBuffer = function (mimeType) {
      const sourceBuffer = originalAddSourceBuffer.call(this, mimeType);
      const mime = String(mimeType || "").toLowerCase();
      sourceBuffer.__omniMime = mime;
      sourceBuffer.__omniIsAudio = mime.includes("audio");

      if (sourceBuffer.__omniIsAudio) CatchData.audioMime = mimeType;
      else CatchData.videoMime = mimeType;

      return sourceBuffer;
    };

    // 代理 endOfStream (视频缓冲完毕)
    if (window.MediaSource.prototype.endOfStream) {
      const originalEndOfStream = window.MediaSource.prototype.endOfStream;
      window.MediaSource.prototype.endOfStream = function (...args) {
        CatchData.isComplete = true;
        notifyProgress();
        return originalEndOfStream.apply(this, args);
      };
    }
  }

  let progressTimer = null;
  function notifyProgress() {
    if (progressTimer) return;
    progressTimer = setTimeout(() => {
      progressTimer = null;
      window.postMessage(
        {
          type: "OMNI_MSE_STATUS",
          totalBytes: CatchData.totalBytes,
          videoCount: CatchData.videoChunks.length,
          audioCount: CatchData.audioChunks.length,
          videoMime: CatchData.videoMime,
          audioMime: CatchData.audioMime,
          isComplete: CatchData.isComplete,
          sizeFormatted: formatBytes(CatchData.totalBytes),
        },
        "*"
      );
    }, 300);
  }

  function formatBytes(bytes) {
    if (!bytes || bytes < 1024) return "0 KB";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + " GB";
  }

  function sanitizeFileName(str) {
    let base = String(str || "video").replace(/[\\/:*?"<>|\x00-\x1f\r\n\t]/g, "_").trim();
    base = base.replace(/\s+/g, " ").slice(0, 80);
    if (!base || base.toLowerCase() === "videoplayback") base = "video";
    return base;
  }

  // 3. 检查并清理多余头部数据 (参考猫抓 Header 校验逻辑，避免 Seek 产生错位)
  function cleanHeader(bufferList) {
    if (!bufferList || bufferList.length <= 1) return bufferList;
    let lastHeaderIdx = -1;

    for (let i = 0; i < bufferList.length; i++) {
      const u8 = new Uint8Array(bufferList[i]);
      // MP4: ftyp (0x66 0x74 0x79 0x70)
      if (u8.length > 8 && u8[4] === 0x66 && u8[5] === 0x74 && u8[6] === 0x79 && u8[7] === 0x70) {
        lastHeaderIdx = i;
      }
      // WebM: 1A 45 DF A3
      else if (u8.length > 4 && u8[0] === 0x1a && u8[1] === 0x45 && u8[2] === 0xdf && u8[3] === 0xa3) {
        lastHeaderIdx = i;
      }
    }

    if (lastHeaderIdx > 0) {
      return bufferList.slice(lastHeaderIdx);
    }
    return bufferList;
  }

  // 4. 极速缓冲全片 (采用平滑递进机制，配备 5 秒硬超时，杜绝 blind setInterval 导致的死锁与按钮永久卡顿)
  let autoBufferTimeoutTimer = null;
  function startAutoBuffering() {
    const video = document.querySelector("video");
    if (!video) {
      window.postMessage({ type: "OMNI_MSE_AUTO_BUFFER_ERROR", message: "未检测到播放中的视频元素" }, "*");
      return;
    }

    CatchData.autoBuffering = true;
    let lastSeekTime = 0;
    let lastBufferedEnd = 0;

    const originalMuted = video.muted;
    const originalRate = video.playbackRate;

    try {
      video.muted = true;
      video.playbackRate = 4.0;
      if (video.paused) {
        video.play().catch(() => {});
      }
    } catch (e) {}

    const cleanup = () => {
      CatchData.autoBuffering = false;
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("ended", cleanup);
      if (autoBufferTimeoutTimer) {
        clearTimeout(autoBufferTimeoutTimer);
        autoBufferTimeoutTimer = null;
      }
      try {
        video.playbackRate = originalRate;
        video.muted = originalMuted;
      } catch (e) {}
    };

    const onProgress = () => {
      if (!CatchData.autoBuffering) return;

      if (video.buffered && video.buffered.length > 0) {
        const bufferedEnd = video.buffered.end(video.buffered.length - 1);
        const totalDur = Number.isFinite(video.duration) ? video.duration : 0;

        if (totalDur > 0) {
          const pct = Math.min(100, Math.round((bufferedEnd / totalDur) * 100));
          window.postMessage(
            {
              type: "OMNI_MSE_AUTO_BUFFER_PROGRESS",
              percent: pct,
              bufferedEnd: bufferedEnd.toFixed(1),
              duration: totalDur.toFixed(1),
              totalBytes: CatchData.totalBytes,
              sizeFormatted: formatBytes(CatchData.totalBytes),
            },
            "*"
          );

          if (bufferedEnd >= totalDur - 1.5) {
            cleanup();
            CatchData.isComplete = true;
            window.postMessage(
              {
                type: "OMNI_MSE_AUTO_BUFFER_DONE",
                totalBytes: CatchData.totalBytes,
                sizeFormatted: formatBytes(CatchData.totalBytes),
              },
              "*"
            );
            return;
          }

          // 仅当缓冲尾实际拉长且间隔超过 1200ms 时平滑推进，避免破坏底层 SABR 请求
          const now = Date.now();
          if (bufferedEnd > lastBufferedEnd + 1.0 && now - lastSeekTime > 1200) {
            lastBufferedEnd = bufferedEnd;
            lastSeekTime = now;
            video.currentTime = Math.max(0, bufferedEnd - 2);
          }
        }
      }
    };

    video.addEventListener("progress", onProgress);
    video.addEventListener("ended", cleanup);

    // 最大 5 秒硬超时保护，绝不永久卡住
    autoBufferTimeoutTimer = setTimeout(() => {
      cleanup();
      window.postMessage(
        {
          type: "OMNI_MSE_AUTO_BUFFER_DONE",
          totalBytes: CatchData.totalBytes,
          sizeFormatted: formatBytes(CatchData.totalBytes),
          timeout: true,
        },
        "*"
      );
    }, 5000);

    onProgress();
  }

  function stopAutoBuffering() {
    CatchData.autoBuffering = false;
    if (autoBufferTimeoutTimer) {
      clearTimeout(autoBufferTimeoutTimer);
      autoBufferTimeoutTimer = null;
    }
  }

  // 5. 直接在网页上下文触发下载落盘 (参考猫抓 downloadDirect 核心逻辑)
  function downloadDirect(title, which = "all") {
    const cleanedVideo = cleanHeader(CatchData.videoChunks);
    const cleanedAudio = cleanHeader(CatchData.audioChunks);
    const safeTitle = sanitizeFileName(title || document.title || "video");
    let downloadedCount = 0;

    // A. 导出视频轨
    if ((which === "all" || which === "video") && cleanedVideo.length > 0) {
      const vMime = (CatchData.videoMime && CatchData.videoMime.split(";")[0]) || "video/mp4";
      const ext = vMime.includes("webm") ? "webm" : "mp4";
      const vBlob = new Blob(cleanedVideo, { type: vMime });
      const vUrl = URL.createObjectURL(vBlob);
      const a = document.createElement("a");
      a.href = vUrl;
      a.download = `${safeTitle}.${ext}`;
      document.documentElement.appendChild(a);
      a.click();
      setTimeout(() => {
        a.remove();
        URL.revokeObjectURL(vUrl);
      }, 15000);
      downloadedCount++;
    }

    // B. 导出音频轨 (若同时导出双轨，错开 600ms 触发，杜绝 Chrome 拦截多次弹窗下载)
    if ((which === "all" || which === "audio") && cleanedAudio.length > 0) {
      const delay = (which === "all" && cleanedVideo.length > 0) ? 600 : 0;
      setTimeout(() => {
        const aMime = (CatchData.audioMime && CatchData.audioMime.split(";")[0]) || "audio/mp4";
        const ext = aMime.includes("webm") ? "weba" : "m4a";
        const aBlob = new Blob(cleanedAudio, { type: aMime });
        const aUrl = URL.createObjectURL(aBlob);
        const a = document.createElement("a");
        a.href = aUrl;
        a.download = `${safeTitle}_audio.${ext}`;
        document.documentElement.appendChild(a);
        a.click();
        setTimeout(() => {
          a.remove();
          URL.revokeObjectURL(aUrl);
        }, 15000);
      }, delay);
      downloadedCount++;
    }

    window.postMessage(
      {
        type: "OMNI_MSE_DOWNLOAD_RESULT",
        success: downloadedCount > 0,
        count: downloadedCount,
        title: safeTitle,
        totalBytes: CatchData.totalBytes,
        sizeFormatted: formatBytes(CatchData.totalBytes),
      },
      "*"
    );
  }

  // 6. 猫抓 recorder.js 音画合一实时录制引擎
  let activeRecorder = null;
  let recorderChunks = [];

  function startRecording(title) {
    const video = document.querySelector("video");
    if (!video) {
      window.postMessage({ type: "OMNI_RECORDER_ERROR", message: "未检测到视频播放器" }, "*");
      return;
    }

    let stream = null;
    try {
      if (video.captureStream) {
        stream = video.captureStream();
      } else if (video.mozCaptureStream) {
        stream = video.mozCaptureStream();
      } else if (video.webkitCaptureStream) {
        stream = video.webkitCaptureStream();
      }
    } catch (e) {
      console.warn("captureStream 失败:", e);
    }

    if (!stream) {
      window.postMessage({ type: "OMNI_RECORDER_ERROR", message: "当前浏览器不支持捕获此播放器流" }, "*");
      return;
    }

    let mimeType = "video/mp4";
    if (typeof MediaRecorder !== "undefined") {
      if (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1,mp4a.40.2")) {
        mimeType = "video/mp4;codecs=avc1,mp4a.40.2";
      } else if (MediaRecorder.isTypeSupported("video/mp4;codecs=avc1")) {
        mimeType = "video/mp4;codecs=avc1";
      } else if (MediaRecorder.isTypeSupported("video/mp4")) {
        mimeType = "video/mp4";
      } else if (MediaRecorder.isTypeSupported("video/webm;codecs=vp9,opus")) {
        mimeType = "video/webm;codecs=vp9,opus";
      } else if (MediaRecorder.isTypeSupported("video/webm")) {
        mimeType = "video/webm";
      }
    }

    try {
      recorderChunks = [];
      activeRecorder = new MediaRecorder(stream, { mimeType });

      activeRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          recorderChunks.push(event.data);
        }
      };

      activeRecorder.onstop = () => {
        if (recorderChunks.length > 0) {
          const ext = mimeType.includes("mp4") ? "mp4" : "webm";
          const blob = new Blob(recorderChunks, { type: mimeType });
          const url = URL.createObjectURL(blob);
          const a = document.createElement("a");
          const safeTitle = sanitizeFileName(title || document.title || "recorded_video");
          a.href = url;
          a.download = `${safeTitle}_录制.${ext}`;
          document.documentElement.appendChild(a);
          a.click();
          setTimeout(() => {
            a.remove();
            URL.revokeObjectURL(url);
          }, 15000);

          window.postMessage(
            {
              type: "OMNI_RECORDER_DONE",
              title: safeTitle,
              sizeFormatted: formatBytes(blob.size),
            },
            "*"
          );
        }
        recorderChunks = [];
        activeRecorder = null;
      };

      activeRecorder.start(1000);
      window.postMessage({ type: "OMNI_RECORDER_STARTED" }, "*");
    } catch (err) {
      console.error("启动录制失败:", err);
      window.postMessage({ type: "OMNI_RECORDER_ERROR", message: err.message }, "*");
    }
  }

  function stopRecording() {
    if (activeRecorder && activeRecorder.state !== "inactive") {
      activeRecorder.stop();
    }
  }

  // 7. 导出内存 Blob (给 content.js 查询使用)
  function exportCapturedBlobs(requestId) {
    const cleanedVideo = cleanHeader(CatchData.videoChunks);
    const cleanedAudio = cleanHeader(CatchData.audioChunks);

    let videoBlobUrl = null;
    let audioBlobUrl = null;
    let videoSize = 0;
    let audioSize = 0;

    if (cleanedVideo.length > 0) {
      const vMime = (CatchData.videoMime && CatchData.videoMime.split(";")[0]) || "video/mp4";
      const vBlob = new Blob(cleanedVideo, { type: vMime });
      videoBlobUrl = URL.createObjectURL(vBlob);
      videoSize = vBlob.size;
    }

    if (cleanedAudio.length > 0) {
      const aMime = (CatchData.audioMime && CatchData.audioMime.split(";")[0]) || "audio/mp4";
      const aBlob = new Blob(cleanedAudio, { type: aMime });
      audioBlobUrl = URL.createObjectURL(aBlob);
      audioSize = aBlob.size;
    }

    window.postMessage(
      {
        type: "OMNI_MSE_EXPORT_RESULT",
        requestId,
        videoBlobUrl,
        audioBlobUrl,
        videoSize,
        audioSize,
        videoMime: CatchData.videoMime,
        audioMime: CatchData.audioMime,
        totalBytes: CatchData.totalBytes,
      },
      "*"
    );
  }

  // 8. 监听与 content.js 的原生通信
  window.addEventListener("message", (event) => {
    if (!event.data || !event.data.type) return;

    switch (event.data.type) {
      case "OMNI_MSE_EXPORT":
        exportCapturedBlobs(event.data.requestId);
        break;

      case "OMNI_MSE_DIRECT_DOWNLOAD":
        downloadDirect(event.data.title, event.data.which || "all");
        break;

      case "OMNI_MSE_START_FAST_BUFFER":
        startAutoBuffering();
        break;

      case "OMNI_MSE_STOP_FAST_BUFFER":
        stopAutoBuffering();
        break;

      case "OMNI_RECORDER_START":
        startRecording(event.data.title);
        break;

      case "OMNI_RECORDER_STOP":
        stopRecording();
        break;

      case "OMNI_MSE_CLEAR":
        CatchData.videoChunks = [];
        CatchData.audioChunks = [];
        CatchData.totalBytes = 0;
        CatchData.isComplete = false;
        notifyProgress();
        break;

      case "OMNI_MSE_QUERY":
        window.postMessage(
          {
            type: "OMNI_MSE_STATUS",
            totalBytes: CatchData.totalBytes,
            videoCount: CatchData.videoChunks.length,
            audioCount: CatchData.audioChunks.length,
            videoMime: CatchData.videoMime,
            audioMime: CatchData.audioMime,
            isComplete: CatchData.isComplete,
            sizeFormatted: formatBytes(CatchData.totalBytes),
          },
          "*"
        );
        break;
    }
  });

  // 启动即广播一次初始状态
  notifyProgress();
})();
