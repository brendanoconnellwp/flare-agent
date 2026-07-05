// Minimal ULID: 10-char Crockford-base32 timestamp + 16 random chars.
// No dependency; crypto.getRandomValues per Workers best practice.
// (256 % 32 === 0, so the byte→char mapping has no modulo bias.)

const ENC = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function ulid(now = Date.now()): string {
  let ts = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    ts = ENC[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let rand = "";
  for (const b of bytes) rand += ENC[b % 32];
  return ts + rand;
}
