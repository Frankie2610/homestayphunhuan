export const DEFAULT_STANDARD_GUESTS = 2;
export const DEFAULT_EXTRA_GUEST_FEE = 50_000;
export const MAX_BOOKING_GUESTS = 20;

export function clampGuestCount(value, fallback = DEFAULT_STANDARD_GUESTS) {
  const parsed = Math.round(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(MAX_BOOKING_GUESTS, parsed));
}

export function calculateGuestPricing({
  guestCount,
  basePrice,
  standardGuests = DEFAULT_STANDARD_GUESTS,
  extraGuestFeePerPerson = DEFAULT_EXTRA_GUEST_FEE
} = {}) {
  const guests = clampGuestCount(guestCount, Math.max(1, Number(standardGuests || DEFAULT_STANDARD_GUESTS)));
  const standardGuestCount = Math.max(1, Math.round(Number(standardGuests || DEFAULT_STANDARD_GUESTS)));
  const feePerPerson = Math.max(0, Math.round(Number(extraGuestFeePerPerson || 0)));
  const normalizedBasePrice = Math.max(0, Math.round(Number(basePrice || 0)));
  const extraGuestCount = Math.max(0, guests - standardGuestCount);
  const extraGuestFee = extraGuestCount * feePerPerson;
  return {
    guestCount: guests,
    standardGuestCount,
    extraGuestCount,
    extraGuestFeePerPerson: feePerPerson,
    extraGuestFee,
    basePrice: normalizedBasePrice,
    actualPrice: normalizedBasePrice + extraGuestFee,
    paymentAmount: normalizedBasePrice + extraGuestFee
  };
}
