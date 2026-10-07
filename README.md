# OmniVideo · 纯前端智能视频下载扩展 v3.0 (Standalone)

> **零服务端依赖 · 100% 纯前端运行 · MV3 独立引擎**

OmniVideo 是一款彻底脱离任何外部或本地 Python / FFmpeg / yt-dlp 后端服务的 Chrome 原生智能视频下载扩展。基于浏览器底层 **Web Crypto API**、**Offscreen Document 多媒体沙箱**、**mux.js 流转封装** 与 **MP4Box 纯前端多轨合流** 架构，所有分片拉取、解密、混流、转码与落盘操作均在浏览器内部纯前端闭环完成。

---

## 核心架构亮点

1. **100% 本地纯前端运行**：
   - 彻底摆脱对 `OmniGrabber`、Python、Uvicorn、SQLite 与 FFmpeg 的一切依赖；
   - 内存占用极小，关闭浏览器即释放，零后台僵尸进程，随装随用。
2. **多线程并发 HLS / M3U8 流转封装**：
   - 内置前端 `HlsParser`，智能解析 Master / Media 播放列表；
   - 支持多线程并发分片拉取（1~8 线程自由调节）；
   - 完整支持 AES-128 切片加密算法（基于浏览器原生 `crypto.subtle` 高速解密）；
   - 集成 `mux.js`，将 MPEG-2 TS 切片在内存中无缝转封装为标准 Fragmented MP4。
3. **DeclarativeNetRequest 智能防盗链绕过**：
   - 动态配置浏览器网络底层请求头，自动为 B站 (`bilivideo.com`)、抖音 (`bytevod.com`) 等平台流媒体注入合法 Referer / Origin，彻底解决 403 Forbidden 痛点。
4. **B站 DASH / 音画分离流前端提取**：
   - 智能识别页面视频轨与音频轨，支持最高画质视频下载或一键提取纯音频（MP3/M4A）。
5. **全场景视频嗅探与超级悬浮胶囊**：
   - **播放器超级悬浮胶囊**：一键下载、截图高清当前帧(PNG)、画中画(PiP)、突破系统限制多倍速播放(1.0x~3.0x)、循环播放、复制纯净直链；
   - **页面列表卡片智能识别**：在 B站、YouTube、抖音、Eporner 等列表原位注入微型下载胶囊；
   - **右侧吸边助手胶囊**：实时显示当前页面嗅探到的视频数量，点击一键展开原生 SidePanel；
   - **网络性能深度探测**：除 DOM 外，自动扫描 `performance.getEntriesByType('resource')` 嗅探被 blob 隐藏的 m3u8 和真实媒体流。
6. **毫秒级响应式任务面板**：
   - 基于 `chrome.storage.local` 持久化队列与实时 `chrome.storage.onChanged` 事件广播；
   - 实时显示分片下载进度百分比、动态下载速度（如 `3.8 MB/s`）、已下载文件体积；
   - 下载完成直接调用原生下载管理器落盘，一键「▶ 打开」文件。

---

## 安装与使用（即装即用，无需配置服务）

1. 打开 Chrome / Edge 浏览器，在地址栏输入 `chrome://extensions` 并回车；
2. 开启右上角 **「开发者模式」** 开关；
3. 点击左上角 **「加载已解压的扩展程序」**；
4. 选择本插件目录：`/Users/eden/workspace/OmniVideo`；
5. 加载完成！右键固定到浏览器扩展栏，点击即可直接使用，无需任何安装命令或后台服务！

---

## 目录结构

```
OmniVideo/
├── manifest.json       # Chrome MV3 清单（声明 offscreen, declarativeNetRequest, downloads）
├── background.js       # 后台 Service Worker（任务调度、DNR 防盗链规则注入、状态管理）
├── content.js          # 页面交互与深度嗅探（播放器胶囊、卡片胶囊、DASH提取、性能流探测）
├── content.css         # 页面微型悬浮胶囊、毛玻璃下拉菜单与 Toast 样式
├── core/
│   ├── offscreen.html  # MV3 离线多媒体沙箱页面
│   ├── offscreen.js    # 离线下载与混流调度（HLS并发分片、AES-128解密、mux.js转码）
│   └── hls-parser.js   # 纯前端 M3U8 播放列表解析器与 WebCrypto 解密适配
├── libs/
│   ├── mux.min.js      # Video.js 官方 MPEG-2 TS 到 MP4 纯前端转封装引擎
│   └── mp4box.all.min.js # ISO BMFF / MP4 纯前端合成与轨道复用器
├── popup/
│   ├── popup.html      # 侧边栏/弹窗主结构（快捷下载、嗅探列表、实时任务、引擎设置）
│   ├── popup.css       # 现代科技深色风格样式
│   └── popup.js        # 侧边栏交互逻辑（纯本地存储、实时响应式监听、任务管理）
└── icons/              # 插件图标资源 (16/32/48/128)
```
