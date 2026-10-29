/**
 * Normalize a phone number to E.164-ish form so the app and iMessage agree.
 * "(555) 123 4567" -> "+15551234567". Email handles (iMessage Apple IDs) pass through.
 */
/** Seeded demo profiles use fictional 555-01xx numbers; never text them. */
export function isDemoPhone(phone: string): boolean {
  return /^\+1\d{3}55501\d{2}$/.test(phone);
}

/**
 * Any way people (or autofill) write a number -> E.164.
 *   "(585) 210-6589", "585.210.6589", "5852106589" -> "+15852106589"   (US default)
 *   "1 585 210 6589", "+1 (585) 210 6589"          -> "+15852106589"
 *   "+86 181 7141 5420", "0086 181...", "011 86 181..." -> "+8618171415420"
 * Email handles (iMessage Apple IDs) pass through lowercased.
 * Must match PhoneNumber.normalize in the iOS app.
 */
export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const plus = /^[+＋]/.test(trimmed);
  let digits = trimmed.replace(/[^0-9]/g, "");
  if (!plus) {
    if (digits.startsWith("011")) return `+${digits.slice(3)}`;
    if (digits.startsWith("00")) return `+${digits.slice(2)}`;
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  }
  return `+${digits}`;
}

/** E.164 allows 8 to 15 digits including the country code; US numbers are exactly +1 and 10 digits. */
export function isValidPhone(e164: string): boolean {
  const digits = e164.replace(/[^0-9]/g, "");
  if (!e164.startsWith("+") || digits.length < 8 || digits.length > 15) return false;
  return digits.startsWith("1") ? digits.length === 11 : true;
}
