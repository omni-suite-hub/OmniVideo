/* OmniVideo 弹窗核心交互逻辑 */
"use strict";

const $ = (id) => document.getElementById(id);

/* 全局状态 */
const state = {
  activeTab: "tab-download",
  quality: "best",
  concurrency: 5,
  autoClearDone: false,
  sniffResults: [],
  selectedSniffUrls: new Set(),
  tasks: [],
  taskPage: 1,
  taskPageSize: 10,
  taskTotal: 0,
  pollTimer: null,
};

/* ---------- 与 Background 通信包装 ---------- */
function bg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res || { ok: false });
      }
    });
  });
}

/* ---------- 辅助工具函数 ---------- */
function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[m]));
}

function shortUrl(u) {
  try {
    const p = new URL(u);
    const path = p.pathname.length > 24 ? p.pathname.slice(0, 24) + "…" : p.pathname;
    const search = p.search ? (p.search.length > 18 ? p.search.slice(0, 18) + "…" : p.search) : "";
    return p.hostname + path + search;
  } catch (e) {
    return u;
  }
}

function showToast(msg, kind = "info") {
  let toast = document.querySelector(".popup-toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "popup-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = msg;
  toast.className = `popup-toast show ${kind}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.remove("show");
  }, 2500);
}

/* ---------- 1. Tab 切换 ---------- */
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tabId = btn.dataset.tab;
      switchTab(tabId);
    });
  });
}

function switchTab(tabId) {
  state.activeTab = tabId;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tabId);
  });
  document.querySelectorAll(".tab-pane").forEach((p) => {
    p.classList.toggle("active", p.id === tabId);
  });

  if (tabId === "tab-tasks") {
    loadTasks(1);
  } else if (tabId === "tab-download") {
    loadSniff();
  }
}

/* ---------- 2. 引擎状态与设置管理 ---------- */
async function refreshState() {
  const st = await bg({ type: "getState" });
  const statusEl = $("serverStatus");
  const statusTxt = $("statusText");
  try {
    const res = await fetch("http://127.0.0.1:8090/api/health").catch(() => null);
    if (res && res.ok) {
      if (statusEl) statusEl.className = "server-status on";
      if (statusTxt) statusTxt.textContent = "本地极速引擎 · 就绪";
    } else {
      if (statusEl) statusEl.className = "server-status on";
      if (statusTxt) statusTxt.textContent = "纯前端模式 · 就绪";
    }
  } catch (e) {
    if (statusEl) statusEl.className = "server-status on";
    if (statusTxt) statusTxt.textContent = "纯前端模式 · 就绪";
  }

  // 加载用户偏好设置
  const setRes = await bg({ type: "getSettings" });
  if (setRes && setRes.ok && setRes.settings) {
    const s = setRes.settings;
    if ($("chkShowSideCapsule")) $("chkShowSideCapsule").checked = s.showSideCapsule !== false;
    if ($("chkShowCardCapsule")) $("chkShowCardCapsule").checked = s.showCardCapsule !== false;
    if ($("chkShowPlayerCapsule")) $("chkShowPlayerCapsule").checked = s.showPlayerCapsule !== false;
    if ($("selectConcurrency")) $("selectConcurrency").value = String(s.concurrency || 5);
    if ($("selectDefaultQuality")) $("selectDefaultQuality").value = s.defaultQuality || "best";
    if ($("selectCobaltQuality")) $("selectCobaltQuality").value = s.cobaltQuality || "1080";
    if ($("chkSaveAs")) $("chkSaveAs").checked = !!s.saveAs;
    if ($("chkAutoClearDone")) $("chkAutoClearDone").checked = !!s.autoClearDone;
    state.concurrency = s.concurrency || 5;
    state.autoClearDone = !!s.autoClearDone;
    if (s.defaultQuality) {
      state.quality = s.defaultQuality;
      document.querySelectorAll(".q-chip").forEach((chip) => {
        chip.classList.toggle("active", chip.dataset.quality === s.defaultQuality);
      });
    }
  }
}

function setupSettingsTab() {
  const saveCurrentSettings = async () => {
    const settings = {
      concurrency: parseInt($("selectConcurrency").value, 10) || 5,
      engineMode: "stream",
      defaultQuality: $("selectDefaultQuality").value || "best",
      cobaltQuality: $("selectCobaltQuality")?.value || "1080",
      saveAs: !!$("chkSaveAs")?.checked,
      autoClearDone: $("chkAutoClearDone").checked,
      showSideCapsule: $("chkShowSideCapsule") ? $("chkShowSideCapsule").checked : true,
      showCardCapsule: $("chkShowCardCapsule") ? $("chkShowCardCapsule").checked : true,
      showPlayerCapsule: $("chkShowPlayerCapsule") ? $("chkShowPlayerCapsule").checked : true,
    };
    state.concurrency = settings.concurrency;
    state.quality = settings.defaultQuality;
    state.autoClearDone = settings.autoClearDone;
    await bg({ type: "saveSettings", settings });
  };

  $("chkShowSideCapsule")?.addEventListener("change", saveCurrentSettings);
  $("chkShowCardCapsule")?.addEventListener("change", saveCurrentSettings);
  $("chkShowPlayerCapsule")?.addEventListener("change", saveCurrentSettings);
  $("selectConcurrency")?.addEventListener("change", saveCurrentSettings);
  $("selectDefaultQuality")?.addEventListener("change", saveCurrentSettings);
  $("selectCobaltQuality")?.addEventListener("change", saveCurrentSettings);
  $("chkSaveAs")?.addEventListener("change", saveCurrentSettings);
  $("chkAutoClearDone")?.addEventListener("change", saveCurrentSettings);

  $("btnOpenChromeDownloads")?.addEventListener("click", () => {
    chrome.tabs.create({ url: "chrome://downloads" });
  });

  $("btnClearAllTaskHistory")?.addEventListener("click", async () => {
    if (confirm("确定要清空所有的下载任务历史记录吗？")) {
      await chrome.storage.local.set({ omni_tasks: [] });
      loadTasks();
    }
  });
}

/* ---------- 3. Tab 1: 快捷下载与指定链接 ---------- */
function setupDownloadTab() {
  // 画质选择
  document.querySelectorAll(".q-chip").forEach((chip) => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".q-chip").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      state.quality = chip.dataset.quality;
    });
  });

  // 剪贴板读取
  $("btnPasteClipboard").addEventListener("click", async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text && text.trim()) {
        $("inputCustomUrl").value = text.trim();
        showActionFeedback("已粘贴剪贴板内容", "ok");
      } else {
        showActionFeedback("剪贴板内容为空", "err");
      }
    } catch (e) {
      showActionFeedback("无法读取剪贴板，请直接粘贴", "err");
    }
  });

  // 当前标签页 URL
  $("btnUseCurrentPage").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url) {
      $("inputCustomUrl").value = tab.url;
      showActionFeedback("已填入当前页面地址", "ok");
    }
  });

  // 立即下载指定视频
  $("btnSubmitCustomUrl").addEventListener("click", async () => {
    const rawUrl = $("inputCustomUrl").value.trim();
    if (!rawUrl) {
      showActionFeedback("请先输入或粘贴视频链接", "err");
      $("inputCustomUrl").focus();
      return;
    }

    const btn = $("btnSubmitCustomUrl");
    btn.disabled = true;
    btn.innerHTML = "<span>⏳ 正在提交任务…</span>";

    const activeTab = await getActiveWebTab();
    const res = await bg({
      type: "sendDownload",
      url: rawUrl,
      quality: state.quality,
      tabId: activeTab ? activeTab.id : null,
    });

    btn.disabled = false;
    btn.innerHTML = "<span>🚀 立即下载指定视频</span>";

    if (res && res.ok) {
      showActionFeedback("任务已创建！正在后台解析下载 ✓", "ok");
      $("inputCustomUrl").value = "";
      setTimeout(() => switchTab("tab-tasks"), 700);
    } else {
      const err = (res && res.error) || "提交失败，请检查服务状态";
      showActionFeedback(err, "err");

      // 若为未播放的 YouTube 链接，贴心引导并一键在新标签页中打开
      if (err.includes("YouTube") || err.includes("需在网页播放器中加载")) {
        const urlMatch = rawUrl.match(/https?:\/\/[^\s"'<>]+/);
        const targetUrl = urlMatch ? urlMatch[0] : rawUrl;
        if (targetUrl.startsWith("http")) {
          setTimeout(() => {
            chrome.tabs.create({ url: targetUrl, active: true });
          }, 1500);
        }
      }
    }
  });
}

function showActionFeedback(msg, kind) {
  const el = $("customUrlFeedback");
  el.textContent = msg;
  el.className = "action-feedback " + (kind || "");
  setTimeout(() => {
    if (el.textContent === msg) el.textContent = "";
  }, 4000);
}

/* ---------- 4. 本页视频嗅探列表与单项下载 ---------- */
async function getActiveWebTab() {
  const isWeb = (u) => u && (u.startsWith("http://") || u.startsWith("https://"));

  // 1. 优先获取当前窗口的活跃网页标签
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id && isWeb(tab.url)) return tab;
  } catch (e) {}

  // 2. 侧边栏模式下获取最近聚焦窗口的活跃标签
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab && tab.id && isWeb(tab.url)) return tab;
  } catch (e) {}

  // 3. 兜底获取任意打开的活跃网页标签
  try {
    const all = await chrome.tabs.query({ active: true });
    const valid = all.find((t) => isWeb(t.url));
    if (valid) return valid;
    return all[0] || null;
  } catch (e) {
    return null;
  }
}

async function loadSniff() {
  const container = $("sniffListContainer");
  const countBadge = $("sniffCountBadge");

  try {
    const tab = await getActiveWebTab();
    if (!tab || !tab.id) {
      container.innerHTML = '<div class="empty-hint">无法获取当前网页标签</div>';
      return;
    }

    if (tab.url && (tab.url.startsWith("chrome://") || tab.url.startsWith("chrome-extension://"))) {
      container.innerHTML = `
        <div class="empty-hint">
          <span>当前页面为浏览器内置页面</span><br/>
          <span style="font-size:11px;color:var(--dim)">请切换至视频网站（B站/YouTube/抖音等）查看嗅探</span>
        </div>
      `;
      countBadge.textContent = "0";
      return;
    }

    // 发送页面 DOM 嗅探探测请求
    let res = await chrome.tabs.sendMessage(tab.id, { type: "sniff" }).catch(() => null);

    // 如果未收到响应，使用 chrome.scripting 立即自动重注入并重试
    if ((!res || !res.ok) && chrome.scripting && chrome.scripting.executeScript) {
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["content.css"] }).catch(() => {});
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] }).catch(() => {});
        await new Promise((r) => setTimeout(r, 200));
        res = await chrome.tabs.sendMessage(tab.id, { type: "sniff" }).catch(() => null);
      } catch (e) {}
    }

    // 同时读取 WebRequest 网络探测到的真实流媒体 (YouTube, B站, HLS 等)
    const netMedia = await bg({ type: "getTabMedia", tabId: tab.id });
    const foundList = (res && res.found) ? res.found.slice() : [];

    if (netMedia && netMedia.ok && netMedia.media) {
      for (const m of netMedia.media) {
        if (!foundList.some((item) => item.url === m.url)) {
          const isYt = m.url.includes("googlevideo.com");
          const isBi = m.url.includes("bilivideo");
          const platform = isYt ? "YouTube" : (isBi ? "B站" : (m.type === "hls" ? "HLS" : "MP4直链"));
          const typeLabel = m.type === "hls" ? "HLS流" : (m.type === "audio" ? "音频轨" : "视频轨");
          const sizeLabel = m.size ? ` (${m.size} MB)` : "";
          foundList.unshift({
            url: m.url,
            title: `${tab.title || "网页流"} [${platform} ${typeLabel}]${sizeLabel}`,
            platform,
            source: "network",
          });
        }
      }
    }

    if (!foundList.length) {
      state.sniffResults = [];
      countBadge.textContent = "0";
      container.innerHTML = `
        <div class="empty-hint">
          <span>本页暂未识别到视频流</span><br/>
          <span style="font-size:11px;color:var(--dim)">请在页面中开启播放视频，插件将自动捕获网络真实媒体流</span>
        </div>
      `;
      $("btnBatchDownload").disabled = true;
      return;
    }

    state.sniffResults = foundList;
    state.selectedSniffUrls.clear();
    countBadge.textContent = String(foundList.length);

    renderSniffList();
  } catch (e) {
    container.innerHTML = '<div class="empty-hint">页面探测未就绪，可点击 🔄 重试</div>';
  }
}

function cleanItemTitle(title) {
  return String(title || "")
    .replace(/\s*\[(?:YouTube|B站|HLS|MP4直链)[^\]]*\]/gi, "")
    .replace(/\s*\(\d+(?:\.\d+)?\s*[KMGT]?B\)/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function renderSniffList() {
  const container = $("sniffListContainer");
  container.innerHTML = state.sniffResults.map((item, idx) => {
    const isChecked = state.selectedSniffUrls.has(item.url);
    const tagClass = getPlatformTagClass(item.platform);
    const isYtLink = item.source === "link" && /youtube\.com|youtu\.be/i.test(item.url);

    return `
      <div class="sniff-item" data-idx="${idx}">
        <input type="checkbox" class="sniff-chk" data-url="${escapeHtml(item.url)}" ${isChecked ? "checked" : ""} />
        <span class="sniff-tag ${tagClass}">${escapeHtml(item.platform)}</span>
        <div class="sniff-info">
          <div class="sniff-name" title="${escapeHtml(item.title)}">${escapeHtml(item.title || "未命名视频")}</div>
          <div class="sniff-url" title="${escapeHtml(item.url)}">${escapeHtml(shortUrl(item.url))}</div>
        </div>
        <div class="sniff-actions">
          ${
            item.isMse
              ? `<button class="btn btn-sm btn-primary btn-item-mse-dl" data-title="${escapeHtml(cleanItemTitle(item.title))}" title="通过浏览器原生截获完整视频落盘">⚡ 下载 MP4</button>`
              : isYtLink
              ? `<button class="btn btn-sm btn-outline btn-item-open" data-url="${escapeHtml(item.url)}" title="YouTube 需要打开播放以捕获真实流">▶ 打开播放</button>`
              : `<button class="btn btn-sm btn-outline btn-item-dl" data-url="${escapeHtml(item.url)}" data-title="${escapeHtml(cleanItemTitle(item.title))}">⚡ 下载</button>`
          }
        </div>
      </div>
    `;
  }).join("");

  updateBatchButton();
}

function getPlatformTagClass(p) {
  if (p === "B站") return "tag-bilibili";
  if (p === "YouTube") return "tag-youtube";
  if (p === "抖音") return "tag-douyin";
  if (p === "Eporner") return "tag-eporner";
  if (p === "HLS") return "tag-hls";
  return "";
}

/* 嗅探列表事件委托（单项下载 & 打开播放 & 复选框选择） */
$("sniffListContainer").addEventListener("click", async (e) => {
  // 1. 点击 MSE 下载
  const mseBtn = e.target.closest(".btn-item-mse-dl");
  if (mseBtn) {
    const title = mseBtn.dataset.title;
    mseBtn.disabled = true;
    mseBtn.innerHTML = "✓ 正在保存";
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_MSE_DOWNLOAD", title });
      }
    } catch (err) {}
    setTimeout(() => {
      mseBtn.disabled = false;
      mseBtn.innerHTML = "⚡ 下载 MP4";
    }, 3000);
    return;
  }

  // 2. 点击打开播放（针对 YouTube 推荐链接）
  const openBtn = e.target.closest(".btn-item-open");
  if (openBtn) {
    const url = openBtn.dataset.url;
    chrome.tabs.create({ url, active: true });
    openBtn.textContent = "✓ 已打开";
    openBtn.style.color = "var(--accent)";
    return;
  }

  // 3. 点击单项通用下载
  const dlBtn = e.target.closest(".btn-item-dl");
  if (dlBtn) {
    const url = dlBtn.dataset.url;
    const title = dlBtn.dataset.title;

    dlBtn.disabled = true;
    dlBtn.innerHTML = "⏳ 提交中";

    const res = await bg({
      type: "sendDownload",
      url,
      title,
      quality: state.quality,
    });

    if (res && res.ok) {
      dlBtn.innerHTML = "✓ 已添加";
      dlBtn.style.color = "var(--green)";
      dlBtn.style.borderColor = "var(--green)";
      loadTasks();
    } else {
      dlBtn.disabled = false;
      dlBtn.innerHTML = "! 失败";
    }
    return;
  }

  // 2. 点击复选框
  const chk = e.target.closest(".sniff-chk");
  if (chk) {
    const url = chk.dataset.url;
    if (chk.checked) {
      state.selectedSniffUrls.add(url);
    } else {
      state.selectedSniffUrls.delete(url);
    }
    updateBatchButton();
  }
});

/* 全选 / 取消全选 */
$("chkSelectAll").addEventListener("change", (e) => {
  const checked = e.target.checked;
  document.querySelectorAll(".sniff-chk").forEach((c) => {
    c.checked = checked;
    if (checked) {
      state.selectedSniffUrls.add(c.dataset.url);
    } else {
      state.selectedSniffUrls.delete(c.dataset.url);
    }
  });
  updateBatchButton();
});

function updateBatchButton() {
  const count = state.selectedSniffUrls.size;
  const btn = $("btnBatchDownload");
  btn.disabled = count === 0;
  btn.textContent = count > 0 ? `批量下载已选 (${count})` : "批量下载已选";
  $("chkSelectAll").checked = state.sniffResults.length > 0 && count === state.sniffResults.length;
}

/* 批量下载已选 */
$("btnBatchDownload").addEventListener("click", async () => {
  const urls = Array.from(state.selectedSniffUrls);
  if (!urls.length) return;

  const btn = $("btnBatchDownload");
  btn.disabled = true;
  let successCount = 0;

  for (let i = 0; i < urls.length; i++) {
    btn.textContent = `下载中 (${i + 1}/${urls.length})…`;
    const item = state.sniffResults.find((r) => r.url === urls[i]);
    const res = await bg({
      type: "sendDownload",
      url: urls[i],
      title: item ? item.title : "",
      quality: state.quality,
    });
    if (res && res.ok) successCount++;
  }

  btn.textContent = `✓ 已提交 ${successCount} 个`;
  setTimeout(() => {
    updateBatchButton();
    switchTab("tab-tasks");
  }, 1000);
});

/* 重新扫描嗅探 */
$("btnRefreshSniff").addEventListener("click", () => {
  loadSniff();
});

/* ---------- 5. Tab 2: 任务管理 ---------- */
async function loadTasks(page) {
  if (page) state.taskPage = page;
  const res = await bg({
    type: "getTasks",
    page: state.taskPage,
    pageSize: state.taskPageSize,
  });

  if (!res || !res.ok) return;

  state.tasks = (res.data && res.data.tasks) || [];
  state.taskTotal = (res.data && res.data.total) || 0;

  renderTasks();
}

function renderTasks() {
  $("tasksTotalCount").textContent = String(state.taskTotal);
  const container = $("tasksListContainer");

  // 更新活跃任务角标
  const activeCount = state.tasks.filter((t) =>
    ["queued", "parsing", "downloading", "merging"].includes(t.status)
  ).length;
  const badge = $("tasksActiveBadge");
  if (activeCount > 0) {
    badge.hidden = false;
    badge.textContent = String(activeCount);
  } else {
    badge.hidden = true;
  }

  const pager = $("tasksPager");
  if (!state.tasks.length) {
    container.innerHTML = '<div class="empty-hint">暂无下载任务</div>';
    pager.hidden = true;
    pager.style.display = "none";
    return;
  }

  container.innerHTML = state.tasks.map(renderTaskItem).join("");

  // 分页器：仅在总页数大于 1 时显示
  const pages = Math.ceil(state.taskTotal / state.taskPageSize) || 1;
  if (pages <= 1) {
    pager.hidden = true;
    pager.style.display = "none";
  } else {
    pager.hidden = false;
    pager.style.display = "flex";
    $("pagerInfo").textContent = `${state.taskPage} / ${pages}`;
    $("btnPagePrev").disabled = state.taskPage <= 1;
    $("btnPageNext").disabled = state.taskPage >= pages;
  }
}

function renderTaskItem(t) {
  const statusMap = {
    queued: { label: "排队中", class: "queued" },
    parsing: { label: "解析中", class: "parsing" },
    downloading: { label: "下载中", class: "downloading" },
    merging: { label: "转码合并", class: "merging" },
    done: { label: "已完成", class: "done" },
    failed: { label: "失败", class: "failed" },
  };
  const st = statusMap[t.status] || { label: t.status, class: "queued" };
  const pct = Math.max(0, Math.min(100, Math.round((t.progress || 0) * 100)));

  // 进度条
  const showBar = ["downloading", "merging"].includes(t.status);
  const barHtml = showBar
    ? `<div class="task-bar-wrap"><div class="task-bar-inner" style="width: ${pct}%"></div></div>`
    : "";

  // 动作按钮
  const copyBtnHtml = `<button class="btn btn-sm btn-outline act-copy-link" data-id="${t.id}" data-url="${escapeHtml(t.url)}" title="复制下载链接">🔗 复制链接</button>`;

  let actsHtml = "";
  if (t.status === "done") {
    actsHtml = `
      ${copyBtnHtml}
      <button class="btn btn-sm btn-primary act-play" data-id="${t.id}" title="使用本地默认播放器播放">▶ 播放</button>
      <button class="btn btn-sm btn-outline act-open" data-id="${t.id}" title="在访达 (Finder) 中定位文件">📁 定位</button>
      <button class="btn btn-sm btn-icon act-del" data-id="${t.id}" title="删除记录">🗑️</button>
    `;
  } else if (t.status === "failed") {
    actsHtml = `
      ${copyBtnHtml}
      <button class="btn btn-sm btn-outline act-retry" data-id="${t.id}">↺ 重试</button>
      <button class="btn btn-sm btn-icon act-del" data-id="${t.id}" title="删除记录">🗑️</button>
    `;
  } else {
    actsHtml = `
      ${copyBtnHtml}
      <button class="btn btn-sm btn-icon act-del" data-id="${t.id}" title="取消并删除">✕</button>
    `;
  }

  // 元数据标签
  const meta = [];
  if (t.platform) meta.push(t.platform.toUpperCase());
  if (t.speed && ["downloading", "merging"].includes(t.status)) meta.push(t.speed);
  if (t.size) meta.push(`${t.size} MB`);
  if (showBar) meta.push(`${pct}%`);

  return `
    <div class="task-item" data-id="${t.id}">
      <div class="task-header">
        <span class="task-pill ${st.class}">${st.label}</span>
        <span class="task-title" title="${escapeHtml(t.title || "")}">${escapeHtml(t.title || "解析中…")}</span>
      </div>
      ${barHtml}
      <div class="task-footer">
        <div class="task-meta">
          ${t.status === "failed" && t.error ? `<span class="task-err-msg" title="${escapeHtml(t.error)}">${escapeHtml(t.error)}</span>` : meta.join(" · ")}
        </div>
        <div class="task-btns">${actsHtml}</div>
      </div>
    </div>
  `;
}

/* 任务列表事件委托（复制链接、打开文件、重试、删除） */
$("tasksListContainer").addEventListener("click", async (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  const id = btn.dataset.id;
  if (!id) return;

  if (btn.classList.contains("act-copy-link")) {
    const t = state.tasks.find((x) => x.id === id);
    const dlUrl = (t && t.status === "done")
      ? (t.downloadUrl || (t && t.url) || "")
      : (btn.dataset.url || (t && t.url) || "");

    navigator.clipboard.writeText(dlUrl).then(() => {
      const orig = btn.innerHTML;
      btn.innerHTML = "✓ 已复制";
      btn.style.color = "var(--green)";
      btn.style.borderColor = "var(--green)";
      setTimeout(() => {
        btn.innerHTML = orig;
        btn.style.color = "";
        btn.style.borderColor = "";
      }, 1500);
    }).catch(() => {
      prompt("请手动复制下载链接：", dlUrl);
    });
    return;
  }

  if (btn.classList.contains("act-play")) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "⏳ 打开中";
    const res = await bg({ type: "playFile", id });
    if (res && res.ok) {
      btn.innerHTML = "▶ 播放中";
      showToast(res.message || "已在系统默认播放器中打开 ✓", "ok");
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = orig;
      }, 1500);
    } else {
      btn.disabled = false;
      btn.innerHTML = "! 失败";
      showToast(res?.error || "启动播放失败", "err");
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
  } else if (btn.classList.contains("act-open")) {
    const orig = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = "⏳ 定位中";
    const res = await bg({ type: "openFile", id });
    if (res && res.ok) {
      btn.innerHTML = "📁 已定位";
      showToast(res.message || "已在访达 (Finder) 中高亮定位 ✓", "ok");
      setTimeout(() => {
        btn.disabled = false;
        btn.innerHTML = orig;
      }, 1500);
    } else {
      btn.disabled = false;
      btn.innerHTML = "! 失败";
      showToast(res?.error || "定位文件失败", "err");
      setTimeout(() => { btn.innerHTML = orig; }, 2000);
    }
  } else if (btn.classList.contains("act-retry")) {
    btn.disabled = true;
    btn.textContent = "重试中…";
    await bg({ type: "retryTask", id });
    loadTasks();
  } else if (btn.classList.contains("act-del")) {
    await bg({ type: "deleteTask", id });
    loadTasks();
  }
});

/* 清理已完成 */
$("btnClearDoneTasks").addEventListener("click", async () => {
  await bg({ type: "clearDone" });
  loadTasks();
});

/* 手动刷新任务 */
$("btnRefreshTasks").addEventListener("click", () => {
  loadTasks();
});

/* 分页控制 */
$("btnPagePrev").addEventListener("click", () => {
  if (state.taskPage > 1) loadTasks(state.taskPage - 1);
});
$("btnPageNext").addEventListener("click", () => {
  loadTasks(state.taskPage + 1);
});

/* ---------- 6. 自动轮询、响应式更新与启动 ---------- */
async function startAutoPoll() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (!document.hidden) {
      if (state.activeTab === "tab-tasks") {
        loadTasks();
      }
    }
  }, 3500);
}

document.addEventListener("DOMContentLoaded", async () => {
  setupTabs();
  setupDownloadTab();
  setupSettingsTab();
  await refreshState();
  loadSniff();
  loadTasks(1);
  startAutoPoll();

  // 响应式监听 storage 变化：分片下载进度、状态变更实时毫秒级刷新
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.omni_tasks) {
        if (state.activeTab === "tab-tasks") {
          loadTasks();
        } else {
          const list = changes.omni_tasks.newValue || [];
          const activeCount = list.filter((t) =>
            ["queued", "parsing", "downloading", "merging"].includes(t.status)
          ).length;
          const badge = $("tasksActiveBadge");
          if (badge) {
            badge.hidden = activeCount === 0;
            badge.textContent = String(activeCount);
          }
        }
      }
    });
  }

  // 侧边栏常驻时，用户切换或刷新浏览器标签页自动重载嗅探列表
  if (chrome.tabs && chrome.tabs.onActivated) {
    chrome.tabs.onActivated.addListener(() => {
      if (state.activeTab === "tab-download") {
        setTimeout(loadSniff, 150);
      }
    });
  }
  if (chrome.tabs && chrome.tabs.onUpdated) {
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (changeInfo.status === "complete" && state.activeTab === "tab-download") {
        setTimeout(loadSniff, 200);
      }
    });
  }
});
