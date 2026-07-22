/*
  Gắn đoạn này vào trang admin SAU KHI đã có biến `db` từ Firebase Web SDK.
  Không dùng ở trang khách. Quyền đọc phải được bảo vệ bằng Firebase Auth/Rules.
*/
import { onValue, query, ref, limitToLast } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-database.js";

export function watchMessengerLeads(db, onChange) {
  const leadsQuery = query(ref(db, "messengerBot/leads"), limitToLast(100));
  return onValue(leadsQuery, snapshot => {
    const raw = snapshot.val() || {};
    const leads = Object.values(raw).sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0));
    onChange(leads);
  });
}

export function watchMessengerConversation(db, psid, onChange) {
  return onValue(ref(db, `messengerBot/conversations/${psid}`), snapshot => {
    onChange(snapshot.val() || null);
  });
}
