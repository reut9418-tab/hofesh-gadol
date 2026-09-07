import { useEffect, useState } from 'react';
import { T, STATUS_HE, STATUS_COLOR, BUCKET_COLOR } from '../theme';
import { btn, card, input } from '../ui';
import {
  getClient, updateClient, ClientNode, Report, createAuthority, deleteAuthority,
  createReport, deleteReport,
} from '../api';
import CostReportsPanel from './CostReports';
import type { Nav } from '../App';

const FRAMEWORKS = [
  { key: 'gardens', label: 'גנים' },
  { key: 'schools', label: 'בתי ספר' },
  { key: 'prep', label: 'מכינות קיץ' },
];
const PROGRAMS = [
  { key: 'base15', label: '15 יום' },
  { key: 'extension', label: 'הרחבה' },
];

function AddReport({ clientId, authorityId, onDone }: { clientId: number; authorityId: number | null; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [framework, setFramework] = useState('gardens');
  const [program, setProgram] = useState('base15');
  const [extDays, setExtDays] = useState(6);
  const isPrep = framework === 'prep';

  const add = async () => {
    await createReport({
      client_id: clientId,
      authority_id: authorityId,
      framework,
      program: isPrep ? 'base' : program,
      extension_days: !isPrep && program === 'extension' ? extDays : 0,
    });
    setOpen(false);
    onDone();
  };

  if (!open) return <button onClick={() => setOpen(true)} style={btn('ghost')}>+ הוספת דוח</button>;
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', background: T.paper, borderRadius: 8, padding: '8px 10px' }}>
      <select value={framework} onChange={(e) => setFramework(e.target.value)} style={{ ...input, padding: '6px 8px', fontSize: 12.5 }}>
        {FRAMEWORKS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
      </select>
      {!isPrep && (
        <select value={program} onChange={(e) => setProgram(e.target.value)} style={{ ...input, padding: '6px 8px', fontSize: 12.5 }}>
          {PROGRAMS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
        </select>
      )}
      {!isPrep && program === 'extension' && (
        <label style={{ fontSize: 12, color: T.inkSoft, display: 'flex', alignItems: 'center', gap: 4 }}>
          ימי הרחבה:
          <input type="number" min={0} max={60} value={extDays} onChange={(e) => setExtDays(parseInt(e.target.value) || 0)}
            style={{ ...input, padding: '6px 8px', width: 64, fontSize: 12.5 }} />
        </label>
      )}
      <button onClick={add} style={btn('dark')}>הוספה</button>
      <button onClick={() => setOpen(false)} style={btn('ghost')}>ביטול</button>
    </div>
  );
}

function ReportRow({ r, onOpen, onDelete }: { r: Report; onOpen: () => void; onDelete: () => void }) {
  const h = r.health;
  const dot = h ? BUCKET_COLOR[h.bucket] : (STATUS_COLOR[r.status] || T.inkSoft);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.paper }}>
      <span style={{ width: 9, height: 9, borderRadius: '50%', background: dot }} />
      <button onClick={onOpen} style={{ border: 'none', background: 'transparent', color: T.teal, fontWeight: 700, fontSize: 13.5, cursor: 'pointer', fontFamily: 'inherit', padding: 0 }}>
        {r.label}
      </button>
      <span style={{ fontSize: 11, color: T.inkSoft }}>
        {h ? `${h.bucketLabel} · ${h.completion}%` : (STATUS_HE[r.status] || r.status)}
        {r.program === 'extension' ? ` · ${r.extension_days} ימי הרחבה` : ''}
      </span>
      {h && h.exceptions.errors > 0 && <span style={{ fontSize: 10.5, color: T.red, fontWeight: 700 }}>⚠ {h.exceptions.errors} חריגות</span>}
      <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={onOpen} style={btn('primary')}>פתיחה</button>
        <button title="מחיקת הדוח" onClick={onDelete}
          style={{ border: 'none', background: 'transparent', color: T.red, cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: 0 }}>✕</button>
      </span>
    </div>
  );
}

