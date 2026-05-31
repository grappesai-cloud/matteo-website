// === ADMIN AUTH — two roles, cookie session ===
// Two roles share one login form:
//   • admin  → full access (products, landing, codes, orders report) — ADMIN_PASSWORD
//   • ruvix  → fulfillment only (orders dashboard, set status/AWB)    — RUVIX_PASSWORD
// A correct password mints an HMAC token that embeds the role. The token is
// `${role}.${hmac}` where hmac is keyed by THAT role's password, so a ruvix
// session can never be tampered into an admin one. No session store needed.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { AstroCookies } from 'astro';

export const COOKIE = 'mm_admin';
const SESSION_TAG = 'mattman-admin-v1';
const MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export type Role = 'admin' | 'ruvix';
export const ROLES: Role[] = ['admin', 'ruvix'];

function passwordFor(role: Role): string {
  if (role === 'ruvix') {
    return process.env.RUVIX_PASSWORD || import.meta.env.RUVIX_PASSWORD || '';
  }
  return process.env.ADMIN_PASSWORD || import.meta.env.ADMIN_PASSWORD || '';
}

/** True when the given role has a usable password configured. */
export function isConfigured(role: Role = 'admin'): boolean {
  const p = passwordFor(role);
  return !!p && p !== 'schimba-ma';
}

function sign(role: Role): string {
  return createHmac('sha256', passwordFor(role)).update(`${SESSION_TAG}:${role}`).digest('hex');
}

export function makeToken(role: Role): string {
  return `${role}.${sign(role)}`;
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** Returns the role whose password matches, or null. Admin wins on a tie. */
export function checkPassword(input: string): Role | null {
  const got = String(input ?? '');
  for (const role of ROLES) {
    const p = passwordFor(role);
    if (!p) continue;
    if (safeEqual(p, got)) return role;
  }
  return null;
}

function roleFromToken(value: string | undefined): Role | null {
  if (!value) return null;
  const dot = value.indexOf('.');
  if (dot < 0) return null;
  const role = value.slice(0, dot) as Role;
  if (!ROLES.includes(role) || !isConfigured(role)) return null;
  return safeEqual(makeToken(role), value) ? role : null;
}

/** The role of the current session, or null when not authenticated. */
export function sessionRole(cookies: AstroCookies): Role | null {
  return roleFromToken(cookies.get(COOKIE)?.value);
}

export function isAuthed(cookies: AstroCookies): boolean {
  return sessionRole(cookies) !== null;
}

/** True only for the full-access admin role (gates website-editing APIs). */
export function isAdmin(cookies: AstroCookies): boolean {
  return sessionRole(cookies) === 'admin';
}

export function setSession(cookies: AstroCookies, role: Role): void {
  cookies.set(COOKIE, makeToken(role), {
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
