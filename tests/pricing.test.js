import test from "node:test";
import assert from "node:assert/strict";
import {
  allComboRanges,
  buildPricingCatalogFromData,
  comboPriceRange,
  extraGuestCharge,
  extractLateCheckoutFee,
  findPricingHome
} from "../lib/pricing.js";

test("đọc đúng giá combo từ roomPricing theo HOME", () => {
  const catalog = buildPricingCatalogFromData(
    {
      a: { name: "HOME 1", title: "HOME1" },
      b: { name: "HOME 2", title: "HOME2" }
    },
    {
      HOME1: { packages: { 2: 180000, 4: 280000 }, night: { 12: 520000 }, extraHour: 100000 },
      HOME2: { day: { 2: 200000, 4: 300000 }, night: { 12: 550000 }, lateCheckout30: 60000 }
    }
  );

  assert.equal(catalog.homes.length, 2);
  assert.equal(catalog.homes[0].combos[4], 280000);
  assert.equal(catalog.homes[0].combos[12], 520000);
  assert.equal(catalog.homes[0].lateCheckout.amount, 50000);
  assert.equal(catalog.homes[1].lateCheckout.amount, 60000);
  assert.equal(findPricingHome(catalog, "home 2")?.homeId, "b");
});

test("tính khoảng giá theo combo giữa các HOME", () => {
  const catalog = buildPricingCatalogFromData(
    { a: { title: "HOME1" }, b: { title: "HOME2" } },
    { HOME1: { packages: { 4: 250000 } }, HOME2: { packages: { 4: 300000 } } }
  );
  const range = comboPriceRange(catalog, 4);
  assert.equal(range.min, 250000);
  assert.equal(range.max, 300000);
  assert.equal(allComboRanges(catalog).length, 1);
});

test("ưu tiên phí checkout trễ 30 phút, nếu chỉ có phí giờ thì chia đôi", () => {
  assert.deepEqual(
    extractLateCheckoutFee({ lateCheckout30: 70000 }, {}),
    { amount: 70000, stepMinutes: 30, source: "explicit_30_minute_fee" }
  );
  assert.equal(extractLateCheckoutFee({ extraHour: 120000 }, {}).amount, 60000);
});

test("phụ thu từ người thứ ba là 50 nghìn mỗi người", () => {
  assert.equal(extraGuestCharge(2), 0);
  assert.equal(extraGuestCharge(3), 50000);
  assert.equal(extraGuestCharge(5), 150000);
});
