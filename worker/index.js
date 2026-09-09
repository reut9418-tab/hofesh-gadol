/* Cloudflare Worker — summer-vacation
   מגיש את הממשק הבנוי (Static Assets) ומעביר את קריאות ה-API לשרת ה-Node
   (שם רצים קליטת האקסל, הקבצים והחיבור ל-Supabase). כך אין CORS, אין
   סודות בקוד, והדומיין כולו מנוהל ב-Cloudflare. */

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
      return fetch(proxied);
    }
    return env.ASSETS.fetch(request);
  },
};
