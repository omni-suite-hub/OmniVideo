/* OmniVideo · 纯前端 HLS / M3U8 解析器
   支持：
   1. Master Playlist 多分辨率自适应挑选（默认最高码率）
   2. Media Playlist 分片切片提取 (EXTINF)
   3. 标准 AES-128 加密支持（自动提取 KEY URL 与序列号 IV）
   4. 相对路径自动补全为完整 CDN 链接
*/
"use strict";

const HlsParser = {
  /**
   * 拉取并解析 M3U8 链接（自动处理主播放列表嵌套）
   * @param {string} m3u8Url
   * @param {object} headers 可选请求头
   * @returns {Promise<{ segments: Array, totalDuration: number, isEncrypted: boolean, keyInfo: object|null }>}
   */
  async load(m3u8Url, headers = {}) {
    const resp = await fetch(m3u8Url, { headers });
    if (!resp.ok) {
      throw new Error(`加载 M3U8 失败: HTTP ${resp.status}`);
    }
    const text = await resp.text();
    const finalUrl = resp.url || m3u8Url;

    // 检查是否为 Master Playlist（包含子分辨率流）
    if (text.includes("#EXT-X-STREAM-INF")) {
      const subUrl = this.selectBestStream(text, finalUrl);
      if (subUrl && subUrl !== finalUrl) {
        return this.load(subUrl, headers);
      }
    }

    return this.parseMediaPlaylist(text, finalUrl);
  },

  /**
   * 从 Master Playlist 挑选最高码率或首个有效流
   */
  selectBestStream(content, baseUrl) {
    const lines = content.split(/\r?\n/);
    let bestBandwidth = -1;
    let bestUri = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const bwMatch = line.match(/BANDWIDTH=(\d+)/i);
        const bw = bwMatch ? parseInt(bwMatch[1], 10) : 0;
        // 下一行即为 URI
        const nextLine = (lines[i + 1] || "").trim();
        if (nextLine && !nextLine.startsWith("#")) {
          if (bw > bestBandwidth) {
            bestBandwidth = bw;
            bestUri = nextLine;
          }
        }
      }
    }

    if (bestUri) {
      return new URL(bestUri, baseUrl).href;
    }
    return baseUrl;
  },

  /**
   * 解析实际包含 TS 切片的媒体播放列表
   */
  parseMediaPlaylist(content, baseUrl) {
    const lines = content.split(/\r?\n/);
    const segments = [];
    let currentDuration = 0;
    let totalDuration = 0;
    let currentKey = null;
    let sequence = 0;

    // 检查是否有序列号起始标记
    const seqMatch = content.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
    if (seqMatch) {
      sequence = parseInt(seqMatch[1], 10);
    }

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      if (line.startsWith("#EXT-X-KEY:")) {
        // 解析加密属性：#EXT-X-KEY:METHOD=AES-128,URI="...",IV=0x...
        const methodMatch = line.match(/METHOD=([^,\s]+)/i);
        const method = methodMatch ? methodMatch[1].toUpperCase() : "NONE";

        if (method === "AES-128") {
          const uriMatch = line.match(/URI=["']?([^"'\s]+)["']?/i);
          const ivMatch = line.match(/IV=(0x[0-9a-fA-F]+)/i);

          const keyUri = uriMatch ? new URL(uriMatch[1], baseUrl).href : "";
          let iv = null;
          if (ivMatch) {
            iv = this.hexToUint8Array(ivMatch[1]);
          }

          currentKey = {
            method: "AES-128",
            uri: keyUri,
            iv,
          };
        } else if (method === "NONE") {
          currentKey = null;
        }
      } else if (line.startsWith("#EXTINF:")) {
        // 片段时长：#EXTINF:4.167,
        const durMatch = line.match(/#EXTINF:([\d.]+)/i);
        currentDuration = durMatch ? parseFloat(durMatch[1]) : 0;
      } else if (!line.startsWith("#")) {
        // 分片切片地址
        const segUrl = new URL(line, baseUrl).href;
        const segIndex = sequence + segments.length;

        // 如果没有显式 IV，则用 sequence 作为大端 128 位数字作为默认 IV
        let segKey = null;
        if (currentKey) {
          segKey = { ...currentKey };
          if (!segKey.iv) {
            segKey.iv = this.sequenceToIV(segIndex);
          }
        }

        segments.push({
          index: segments.length,
          url: segUrl,
          duration: currentDuration,
          key: segKey,
        });

        totalDuration += currentDuration;
        currentDuration = 0;
      }
    }

    return {
      segments,
      totalDuration,
      isEncrypted: segments.some((s) => !!s.key),
      count: segments.length,
    };
  },

  hexToUint8Array(hex) {
    hex = hex.replace(/^0x/i, "");
    if (hex.length % 2 !== 0) hex = "0" + hex;
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
  },

  sequenceToIV(seq) {
    const iv = new Uint8Array(16);
    // 高位为 0，低 4 字节存放 seq (大端)
    iv[12] = (seq >> 24) & 0xff;
    iv[13] = (seq >> 16) & 0xff;
    iv[14] = (seq >> 8) & 0xff;
    iv[15] = seq & 0xff;
    return iv;
  },

  /**
   * 解密单个分片 ArrayBuffer（AES-128-CBC via Web Crypto API）
   */
  async decryptSegment(encryptedBuffer, keyBuffer, iv) {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBuffer,
      { name: "AES-CBC" },
      false,
      ["decrypt"]
    );
    return await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      encryptedBuffer
    );
  },
};

if (typeof module !== "undefined" && module.exports) {
  module.exports = HlsParser;
}
