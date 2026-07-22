import {
  answerScopedQuestionWithGemini,
  runWithGeminiMessageContext
} from "../lib/gemini.js";

const questions = [
  "Chỉ đường tới HOME giúp mình",
  "Khu vực quanh HOME có gì để đi chơi?",
  "Luật việt vị trong bóng đá là gì?",
  "Tỷ số trận tối nay bao nhiêu?",
  "Viết code JavaScript giúp mình"
];

for (const question of questions) {
  const result = await runWithGeminiMessageContext(
    { userMessage: question, payload: "", rewriteCount: 0 },
    () => answerScopedQuestionWithGemini({ userMessage: question })
  );
  console.log("\nQ:", question);
  console.log("Handled:", result.handled, "Topic:", result.topic || "-");
  console.log("A:", result.reply || "Không xử lý — bot sẽ dùng fallback cũ.");
}
