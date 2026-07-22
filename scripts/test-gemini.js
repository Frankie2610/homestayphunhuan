import {
  rewriteReplyWithGemini,
  runWithGeminiMessageContext
} from "../lib/gemini.js";

const result = await runWithGeminiMessageContext(
  {
    psid: "local-test",
    userMessage: "HOME2 ngày mai lúc 20h30 còn gói 4H không?",
    payload: ""
  },
  () => rewriteReplyWithGemini({
    originalReply:
      "HOME2 còn trống từ 20:30 đến 00:30 ngày mai. Giá gói 4H là 485.000đ. Bạn muốn mình giữ phòng không?",
    quickReplies: [
      { title: "Giữ phòng", payload: "HOLD|HOME2" },
      { title: "Xem HOME khác", payload: "FILTER|CLEAR" }
    ]
  })
);

console.log(result);
