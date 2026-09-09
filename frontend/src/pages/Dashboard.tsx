import { useEffect, useState } from 'react';
import { T, BUCKET_COLOR, STAGE_COLOR } from '../theme';
import { btn, card, input, Metric, pill } from '../ui';
import { getTree, getDashboard, createClient, deleteClient, ClientNode, Dashboard as Dash, Report } from '../api';
import type { Nav } from '../App';

const fmt = (n: number) => (n == null ? '—' : n.toLocaleString('he-IL'));

function ReportChip({ r, onOpen }: { r: Report; onOpen: () => void }) {
  const bucket = r.health?.bucket || 'open';
  const color = BUCKET_COLOR[bucket] || T.inkSoft;
  const errs = r.health?.exceptions.errors || 0;
  return (
    <button onClick={onOpen} title={`${r.label} · ${r.health?.bucketLabel || ''}${errs ? ` · ${errs} חריגות` : ''}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, padding: '6px 12px', borderRadius: 18, cursor: 'pointer',
        border: `1px solid ${T.line}`, background: T.paper, color: T.ink, fontFamily: 'inherit', fontSize: 12.5, fontWeight: 600,
      }}>
      <span style={{ width: 8, height: 8, borderRadius: '50%', background: color, display: 'inline-block' }} />
      {r.label}
      {errs > 0 && <span style={{ fontSize: 10.5, color: T.red, fontWeight: 700 }}>⚠{errs}</span>}
    </button>
  );
}

export default function Dashboard({ go }: { go: (n: Nav) => void }) {
  const [tree, setTree] = useState<ClientNode[]>([]);
  const [dash, setDash] = useState<Dash | null>(null);
  const [newClient, setNewClient] = useState('');
  const [newVat, setNewVat] = useState(false);
  const [query, setQuery] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    Promise.all([getTree(), getDashboard()])
      .then(([t, d]) => { setTree(t); setDash(d); setErr(null); })
      .catch(() => setErr('לא ניתן להתחבר לשרת. ודאי שהשרת (backend) רץ על פורט 3101.'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const addClient = async () => {
    const name = newClient.trim();
    if (!name) return;
    await createClient({ name, has_vat: newVat });
    setNewClient('');
    setNewVat(false);
    load();
  };

  const removeClient = async (c: ClientNode) => {
    if (!window.confirm(`למחוק את הלקוח "${c.name}" על כל הרשויות והדוחות שלו?`)) return;
    await deleteClient(c.id);
    load();
  };

  const q = query.trim();
  const shown = tree.filter((c) =>
    !q ||
    c.name.includes(q) ||
    c.authorities.some((a) => a.name.includes(q) || a.reports.some((r) => r.label.includes(q))) ||
    c.directReports.some((r) => r.label.includes(q))
  );

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {err && <div style={{ background: T.redBg, color: T.red, borderRadius: 8, padding: '12px 16px', fontSize: 13 }}>{err}</div>}

      {/* צנרת הלקוחות: מי הביא חומר, מי בטיפול, מי סיים */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 12 }}>
        <Metric label="טרם הביאו חומר" value={dash?.status?.pipeline?.counts?.no_material ?? '—'} color={T.red} />
        <Metric label="הביאו חומר — טרם טופל" value={dash?.status?.pipeline?.counts?.material ?? 0} color={T.amber} />
        <Metric label="בטיפול" value={dash?.status?.pipeline?.counts?.in_treatment ?? 0} color={T.teal} />
        <Metric label="סיימו טיפול" value={dash?.status?.pipeline?.counts?.done ?? 0} color={T.green} />
      </section>

      {/* סטטוס הדוחות */}
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12 }}>
        <Metric label="דוחות פתוחים" value={dash?.status?.buckets?.open ?? '—'} />
        <Metric label="לקראת סיום" value={dash?.status?.buckets?.near ?? 0} color={T.teal} />
        <Metric label="תקועים על חוסר" value={dash?.status?.buckets?.blocked ?? 0} color={T.amber} />
        <Metric label="מוכנים להגשה" value={dash?.status?.buckets?.ready ?? 0} color={T.green} />
      </section>

      <section style={card}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          <span style={{ fontWeight: 700, fontSize: 15, marginInlineEnd: 'auto' }}>לוח השליטה — כל הלקוחות</span>
          {tree.length > 0 && (
            <input placeholder="חיפוש לקוח / רשות / דוח" value={query} onChange={(e) => setQuery(e.target.value)}
              style={{ ...input, flex: '0 1 260px' }} />
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <input placeholder="שם הלקוח החדש" value={newClient} onChange={(e) => setNewClient(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addClient()} style={{ ...input, flex: '1 1 220px' }} />
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer' }}>
            <input type="checkbox" checked={newVat} onChange={(e) => setNewVat(e.target.checked)} />
            חייב מע"מ (18%)
          </label>
          <button onClick={addClient} style={btn('dark')}>הוספת לקוח</button>
        </div>
      </section>

      {loading && <div style={{ textAlign: 'center', color: T.inkSoft, padding: 20 }}>טוען…</div>}
      {!loading && tree.length === 0 && !err && (
        <div style={{ textAlign: 'center', color: T.inkSoft, fontSize: 14, padding: '24px 0', lineHeight: 1.9 }}>
          עוד אין לקוחות. מוסיפים את הלקוח הראשון למעלה, בתוכו מוסיפים רשות, ובתוכה פותחים דוחות.
        </div>
      )}
      {!loading && tree.length > 0 && shown.length === 0 && (
        <div style={{ textAlign: 'center', color: T.inkSoft, padding: '20px 0' }}>לא נמצאו תוצאות ל"{query}".</div>
      )}

      {shown.map((c) => {
        const total = c.directReports.length + c.authorities.reduce((s, a) => s + a.reports.length, 0);
        return (
          <section key={c.id} style={card}>
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: total ? 14 : 0 }}>
              <button onClick={() => go({ view: 'client', clientId: c.id })}
                style={{ border: 'none', background: 'transparent', color: T.teal, fontWeight: 700, fontSize: 16, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
                {c.name}
              </button>
              {c.stage && <span style={pill(STAGE_COLOR[c.stage] || T.inkSoft)}>{c.stageLabel}</span>}
              {c.has_vat && <span style={pill(T.amber)}>חייב מע"מ</span>}
              <span style={{ fontSize: 11.5, color: T.inkSoft }}>
                {c.authorities.length ? `${c.authorities.length} רשויות · ` : ''}{total} דוחות
              </span>
              <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
                <button onClick={() => go({ view: 'client', clientId: c.id })} style={btn('primary')}>ניהול הלקוח</button>
                <button title="מחיקת הלקוח" onClick={() => removeClient(c)}
                  style={{ border: 'none', background: 'transparent', color: T.red, cursor: 'pointer', fontSize: 15, fontWeight: 700, padding: 0 }}>✕</button>
              </span>
            </div>

            {c.directReports.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: c.authorities.length ? 12 : 0 }}>
                {c.directReports.map((r) => (
                  <ReportChip key={r.id} r={r} onOpen={() => go({ view: 'report', reportId: r.id, clientId: c.id })} />
                ))}
              </div>
            )}

            {c.authorities.map((a) => (
              <div key={a.id} style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 0', borderTop: `1px solid ${T.line}` }}>
                <span style={{ fontWeight: 700, fontSize: 13, minWidth: 120 }}>🏛 {a.name}</span>
                {a.reports.length === 0
                  ? <span style={{ fontSize: 12, color: T.inkSoft }}>אין דוחות</span>
                  : a.reports.map((r) => (
                      <ReportChip key={r.id} r={r} onOpen={() => go({ view: 'report', reportId: r.id, clientId: c.id })} />
                    ))}
              </div>
            ))}

            {total === 0 && <div style={{ fontSize: 12.5, color: T.inkSoft }}>עדיין אין דוחות — "ניהול הלקוח" כדי להוסיף.</div>}
          </section>
        );
      })}
    </div>
  );
}
