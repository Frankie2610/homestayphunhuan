import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";

function extractFunction(source, name, nextName) {
  const start = source.indexOf(`function ${name}`);
  const end = source.indexOf(`function ${nextName}`, start);
  assert.ok(start >= 0 && end > start, `Không tìm thấy ${name}`);
  return source.slice(start, end);
}

test("HOME cards render from Firebase data before bookings finish", () => {
  const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
  const functionSource = extractFunction(
    html,
    "renderHomesFromFirebaseWhileAvailabilityLoads",
    "renderHomesAvailabilityError"
  );

  const grid = {
    classList: { remove() {} },
    innerHTML: "",
    __lastRoomHTML: null
  };

  const context = {
    console,
    document: {
      getElementById(id) {
        return id === "roomGrid" ? grid : null;
      }
    },
    homes: {
      a: {
        title: "HOME 1",
        description: "Dữ liệu Firebase 1",
        coverImage: "/home1.jpg",
        amenities: ["Netflix"],
        pricing: { packages: { 4: 300000 } }
      },
      b: {
        title: "HOME 2",
        description: "Dữ liệu Firebase 2",
        coverImage: "/home2.jpg",
        amenities: ["Máy chiếu"],
        pricing: { packages: { 3: 250000 } }
      }
    },
    roomMap: { HOME1: "a", HOME2: "b" },
    getMainPackage(home) {
      const packages = home.pricing?.packages || {};
      if (packages[4]) return { hours: 4, price: packages[4] };
      return { hours: 3, price: packages[3] || 0 };
    },
    optimizeCloudinary(value) { return value; },
    escapeHTML(value) { return String(value ?? ""); },
    renderAmenityChips(home) {
      return (home.amenities || []).map(item => `<span>${item}</span>`).join("");
    },
    encodeURIComponent
  };

  vm.createContext(context);
  vm.runInContext(`${functionSource}\nrenderHomesFromFirebaseWhileAvailabilityLoads();`, context);

  assert.match(grid.innerHTML, /HOME 1/);
  assert.match(grid.innerHTML, /HOME 2/);
  assert.match(grid.innerHTML, /Đang kiểm tra lịch trống/);
  assert.equal((grid.innerHTML.match(/room-card-data-ready/g) || []).length, 2);
});
