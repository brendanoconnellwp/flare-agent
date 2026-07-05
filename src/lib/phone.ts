// North American (NANP) numbers only. This is a single-tenant US product,
// and refusing non-NANP callers/destinations outright is the cheap defense
// against SMS-pumping toll fraud: attackers trigger auto-replies to
// premium-rate international numbers they own and collect the termination
// fees. Pair with Twilio's Messaging Geo Permissions (US/CA only).

export function isNanpPhone(phone: string): boolean {
  return /^\+1[2-9]\d{9}$/.test(phone);
}
