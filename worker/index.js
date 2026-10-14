/* Cloudflare Worker — summer-vacation
   מגיש את הממשק הבנוי (Static Assets) ומעביר את קריאות ה-API לשרת ה-Node
   (שם רצים קליטת האקסל, הקבצים והחיבור ל-Supabase). כך אין CORS, אין
   סודות בקוד, והדומיין כולו מנוהל ב-Cloudflare.

   כותרות אבטחה (בקרה יומית 14.10, רעות אישרה): נוספות כאן לכל תשובה —
   HSTS, nosniff, חסימת iframe — ומוסרת כותרת x-powered-by של Express.
   CSP רק לדפי הממשק (הנכסים): המסמכים שהשרת מייצר ב-/api (מכתבים, דוחות
   HTML לפתיחה בטאב) בנויים עם סגנונות פנימיים ולא מקבלים CSP. */

const COMMON_HEADERS = {
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

// הממשק: סקריפטים רק מהדומיין; סגנונות — Vite + React (inline) + Google Fonts;
// פונטים מ-gstatic; הורדות דרך blob:; קריאות API רק לאותו דומיין
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

function withHeaders(res, { csp }) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(COMMON_HEADERS)) out.headers.set(k, v);
  if (csp) out.headers.set('Content-Security-Policy', CSP);
  out.headers.delete('x-powered-by');
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api')) {
      const target = new URL(env.API_ORIGIN);
      url.protocol = target.protocol;
      url.hostname = target.hostname;
      url.port = target.port;
      const proxied = new Request(url, request);
      proxied.headers.set('X-Forwarded-Host', new URL(request.url).hostname);
      return withHeaders(await fetch(proxied), { csp: false });
    }
    return withHeaders(await env.ASSETS.fetch(request), { csp: true });
  },
};
