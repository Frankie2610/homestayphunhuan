const DISPLAY_FIELDS = [
  "title",
  "name",
  "displayName",
  "description",
  "shortDescription",
  "content",
  "address",
  "addressLine",
  "location",
  "fullAddress",
  "diaChi",
  "diachi"
];

export function normalizePublicBrandText(value = "") {
  return String(value || "")
    .replace(/Homestay 3 Cây Non/giu, "Homestay Phú Nhuận")
    .replace(/3 Cây Non/giu, "Homestay Phú Nhuận")
    .replace(/23\/5\/18 Lê Văn Duyệt/giu, "26/10 Lê Văn Sỹ")
    .replace(/Phường Gia Định/giu, "Quận Phú Nhuận")
    .replace(/Bình Thạnh/giu, "Phú Nhuận");
}

export function normalizePublicHomeRecord(rawHome = {}) {
  if (!rawHome || typeof rawHome !== "object" || Array.isArray(rawHome)) {
    return rawHome;
  }

  const home = { ...rawHome };
  DISPLAY_FIELDS.forEach(field => {
    if (typeof home[field] === "string") {
      home[field] = normalizePublicBrandText(home[field]);
    }
  });
  return home;
}
