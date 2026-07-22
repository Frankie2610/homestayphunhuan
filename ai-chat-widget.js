(function () {
  "use strict";

  const root = document.getElementById("webChatWidget");
  if (!root) return;

  const apiUrl = root.dataset.api || "/api/web-chat";
  const launcher = root.querySelector("[data-chat-launcher]");
  const panel = root.querySelector("[data-chat-panel]");
  const closeButton = root.querySelector("[data-chat-close]");
  const messagesEl = root.querySelector("[data-chat-messages]");
  const form = root.querySelector("[data-chat-form]");
  const input = root.querySelector("[data-chat-input]");
  const sendButton = root.querySelector("[data-chat-send]");
  const liveRegion = root.querySelector("[data-chat-live]");
  const badge = root.querySelector("[data-chat-badge]");
  const configuredTimeoutMs = Number(root.dataset.timeoutMs || 25_000);
  const requestTimeoutMs = Math.min(120_000, Math.max(15_000, configuredTimeoutMs));
  const sessionKey = "h3cn_web_chat_session_v1";
  const historyKey = "h3cn_web_chat_history_v1";
  const maxHistory = 36;
  let busy = false;
  let typingEl = null;

  function storageGet(storage, key) {
    try { return storage.getItem(key); } catch { return null; }
  }

  function storageSet(storage, key, value) {
    try { storage.setItem(key, value); } catch { /* Storage may be blocked. */ }
  }

  function createSessionId() {
    if (window.crypto?.randomUUID) {
      return window.crypto.randomUUID().replaceAll("-", "");
    }
    const bytes = new Uint8Array(24);
    window.crypto?.getRandomValues?.(bytes);
    const random = Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    return random || `${Date.now()}_${Math.random().toString(36).slice(2, 18)}`;
  }

  function getSessionId() {
    const stored = storageGet(localStorage, sessionKey);
    if (/^[a-zA-Z0-9_-]{16,96}$/.test(stored || "")) return stored;
    const created = createSessionId();
    storageSet(localStorage, sessionKey, created);
    return created;
  }

  const sessionId = getSessionId();

  function timeLabel(timestamp = Date.now()) {
    try {
      return new Intl.DateTimeFormat("vi-VN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false
      }).format(new Date(timestamp));
    } catch {
      return "";
    }
  }

  function scrollToLatest() {
    requestAnimationFrame(() => {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    });
  }

  function saveHistory() {
    const records = Array.from(messagesEl.querySelectorAll("[data-history-record]"))
      .slice(-maxHistory)
      .map(node => {
        try { return JSON.parse(node.dataset.historyRecord); } catch { return null; }
      })
      .filter(Boolean);
    storageSet(sessionStorage, historyKey, JSON.stringify(records));
  }

  function setRecord(node, record) {
    node.dataset.historyRecord = JSON.stringify({
      ...record,
      at: Number(record.at || Date.now())
    });
  }

  function makeBubble(text, side, at) {
    const row = document.createElement("div");
    row.className = `web-chat-message ${side === "user" ? "is-user" : "is-bot"}`;

    const bubble = document.createElement("div");
    bubble.className = "web-chat-bubble";
    bubble.textContent = String(text || "");

    const time = document.createElement("span");
    time.className = "web-chat-time";
    time.textContent = timeLabel(at);
    bubble.appendChild(time);
    row.appendChild(bubble);
    return row;
  }

  function quickReplyButton(item) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = String(item?.title || "Chọn");
    button.dataset.payload = String(item?.payload || item?.title || "");
    button.addEventListener("click", () => {
      if (busy) return;
      sendMessage({
        message: button.textContent,
        payload: button.dataset.payload,
        showUser: true
      });
    });
    return button;
  }

  function appendTextMessage(message, options = {}) {
    const side = options.side === "user" ? "user" : "bot";
    const at = Number(options.at || Date.now());
    const row = makeBubble(message.text || "", side, at);
    setRecord(row, {
      kind: "text",
      side,
      text: String(message.text || ""),
      quickReplies: Array.isArray(message.quickReplies) ? message.quickReplies : [],
      at
    });
    messagesEl.appendChild(row);

    if (side === "bot" && Array.isArray(message.quickReplies) && message.quickReplies.length) {
      const actions = document.createElement("div");
      actions.className = "web-chat-quick-replies";
      message.quickReplies.forEach(item => actions.appendChild(quickReplyButton(item)));
      messagesEl.appendChild(actions);
    }

    if (!options.restoring) saveHistory();
    scrollToLatest();
  }

  function appendImages(message, options = {}) {
    const urls = Array.isArray(message.imageUrls)
      ? message.imageUrls.filter(url => /^https:\/\//i.test(String(url || ""))).slice(0, 4)
      : [];
    if (!urls.length) return;

    const grid = document.createElement("div");
    grid.className = "web-chat-images";
    urls.forEach((url, index) => {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener";
      link.setAttribute("aria-label", `Mở ảnh phòng ${index + 1}`);
      const image = document.createElement("img");
      image.src = url;
      image.alt = `Ảnh phòng ${index + 1}`;
      image.loading = "lazy";
      link.appendChild(image);
      grid.appendChild(link);
    });
    setRecord(grid, { kind: "images", imageUrls: urls, at: Number(options.at || Date.now()) });
    messagesEl.appendChild(grid);
    if (!options.restoring) saveHistory();
    scrollToLatest();
  }

  function appendTemplate(message, options = {}) {
    const at = Number(options.at || Date.now());
    appendTextMessage({ text: message.text || "" }, { side: "bot", at, restoring: true });

    const actions = document.createElement("div");
    actions.className = "web-chat-template-actions";
    (Array.isArray(message.buttons) ? message.buttons : []).forEach(item => {
      if (item.type === "web_url" && /^https?:\/\//i.test(String(item.url || ""))) {
        const link = document.createElement("a");
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noopener";
        link.textContent = item.title || "Mở liên kết";
        actions.appendChild(link);
      } else if (item.type === "postback") {
        actions.appendChild(quickReplyButton(item));
      }
    });
    if (actions.childElementCount) messagesEl.appendChild(actions);

    const lastRecord = Array.from(messagesEl.querySelectorAll("[data-history-record]")).at(-1);
    if (lastRecord) {
      setRecord(lastRecord, {
        kind: "template",
        text: String(message.text || ""),
        buttons: Array.isArray(message.buttons) ? message.buttons : [],
        at
      });
    }
    if (!options.restoring) saveHistory();
    scrollToLatest();
  }

  function appendServerMessage(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "images") {
      appendImages(message);
      return;
    }
    if (message.type === "template") {
      appendTemplate(message);
      return;
    }
    appendTextMessage(message, { side: "bot" });
  }

  function restoreHistory() {
    let records = [];
    try { records = JSON.parse(storageGet(sessionStorage, historyKey) || "[]"); } catch { records = []; }
    if (!Array.isArray(records) || !records.length) return false;

    records.slice(-maxHistory).forEach(record => {
      if (record.kind === "images") {
        appendImages(record, { restoring: true, at: record.at });
      } else if (record.kind === "template") {
        appendTemplate(record, { restoring: true, at: record.at });
      } else {
        appendTextMessage(record, {
          side: record.side,
          at: record.at,
          restoring: true
        });
      }
    });
    return true;
  }

  function showWelcome() {
    appendTextMessage({
      text: "Chào bạn 🌿 Mình là trợ lý Homestay Phú Nhuận. Mình có thể kiểm tra lịch trống, giá combo và tiện nghi trực tiếp từ hệ thống.",
      quickReplies: [
        { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
        { title: "Giá & combo", payload: "FAQ|PRICE" },
        { title: "Xem hình phòng", payload: "OPEN|GALLERY" },
        { title: "Gặp nhân viên", payload: "HUMAN|REQUEST" }
      ]
    }, { side: "bot" });
  }

  function setOpen(open) {
    root.classList.toggle("is-open", Boolean(open));
    launcher.setAttribute("aria-expanded", String(Boolean(open)));
    panel.setAttribute("aria-hidden", String(!open));
    if (open) {
      badge.classList.remove("is-unread");
      window.setTimeout(() => input.focus({ preventScroll: true }), 220);
      scrollToLatest();
    }
  }

  function setBusy(next) {
    busy = Boolean(next);
    input.disabled = busy;
    sendButton.disabled = busy || !input.value.trim();
    root.querySelectorAll(".web-chat-quick-replies button, .web-chat-template-actions button")
      .forEach(button => { button.disabled = busy; });
  }

  function showTyping() {
    if (typingEl) return;
    typingEl = document.createElement("div");
    typingEl.className = "web-chat-message is-bot";
    typingEl.setAttribute("aria-label", "HOME đang trả lời");
    typingEl.innerHTML = `
      <div class="web-chat-typing">
        <span></span><span></span><span></span>
        <small class="web-chat-typing-label">Đang kiểm tra dữ liệu...</small>
      </div>
    `;
    messagesEl.appendChild(typingEl);
    scrollToLatest();
  }

  function hideTyping() {
    typingEl?.remove();
    typingEl = null;
  }

  async function consumeChatStream(response, onMessage) {
    if (!response.body?.getReader) throw new Error("Trình duyệt không hỗ trợ nhận phản hồi trực tiếp.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let deliveredMessages = 0;
    let doneEvent = null;

    const consumeBlock = block => {
      const data = block
        .split("\n")
        .filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart())
        .join("\n");
      if (!data) return;

      const event = JSON.parse(data);
      if (event.type === "message" && event.message) {
        deliveredMessages += 1;
        onMessage(event.message);
      } else if (event.type === "done") {
        doneEvent = event;
      } else if (event.type === "error") {
        const error = new Error(event.message || "Luồng chatbot bị gián đoạn.");
        error.code = event.code || "chat_stream_error";
        throw error;
      }
    };

    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
      const blocks = buffer.split(/\r?\n\r?\n/);
      buffer = blocks.pop() || "";
      blocks.forEach(consumeBlock);
      if (done) break;
    }
    if (buffer.trim()) consumeBlock(buffer);

    return { deliveredMessages, doneEvent };
  }

  async function sendMessage({ message, payload = "", showUser = true }) {
    const cleanMessage = String(message || "").trim().slice(0, 800);
    if (busy || (!cleanMessage && !payload)) return;

    if (showUser) appendTextMessage({ text: cleanMessage }, { side: "user" });
    input.value = "";
    input.style.height = "auto";
    setBusy(true);
    showTyping();

    const controller = new AbortController();
    const startedAt = Date.now();
    let deliveredMessages = 0;
    const slowHintTimeout = window.setTimeout(() => {
      typingEl?.classList.add("is-slow");
      liveRegion.textContent = "HOME vẫn đang kiểm tra dữ liệu.";
    }, 10_000);
    const timeout = window.setTimeout(() => {
      const reason = typeof DOMException === "function"
        ? new DOMException("chat_request_timeout", "TimeoutError")
        : Object.assign(new Error("chat_request_timeout"), { name: "TimeoutError" });
      controller.abort(reason);
    }, requestTimeoutMs);

    try {
      const response = await fetch(apiUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "text/event-stream, application/json"
        },
        credentials: "same-origin",
        body: JSON.stringify({
          sessionId,
          message: cleanMessage,
          payload
        }),
        signal: controller.signal
      });

      const contentType = response.headers.get("content-type") || "";
      if (response.ok && contentType.includes("text/event-stream")) {
        const result = await consumeChatStream(response, serverMessage => {
          deliveredMessages += 1;
          hideTyping();
          appendServerMessage(serverMessage);
          liveRegion.textContent = "HOME vừa gửi câu trả lời.";
        });
        deliveredMessages = Math.max(deliveredMessages, result.deliveredMessages);
      } else {
        const data = await response.json().catch(() => ({}));
        if (!response.ok || data.ok !== true) {
          const error = new Error(data.message || "Không thể kết nối chatbot lúc này.");
          error.status = response.status;
          throw error;
        }

        const replies = Array.isArray(data.messages) ? data.messages : [];
        replies.forEach(reply => {
          deliveredMessages += 1;
          hideTyping();
          appendServerMessage(reply);
        });
      }

      hideTyping();
      if (!deliveredMessages) {
        appendTextMessage({ text: "Mình chưa nhận được câu trả lời. Bạn thử diễn đạt lại giúp mình nhé." }, { side: "bot" });
      }

      if (!root.classList.contains("is-open")) badge.classList.add("is-unread");
      liveRegion.textContent = "HOME đã trả lời tin nhắn.";
    } catch (error) {
      hideTyping();
      const timedOut = controller.signal.aborted
        || error?.name === "AbortError"
        || error?.name === "TimeoutError";
      if (!deliveredMessages) {
        appendTextMessage({
          text: timedOut
            ? "Hệ thống phản hồi quá thời gian chờ. Bạn thử gửi lại sau ít giây nhé."
            : (error?.message || "Chatbot đang kết nối lại. Bạn thử gửi lại hoặc nhắn Zalo giúp mình nhé.")
        }, { side: "bot" });
        liveRegion.textContent = "Không gửi được tin nhắn. Vui lòng thử lại.";
      }
      console.error("Website AI chatbot request failed", {
        status: error?.status || 0,
        code: timedOut ? "chat_request_timeout" : "chat_request_failed",
        elapsedMs: Date.now() - startedAt,
        message: timedOut ? "Request exceeded client timeout" : (error?.message || String(error))
      });
    } finally {
      window.clearTimeout(timeout);
      window.clearTimeout(slowHintTimeout);
      hideTyping();
      setBusy(false);
      input.focus({ preventScroll: true });
    }
  }

  launcher.addEventListener("click", () => setOpen(true));
  closeButton.addEventListener("click", () => setOpen(false));

  form.addEventListener("submit", event => {
    event.preventDefault();
    sendMessage({ message: input.value, showUser: true });
  });

  input.addEventListener("input", () => {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 104)}px`;
    sendButton.disabled = busy || !input.value.trim();
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });

  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && root.classList.contains("is-open")) setOpen(false);
  });

  panel.addEventListener("click", event => event.stopPropagation());

  if (!restoreHistory()) showWelcome();
  sendButton.disabled = true;
  panel.setAttribute("aria-hidden", "true");
})();
