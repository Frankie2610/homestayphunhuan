import {
  rewriteReplyWithGemini,
  runWithGeminiMessageContext
} from "../lib/gemini.js";

const result = await runWithGeminiMessageContext(
  {
    userMessage: "HOME2 ngày mai còn không?",
    payload: "",
    rewriteCount: 0
  },
  () => rewriteReplyWithGemini({
    originalReply: "HOME2 còn trống từ 20:30 đến 00:30 ngày mai. Giá gói 4H là 485.000đ. Bạn muốn mình giữ phòng không?"
  })
);

console.log(result);
