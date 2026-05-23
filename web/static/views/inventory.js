// MINIWEB-VIEW: inventory transfer modal
(function () {
  "use strict";

  const { fetchJson, postJson } = window.MiniwebApi;
  const { openModal } = window.MiniwebModal;
  const { escapeAttr, escapeHtml, formatNumber } = window.MiniwebFormat;

  async function openInventoryModal({ copyCommandToClipboard }) {
    const dialog = openModal({
      title: "库存 / 批量转移",
      body: `
        <section class="modal-section">
          <h4>当前库存</h4>
          <p class="muted">以最近 .储物袋 为权威快照,叠加明确成功回执。estimated 表示估算值,可再手动 .储物袋 校准。</p>
          <div class="form-grid">
            <label>
              <span>资源号</span>
              <select id="inventoryOwnerSelect"></select>
            </label>
            <label>
              <span>搜索物品</span>
              <input id="inventorySearch" placeholder="例如 阴凝、残图、灵石" />
            </label>
            <label>
              <span>购买方</span>
              <input id="inventoryBuyer" placeholder="集中资源的 @username" />
            </label>
            <label>
              <span>诱饵物品</span>
              <input id="inventoryBaitName" value="凝血草" />
            </label>
            <label>
              <span>诱饵数量</span>
              <input id="inventoryBaitAmount" inputmode="numeric" value="1" />
            </label>
          </div>
          <div class="form-actions">
            <button type="button" id="inventoryRefresh">刷新快照</button>
            <button type="button" class="primary" id="inventoryPlan">生成转移命令</button>
          </div>
          <p class="modal-status-line info" id="inventoryStatus" hidden></p>
        </section>
        <section class="modal-section">
          <div id="inventorySnapshots" class="inventory-snapshots"></div>
          <div id="inventoryBatchBar" class="inventory-batch-bar" hidden>
            <span id="inventoryPickCount">未选择物品</span>
            <button type="button" data-inventory-batch="select-visible">选择可见</button>
            <button type="button" data-inventory-batch="clear">清空</button>
            <button type="button" data-inventory-batch="qty-max">数量填满</button>
            <button type="button" data-inventory-batch="qty-one">数量填 1</button>
          </div>
          <div id="inventoryItems" class="inventory-items"></div>
          <div id="inventoryPlanResult" class="send-as-result" hidden></div>
        </section>
      `,
      footer: `<button type="button" data-modal-close>关闭</button>`,
    });
    if (!dialog) return;
    const deps = { copyCommandToClipboard };
    bindInventoryModal(dialog, deps);
    await refreshInventorySnapshots(dialog);
  }

  function bindInventoryModal(dialog, deps) {
    dialog.querySelector("#inventoryRefresh")?.addEventListener("click", () => {
      refreshInventorySnapshots(dialog).catch((error) => setInventoryStatus(dialog, "error", error.message));
    });
    dialog.querySelector("#inventoryOwnerSelect")?.addEventListener("change", () => {
      renderInventoryItems(dialog).catch((error) => setInventoryStatus(dialog, "error", error.message));
    });
    dialog.querySelector("#inventorySearch")?.addEventListener("input", () => {
      renderInventoryItems(dialog).catch((error) => setInventoryStatus(dialog, "error", error.message));
    });
    dialog.querySelector("#inventoryPlan")?.addEventListener("click", () => {
      planInventoryTransfer(dialog, deps).catch((error) => setInventoryStatus(dialog, "error", error.message));
    });
    dialog.querySelectorAll("[data-inventory-batch]").forEach((button) => {
      button.addEventListener("click", () => {
        applyInventoryBatchAction(dialog, button.dataset.inventoryBatch || "");
      });
    });
  }

  async function refreshInventorySnapshots(dialog) {
    setInventoryStatus(dialog, "info", "读取当前库存…");
    const payload = await fetchJson("/api/inventory?latest_only=1&limit=200&include_items=0");
    dialog._inventorySnapshots = (payload.snapshots || []).map((snapshot) => ({
      ...snapshot,
      items: [],
      items_loaded: false,
    }));
    dialog._inventoryCurrent = payload.current || [];
    renderInventoryOwnerSelect(dialog);
    const count = inventoryOwners(dialog).length;
    setInventoryStatus(
      dialog,
      count ? "ok" : "warn",
      count
        ? `已载入 ${count} 个资源号的当前库存。`
        : "没有可见资源号快照。先确认账号/身份/own_aliases,再用 .储物袋 让消息箱采到。"
    );
    await renderInventoryItems(dialog);
  }

  function inventoryOwners(dialog) {
    const seen = new Set();
    const owners = [];
    [...(dialog._inventorySnapshots || []), ...(dialog._inventoryCurrent || [])].forEach((item) => {
      const owner = String(item.owner || "").trim();
      const key = owner.toLowerCase();
      if (!owner || seen.has(key)) return;
      seen.add(key);
      owners.push(owner);
    });
    return owners;
  }

  function renderInventoryOwnerSelect(dialog) {
    const select = dialog.querySelector("#inventoryOwnerSelect");
    if (!select) return;
    const snapshots = dialog._inventorySnapshots || [];
    const current = dialog._inventoryCurrent || [];
    const prev = select.value;
    const owners = inventoryOwners(dialog);
    select.innerHTML = owners.map((owner) => {
      const snapshot = snapshots.find((item) => String(item.owner || "").toLowerCase() === owner.toLowerCase()) || {};
      const itemCount = current.filter((item) => String(item.owner || "").toLowerCase() === owner.toLowerCase()).length || snapshot.item_count || 0;
      const label = `@${owner}｜${formatNumber(itemCount)} 类｜${formatInventoryTime(snapshot.event_time || "")}`;
      return `<option value="${escapeAttr(owner)}">${escapeHtml(label)}</option>`;
    }).join("") || '<option value="">暂无快照</option>';
    if (prev && owners.some((owner) => owner === prev)) {
      select.value = prev;
    }
  }

  async function renderInventoryItems(dialog) {
    const owners = inventoryOwners(dialog);
    const owner = dialog.querySelector("#inventoryOwnerSelect")?.value || owners[0] || "";
    const search = (dialog.querySelector("#inventorySearch")?.value || "").trim();
    const snapshots = dialog._inventorySnapshots || [];
    const snapshot = snapshots.find((item) => item.owner === owner)
      || (owner ? { owner, item_count: 0, total_amount: 0, event_time: "", msg_id: "", items: [], items_loaded: true } : null);
    const snapshotBox = dialog.querySelector("#inventorySnapshots");
    const itemBox = dialog.querySelector("#inventoryItems");
    const resultBox = dialog.querySelector("#inventoryPlanResult");
    if (resultBox) {
      resultBox.hidden = true;
      resultBox.innerHTML = "";
    }
    if (!snapshot) {
      if (snapshotBox) snapshotBox.innerHTML = '<p class="empty inline">暂无储物袋快照。</p>';
      if (itemBox) itemBox.innerHTML = "";
      setInventoryBatchBarVisible(dialog, false);
      return;
    }
    const currentItems = currentInventoryItemsForOwner(dialog, snapshot.owner);
    const needsSnapshotItems = currentItems.length === 0;
    if (needsSnapshotItems && !snapshot.items_loaded) {
      if (itemBox) itemBox.innerHTML = '<p class="empty inline">正在载入该角色物品…</p>';
      await loadInventorySnapshotItems(dialog, snapshot.owner);
      return renderInventoryItems(dialog);
    }
    if (snapshotBox) {
      const estimatedCount = currentItems.filter((item) => item.confidence === "estimated").length;
      snapshotBox.innerHTML = `
        <div class="inventory-summary">
          <strong>@${escapeHtml(snapshot.owner)}</strong>
          <span>当前 ${escapeHtml(formatNumber(currentItems.length || snapshot.item_count || 0))} 类</span>
          <span>估算 ${escapeHtml(formatNumber(estimatedCount))} 类</span>
          <span>快照 ${escapeHtml(formatInventoryTime(snapshot.event_time))}</span>
          <span>消息 #${escapeHtml(String(snapshot.msg_id || ""))}</span>
        </div>
      `;
    }
    const sourceItems = currentItems.length ? currentItems : (snapshot.items || []).map((item) => ({
      ...item,
      confidence: "snapshot",
      basis: "snapshot",
    }));
    const items = sourceItems
      .filter((item) => !search || `${item.name} ${item.section} ${item.extra}`.includes(search))
      .sort((a, b) => String(a.section || "").localeCompare(String(b.section || ""), "zh-CN") || String(a.name || "").localeCompare(String(b.name || ""), "zh-CN"));
    if (!itemBox) return;
    if (!items.length) {
      itemBox.innerHTML = '<p class="empty inline">没有匹配物品。</p>';
      setInventoryBatchBarVisible(dialog, false);
      return;
    }
    setInventoryBatchBarVisible(dialog, true);
    itemBox.innerHTML = `
      <table class="inventory-table">
        <thead>
          <tr>
            <th>选</th>
            <th>分组</th>
            <th>物品</th>
            <th>库存</th>
            <th>依据</th>
            <th>转移数量</th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item, index) => `
            <tr>
              <td><input type="checkbox" data-inventory-pick="${index}" data-name="${escapeAttr(item.name)}" data-max="${escapeAttr(String(item.amount || 0))}" /></td>
              <td>${escapeHtml(item.section || "")}</td>
              <td>${escapeHtml(item.name || "")}${item.extra ? ` <small>${escapeHtml(item.extra)}</small>` : ""}</td>
              <td class="num">${escapeHtml(formatNumber(item.amount || 0))}</td>
              <td>${renderInventoryConfidence(item)}</td>
              <td><input class="inventory-qty" data-inventory-qty="${index}" inputmode="numeric" min="1" max="${escapeAttr(String(item.amount || 0))}" value="${escapeAttr(String(Math.min(Number(item.amount || 1), 1)))}" /></td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
    itemBox.querySelectorAll("[data-inventory-qty]").forEach((input) => {
      input.addEventListener("input", () => {
        const idx = input.dataset.inventoryQty;
        const pick = itemBox.querySelector(`[data-inventory-pick="${CSS.escape(idx)}"]`);
        if (pick && String(input.value || "").trim()) pick.checked = true;
        updateInventoryPickCount(dialog);
      });
    });
    itemBox.querySelectorAll("[data-inventory-pick]").forEach((input) => {
      input.addEventListener("change", () => updateInventoryPickCount(dialog));
    });
    updateInventoryPickCount(dialog);
  }

  function currentInventoryItemsForOwner(dialog, owner) {
    const key = String(owner || "").toLowerCase();
    return (dialog._inventoryCurrent || []).filter((item) => String(item.owner || "").toLowerCase() === key);
  }

  function renderInventoryConfidence(item) {
    const confidence = String(item.confidence || "snapshot");
    const label = confidence === "estimated" ? "估算" : "快照";
    const className = confidence === "estimated" ? "status-pill warn" : "status-pill ok";
    return `<span class="${className}">${escapeHtml(label)}</span>`;
  }

  function setInventoryBatchBarVisible(dialog, visible) {
    const bar = dialog.querySelector("#inventoryBatchBar");
    if (!bar) return;
    bar.hidden = !visible;
  }

  function updateInventoryPickCount(dialog) {
    const countEl = dialog.querySelector("#inventoryPickCount");
    const itemBox = dialog.querySelector("#inventoryItems");
    if (!countEl || !itemBox) return;
    const picks = Array.from(itemBox.querySelectorAll("[data-inventory-pick]:checked"));
    const totalQty = picks.reduce((total, pick) => {
      const idx = pick.dataset.inventoryPick;
      const qtyInput = itemBox.querySelector(`[data-inventory-qty="${CSS.escape(idx)}"]`);
      return total + Math.max(0, Number(qtyInput?.value || 0));
    }, 0);
    countEl.textContent = picks.length
      ? `已选 ${formatNumber(picks.length)} 类 / ${formatNumber(totalQty)} 件`
      : "未选择物品";
  }

  function applyInventoryBatchAction(dialog, action) {
    const itemBox = dialog.querySelector("#inventoryItems");
    if (!itemBox) return;
    const picks = Array.from(itemBox.querySelectorAll("[data-inventory-pick]"));
    if (action === "select-visible") {
      picks.forEach((pick) => { pick.checked = true; });
    } else if (action === "clear") {
      picks.forEach((pick) => { pick.checked = false; });
    } else if (action === "qty-max") {
      picks.forEach((pick) => {
        const idx = pick.dataset.inventoryPick;
        const qtyInput = itemBox.querySelector(`[data-inventory-qty="${CSS.escape(idx)}"]`);
        if (qtyInput) qtyInput.value = String(Math.max(1, Number(pick.dataset.max || 1)));
        pick.checked = true;
      });
    } else if (action === "qty-one") {
      picks.forEach((pick) => {
        const idx = pick.dataset.inventoryPick;
        const qtyInput = itemBox.querySelector(`[data-inventory-qty="${CSS.escape(idx)}"]`);
        if (qtyInput) qtyInput.value = "1";
      });
    }
    updateInventoryPickCount(dialog);
  }

  async function loadInventorySnapshotItems(dialog, owner) {
    const cleanOwner = String(owner || "").trim();
    if (!cleanOwner) return null;
    const params = new URLSearchParams({
      latest_only: "1",
      limit: "1",
      owner: cleanOwner,
      include_items: "1",
    });
    const payload = await fetchJson(`/api/inventory?${params.toString()}`);
    const loaded = (payload.snapshots || [])[0] || null;
    if (payload.current) dialog._inventoryCurrent = payload.current;
    if (!loaded) return null;
    dialog._inventorySnapshots = (dialog._inventorySnapshots || []).map((snapshot) => (
      snapshot.owner === cleanOwner
        ? { ...snapshot, ...loaded, items: loaded.items || [], items_loaded: true }
        : snapshot
    ));
    return loaded;
  }

  async function planInventoryTransfer(dialog, deps) {
    const owner = dialog.querySelector("#inventoryOwnerSelect")?.value || "";
    const buyer = (dialog.querySelector("#inventoryBuyer")?.value || "").trim().replace(/^@/, "");
    const baitName = (dialog.querySelector("#inventoryBaitName")?.value || "").trim();
    const baitAmount = Number(dialog.querySelector("#inventoryBaitAmount")?.value || 1);
    const itemBox = dialog.querySelector("#inventoryItems");
    const items = [];
    itemBox?.querySelectorAll("[data-inventory-pick]:checked").forEach((pick) => {
      const idx = pick.dataset.inventoryPick;
      const qtyInput = itemBox.querySelector(`[data-inventory-qty="${CSS.escape(idx)}"]`);
      const amount = Number(qtyInput?.value || 0);
      if (pick.dataset.name && amount > 0) {
        items.push({ name: pick.dataset.name, amount });
      }
    });
    const payload = await postJson("/api/inventory/transfer-plan", {
      provider: owner,
      buyer,
      bait_name: baitName,
      bait_amount: baitAmount,
      items,
    });
    if (!payload.ok) throw new Error(payload.error || "生成失败");
    renderInventoryPlan(dialog, payload, deps);
    setInventoryStatus(dialog, "ok", `已生成 ${payload.commands.length} 条命令。`);
  }

  function renderInventoryPlan(dialog, plan, deps) {
    const box = dialog.querySelector("#inventoryPlanResult");
    if (!box) return;
    box.hidden = false;
    box.innerHTML = `
      <p><strong>转移计划</strong>｜资源号 @${escapeHtml(plan.provider || "未填")} → 购买方 @${escapeHtml(plan.buyer || "")}</p>
      <ul class="send-as-result-list">
        ${(plan.commands || []).map((item, index) => `
          <li class="${item.template ? "warn" : "ok"}">
            <code>${escapeHtml(item.command || "")}</code>
            <small>${escapeHtml(item.note || "")}</small>
            <button type="button" data-inventory-copy="${index}">复制</button>
          </li>
        `).join("")}
      </ul>
      ${(plan.notes || []).length ? `<div class="resource-stats-notes">${plan.notes.map((note) => `<span>${escapeHtml(note)}</span>`).join("")}</div>` : ""}
    `;
    box.querySelectorAll("[data-inventory-copy]").forEach((button) => {
      button.addEventListener("click", async () => {
        const idx = Number(button.dataset.inventoryCopy || 0);
        const command = (plan.commands || [])[idx]?.command || "";
        await deps.copyCommandToClipboard(command, button);
      });
    });
  }

  function setInventoryStatus(dialog, kind, text) {
    const status = dialog.querySelector("#inventoryStatus");
    if (!status) return;
    status.hidden = !text;
    status.className = `modal-status-line ${kind || "info"}`;
    status.textContent = text || "";
  }

  function formatInventoryTime(value) {
    const raw = String(value || "");
    if (!raw) return "未知";
    return raw.replace("T", " ").replace(/\..+$/, "").replace(/\+.+$/, "");
  }

  window.MiniwebViews = window.MiniwebViews || {};
  window.MiniwebViews.inventory = { openInventoryModal };
})();
