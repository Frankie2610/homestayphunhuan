import { AsyncLocalStorage } from "node:async_hooks";
import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";

const messageContextStorage = new AsyncLocalStorage();
let client = null;

const SENSITIVE_PATTERN = /(?:\b(?:cccd|cmnd|so tai khoan|chuyen khoan|momo|ngan hang|so dien thoai|sdt)\b|\b\d{9,16}\b)/i;

function cleanText(value = "") {
  return String(value || "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

function isEnabled() {
  return config.geminiEnabled === true && Boolean(config.geminiApiKey);
}

function getClient() {
  if (!client) {
    client = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return client;
}

function currentMessageContext() {
  return messageContextStorage.getStore() || {};
}

/**
 * Bọc toàn bộ một lượt webhook Messenger. AsyncLocalStorage giữ đúng ngữ cảnh
 * riêng cho từng request, không bị lẫn khi nhiều khách nhắn cùng lúc.
 */
export function runWithGeminiMessageContext(context, handler) {
  return messageContextStorage.run({ ...(context || {}) }, handler);
}

function quickReplyTitles(items = []) {
  return (Array.isArray(items) ? items : [])
    .map(item => cleanText(item?.title))
    .filter(Boolean)
    .slice(0, 13);
}

function normalizeForFacts(value = "") {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const SCOPED_TOPIC_PATTERNS = Object.freeze({
  directions: /\b(duong di|chi duong|dia chi|ban do|map|google maps|toi home|den home|di den|o dau|vi tri)\b/,
  nearbyTravel: /\b(du lich|tham quan|choi gi|an gi|quan an|cafe|gan day|xung quanh|khu vuc|dia diem|check in dep)\b/,
  amenities: /\b(tien ich|bon tam|may chieu|netflix|wifi|may lanh|nuoc nong|tv|ban cong|do dung|dich vu phong)\b/,
  football: /\b(bong da|football|soccer|premier league|ngoai hang anh|champions league|c1|world cup|euro|la liga|serie a|bundesliga|ligue 1|v league|v-league|doi bong|cau thu|chien thuat|luat bong da)\b/,
  hospitality: /\b(homestay|home|luu tru|nghi duong|phong|dat phong|book phong|giu phong|checkin|check in|checkout|check out|qua dem|combo)\b/
});

const LIVE_FOOTBALL_PATTERN = /\b(hom nay|toi nay|dem nay|ngay mai|lich thi dau|tran nao|may gio da|ty so|ket qua|dang da|truc tiep|live|bang xep hang|bxh|moi nhat|vua da)\b/;

function detectScopedTopic(text = "") {
  const normalized = normalizeForFacts(text);
  for (const [topic, pattern] of Object.entries(SCOPED_TOPIC_PATTERNS)) {
    if (pattern.test(normalized)) return topic;
  }
  return "";
}

function normalizeBrandVoice(value = "") {
  return cleanText(value)
    .replace(/\bBên mình\b/gi, "HOME")
    .replace(/\bbên mình\b/gi, "HOME")
    .replace(/\bBạn muốn mình\b/gi, "Bạn muốn HOME")
    .replace(/\bcho mình\b/gi, "cho Bạn")
    .replace(/\bgiúp mình\b/gi, "giúp Bạn")
    .replace(/\bmình\b/gi, "HOME")
    .replace(/\bHome\b/g, "HOME")
    .replace(/\bhome\b/g, "HOME")
    .replace(/\bshop\b/gi, "HOME")
    .replace(/\bquý khách\b/gi, "Bạn")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unique(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function collectMatches(text, regex, mapper) {
  const output = [];
  let match;
  while ((match = regex.exec(text))) {
    const value = mapper(match);
    if (value !== null && value !== undefined && value !== "") output.push(String(value));
  }
  return unique(output);
}

function extractProtectedFacts(text = "") {
  const normalized = normalizeForFacts(text);

  const homes = collectMatches(
    normalized,
    /\bhome\s*[- ]?(\d{1,2})\b/g,
    match => `HOME${Number(match[1])}`
  );

  function normalizeClockFact(hourValue, minuteValue, markerValue = "") {
    let hour = Number(hourValue);
    const minute = Number(minuteValue);
    const marker = String(markerValue || "").trim();

    if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
      return null;
    }

    if (marker === "am" || marker === "sang") {
      if (hour === 12) hour = 0;
    } else if (marker === "pm" || marker === "chieu" || marker === "toi") {
      if (hour < 12) hour += 12;
    } else if (marker === "trua") {
      if (hour < 11) hour += 12;
    } else if (marker === "dem") {
      // “12h30 đêm” tương đương 00:30; “8h30 đêm” tương đương 20:30.
      if (hour === 12) hour = 0;
      else if (hour >= 5 && hour < 12) hour += 12;
    }

    if (hour < 0 || hour > 23) return null;
    return hour * 60 + minute;
  }

  const times = [
    ...collectMatches(
      normalized,
      /\b([01]?\d|2[0-3])\s*[:h]\s*([0-5]\d)(?:\s*(am|pm|sang|trua|chieu|toi|dem))?\b/g,
      match => normalizeClockFact(match[1], match[2], match[3])
    ),
    ...collectMatches(
      normalized,
      /\b([01]?\d|2[0-3])\s*gio\s*([0-5]\d)(?:\s*(am|pm|sang|trua|chieu|toi|dem))?\b/g,
      match => normalizeClockFact(match[1], match[2], match[3])
    )
  ];

  const money = collectMatches(
    normalized,
    /\b(\d[\d\s.,]{0,18})\s*(?:d|dong|vnd)\b/g,
    match => {
      const digits = match[1].replace(/\D/g, "");
      return digits ? String(Number(digits)) : "";
    }
  );

  const durations = collectMatches(
    normalized,
    /\b(\d{1,2})\s*(?:h|gio|tieng)\b/g,
    match => Number(match[1])
  );

  const guestCounts = collectMatches(
    normalized,
    /\b(\d{1,2})\s*(?:nguoi|khach)\b/g,
    match => Number(match[1])
  );

  const dates = collectMatches(
    normalized,
    /\b(\d{1,2})[\/-](\d{1,2})(?:[\/-](\d{2,4}))?\b/g,
    match => {
      const day = Number(match[1]);
      const month = Number(match[2]);
      const year = match[3] ? Number(match[3]) : 0;
      return `${day}/${month}/${year}`;
    }
  );

  const relativeDates = [
    "hom nay",
    "ngay mai",
    "ngay mot"
  ].filter(value => new RegExp(`\\b${value}\\b`).test(normalized));

  return {
    homes,
    times: unique(times),
    money,
    durations,
    guestCounts,
    dates,
    relativeDates
  };
}

function missingProtectedFacts(original, rewritten) {
  const expected = extractProtectedFacts(original);
  const actual = extractProtectedFacts(rewritten);
  const missing = {};

  for (const key of Object.keys(expected)) {
    const actualSet = new Set(actual[key] || []);
    const absent = (expected[key] || []).filter(value => !actualSet.has(value));
    if (absent.length) missing[key] = absent;
  }

  return missing;
}

function preservesNumericFacts(original, rewritten) {
  return Object.keys(missingProtectedFacts(original, rewritten)).length === 0;
}

function protectedLiteralHints(text = "") {
  const source = cleanText(text);
  const patterns = [
    /\bHOME\s*[- ]?\d{1,2}\b/gi,
    /\b(?:[01]?\d|2[0-3])\s*[:h]\s*[0-5]\d(?:\s*(?:AM|PM|sáng|trưa|chiều|tối|đêm))?\b/gi,
    /\b\d[\d\s.,]{0,18}\s*(?:đ|đồng|VND)\b/gi,
    /\b\d{1,2}\s*(?:H|giờ|tiếng)\b/gi
  ];
  return unique(patterns.flatMap(pattern => source.match(pattern) || []));
}

function shouldSkipRewrite(originalReply, store) {
  if (!isEnabled()) return true;
  if (!originalReply || originalReply.length < 24) return true;

  const maxPerMessage = Math.max(0, Number(config.geminiMaxRewritesPerMessage || 0));
  if (maxPerMessage === 0 || Number(store.rewriteCount || 0) >= maxPerMessage) return true;

  // Gemini Free Tier có thể dùng dữ liệu để cải thiện sản phẩm. Mặc định bỏ qua
  // các câu có SĐT/CCCD/tài khoản/chuyển khoản để không gửi dữ liệu nhạy cảm.
  if (!config.geminiRewriteSensitive && SENSITIVE_PATTERN.test(originalReply)) return true;

  return false;
}

function timeoutAfter(ms) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      const error = new Error("gemini_timeout");
      error.code = "GEMINI_TIMEOUT";
      reject(error);
    }, Math.max(500, Number(ms || 8_000)));
    timer.unref?.();
  });
}

