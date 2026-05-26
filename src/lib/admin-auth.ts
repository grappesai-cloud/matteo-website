// === ADMIN AUTH — single shared password, cookie session ===
// A correct ADMIN_PASSWORD mints an HMAC token stored in an httpOnly cookie.
// Verification recomputes the token; no session store needed.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';

export const COOKIE = 'mm_admin';
const SESSION_TAG = 'mattman-admin-v1';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function password(): string {
  return process.env.ADMIN_PASSWORD || import.meta.env.ADMIN_PASSWORD || '';
}

export function isConfigured(): boolean {
  const p = password();
  return !!p && p !== 'schimba-ma';
}

export function makeToken(): string {
  return createHmac('sha256', password()).update(SESSION_TAG).digest('hex');
}

export function checkPassword(input: string): boolean {
  const expected = Buffer.from(password());
  const got = Buffer.from(String(input ?? ''));
  if (!password() || expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

function verifyToken(value: string | undefined): boolean {
  if (!value || !isConfigured()) return false;
  const expected = Buffer.from(makeToken());
  const got = Buffer.from(value);
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

export function isAuthed(cookies: AstroCookies): boolean {
  return verifyToken(cookies.get(COOKIE)?.value);
}

export function setSession(cookies: AstroCookies): void {
  cookies.set(COOKIE, makeToken(), {
    httpOnly: true,
    secure: import.meta.env.PROD,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
  });
}

export function clearSession(cookies: AstroCookies): void {
  cookies.delete(COOKIE, { path: '/' });
}
