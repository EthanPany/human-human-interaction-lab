/**
 * Normalize a phone number to E.164-ish form so the app and iMessage agree.
 * "(555) 123 4567" -> "+15551234567". Email handles (iMessage Apple IDs) pass through.
 */
/** Seeded demo profiles use fictional 555-01xx numbers; never text them. */
export function isDemoPhone(phone: string): boolean {
  return /^\+1\d{3}55501\d{2}$/.test(phone);
}

export function normalizePhone(input: string): string {
  const trimmed = input.trim();
  if (trimmed.includes("@")) return trimmed.toLowerCase();
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return trimmed.startsWith("+") ? `+${digits}` : `+${digits}`;
}
