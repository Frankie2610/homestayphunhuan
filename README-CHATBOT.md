# Chatbot website 3 Cây Non

Widget `Chat với HOME` đã thay phần `Hỏi nhanh` và dùng chung lõi xử lý với bot Messenger. Khi khách hỏi lịch, giá hoặc HOME, API `/api/web-chat` đọc dữ liệu hiện tại từ Firebase Realtime Database.

## Chạy local

1. Dùng Node.js 20 trở lên và chạy `npm install`.
2. Giữ file `.env.local` hiện có, hoặc sao chép `.env.example` thành `.env.local` rồi điền Firebase Admin.
3. Chạy `npx vercel dev`, sau đó mở `http://localhost:3000`.
4. Mở widget và thử lần lượt: `Giá HOME1 combo 4H`, `Còn HOME nào ngày mai lúc 13:00 trong 4 giờ?`, `Xem hình HOME1`.

## Deploy

Các biến Firebase/Gemini/Meta vẫn phải có trong Vercel Project Settings. Không đưa `.env.local` lên Git hoặc vào file ZIP chia sẻ công khai.