/**
 * Gemini chỉ viết lại câu trả lời đã được logic cũ xác minh.
 * Không cho Gemini tự đọc Firebase, tự quyết định lịch hoặc tự tạo giá.
 */
export async function rewriteReplyWithGemini({
  originalReply,
  quickReplies = [],
  maxCharacters = 2000
} = {}) {
  const fallback = cleanText(originalReply).slice(0, maxCharacters);
  const store = currentMessageContext();

  if (shouldSkipRewrite(fallback, store)) return normalizeBrandVoice(fallback);

  const titles = quickReplyTitles(quickReplies);
  const userMessage = cleanText(store.userMessage || "");
  const normalizedUserMessage = normalizeForFacts(userMessage);
  const customerGreeted = /^(hi|hello|alo|chao|xin chao|ad oi|home oi|shop oi)\b/.test(normalizedUserMessage);

  const prompt = `
Bạn là trợ lý tư vấn của ${config.brandName}.

MỤC TIÊU
Viết lại CÂU TRẢ LỜI GỐC thành lời nhắn Messenger chuyên nghiệp, tự nhiên, rõ ràng và giống một nhân viên tư vấn có kinh nghiệm.

GIỌNG THƯƠNG HIỆU
- Xưng doanh nghiệp là “HOME”, gọi khách là “Bạn”. Tuyệt đối không xưng “mình”, “bên mình”, “em”, “shop” hoặc “quý khách”.
- Giọng ấm áp, điềm tĩnh, lịch sự và chủ động; không suồng sã, không cứng nhắc, không phô trương.
- Không mở đầu bằng “Chào bạn” nếu khách không vừa chào.
- Chỉ dùng “Dạ” khi thật phù hợp, không lặp “dạ”, “nha”, “nhé”, “ạ” trong nhiều câu liên tiếp.
- Ưu tiên câu ngắn, mạch lạc. Thường 2–3 câu; tối đa 4 câu.
- Không dùng emoji trong câu tư vấn thông thường. Chỉ dùng tối đa 1 emoji ở lời chào hoặc lời cảm ơn khi thật tự nhiên.
- Tránh các cụm máy móc: “quý khách”, “xin vui lòng”, “hiện đang”, “với giá”, “theo thông tin được cung cấp”, “rất hân hạnh”.
- Câu cuối là một bước tiếp theo cụ thể, nhẹ nhàng và đúng ngữ cảnh; không chèo kéo.
- Không lặp lại nguyên câu khách hỏi nếu không cần thiết.

QUY TẮC DỮ LIỆU BẮT BUỘC
- Chỉ dùng thông tin có trong CÂU TRẢ LỜI GỐC.
- Không tự tạo hoặc thay đổi HOME, giá, ngày, giờ, thời lượng, tiện ích, chính sách hay ưu đãi.
- Giữ nguyên mọi chuỗi dữ kiện được liệt kê bên dưới.
- Không tự chuyển nhân viên nếu câu gốc không yêu cầu.
- Không thêm thông tin chuyển khoản, số điện thoại hoặc dữ liệu cá nhân.
- Nếu có nút gợi ý, lời nhắn phải dẫn tự nhiên tới các nút đó.
- Chỉ trả về nội dung cuối cùng, không giải thích.

QUY TẮC CHÀO HỎI
Khách vừa chào: ${customerGreeted ? "Có" : "Không"}
Nếu là “Không”, tuyệt đối không mở đầu bằng “Chào bạn”.

VÍ DỤ PHONG CÁCH
Câu gốc: HOME2 còn trống từ 20:30 đến 00:30 ngày mai. Giá gói 4H là 485.000đ. Bạn muốn mình giữ phòng không?
Câu tốt: HOME2 còn trống từ 20:30 đến 00:30 ngày mai. Gói 4H là 485.000đ. Bạn muốn HOME giữ chỗ để nhân viên xác nhận không?

Câu gốc: Bạn vui lòng chọn ngày muốn ở.
Câu tốt: Bạn dự kiến lưu trú ngày nào để HOME kiểm tra lịch?

Câu gốc: Không còn phòng phù hợp trong khung giờ này.
Câu tốt: Khung giờ này chưa còn HOME phù hợp. HOME có thể kiểm tra khung giờ gần nhất cho Bạn.

Câu gốc: Mình gửi bạn địa chỉ nhé.
Câu tốt: Địa chỉ của HOME là 23/5/18 Lê Văn Duyệt, Phường Gia Định, TP.HCM. Bạn có thể mở bản đồ để xem đường đi thuận tiện nhất.

TIN NHẮN KHÁCH
${userMessage}

PAYLOAD/NÚT KHÁCH BẤM
${cleanText(store.payload || "")}

CÁC NÚT SẼ HIỂN THỊ
${titles.length ? titles.join(" | ") : "Không có"}

CÁC CHUỖI DỮ KIỆN PHẢI GIỮ NGUYÊN Y HỆT
${protectedLiteralHints(fallback).join(" | ") || "Không có"}

CÂU TRẢ LỜI GỐC
${fallback}
`.trim();

  try {
    const request = getClient().models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
        temperature: Math.min(0.5, Math.max(0, Number(config.geminiTemperature || 0.2))),
        maxOutputTokens: Math.max(64, Number(config.geminiMaxOutputTokens || 220))
      }
    });

    const response = await Promise.race([
      request,
      timeoutAfter(config.geminiTimeoutMs)
    ]);

    const rewritten = normalizeBrandVoice(response?.text).slice(0, maxCharacters);
    if (!rewritten) return fallback;
    if (!preservesNumericFacts(fallback, rewritten)) {
      console.warn("Gemini rewrite rejected: protected facts changed", {
        missing: missingProtectedFacts(fallback, rewritten)
      });
      return fallback;
    }

    store.rewriteCount = Number(store.rewriteCount || 0) + 1;
    return rewritten;
  } catch (error) {
    console.warn("Gemini rewrite fallback", {
      code: error?.code || "",
      status: error?.status || error?.response?.status || "",
      message: String(error?.message || error || "gemini_error").slice(0, 300)
    });
    return fallback;
  }
}

