import type { Context, Next } from 'hono';

export type AppEnv = { Bindings: Env; Variables: { user: SessionUser } };
type Ctx = Context<AppEnv>;
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Env } from './db';

/* Passwords: PBKDF2-SHA256, 100k iterations (the Workers maximum), stored as
   pbkdf2$<iterations>$<salt b64>$<hash b64>. scripts/add-user.mjs makes the same format. */
const ITER = 100_000;
const b64 = (buf: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(buf as ArrayBuffer)));
const unb64 = (s: string) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function pbkdf2(password: string, salt: Uint8Array, iterations: number) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}
export async function hashPassword(password: string) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(salt)}$${b64(await pbkdf2(password, salt, ITER))}`;
}
export async function verifyPassword(password: string, stored: string) {
  const [alg, it, salt, hash] = stored.split('$');
  if (alg !== 'pbkdf2' || !salt || !hash) return false;
  const got = new Uint8Array(await pbkdf2(password, unb64(salt), Math.min(Number(it) || ITER, ITER)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0; for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}
export async function sha256(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}
export function randomToken(bytes = 24) {
  const a = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/* Sessions live in KV for 30 days. */
const COOKIE = 'jp_session';
const TTL = 60 * 60 * 24 * 30;
export interface SessionUser { id: string; username: string; name: string }

export async function startSession(c: Ctx, user: SessionUser) {
  const sid = randomToken(32);
  await c.env.SESSIONS.put(`s:${sid}`, JSON.stringify(user), { expirationTtl: TTL });
  const secure = new URL(c.req.url).protocol === 'https:';
  setCookie(c, COOKIE, sid, { httpOnly: true, secure, sameSite: 'Lax', path: '/', maxAge: TTL });
}
export async function endSession(c: Ctx) {
  const sid = getCookie(c, COOKIE);
  if (sid) await c.env.SESSIONS.delete(`s:${sid}`);
  deleteCookie(c, COOKIE, { path: '/' });
}
export async function currentUser(c: Ctx): Promise<SessionUser | null> {
  const sid = getCookie(c, COOKIE);
  if (!sid || sid.length > 100) return null;
  const raw = await c.env.SESSIONS.get(`s:${sid}`);
  return raw ? JSON.parse(raw) as SessionUser : null;
}

/** Signed-in people only. Changes also need the X-Ledger header, which other sites can't send. */
export async function requireUser(c: Ctx, next: Next) {
  const user = await currentUser(c);
  if (!user) return c.json({ error: 'Sign in to continue.' }, 401);
  if (c.req.method !== 'GET' && c.req.header('x-ledger') !== '1') return c.json({ error: 'Missing X-Ledger header.' }, 403);
  c.set('user', user);
  await next();
}

/* Slow down password guessing: 8 misses per username+IP per 15 minutes. */
export async function tooManyAttempts(env: Env, key: string) {
  const n = Number(await env.SESSIONS.get(`rl:${key}`)) || 0;
  return n >= 8;
}
export async function noteFailedAttempt(env: Env, key: string) {
  const n = Number(await env.SESSIONS.get(`rl:${key}`)) || 0;
  await env.SESSIONS.put(`rl:${key}`, String(n + 1), { expirationTtl: 900 });
}
