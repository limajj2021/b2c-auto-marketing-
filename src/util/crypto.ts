const enc = new TextEncoder();

function b64(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

export async function hmacBase64(secret: string, data: string): Promise<string> {
  return b64(await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data)));
}

/** LINE X-Line-Signature 驗證：HMAC-SHA256(channel secret, raw body) → base64 */
export async function verifyLineSignature(secret: string, rawBody: string, signature: string | null): Promise<boolean> {
  if (!secret || !signature) return false;
  return timingSafeEqual(await hmacBase64(secret, rawBody), signature);
}

// ---- 密碼（PBKDF2-SHA256；Workers 上限 100000 次）----
const ITER = 100000;
export async function hashPassword(password: string, salt?: Uint8Array): Promise<string> {
  const s = salt ?? crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: s, iterations: ITER }, key, 256);
  return `pbkdf2$${ITER}$${b64(s)}$${b64(bits)}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, iter, salt] = stored.split('$');
  if (scheme !== 'pbkdf2' || Number(iter) !== ITER) return false;
  return timingSafeEqual(await hashPassword(password, unb64(salt)), stored);
}

// ---- 簽章 Session token（無狀態，每次請求仍會回查 admin_users.enabled）----
export async function signToken(secret: string, payload: { uid: number; exp: number; p?: string }): Promise<string> {
  const body = btoa(JSON.stringify(payload));
  return `${body}.${await hmacBase64(secret, body)}`;
}
export async function verifyToken(secret: string, token: string, nowSec: number): Promise<{ uid: number; p?: string } | null> {
  const [body, sig] = token.split('.');
  if (!body || !sig || !secret) return null;
  if (!timingSafeEqual(await hmacBase64(secret, body), sig)) return null;
  try {
    const p = JSON.parse(atob(body));
    if (typeof p.uid !== 'number' || typeof p.exp !== 'number' || p.exp < nowSec) return null;
    return { uid: p.uid, p: typeof p.p === 'string' ? p.p : undefined };
  } catch {
    return null;
  }
}
