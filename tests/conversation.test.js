import test from "node:test";
import assert from "node:assert/strict";
import { __conversationTest } from "../lib/conversation.js";


test("new availability query clears stale room and amenity filters", () => {
  const fresh = __conversationTest.freshSearchContext("Ngày mai 13h còn phòng 4 tiếng không?");
  assert.ok(fresh.dateKey);
  assert.equal(fresh.startMinute, 13 * 60);
  assert.equal(fresh.durationHours, 4);
  assert.equal(fresh.preferredHomeId, "");
  assert.deepEqual(fresh.amenities, []);
});


test("availability intent recognizes common Vietnamese phrasing", () => {
  assert.equal(__conversationTest.detectAvailabilityRequest("13h còn phòng không?"), true);
  assert.equal(__conversationTest.detectAvailabilityRequest("kiểm tra phòng tối nay"), true);
  assert.equal(__conversationTest.detectAvailabilityRequest("giá bao nhiêu"), false);
});


test("home reference parser accepts HOME1 and HOME 2", () => {
  assert.equal(__conversationTest.parseHomeReference("Mình chọn HOME1"), "HOME1");
  assert.equal(__conversationTest.parseHomeReference("home 2 còn không"), "HOME2");
});


test("nhận biết yêu cầu khẩn cấp ngoài giờ", () => {
  assert.equal(__conversationTest.detectUrgentRequest("mình cần phòng ngay bây giờ"), true);
  assert.equal(__conversationTest.detectUrgentRequest("cho mình hỏi giá"), false);
});

test("nhận biết thêm các câu đặt gấp", () => {
  assert.equal(__conversationTest.detectUrgentRequest("mình muốn đặt ngay"), true);
  assert.equal(__conversationTest.detectUrgentRequest("chuyển khoản ngay được không"), true);
});

test("phân loại đúng câu hỏi giá, số người, CCCD, máy bán hàng và checkout trễ", () => {
  assert.equal(__conversationTest.detectFaqIntent("HOME 2 gói 4H giá bao nhiêu?"), "price");
  assert.equal(__conversationTest.detectFaqIntent("phòng tiêu chuẩn mấy người?"), "capacity");
  assert.equal(__conversationTest.detectFaqIntent("qua đêm có cần CCCD không?"), "identity");
  assert.equal(__conversationTest.detectFaqIntent("có máy bán hàng bán mì ly không?"), "vending");
  assert.equal(__conversationTest.detectFaqIntent("HOME 3 checkout trễ 30 phút phụ thu bao nhiêu?"), "late_checkout");
});

test("đọc đúng số khách mà không nhầm với combo", () => {
  assert.equal(__conversationTest.parseGuestCount("mình đi 3 người"), 3);
  assert.equal(__conversationTest.parseGuestCount("gói 4H"), null);
});
