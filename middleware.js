import { next } from '@vercel/edge';

// Runs on every request that matches `config.matcher` below.
// Checks for a valid session cookie; if missing/wrong, bounces to /login.
// Uses plain Web Request/Response APIs — no 'next/server' import, so this
// works on a static project with no framework installed.

export const config = {
  // Everything EXCEPT: /login itself, /api/login (the endpoint that sets
  // the cookie), and static assets (logo, favicon). Without these
  // exclusions the login page would redirect to itself in an infinite loop.
  matcher: ['/((?!login$|api/login$|logo\\.png$|favicon\\.ico$).*)'],
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
