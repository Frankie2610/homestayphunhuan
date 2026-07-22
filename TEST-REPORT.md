# Test report — Firebase HOME loading fix

## Đã kiểm tra

- `api/public-config.js` hợp lệ về cú pháp.
- `server.mjs` hợp lệ về cú pháp và đã có route local `/api/public-config`.
- Module JavaScript chính trong `index.html` hợp lệ về cú pháp.
- Module JavaScript trong `firebase-debug.html` hợp lệ về cú pháp.
- API config đọc được cả biến `FIREBASE_*` và `PUBLIC_FIREBASE_*`.
- Response lỗi thiếu biến môi trường dùng `no-store`, không cache lỗi 503.
- Local server trả HTTP 200 cho `/api/public-config` và `/firebase-debug.html` với config giả lập.
- Test render HOME: `/homes` trả 2 HOME, `bookingsByMonth` bị treo; card HOME vẫn render đủ trước khi booking hoàn tất.
- Test delivery website không gọi Meta API.
- Test chữ ký webhook Meta.

## Kết quả test tập trung

`5/5` test đạt:

1. HOME render trước booking.
2. Meta signature.
3. Public config hỗ trợ tên biến hiện có.
4. Public config không cache lỗi.
5. Web delivery tách khỏi Meta.

Các test chatbot đầy đủ cần chạy sau `npm install` vì phụ thuộc `firebase-admin`, `luxon`, `@google/genai` và `@vercel/functions`.