export default function ClientView({ clientId, go }: { clientId: number; go: (n: Nav) => void }) {
  const [client, setClient] = useState<ClientNode | null>(null);
  const [newAuthority, setNewAuthority] = useState('');

  const load = () => getClient(clientId).then(setClient).catch(() => setClient(null));
  useEffect(() => { load(); }, [clientId]);

  if (!client) return <div style={{ color: T.inkSoft, padding: 20 }}>טוען…</div>;

  const addAuthority = async () => {
    const name = newAuthority.trim();
    if (!name) return;
    await createAuthority(clientId, name);
    setNewAuthority('');
    load();
  };
  const removeReport = async (r: Report) => {
    if (!window.confirm(`למחוק את הדוח "${r.label}"?`)) return;
    await deleteReport(r.id); load();
  };
  const removeAuthority = async (aId: number, name: string, count: number) => {
    if (!window.confirm(`למחוק את הרשות "${name}" על כל ${count} הדוחות שלה?`)) return;
    await deleteAuthority(aId); load();
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={card}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>{client.name}</span>
          {client.cluster_number != null && <span style={{ fontSize: 12, color: T.inkSoft }}>אשכול למ"ס: {client.cluster_number}</span>}
          {/* הגדרת מע"מ פר-לקוח (§7) — משפיעה על התאמת הביצוע (עלות × 1.18) */}
          <label style={{ marginInlineStart: 'auto', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer',
            background: client.has_vat ? T.amberBg : T.paper, borderRadius: 6, padding: '4px 10px',
            color: client.has_vat ? T.amber : T.inkSoft, fontWeight: 600 }}>
            <input type="checkbox" checked={client.has_vat}
              onChange={async (e) => { await updateClient(clientId, { name: client.name, has_vat: e.target.checked, cluster_number: client.cluster_number, notes: client.notes || undefined }); load(); }} />
            לקוח חייב מע"מ (18%)
          </label>
        </div>
      </section>

      {/* דוחות עלות שכר — ניתוב חוצה-פרויקטים (צעד 3) */}
      <CostReportsPanel clientId={clientId} onRouted={load} />

      {/* דוחות ישנים שנפתחו ישירות תחת הלקוח (ללא רשות) — פתיחת דוחות חדשים נעשית תחת רשות בלבד */}
      {client.directReports.length > 0 && (
        <section style={card}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>דוחות ללא רשות</div>
          <div style={{ fontSize: 12, color: T.inkSoft, marginBottom: 12 }}>דוחות שנפתחו בעבר ישירות תחת הלקוח. דוחות חדשים פותחים בתוך רשות.</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {client.directReports.map((r) => (
              <ReportRow key={r.id} r={r} onOpen={() => go({ view: 'report', reportId: r.id, clientId })} onDelete={() => removeReport(r)} />
            ))}
          </div>
        </section>
      )}

      {/* רשויות — הדוחות נפתחים כאן, בתוך הרשות */}
      <section style={card}>
        <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 4 }}>רשויות ודוחות</div>
        <div style={{ fontSize: 12, color: T.inkSoft, marginBottom: 12 }}>מוסיפים רשות, ובתוכה פותחים את הדוחות (הפרויקטים) שלה.</div>
        <div style={{ display: 'grid', gap: 12 }}>
          {client.authorities.length === 0 && <div style={{ fontSize: 13, color: T.inkSoft }}>עוד אין רשויות — מוסיפים רשות למטה, ובתוכה פותחים דוחות.</div>}
          {client.authorities.map((a) => (
            <div key={a.id} style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: '12px 14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                <span style={{ fontWeight: 700, fontSize: 14 }}>🏛 {a.name}</span>
                <span style={{ fontSize: 11.5, color: T.inkSoft }}>{a.reports.length} דוחות</span>
                <button title="מחיקת הרשות" onClick={() => removeAuthority(a.id, a.name, a.reports.length)}
                  style={{ marginInlineStart: 'auto', border: 'none', background: 'transparent', color: T.red, cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: 0 }}>✕</button>
              </div>
              <div style={{ display: 'grid', gap: 6, marginBottom: 10 }}>
                {a.reports.map((r) => (
                  <ReportRow key={r.id} r={r} onOpen={() => go({ view: 'report', reportId: r.id, clientId })} onDelete={() => removeReport(r)} />
                ))}
              </div>
              <AddReport clientId={clientId} authorityId={a.id} onDone={load} />
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <input placeholder="שם הרשות החדשה" value={newAuthority} onChange={(e) => setNewAuthority(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addAuthority()} style={{ ...input, flex: '1 1 220px' }} />
          <button onClick={addAuthority} style={btn('dark')}>הוספת רשות</button>
        </div>
      </section>
    </div>
  );
}
