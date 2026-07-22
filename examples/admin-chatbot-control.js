/*
  Drop-in control panel for the existing admin website.
  Requires Firebase Web SDK modular `db` instance and authenticated admin.

  Usage:
    import { mountMessengerBotControl } from './admin-chatbot-control.js';
    mountMessengerBotControl({
      db,
      container: document.querySelector('#messengerBotControl'),
      actor: () => auth.currentUser?.email || 'admin_web'
    });
*/
import {
  limitToLast,
  onValue,
  orderByChild,
  push,
  query,
  ref,
  serverTimestamp,
  set,
  update
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatTime(timestamp) {
  const value = Number(timestamp || 0);
  if (!value) return "Chưa có hoạt động";
  return new Intl.DateTimeFormat("vi-VN", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function minuteLabel(value) {
  const minute = Number(value);
  if (!Number.isFinite(minute)) return "";
  const normalized = ((minute % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function shortPsid(psid) {
  const text = String(psid || "");
  return text.length > 10 ? `…${text.slice(-8)}` : text;
}

function normalizeMode(value, fallback = "bot") {
  return value === "human" || value === "bot" ? value : fallback;
}

function mergeRecords(state) {
  const keys = new Set([
    ...Object.keys(state.conversations || {}),
    ...Object.keys(state.leads || {}),
    ...Object.keys(state.controls || {})
  ]);
  const defaultMode = normalizeMode(state.settings?.defaultMode, "bot");
  return [...keys].map(psid => {
    const conversation = state.conversations?.[psid] || {};
    const lead = state.leads?.[psid] || {};
    const control = state.controls?.[psid] || {};
    return {
      psid,
      conversation,
      lead,
      control,
      mode: normalizeMode(control.mode || conversation.controlMode, defaultMode),
      updatedAt: Math.max(
        Number(control.updatedAt || 0),
        Number(conversation.updatedAt || conversation.lastInteractionAt || 0),
        Number(lead.updatedAt || 0)
      )
    };
  }).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function writeMode(db, psid, mode, actor) {
  const now = Date.now();
  const payload = {
    mode,
    updatedAt: now,
    updatedBy: actor || "admin_web",
    actorName: actor || "Admin",
    reason: "manual_admin_toggle",
    source: "admin_web",
    allowCustomerResume: false
  };
  const updates = {
    [`messengerBot/controls/${psid}`]: payload,
    [`messengerBot/conversations/${psid}/controlMode`]: mode,
    [`messengerBot/conversations/${psid}/controlUpdatedAt`]: now,
    [`messengerBot/leads/${psid}/controlMode`]: mode,
    [`messengerBot/leads/${psid}/controlUpdatedAt`]: now
  };
  if (mode === "bot") {
    updates[`messengerBot/conversations/${psid}/state`] = "new";
    updates[`messengerBot/conversations/${psid}/handoffRequested`] = false;
  }
  await update(ref(db), updates);
  await set(push(ref(db, `messengerBot/controlAudit/${psid}`)), {
    ...payload,
    createdAt: serverTimestamp()
  });
}

function notificationBody(alert = {}) {
  const parts = [alert.message || "Khách Messenger cần hỗ trợ"];
  if (alert.context?.selectedHomeName || alert.context?.selectedHomeId) {
    parts.push(alert.context.selectedHomeName || alert.context.selectedHomeId);
  }
  if (alert.context?.phone) parts.push(alert.context.phone);
  return parts.filter(Boolean).join(" · ").slice(0, 240);
}

export function mountMessengerBotControl({ db, container, actor = () => "admin_web" }) {
  if (!db) throw new Error("Thiếu Firebase Realtime Database instance `db`");
  const root = typeof container === "string" ? document.querySelector(container) : container;
  if (!root) throw new Error("Không tìm thấy container cho Messenger Bot Control");

  root.classList.add("mbc-root");
  root.innerHTML = `
    <div class="mbc-toolbar">
      <div>
        <div class="mbc-eyebrow">MESSENGER CONTROL</div>
        <h2>Bot hay nhân viên tư vấn?</h2>
        <p>Chọn riêng cho từng khách. Khi nhân viên nhắn từ Meta Inbox, bot có thể tự tạm dừng.</p>
      </div>
      <button type="button" class="mbc-notify-btn">Bật thông báo trình duyệt</button>
    </div>
    <div class="mbc-urgent-wrap" hidden>
      <div class="mbc-urgent-head">
        <div><strong>Cảnh báo cần xử lý</strong><small>Lead gấp được ghi trực tiếp từ chatbot.</small></div>
      </div>
      <div class="mbc-urgent-list"></div>
    </div>
    <div class="mbc-settings">
      <label class="mbc-switch-row">
        <span>
          <strong>Tự ngưng bot khi nhân viên nhắn</strong>
          <small>Cần đăng ký webhook <code>message_echoes</code>.</small>
        </span>
        <input type="checkbox" class="mbc-auto-pause" checked>
      </label>
    </div>
    <div class="mbc-summary" aria-live="polite"></div>
    <div class="mbc-list"><div class="mbc-empty">Đang đọc hội thoại…</div></div>
  `;

  const listEl = root.querySelector(".mbc-list");
  const summaryEl = root.querySelector(".mbc-summary");
  const autoPauseEl = root.querySelector(".mbc-auto-pause");
  const notifyBtn = root.querySelector(".mbc-notify-btn");
  const urgentWrap = root.querySelector(".mbc-urgent-wrap");
  const urgentList = root.querySelector(".mbc-urgent-list");

  const state = { conversations: {}, leads: {}, controls: {}, settings: {}, alerts: {} };
  let alertInitialized = false;
  const initialAlertIds = new Set();

  function render() {
    const records = mergeRecords(state).slice(0, 100);
    const botCount = records.filter(item => item.mode === "bot").length;
    const humanCount = records.filter(item => item.mode === "human").length;
    summaryEl.innerHTML = `
      <span><b>${records.length}</b> hội thoại</span>
      <span class="is-bot"><b>${botCount}</b> bot đang trực</span>
      <span class="is-human"><b>${humanCount}</b> nhân viên tiếp quản</span>
    `;

    autoPauseEl.checked = state.settings?.autoPauseOnHumanReply !== false;

    const urgentAlerts = Object.entries(state.alerts || {})
      .filter(([, alert]) => alert?.status === "unread" && alert?.priority === "high")
      .sort((a, b) => Number(b[1]?.createdAt || 0) - Number(a[1]?.createdAt || 0))
      .slice(0, 6);
    urgentWrap.hidden = urgentAlerts.length === 0;
    urgentList.innerHTML = urgentAlerts.map(([id, alert]) => `
      <article class="mbc-urgent-item" data-alert-id="${esc(id)}">
        <div>
          <strong>${esc(alert.title || "Khách cần xử lý gấp")}</strong>
          <p>${esc(notificationBody(alert))}</p>
          <small>${esc(formatTime(alert.createdAt))}</small>
        </div>
        <button type="button" data-alert-done="${esc(id)}">Đã xử lý</button>
      </article>
    `).join("");

    if (!records.length) {
      listEl.innerHTML = '<div class="mbc-empty">Chưa có hội thoại Messenger.</div>';
      return;
    }

    listEl.innerHTML = records.map(item => {
      const { psid, conversation, lead, control, mode } = item;
      const context = conversation.context || {};
      const phone = lead.phone || context.phone || "";
      const home = lead.selectedHomeName || context.selectedHome?.displayName || lead.selectedHomeId || context.preferredHomeId || "";
      const dateKey = lead.dateKey || context.dateKey || "";
      const start = lead.startMinute ?? context.startMinute;
      const checkout = lead.checkoutMinute ?? context.checkoutMinute;
      const duration = lead.durationHours || context.durationHours || "";
      const detail = [
        home,
        dateKey,
        Number.isFinite(Number(start)) ? `vào ${minuteLabel(start)}` : "",
        Number.isFinite(Number(checkout)) ? `trả ${minuteLabel(checkout)}${Number(checkout) >= 1440 ? " hôm sau" : ""}` : "",
        duration ? `${duration}H` : ""
      ].filter(Boolean).join(" · ");
      const statusText = mode === "human" ? "Nhân viên đang tư vấn" : "Bot đang tự động";
      const reason = control.reason === "human_reply_detected"
        ? "Tự ngưng sau khi Page trả lời"
        : control.reason === "manual_admin_toggle"
          ? "Nhân viên chọn thủ công"
          : "";
      return `
        <article class="mbc-card ${mode === "human" ? "is-human" : "is-bot"}" data-psid="${esc(psid)}">
          <div class="mbc-card-main">
            <div class="mbc-card-title-row">
              <div>
                <h3>${phone ? esc(phone) : "Khách Messenger"}</h3>
                <span class="mbc-id">ID ${esc(shortPsid(psid))}</span>
              </div>
              <span class="mbc-status">${esc(statusText)}</span>
            </div>
            <p class="mbc-detail">${detail ? esc(detail) : "Chưa đủ thông tin ngày, giờ hoặc HOME"}</p>
            <div class="mbc-meta">
              <span>${esc(formatTime(item.updatedAt))}</span>
              ${reason ? `<span>${esc(reason)}</span>` : ""}
            </div>
          </div>
          <div class="mbc-segment" role="group" aria-label="Chế độ hội thoại">
            <button type="button" data-mode="bot" class="${mode === "bot" ? "active" : ""}">🤖 Bật bot</button>
            <button type="button" data-mode="human" class="${mode === "human" ? "active" : ""}">👤 Tự tư vấn</button>
          </div>
        </article>
      `;
    }).join("");
  }

  const unsubscribers = [];
  const bind = (path, key, useQuery = false) => {
    const target = useQuery
      ? query(ref(db, path), orderByChild("updatedAt"), limitToLast(100))
      : ref(db, path);
    unsubscribers.push(onValue(target, snapshot => {
      state[key] = snapshot.val() || {};
      render();
    }));
  };

  bind("messengerBot/conversations", "conversations", true);
  bind("messengerBot/leads", "leads", true);
  bind("messengerBot/controls", "controls");
  bind("messengerBot/settings", "settings");

  listEl.addEventListener("click", async event => {
    const button = event.target.closest("button[data-mode]");
    if (!button) return;
    const card = button.closest("[data-psid]");
    const psid = card?.dataset.psid;
    const mode = button.dataset.mode;
    if (!psid || !["bot", "human"].includes(mode)) return;
    card.classList.add("is-saving");
    try {
      await writeMode(db, psid, mode, typeof actor === "function" ? actor() : actor);
    } catch (error) {
      console.error("Không đổi được chế độ chatbot", error);
      alert(`Không đổi được chế độ: ${error.message || error}`);
    } finally {
      card.classList.remove("is-saving");
    }
  });

  autoPauseEl.addEventListener("change", async () => {
    autoPauseEl.disabled = true;
    try {
      await update(ref(db, "messengerBot/settings"), {
        autoPauseOnHumanReply: autoPauseEl.checked,
        updatedAt: serverTimestamp(),
        updatedBy: typeof actor === "function" ? actor() : actor
      });
    } catch (error) {
      autoPauseEl.checked = !autoPauseEl.checked;
      alert(`Không lưu được thiết lập: ${error.message || error}`);
    } finally {
      autoPauseEl.disabled = false;
    }
  });

  urgentList.addEventListener("click", async event => {
    const button = event.target.closest("button[data-alert-done]");
    if (!button) return;
    const alertId = button.dataset.alertDone;
    button.disabled = true;
    try {
      await update(ref(db, `messengerBot/alerts/${alertId}`), {
        status: "read",
        handledAt: serverTimestamp(),
        handledBy: typeof actor === "function" ? actor() : actor
      });
    } catch (error) {
      button.disabled = false;
      alert(`Không cập nhật được cảnh báo: ${error.message || error}`);
    }
  });

  notifyBtn.addEventListener("click", async () => {
    if (!("Notification" in window)) {
      alert("Trình duyệt này không hỗ trợ thông báo.");
      return;
    }
    const permission = await Notification.requestPermission();
    notifyBtn.textContent = permission === "granted"
      ? "Đã bật thông báo"
      : "Thông báo đang bị chặn";
  });

  const alertsQuery = query(ref(db, "messengerBot/alerts"), orderByChild("createdAt"), limitToLast(30));
  unsubscribers.push(onValue(alertsQuery, snapshot => {
    const alerts = snapshot.val() || {};
    state.alerts = alerts;
    render();
    if (!alertInitialized) {
      Object.keys(alerts).forEach(id => initialAlertIds.add(id));
      alertInitialized = true;
      return;
    }
    for (const [id, alertData] of Object.entries(alerts)) {
      if (initialAlertIds.has(id)) continue;
      initialAlertIds.add(id);
      if (Notification.permission === "granted" && alertData?.status === "unread") {
        new Notification(alertData.title || "Khách Messenger cần hỗ trợ", {
          body: notificationBody(alertData),
          tag: `messenger-alert-${id}`
        });
      }
    }
  }));

  return () => unsubscribers.forEach(unsubscribe => unsubscribe?.());
}
