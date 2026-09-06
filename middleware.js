import { next } from '@vercel/functions';

// Runs on every request that matches `config.matcher` below.
// Checks for a valid session cookie; if missing/wrong, bounces to /login.
// Uses plain Web Request/Response APIs — no 'next/server' import, so this
// works on a static project with no framework installed.
//
// DEFAULT-DENY: everything is gated except the small public allowlist
// below. A new route (a future storefront page, a new API endpoint)
// is protected automatically — you only ever have to remember to open
// something up, never to remember to lock it down.
//
// /login and /api/login are the only ways in, so they must stay public
// or nobody — including you — can ever authenticate.
export const config = {
  matcher: [
    '/((?!login$|api/login$).*)',
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
