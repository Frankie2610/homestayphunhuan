(() => {
  "use strict";

  function resolveApiUrl() {
    const configured = String(
      globalThis.HOMESTAY_AI_CHAT_CONFIG?.apiUrl
      || globalThis.H3CN_AI_CHAT_CONFIG?.apiUrl
      || ""
    ).trim();
    return configured || "/api/web-chat";
  }

  const API_URL = resolveApiUrl();
  const SESSION_KEY = "h3cn_ai_chat_session_v1";
  const HISTORY_KEY = "h3cn_ai_chat_history_v1";
  const MAX_HISTORY = 60;

  const state = {
    busy: false,
    initialized: false,
    sessionId: "",
    messages: []
  };

  const elements = {};

  function randomId(prefix = "msg") {
    const uuid = globalThis.crypto?.randomUUID?.()
      || `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    return `${prefix}_${uuid}`;
  }

  function getSessionId() {
    let value = "";
    try {
      value = String(localStorage.getItem(SESSION_KEY) || "");
    } catch {
      value = "";
    }

    value = value.replace(/^web_+/i, "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
    if (value.length < 8) {
      value = randomId("session").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 96);
      try {
        localStorage.setItem(SESSION_KEY, value);
      } catch {
        // LocalStorage có thể bị chặn trong chế độ riêng tư.
      }
    }
    return value;
  }

  function formatTime(value = Date.now()) {
    const date = new Date(Number(value) || Date.now());
    return date.toLocaleTimeString("vi-VN", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    });
  }

  function safeUrl(value) {
    try {
      const url = new URL(String(value || ""), window.location.origin);
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.href;
    } catch {
      return "";
    }
  }

  function textWithLinks(container, value) {
    const text = String(value || "");
    const urlPattern = /(https?:\/\/[^\s<]+)/gi;
    let cursor = 0;
    let match;

    while ((match = urlPattern.exec(text)) !== null) {
      const before = text.slice(cursor, match.index);
      if (before) container.append(document.createTextNode(before));

      const href = safeUrl(match[0]);
      if (href) {
        const link = document.createElement("a");
        link.href = href;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = match[0];
        container.append(link);
      } else {
        container.append(document.createTextNode(match[0]));
      }
      cursor = match.index + match[0].length;
    }

    const tail = text.slice(cursor);
    if (tail) container.append(document.createTextNode(tail));
  }

  function createBotAvatar() {
    const avatar = document.createElement("span");
    avatar.className = "ai-chat-mini-avatar";
    avatar.setAttribute("aria-hidden", "true");
    avatar.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none">
        <path d="M7.2 7.4h9.6A3.2 3.2 0 0 1 20 10.6v4.2a3.2 3.2 0 0 1-3.2 3.2H12l-3.9 2.1.7-2.1H7.2A3.2 3.2 0 0 1 4 14.8v-4.2a3.2 3.2 0 0 1 3.2-3.2Z" fill="currentColor"/>
        <circle cx="9" cy="12.5" r="1" fill="white"/>
        <circle cx="15" cy="12.5" r="1" fill="white"/>
      </svg>`;
    return avatar;
  }

  function createMessageRow(role, createdAt) {
    const row = document.createElement("div");
    row.className = `ai-chat-row ${role === "user" ? "is-user" : "is-bot"}`;
    row.dataset.role = role;

    if (role !== "user") row.append(createBotAvatar());

    const stack = document.createElement("div");
    stack.className = "ai-chat-message-stack";
    const time = document.createElement("span");
    time.className = "ai-chat-time";
    time.textContent = formatTime(createdAt);
    stack.append(time);
    row.append(stack);

    return { row, stack, time };
  }

  function buildReplyButtons(items = []) {
    const replies = Array.isArray(items) ? items.filter(Boolean).slice(0, 13) : [];
    if (!replies.length) return null;

    const wrap = document.createElement("div");
    wrap.className = "ai-chat-quick-replies";

    replies.forEach(reply => {
      const title = String(reply.title || "").trim();
      if (!title) return;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ai-chat-chip";
      button.textContent = title;
      button.addEventListener("click", () => {
        sendMessage(title, String(reply.payload || title));
      });
      wrap.append(button);
    });

    return wrap.childElementCount ? wrap : null;
  }

  function renderTextMessage(message, persist = true) {
    const role = message.role === "user" ? "user" : "bot";
    const { row, stack, time } = createMessageRow(role, message.createdAt);
    const bubble = document.createElement("div");
    bubble.className = "ai-chat-bubble";
    bubble.style.whiteSpace = "pre-wrap";
    textWithLinks(bubble, message.text);
    stack.insertBefore(bubble, time);

    if (role !== "user") {
      const replies = buildReplyButtons(message.quickReplies);
      if (replies) stack.insertBefore(replies, time);
    }

    elements.messages.append(row);
    if (persist) rememberMessage(message);
  }

  function renderImages(message, persist = true) {
    const urls = (Array.isArray(message.imageUrls) ? message.imageUrls : [])
      .map(safeUrl)
      .filter(Boolean)
      .slice(0, 4);
    if (!urls.length) return;

    const { row, stack, time } = createMessageRow("bot", message.createdAt);
    const grid = document.createElement("div");
    grid.className = `ai-chat-image-grid${urls.length === 1 ? " is-single" : ""}`;

    urls.forEach((url, index) => {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.setAttribute("aria-label", `Mở ảnh phòng ${index + 1}`);

      const image = document.createElement("img");
      image.src = url;
      image.alt = `Hình phòng ${index + 1}`;
      image.loading = "lazy";
      image.decoding = "async";
      link.append(image);
      grid.append(link);
    });

    stack.insertBefore(grid, time);
    elements.messages.append(row);
    if (persist) rememberMessage({ ...message, imageUrls: urls });
  }

  function renderTemplate(message, persist = true) {
    const { row, stack, time } = createMessageRow("bot", message.createdAt);
    const bubble = document.createElement("div");
    bubble.className = "ai-chat-bubble";
    bubble.style.whiteSpace = "pre-wrap";
    textWithLinks(bubble, message.text);
    stack.insertBefore(bubble, time);

    const actions = document.createElement("div");
    actions.className = "ai-chat-template-actions";

    (Array.isArray(message.buttons) ? message.buttons : []).slice(0, 3).forEach(item => {
      const title = String(item.title || "").trim();
      if (!title) return;

      if (item.type === "web_url") {
        const url = safeUrl(item.url);
        if (!url) return;
        const link = document.createElement("a");
        link.className = "ai-chat-action";
        link.href = url;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = `${title} ↗`;
        actions.append(link);
        return;
      }

      const button = document.createElement("button");
      button.type = "button";
      button.className = "ai-chat-action";
      button.textContent = title;
      button.addEventListener("click", () => sendMessage(title, String(item.payload || title)));
      actions.append(button);
    });

    if (actions.childElementCount) stack.insertBefore(actions, time);
    elements.messages.append(row);
    if (persist) rememberMessage(message);
  }

  function renderMessage(message, persist = true) {
    if (!message || typeof message !== "object") return;
    if (message.type === "images") {
      renderImages(message, persist);
    } else if (message.type === "button_template") {
      renderTemplate(message, persist);
    } else {
      renderTextMessage(message, persist);
    }
    scrollToBottom();
  }

  function rememberMessage(message) {
    const normalized = {
      id: String(message.id || randomId("local")),
      role: message.role === "user" ? "user" : "bot",
      type: ["images", "button_template"].includes(message.type) ? message.type : "text",
      text: String(message.text || "").slice(0, 4000),
      quickReplies: Array.isArray(message.quickReplies) ? message.quickReplies.slice(0, 13) : [],
      imageUrls: Array.isArray(message.imageUrls) ? message.imageUrls.slice(0, 4) : [],
      buttons: Array.isArray(message.buttons) ? message.buttons.slice(0, 3) : [],
      createdAt: Number(message.createdAt || Date.now())
    };

    state.messages.push(normalized);
    state.messages = state.messages.slice(-MAX_HISTORY);
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(state.messages));
    } catch {
      // Bỏ qua nếu trình duyệt chặn lưu trữ.
    }
  }

  function restoreHistory() {
    let history = [];
    try {
      const value = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]");
      if (Array.isArray(value)) history = value.slice(-MAX_HISTORY);
    } catch {
      history = [];
    }

    state.messages = [];
    if (!history.length) {
      renderMessage({
        id: "welcome",
        role: "bot",
        type: "text",
        text: "Xin chào 👋 Mình là AI tư vấn của Homestay Quận Phú Nhuận. Bạn có thể hỏi lịch trống, giá combo, tiện ích hoặc chọn HOME phù hợp.",
        quickReplies: [
          { title: "Kiểm tra lịch", payload: "START|AVAILABILITY" },
          { title: "Giá & combo", payload: "FAQ|PRICE" },
          { title: "Xem hình phòng", payload: "OPEN|GALLERY" }
        ],
        createdAt: Date.now()
      });
      return;
    }

    history.forEach(item => renderMessage(item, false));
    state.messages = history;
  }

  function setBusy(busy) {
    state.busy = Boolean(busy);
    elements.send.disabled = state.busy;
    elements.input.disabled = state.busy;
    elements.typing.classList.toggle("is-visible", state.busy);
    elements.panel.setAttribute("aria-busy", String(state.busy));

    elements.panel.querySelectorAll(".ai-chat-chip, .ai-chat-action, .ai-chat-suggestion")
      .forEach(button => {
        button.disabled = state.busy;
      });

    scrollToBottom();
  }

  function scrollToBottom() {
    requestAnimationFrame(() => {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    });
  }

  function resizeInput() {
    elements.input.style.height = "auto";
    elements.input.style.height = `${Math.min(elements.input.scrollHeight, 104)}px`;
  }

  async function sendMessage(rawMessage, rawPayload = "") {
    const message = String(rawMessage || "").trim().slice(0, 1200);
    const payload = String(rawPayload || "").trim().slice(0, 1000);
    if ((!message && !payload) || state.busy) return;

    const displayText = message || "Đã chọn một tùy chọn";
    renderMessage({
      id: randomId("user"),
      role: "user",
      type: "text",
      text: displayText,
      createdAt: Date.now()
    });

    elements.input.value = "";
    resizeInput();
    setBusy(true);

    const controller = new AbortController();
    const requestTimeoutMs = Number(window.AI_CHAT_REQUEST_TIMEOUT_MS || 28_000);
    const timeout = window.setTimeout(() => {
      try {
        controller.abort(new DOMException("web_chat_timeout", "TimeoutError"));
      } catch {
        controller.abort();
      }
    }, requestTimeoutMs);

    try {
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: state.sessionId,
          clientMessageId: randomId("client"),
          message,
          payload,
          pageUrl: window.location.href
        }),
        signal: controller.signal
      });

      const responseType = String(response.headers.get("content-type") || "");
      const data = responseType.includes("application/json")
        ? await response.json().catch(() => ({}))
        : {};
      if (!response.ok || data?.ok !== true) {
        const error = new Error(data?.message || data?.error || `HTTP_${response.status}`);
        error.status = response.status;
        error.code = data?.error || "";
        throw error;
      }

      const replies = Array.isArray(data.messages) ? data.messages : [];
      replies.forEach(item => renderMessage({ ...item, role: "bot" }));
    } catch (error) {
      const timedOut = controller.signal.aborted
        || error?.name === "AbortError"
        || error?.name === "TimeoutError"
        || Number(error?.code || 0) === 20
        || /aborted|timeout/i.test(String(error?.message || ""));
      console.error("Website AI chatbot request failed", {
        apiUrl: API_URL,
        status: Number(error?.status || 0),
        code: String(error?.code || ""),
        message: String(error?.message || error || "unknown_error")
      });
      const localHost = ["localhost", "127.0.0.1"].includes(String(location.hostname || "").toLowerCase());
      const configurationMissing = String(error?.code || "") === "server_configuration_missing";

      renderMessage({
        id: randomId("error"),
        role: "bot",
        type: "button_template",
        text: timedOut
          ? "Backend đang chờ dữ liệu quá lâu. Kiểm tra terminal: bản mới sẽ báo rõ Firebase đọc chậm hay Gemini chậm, thay vì treo vô thời hạn."
          : configurationMissing && localHost
            ? "Chatbot local chưa có cấu hình Firebase. Hãy sao chép file `.env.local` từ dự án chatbot gốc sang bản clone rồi chạy lại `npm.cmd run dev`."
            : "Chatbot đang kết nối lại. Bạn có thể thử gửi lại hoặc nhắn trực tiếp cho bên mình.",
        buttons: [
          {
            type: "web_url",
            title: "Nhắn Messenger",
            url: "https://facebook.com"
          },
          {
            type: "web_url",
            title: "Nhắn Zalo",
            url: "https://zalo.me/0933882896"
          }
        ],
        createdAt: Date.now()
      });
    } finally {
      window.clearTimeout(timeout);
      setBusy(false);
      elements.input.focus({ preventScroll: true });
    }
  }

  function bindEvents() {
    elements.form.addEventListener("submit", event => {
      event.preventDefault();
      sendMessage(elements.input.value);
    });

    elements.input.addEventListener("input", resizeInput);
    elements.input.addEventListener("keydown", event => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        elements.form.requestSubmit();
      }
    });

    elements.panel.querySelectorAll("[data-ai-prompt]").forEach(button => {
      button.addEventListener("click", () => {
        sendMessage(
          String(button.dataset.aiPrompt || button.textContent || ""),
          String(button.dataset.aiPayload || "")
        );
      });
    });

    const observer = new MutationObserver(() => {
      const open = elements.panel.classList.contains("show");
      elements.toggle.setAttribute("aria-expanded", String(open));
      elements.panel.setAttribute("aria-hidden", String(!open));
      if (open) {
        window.setTimeout(() => {
          elements.input.focus({ preventScroll: true });
          scrollToBottom();
        }, 160);
      }
    });
    observer.observe(elements.panel, { attributes: true, attributeFilter: ["class"] });
  }

  function init() {
    if (state.initialized) return;

    elements.panel = document.getElementById("faqBox");
    elements.toggle = document.getElementById("faqToggle");
    elements.messages = document.getElementById("aiChatMessages");
    elements.form = document.getElementById("aiChatForm");
    elements.input = document.getElementById("aiChatInput");
    elements.send = document.getElementById("aiChatSend");
    elements.typing = document.getElementById("aiChatTyping");

    if (Object.values(elements).some(item => !item)) return;

    state.initialized = true;
    state.sessionId = getSessionId();
    restoreHistory();
    bindEvents();
    resizeInput();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
