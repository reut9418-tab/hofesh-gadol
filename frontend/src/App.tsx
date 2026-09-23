import { useState, useCallback, useEffect } from 'react';
import { T } from './theme';
import { FirmLogo } from './ui';
import Dashboard from './pages/Dashboard';
import ClientView from './pages/ClientView';
import ReportView from './pages/ReportView';

export type Nav =
  | { view: 'dashboard' }
  | { view: 'client'; clientId: number }
  | { view: 'report'; reportId: number; clientId: number };

/* זיהוי גרסה חדשה (23.9): האפליקציה היא עמוד יחיד — טאב פתוח ממשיך להריץ
   את הגרסה שנטענה בבוקר גם אחרי דיפלוי. בודקים מדי כמה דקות אם ה-HTML
   באתר מפנה ל-bundle אחר מזה שרץ עכשיו, ואם כן מציגים באנר רענון. */
function useUpdateAvailable() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    const current = (document.querySelector('script[src*="assets/index-"]') as HTMLScriptElement | null)?.src?.match(/index-[\w-]+\.js/)?.[0];
    if (!current) return;
    const check = async () => {
      try {
        const html = await fetch('/', { cache: 'no-store' }).then((r) => r.text());
        const latest = html.match(/index-[\w-]+\.js/)?.[0];
        if (latest && latest !== current) setAvailable(true);
      } catch { /* אופליין רגעי — ננסה בסבב הבא */ }
    };
    const id = setInterval(check, 4 * 60 * 1000);
    const onFocus = () => check();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, []);
  return available;
}

export default function App() {
  const [nav, setNav] = useState<Nav>({ view: 'dashboard' });
  const updateAvailable = useUpdateAvailable();

  const go = useCallback((n: Nav) => setNav(n), []);

  const crumb: { label: string; onClick?: () => void }[] = [{ label: 'לוח שליטה', onClick: () => go({ view: 'dashboard' }) }];
  if (nav.view === 'client') crumb.push({ label: 'לקוח' });
  if (nav.view === 'report') {
    crumb.push({ label: 'לקוח', onClick: () => go({ view: 'client', clientId: nav.clientId }) });
    crumb.push({ label: 'דוח' });
  }

  return (
    <div dir="rtl" style={{ minHeight: '100vh', background: T.paper, color: T.ink, paddingBottom: 48 }}>
      {updateAvailable && (
        <div style={{ position: 'sticky', top: 0, zIndex: 50, background: '#1F6E6B', color: '#fff',
          padding: '9px 16px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, fontSize: 13.5 }}>
          <span>עודכנה גרסה חדשה של המערכת 🎉</span>
          <button onClick={() => window.location.reload()}
            style={{ border: '1px solid #fff', background: 'transparent', color: '#fff', borderRadius: 7,
              padding: '4px 14px', cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, fontWeight: 700 }}>
            רענון וקבלת העדכון
          </button>
        </div>
      )}
      <header style={{
        background: `linear-gradient(135deg, #F8F2E3 0%, ${T.goldSoft} 100%)`,
        color: T.ink, padding: '16px 28px 14px',
        borderBottom: `2px solid ${T.gold}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <FirmLogo size={46} />
          <div>
            <div style={{ fontSize: 12, letterSpacing: '0.14em', color: T.teal, marginBottom: 4 }}>
              גוטליב את ביטון, רו"ח · מערכת החופש הגדול
            </div>
            <div style={{ fontSize: 22, fontWeight: 700, color: T.ink }}>בקרת והכנת דוחות חופש גדול</div>
          </div>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8, alignItems: 'center', fontSize: 13 }}>
          {crumb.map((c, i) => (
            <span key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              {i > 0 && <span style={{ color: T.teal }}>‹</span>}
              {c.onClick && i < crumb.length - 1 ? (
                <button onClick={c.onClick}
                  style={{ border: 'none', background: 'transparent', color: T.teal, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, padding: 0, textDecoration: 'underline' }}>
                  {c.label}
                </button>
              ) : (
                <span style={{ color: T.ink, fontWeight: 600 }}>{c.label}</span>
              )}
            </span>
          ))}
        </div>
      </header>

      <main style={{ maxWidth: 1060, margin: '0 auto', padding: '24px 20px' }}>
        {nav.view === 'dashboard' && <Dashboard go={go} />}
        {nav.view === 'client' && <ClientView clientId={nav.clientId} go={go} />}
        {nav.view === 'report' && <ReportView reportId={nav.reportId} clientId={nav.clientId} go={go} />}
      </main>
    </div>
  );
}
