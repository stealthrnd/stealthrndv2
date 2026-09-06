# Stealth R&D Shop Tools

Static HTML tools deployed on Vercel. No build step, no framework.

Root files (URLs drop the .html extension via vercel.json):
- terminal.html      -> /terminal
- shop_timeclock.html -> /shop_timeclock
- qc_inspection.html  -> /qc_inspection
- quote-generator.html -> /quote-generator
- login.html          -> /login

api/ folder = serverless functions (login.js, claude.js, data.js)
middleware.js = PIN-gate auth, runs on every request

Env vars required in Vercel: SHOP_PIN, SITE_TOKEN, ANTHROPIC_API_KEY, BLOB_READ_WRITE_TOKEN
