import { useEffect, useState } from 'react';
import { T, STAGE_COLOR } from '../theme';
import { btn, card, input } from '../ui';
import { updateClient, ClientNode, ManageData, Alert } from '../api';
import type { Nav } from '../App';

/* לשונית הניהול של הלקוח: שלב טיפול, צ'ק-ליסט (הצעת מחיר/חשבון/חומר...),
   מי מטפל, הערות, אנשי קשר — וההתראות של הלקוח (עברו לכאן מהמסך הראשי). */

const CHECKS: { key: keyof ManageData; label: string }[] = [
  { key: 'quote_sent', label: 'נשלחה הצעת מחיר' },
  { key: 'quote_signed', label: 'הוחזרה הצעה חתומה' },
  { key: 'budget_built', label: 'נבנה תקציב' },
  { key: 'invoice_sent', label: 'נשלח חשבון' },
  { key: 'docs_mail_sent', label: 'נשלח מייל עבור דוחות' },
  { key: 'material_arrived', label: 'הגיע חומר' },
  { key: 'got_exec_reports', label: 'התקבלו דוחות ביצוע' },
  { key: 'got_cost_reports', label: 'התקבלו דוחות עלות תקינים' },
];

export default function ManagePanel({ client, onSaved, go }: { client: ClientNode; onSaved: () => void; go: (n: Nav) => void }) {
  const [md, setMd] = useState<ManageData>(client.manageData || {});
  const [stage, setStage] = useState<string>(client.manage_status || '');
  const [notes, setNotes] = useState<string>(client.manage_notes || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => { setMd(client.manageData || {}); setStage(client.manage_status || ''); setNotes(client.manage_notes || ''); }, [client.id]);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      await updateClient(client.id, {
        name: client.name, has_vat: client.has_vat, cluster_number: client.cluster_number,
        manage_status: stage || null, manage_notes: notes || null, manage_data: md,
      });
      setMsg('נשמר.');
      onSaved();
    } catch { setMsg('השמירה נכשלה.'); }
    finally { setBusy(false); }
  };

  const alerts: Alert[] = client.alerts || [];
  const labels = client.stageLabels || {};

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>ניהול הלקוח</span>
        {client.stage && (
          <span style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: STAGE_COLOR[client.stage] || T.inkSoft, borderRadius: 5, padding: '3px 10px' }}>
            {client.stageLabel}
          </span>
        )}
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
          <select value={stage} onChange={(e) => setStage(e.target.value)} style={{ ...input, padding: '6px 8px', fontSize: 12 }}
            title="דריסת השלב ידנית (ריק = נקבע אוטומטית לפי המערכת)">
            <option value="">שלב אוטומטי</option>
            {Object.entries(labels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <button onClick={save} disabled={busy} style={btn('primary')}>{busy ? 'שומר…' : 'שמירה'}</button>
          {msg && <span style={{ fontSize: 11.5, color: T.inkSoft }}>{msg}</span>}
        </span>
      </div>

      {/* צ'ק-ליסט */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(210px,1fr))', gap: 6, marginBottom: 12 }}>
        {CHECKS.map((c) => (
          <label key={String(c.key)} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 12.5, cursor: 'pointer',
            background: md[c.key] ? T.greenBg : T.paper, borderRadius: 7, padding: '7px 11px' }}>
            <input type="checkbox" checked={!!md[c.key]} onChange={(e) => setMd((p) => ({ ...p, [c.key]: e.target.checked }))} />
            {c.label}
          </label>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
        <input placeholder="מי מטפל/ת" value={md.handler || ''} onChange={(e) => setMd((p) => ({ ...p, handler: e.target.value }))}
          style={{ ...input, flex: '0 1 140px', fontSize: 12.5 }} />
        <input placeholder="תאריך קבלת חומר" value={md.material_date || ''} onChange={(e) => setMd((p) => ({ ...p, material_date: e.target.value }))}
          style={{ ...input, flex: '0 1 150px', fontSize: 12.5 }} />
        <input placeholder="הערות" value={notes} onChange={(e) => setNotes(e.target.value)}
          style={{ ...input, flex: '1 1 260px', fontSize: 12.5 }} />
      </div>

      {(md.email1 || md.phone1 || md.email2 || md.phone2) && (
        <div style={{ fontSize: 11.5, color: T.inkSoft, marginBottom: 12, display: 'flex', gap: 14, flexWrap: 'wrap' }}>
          {md.email1 && <span>📧 {md.email1}</span>}
          {md.phone1 && <span dir="ltr">📞 {md.phone1}</span>}
          {md.email2 && <span>📧 {md.email2}</span>}
          {md.phone2 && <span dir="ltr">📞 {md.phone2}</span>}
        </div>
      )}

      {/* ההתראות של הלקוח */}
      {alerts.length > 0 && (
        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>התראות ({alerts.length})</div>
          {alerts.map((a, i) => {
            const c = a.level === 'err' ? T.red : a.level === 'ok' ? T.green : T.amber;
            const bg = a.level === 'err' ? T.redBg : a.level === 'ok' ? T.greenBg : T.amberBg;
            return (
              <button key={i} onClick={() => go({ view: 'report', reportId: a.reportId, clientId: client.id })}
                style={{ display: 'flex', alignItems: 'center', gap: 8, textAlign: 'right', width: '100%', cursor: 'pointer',
                  border: `1px solid ${T.line}`, borderRight: `3px solid ${c}`, background: bg, borderRadius: 8, padding: '8px 12px', fontFamily: 'inherit', fontSize: 12.5, color: T.ink }}>
                <span style={{ width: 7, height: 7, borderRadius: '50%', background: c }} />
                {a.text}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
