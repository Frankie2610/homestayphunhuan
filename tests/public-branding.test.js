import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePublicBrandText,
  normalizePublicHomeRecord
} from "../lib/public-branding.js";

test("legacy public branding and location are normalized", () => {
  assert.equal(
    normalizePublicBrandText("Homestay 3 Cây Non tại 23/5/18 Lê Văn Duyệt, Bình Thạnh"),
    "Homestay Phú Nhuận tại 26/10 Lê Văn Sỹ, Phú Nhuận"
  );
});

test("home normalization changes display fields without changing technical URLs", () => {
  const home = normalizePublicHomeRecord({
    title: "3 Cây Non HOME 1",
    address: "23/5/18 Lê Văn Duyệt, Phường Gia Định, TP.HCM",
    coverImage: "https://storage.example/homestay3caynon/home1.jpg"
  });

  assert.equal(home.title, "Homestay Phú Nhuận HOME 1");
  assert.equal(home.address, "26/10 Lê Văn Sỹ, Quận Phú Nhuận, TP.HCM");
  assert.equal(home.coverImage, "https://storage.example/homestay3caynon/home1.jpg");
});

