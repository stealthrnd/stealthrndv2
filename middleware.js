// ============================================
// STEALTH R&D — PIN GATE MIDDLEWARE
// Version: 1.0.0
// Updated: 2026-09-06
// Pairs with: login.html v1.0.0, api/login.js v1.0.0
// ============================================
// Gates the whole site behind a PIN.
// Anything not matched below requires a valid session cookie.

export const config = {
  matcher: ['/((?!login|api/login|_vercel|favicon.ico).*)']
};

export default function middleware(request) {
  const cookie = request.headers.get('cookie') || '';
  const match = cookie.match(/(?:^|;\s*)srnd=([^;]+)/);
  const token = match ? decodeURIComponent(match[1]) : null;

  if (token && token === process.env.SITE_TOKEN) {
    return; // let the request through
  }

  const url = new URL(request.url);
  return Response.redirect(new URL('/login', url.origin), 307);
}
