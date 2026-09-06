import { next } from '@vercel/functions';

// Runs on every request that matches `config.matcher` below.
// Checks for a valid session cookie; if missing/wrong, bounces to /login.
// Uses plain Web Request/Response APIs — no 'next/server' import, so this
// works on a static project with no framework installed.

export const config = {
  // Only these routes require the PIN. Everything else (your storefront,
  // any public pages) is untouched by this middleware entirely.
  // Add a path here any time a new shop tool needs gating.
  matcher: [
    '/terminal',
    '/shop_timeclock',
    '/qc_inspection',
    '/quote-generator',
  ],
};

export default function middleware(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)shop_session=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  const expected = process.env.SITE_TOKEN;

  if (!expected || token !== expected) {
    const loginUrl = new URL('/login', request.url);
    return Response.redirect(loginUrl, 302);
  }

  return next();
}