/**
 * Trả lời có giới hạn cho các chủ đề được phép khi logic cũ chưa nhận diện.
 * Không dùng cho lịch/giá/booking realtime vì các nội dung đó phải do logic cũ xử lý.
 */
export async function answerScopedQuestionWithGemini({
  userMessage = "",
  conversationContext = {},
  maxCharacters = 1200
} = {}) {
  const store = currentMessageContext();
  const question = cleanText(userMessage || store.userMessage || "");
  const topic = detectScopedTopic(question);

  if (!topic || !isEnabled() || !question || config.geminiScopedTopicsEnabled === false) {
    return { handled: false, topic: "", reply: "" };
  }

  if (topic === "football" && config.geminiFootballEnabled === false) {
    return { handled: false, topic, reply: "" };
  }

  if (!config.geminiRewriteSensitive && SENSITIVE_PATTERN.test(question)) {
    return { handled: false, topic, reply: "" };
  }

  if (topic === "football" && LIVE_FOOTBALL_PATTERN.test(normalizeForFacts(question))) {
    store.rewriteCount = Math.max(
      Number(store.rewriteCount || 0),
      Math.max(1, Number(config.geminiMaxRewritesPerMessage || 1))
    );
    return {
      handled: true,
      topic,
      reply: "HOME có thể trao đổi về bóng đá, nhưng chưa kết nối nguồn dữ liệu trực tiếp để xác nhận lịch thi đấu, tỷ số hoặc bảng xếp hạng mới nhất. Bạn có thể hỏi về luật, chiến thuật, giải đấu, đội bóng hoặc cầu thủ."
    };
  }

  const safeContext = {
    selectedHome: cleanText(
      conversationContext?.selectedHomeName ||
      conversationContext?.selectedHomeId ||
      conversationContext?.preferredHomeId ||
      ""
    ),
    dateKey: cleanText(conversationContext?.dateKey || ""),
    durationHours: Number(conversationContext?.durationHours || 0) || null
  };

  const topicInstruction = {
    hospitality: "Chỉ trả lời kiến thức chung về homestay, lưu trú và quy trình đặt phòng. Không tự xác nhận lịch trống, giá hoặc booking.",
    amenities: "Chỉ nói về tiện ích nếu có dữ kiện xác minh. Nếu câu hỏi liên quan một HOME cụ thể mà chưa có dữ liệu, hỏi lại HOME hoặc đề nghị kiểm tra.",
    directions: `Ưu tiên cung cấp địa chỉ và bản đồ đã xác minh. Địa chỉ HOME: ${config.homeAddress}. Bản đồ: ${config.mapUrl}. Không tự tạo tuyến xe, khoảng cách hoặc thời gian di chuyển.`,
    nearbyTravel: `Có thể gợi ý theo nhóm nhu cầu quanh khu vực ${config.homeAddress}, nhưng không bịa tên cơ sở, khoảng cách, giờ mở cửa hoặc đánh giá. Nếu thiếu dữ liệu xác minh, nói rõ và gợi ý khách kiểm tra bản đồ.`,
    football: "Có thể trả lời kiến thức bóng đá phổ thông, luật, chiến thuật, lịch sử giải đấu, đội bóng và cầu thủ. Không khẳng định thông tin trực tiếp hoặc mới nhất."
  }[topic];

  const prompt = `
Bạn là trợ lý tư vấn của ${config.brandName}.

PHẠM VI ĐƯỢC PHÉP
- Homestay và lưu trú.
- Du lịch quanh khu vực.
- Đường đi tới HOME.
- Tiện ích.
- Đặt phòng.
- Bóng đá.

CHỦ ĐỀ ĐANG XỬ LÝ
${topic}

HƯỚNG DẪN RIÊNG
${topicInstruction}

GIỌNG TRẢ LỜI
- Chuyên nghiệp, tự nhiên, ấm áp và ngắn gọn.
- Xưng doanh nghiệp là “HOME”, gọi khách là “Bạn”.
- Không xưng “mình”, “bên mình”, “em”, “shop” hoặc “quý khách”.
- Không lặp “dạ”, “nha”, “nhé”, “ạ”.
- Không dùng emoji trong câu tư vấn thông thường.
- Tối đa 4 câu. Trả lời trực tiếp trước, sau đó mới gợi ý bước tiếp theo nếu cần.

QUY TẮC AN TOÀN VÀ ĐỘ CHÍNH XÁC
- Không tự tạo giá, lịch trống, booking, chính sách, tiện ích cụ thể, khoảng cách, giờ mở cửa hoặc dữ liệu realtime.
- Không khẳng định tin bóng đá mới nhất, tỷ số trực tiếp, lịch thi đấu hiện tại hoặc bảng xếp hạng hiện tại.
- Nếu thiếu dữ kiện xác minh, nói rõ giới hạn bằng một câu ngắn.
- Không nói rằng Bạn là AI hoặc Gemini.
- Chỉ trả về câu trả lời cuối cùng.

THÔNG TIN HOME ĐÃ XÁC MINH
Tên: ${config.brandName}
Địa chỉ: ${config.homeAddress}
Bản đồ: ${config.mapUrl}
Website: ${config.siteUrl}

NGỮ CẢNH HỘI THOẠI
${JSON.stringify(safeContext)}

CÂU HỎI CỦA KHÁCH
${question}
`.trim();

  try {
    const request = getClient().models.generateContent({
      model: config.geminiModel,
      contents: prompt,
      config: {
        temperature: Math.min(0.4, Math.max(0.15, Number(config.geminiTemperature || 0.3))),
        maxOutputTokens: Math.max(96, Number(config.geminiMaxOutputTokens || 220))
      }
    });

    const response = await Promise.race([
      request,
      timeoutAfter(config.geminiTimeoutMs)
    ]);

    const reply = normalizeBrandVoice(response?.text).slice(0, maxCharacters);
    if (!reply) return { handled: false, topic, reply: "" };

    store.rewriteCount = Math.max(
      Number(store.rewriteCount || 0),
      Math.max(1, Number(config.geminiMaxRewritesPerMessage || 1))
    );

    return { handled: true, topic, reply };
  } catch (error) {
    console.warn("Gemini scoped answer fallback", {
      topic,
      code: error?.code || "",
      status: error?.status || error?.response?.status || "",
      message: String(error?.message || error || "gemini_error").slice(0, 300)
    });
    return { handled: false, topic, reply: "" };
  }
}

