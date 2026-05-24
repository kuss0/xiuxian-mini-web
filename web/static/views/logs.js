// MINIWEB-VIEW: message logs modal
(function () {
  "use strict";

  const { openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml } = window.MiniwebFormat;

  function openLogsModal({ channels = [], exportLogMessages, loadLogMessages, renderTelegramTextHtml }) {
    const dialog = openModal({
      title: "消息日志(全部采集)",
      body: `
        <section class="modal-section">
          <div class="form-grid">
            <label class="span-2">
              <span>频道</span>
              <select id="logsChannelSelect">
                <option value="all" selected>全部频道</option>
                ${channels.map((c) => `<option value="${escapeAttr(c.key)}">${escapeHtml(c.label || c.key)}</option>`).join("")}
              </select>
            </label>
            <label>
              <span>关键字过滤</span>
              <input id="logsSearch" placeholder="文本子串,空 = 不过滤" />
            </label>
            <label>
              <span>每页</span>
              <select id="logsPageSize">
                <option value="100">100 条</option>
                <option value="200" selected>200 条</option>
                <option value="500">500 条</option>
              </select>
            </label>
          </div>
          <div class="form-actions">
            <button type="button" id="logsRefresh">重新加载</button>
            <button type="button" id="logsLoadMore">加载更早</button>
            <span class="muted" style="flex:1"></span>
            <select id="logsExportFmt" title="导出格式">
              <option value="jsonl" selected>jsonl</option>
              <option value="csv">csv</option>
              <option value="txt">txt</option>
            </select>
            <button type="button" id="logsExport" title="导出当前频道全部消息(无 limit)">导出</button>
            <span id="logsStatus" class="muted"></span>
          </div>
        </section>
        <section class="modal-section">
          <div id="logsList" class="logs-modal-list"></div>
        </section>
      `,
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return;
    bindLogsModal(dialog, { exportLogMessages, loadLogMessages, renderTelegramTextHtml });
  }

  function bindLogsModal(dialog, { exportLogMessages, loadLogMessages, renderTelegramTextHtml }) {
    const channelSelect = dialog.querySelector("#logsChannelSelect");
    const searchInput = dialog.querySelector("#logsSearch");
    const pageSizeSelect = dialog.querySelector("#logsPageSize");
    const refreshBtn = dialog.querySelector("#logsRefresh");
    const loadMoreBtn = dialog.querySelector("#logsLoadMore");
    const statusEl = dialog.querySelector("#logsStatus");
    const listEl = dialog.querySelector("#logsList");
    if (!listEl) return;

    const local = { items: [], oldestSeq: 0, loading: false };
    const setStatus = (text) => {
      statusEl.textContent = text || "";
    };

    const fetchPage = async ({ reset = false } = {}) => {
      if (local.loading) return;
      local.loading = true;
      refreshBtn.disabled = true;
      loadMoreBtn.disabled = true;
      setStatus("加载中…");
      try {
        const limit = pageSizeSelect.value || "200";
        if (typeof loadLogMessages !== "function") {
          throw new Error("logs missing dependency: loadLogMessages");
        }
        const result = await loadLogMessages({
          beforeSeq: !reset && local.oldestSeq > 0 ? local.oldestSeq : 0,
          channel: channelSelect.value || "all",
          limit,
        });
        let incoming = result.messages || [];
        const q = (searchInput.value || "").trim();
        if (q) incoming = incoming.filter((m) => (m.raw || m.summary || "").includes(q));
        local.items = reset ? incoming : local.items.concat(incoming);
        const oldest = incoming.reduce((min, m) => (min === 0 || (m.seq && m.seq < min) ? m.seq : min), 0);
        if (oldest > 0) local.oldestSeq = oldest;
        renderLogs(listEl, local.items, { renderTelegramTextHtml });
        setStatus(`已加载 ${local.items.length} 条${incoming.length === 0 && !reset ? "(无更早)" : ""}`);
      } catch (err) {
        setStatus(`错误:${err.message}`);
      } finally {
        local.loading = false;
        refreshBtn.disabled = false;
        loadMoreBtn.disabled = false;
      }
    };

    refreshBtn.addEventListener("click", () => {
      local.oldestSeq = 0;
      fetchPage({ reset: true });
    });
    loadMoreBtn.addEventListener("click", () => fetchPage({ reset: false }));
    channelSelect.addEventListener("change", () => {
      local.oldestSeq = 0;
      fetchPage({ reset: true });
    });
    pageSizeSelect.addEventListener("change", () => {
      local.oldestSeq = 0;
      fetchPage({ reset: true });
    });
    searchInput.addEventListener("input", () => {
      let items = local.items;
      const q = (searchInput.value || "").trim();
      if (q) items = items.filter((m) => (m.raw || m.summary || "").includes(q));
      renderLogs(listEl, items, { renderTelegramTextHtml });
    });

    const exportBtn = dialog.querySelector("#logsExport");
    const exportFmt = dialog.querySelector("#logsExportFmt");
    if (exportBtn) {
      exportBtn.addEventListener("click", async () => {
        const fmt = exportFmt.value || "jsonl";
        exportBtn.disabled = true;
        const oldText = exportBtn.textContent;
        exportBtn.textContent = "导出中…";
        setStatus("拉取全量数据,大批可能要几秒…");
        try {
          if (typeof exportLogMessages !== "function") {
            throw new Error("logs missing dependency: exportLogMessages");
          }
          const res = await exportLogMessages({
            channel: channelSelect.value || "all",
            fmt,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const blob = await res.blob();
          const cd = res.headers.get("Content-Disposition") || "";
          const m = cd.match(/filename="([^"]+)"/);
          const filename = m ? m[1] : `xiuxian-messages.${fmt}`;
          const downloadUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = downloadUrl;
          a.download = filename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(downloadUrl);
          setStatus(`已导出 ${filename}｜${(blob.size / 1024).toFixed(1)} KB`);
        } catch (err) {
          setStatus(`导出失败:${err.message}`);
        } finally {
          exportBtn.disabled = false;
          exportBtn.textContent = oldText;
        }
      });
    }

    fetchPage({ reset: true });
  }

  function renderLogs(container, items, { renderTelegramTextHtml }) {
    if (!items.length) {
      container.innerHTML = '<p class="empty inline">无匹配消息</p>';
      return;
    }
    container.innerHTML = items.map((m) => {
      const time = (m.time || "").replace("T", " ").replace(/\..+$/, "").replace(/\+.+$/, "");
      const sender = m.sender_id || "";
      const channel = m.channel || "";
      const raw = (m.raw || m.summary || "").trim();
      return `
        <article class="logs-row">
          <div class="logs-row-meta">
            <small>${escapeHtml(time)}</small>
            <span class="logs-row-channel">${escapeHtml(channel)}</span>
            <small>from ${escapeHtml(String(sender))}</small>
          </div>
          <pre class="logs-row-text">${renderTelegramTextHtml(raw, m)}</pre>
        </article>
      `;
    }).join("");
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.logs = { openLogsModal };
})();
