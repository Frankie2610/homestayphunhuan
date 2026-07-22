# Homestay Quận Phú Nhuận — Website + AI Chatbot

Một project duy nhất gồm:

- Website khách tại `/`
- AI chatbot website tại `/api/web-chat`
- Facebook Messenger webhook tại `/api/meta-webhook`
- Cùng chatbot core, Firebase và Gemini trong thư mục `lib/`

## Chạy thử đúng cách

Không dùng Live Server vì Live Server không chạy thư mục `api/`. Bản này có server local riêng nên không cần gọi `vercel dev`.

```powershell
npm.cmd install
npm.cmd run dev
```

Mở `http://localhost:3000`. Lệnh `npm run dev` chạy `server.mjs`, tránh lỗi Vercel tự gọi lặp Development Command.

Khi đã liên kết project Vercel và muốn kiểm tra đúng môi trường Vercel, có thể dùng riêng:

```powershell
npm.cmd run dev:vercel
```

## Deploy GitHub → Vercel

1. Đẩy toàn bộ thư mục này lên một GitHub repository mới.
2. Import repository vào một Vercel Project.
3. Root Directory phải là thư mục đang chứa `package.json`, `index.html`, `api/`, `lib/` và `vercel.json`.
4. Thêm Environment Variables trong Vercel Settings.
5. Deploy lại sau khi thêm hoặc thay đổi Environment Variables.

## Environment Variables bắt buộc

Sao chép tên biến từ `.env.example`. Không commit `.env.local` hoặc service-account JSON lên GitHub.

Tối thiểu cho web chat:

- `FIREBASE_DATABASE_URL`
- `FIREBASE_SERVICE_ACCOUNT_JSON`, hoặc bộ ba:
  - `FIREBASE_PROJECT_ID`
  - `FIREBASE_CLIENT_EMAIL`
  - `FIREBASE_PRIVATE_KEY`

Cho Messenger:

- `META_VERIFY_TOKEN`
- `META_APP_SECRET`
- `META_PAGE_ACCESS_TOKEN`

Cho Gemini nếu bật:

- `GEMINI_ENABLED=true`
- `GEMINI_API_KEY`

## Kiểm tra sau deploy

- `https://TEN-MIEN/api/web-chat` phải trả JSON có `configured: true`.
- Meta webhook URL: `https://TEN-MIEN/api/meta-webhook`.
- Widget frontend gọi `/api/web-chat`, nên không cần CORS khi website và API cùng project.

## Tối ưu tốc độ web chat

Mặc định:

- `WEB_CHAT_FAST_MODE=true`
- `WEB_CHAT_GEMINI_REWRITE=true`
- `GEMINI_TIMEOUT_MS=5000` để nếu Gemini chậm thì bot dùng ngay câu trả lời gốc đã được logic/Firebase xác minh
- Cache dữ liệu lịch/giá trong thời gian ngắn
- Ghi log website chạy nền

Gemini được dùng cho câu hỏi mở và viết lại câu trả lời website khi `GEMINI_ENABLED=true` và có `GEMINI_API_KEY`. Nếu Gemini lỗi hoặc quá 5 giây, bot tự động trả câu gốc để tránh treo.

## Domain production đã cấu hình

- Website: `https://homestayphunhuan.vercel.app/`
- Lịch trống: `https://homestayphunhuan.vercel.app/lich-trong`
- Web chat API: `https://homestayphunhuan.vercel.app/api/web-chat`
- Messenger webhook: `https://homestayphunhuan.vercel.app/api/meta-webhook`

Trên Vercel đặt:

- `PUBLIC_SITE_URL=https://homestayphunhuan.vercel.app`
- `WEB_CHAT_ALLOWED_ORIGINS=https://homestayphunhuan.vercel.app`
- `GEMINI_ENABLED=true`
- `WEB_CHAT_GEMINI_REWRITE=true`


## Security patch v4

Firebase Web API key is no longer hardcoded in HTML. Configure these Vercel Environment Variables:

```env
PUBLIC_FIREBASE_API_KEY=...
PUBLIC_FIREBASE_AUTH_DOMAIN=homestay3caynon-e00de.firebaseapp.com
PUBLIC_FIREBASE_DATABASE_URL=https://homestay3caynon-e00de-default-rtdb.firebaseio.com
PUBLIC_FIREBASE_PROJECT_ID=homestay3caynon-e00de
PUBLIC_FIREBASE_STORAGE_BUCKET=homestay3caynon-e00de.firebasestorage.app
BOT_HEALTH_SECRET=create-a-long-random-value
```

After redeploy, test Firebase Admin securely:

```text
https://homestayphunhuan.vercel.app/api/chatbot-health?secret=YOUR_BOT_HEALTH_SECRET
```

The public Firebase API key is delivered to the browser by `/api/public-config`; it must be restricted in Google Cloud to the required Firebase APIs and approved HTTP referrers. Gemini and Firebase Admin credentials must exist only in Vercel Environment Variables.
