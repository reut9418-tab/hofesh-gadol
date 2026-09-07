import { useEffect, useMemo, useRef, useState } from 'react';
import { T } from '../theme';
import { btn, card, input } from '../ui';
import {
  uploadCostFile, getCostFileRouting, routeCostFile, listCostFiles, deleteCostFile, setCostFilePayer,
  CostFile, DeptRow, RouteTarget, RoutingResponse,
} from '../api';

const fmt = (n: number, d = 0) =>
  n == null ? '—' : n.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });

const targetLabel = (t: RouteTarget) => (t.authorityName ? `${t.authorityName} · ${t.label}` : t.label);

/* ---------- מסך ניתוב: מחלקה → פרויקט ---------- */
function RoutingModal({ data, onClose, onDone }: { data: RoutingResponse; onClose: () => void; onDone: () => void }) {
  const { file, reports } = data;
  const [routing, setRouting] = useState<Record<string, number | null>>(() => {
    const init: Record<string, number | null> = {};
    data.departments.forEach((d) => { init[d.dept] = d.proposedReportId; });
    return init;
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setDept = (dept: string, val: number | null) => setRouting((p) => ({ ...p, [dept]: val }));
  const routeAll = (val: number | null) => {
    const next: Record<string, number | null> = {};
    data.departments.forEach((d) => { next[d.dept] = val; });
    setRouting(next);
  };

  const assignedCount = data.departments.filter((d) => routing[d.dept] != null).length;
  const assignedCost = data.departments.filter((d) => routing[d.dept] != null).reduce((s, d) => s + d.cost, 0);

  const confirm = async () => {
    setBusy(true); setErr(null);
    try { await routeCostFile(file.id, routing); onDone(); }
    catch { setErr('שמירת הניתוב נכשלה.'); setBusy(false); }
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(24,42,51,0.55)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: '30px 16px', zIndex: 50, overflowY: 'auto' }}>
      <div style={{ ...card, maxWidth: 860, width: '100%', padding: 0 }} dir="rtl">
        {/* כותרת */}
        <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.line}` }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 16 }}>ניתוב מחלקות לפרויקטים</span>
            <span style={{ fontSize: 11.5, color: T.teal, background: T.tealSoft, borderRadius: 5, padding: '2px 8px' }}>{file.software}</span>
            <button onClick={onClose} style={{ marginInlineStart: 'auto', border: 'none', background: 'transparent', color: T.inkSoft, fontSize: 18, cursor: 'pointer', padding: 0 }}>✕</button>
          </div>
          <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 6 }}>
            {file.filename} · {data.departments.length} מחלקות · {file.rowCount} שורות שכר
          </div>
          <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 8, lineHeight: 1.6 }}>
            לכל מחלקה בחרי לאיזה דוח היא שייכת, או <b>"לא רלוונטי"</b> אם היא אינה חלק מפרויקטי הקיץ.
            הבחירה נזכרת — בהעלאה הבאה המערכת תציע את אותו הניתוב לבד.
          </div>
        </div>

        {/* ניתוב מהיר של כל הקובץ (למשל קובץ נפרד לכל בי"ס) */}
        <div style={{ padding: '10px 20px', background: T.paper, borderBottom: `1px solid ${T.line}`, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: T.inkSoft }}>ניתוב מהיר של כל הקובץ ל:</span>
          <select onChange={(e) => routeAll(e.target.value === '' ? null : Number(e.target.value))} defaultValue=""
            style={{ ...input, padding: '6px 8px', fontSize: 12.5 }}>
            <option value="__none__" disabled>בחרי יעד…</option>
            {reports.map((t) => <option key={t.id} value={t.id}>{targetLabel(t)}</option>)}
            <option value="">לא רלוונטי (כל המחלקות)</option>
          </select>
          <span style={{ fontSize: 11.5, color: T.inkSoft }}>שימושי כשכל הקובץ שייך לפרויקט אחד.</span>
        </div>

        {/* טבלת מחלקות */}
        <div style={{ maxHeight: '48vh', overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, background: T.card, textAlign: 'right', color: T.inkSoft, fontSize: 11.5 }}>
                <th style={{ padding: '8px 20px', fontWeight: 600 }}>מחלקה / תיאור סעיף</th>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}>עובדים</th>
                <th style={{ padding: '8px 6px', fontWeight: 600 }}>עלות</th>
                <th style={{ padding: '8px 20px', fontWeight: 600, width: 240 }}>שייך לדוח</th>
              </tr>
            </thead>
            <tbody>
              {data.departments.map((d) => {
                const assigned = routing[d.dept] != null;
                return (
                  <tr key={d.dept} style={{ borderTop: `1px solid ${T.line}`, background: assigned ? T.greenBg + '55' : undefined }}>
                    <td style={{ padding: '8px 20px', fontWeight: 600 }}>
                      {d.dept}
                      {d.learned && <span style={{ marginInlineStart: 6, fontSize: 10, color: T.teal }}>◆ נלמד</span>}
                    </td>
                    <td style={{ padding: '8px 6px', color: T.inkSoft }}>{d.workers}</td>
                    <td style={{ padding: '8px 6px', color: T.inkSoft }}>₪{fmt(d.cost)}</td>
                    <td style={{ padding: '8px 20px' }}>
                      <select value={routing[d.dept] == null ? '' : String(routing[d.dept])}
                        onChange={(e) => setDept(d.dept, e.target.value === '' ? null : Number(e.target.value))}
                        style={{ ...input, padding: '6px 8px', fontSize: 12.5, width: '100%',
                          borderColor: assigned ? T.green : T.line }}>
                        <option value="">— לא רלוונטי —</option>
                        {reports.map((t) => <option key={t.id} value={t.id}>{targetLabel(t)}</option>)}
                      </select>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* תחתית */}
        <div style={{ padding: '12px 20px', borderTop: `1px solid ${T.line}`, display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 12.5, color: T.inkSoft }}>
            {assignedCount} מתוך {data.departments.length} מחלקות שויכו · ₪{fmt(assignedCost)}
          </span>
          {err && <span style={{ fontSize: 12.5, color: T.red }}>{err}</span>}
          <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={onClose} style={btn('ghost')}>ביטול</button>
            <button onClick={confirm} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>
              {busy ? 'שומר…' : 'אישור הניתוב'}
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}

/* ---------- פאנל דוחות עלות ברמת הלקוח ---------- */
export default function CostReportsPanel({ clientId, onRouted }: { clientId: number; onRouted: () => void }) {
  const [files, setFiles] = useState<CostFile[]>([]);
  const [routing, setRouting] = useState<RoutingResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => listCostFiles(clientId).then(setFiles).catch(() => setFiles([]));
  useEffect(() => { load(); }, [clientId]);

  const onPick = async (fileList: FileList | null) => {
    if (!fileList || !fileList.length) return;
    setBusy(true); setErr(null);
    try {
      // מעלים קובץ-קובץ; מסך הניתוב נפתח על האחרון (השאר נשמרים וממתינים לניתוב)
      let last: RoutingResponse | null = null;
      for (const f of Array.from(fileList)) last = await uploadCostFile(clientId, f);
      await load();
      if (last) setRouting(last);
    } catch (e: any) {
      setErr(e?.response?.data?.error || 'העלאת הקובץ נכשלה.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const openRouting = async (fileId: number) => {
    try { setRouting(await getCostFileRouting(fileId)); }
    catch { setErr('טעינת מסך הניתוב נכשלה.'); }
  };
  const removeFile = async (f: CostFile) => {
    if (!window.confirm(`למחוק את דוח העלות "${f.filename}" ואת כל שורותיו?`)) return;
    await deleteCostFile(f.id); await load(); onRouted();
  };

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 4 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>דוחות עלות שכר</span>
        <span style={{ fontSize: 12, color: T.inkSoft }}>קובץ אחד עם כמה מחלקות מתפזר אוטומטית לפרויקטים; אפשר גם כמה קבצים לאותו דוח.</span>
        <span style={{ marginInlineStart: 'auto' }}>
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.csv" multiple style={{ display: 'none' }}
            onChange={(e) => onPick(e.target.files)} />
          <button onClick={() => inputRef.current?.click()} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>
            {busy ? 'מעלה…' : '＋ העלאת דוח עלות'}
          </button>
        </span>
      </div>

      {err && <div style={{ fontSize: 12.5, color: T.red, marginTop: 8 }}>{err}</div>}

      <div style={{ display: 'grid', gap: 6, marginTop: 12 }}>
        {files.length === 0 && <div style={{ fontSize: 13, color: T.inkSoft }}>טרם הועלו דוחות עלות.</div>}
        {files.map((f) => (
          <div key={f.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', borderRadius: 8, border: `1px solid ${T.line}`, background: T.paper, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 13, fontWeight: 600 }}>{f.filename}</span>
            <span style={{ fontSize: 11, color: T.inkSoft }}>{f.software} · {f.rowCount} שורות</span>
            <input defaultValue={f.payer || ''} placeholder='משלם (מתנ"ס/רשות)'
              title='מי שילם לעובדים בקובץ זה — נרשם ב"הועסק ע&quot;י" ומפריד את הכרטסות'
              onBlur={async (e) => { const v = e.target.value.trim(); if (v !== (f.payer || '')) { await setCostFilePayer(f.id, v || null); load(); } }}
              style={{ ...input, padding: '3px 8px', fontSize: 11, width: 140, borderColor: f.payer ? T.green : T.line }} />
            {f.routed
              ? <span style={{ fontSize: 10.5, fontWeight: 700, color: T.green, background: T.greenBg, borderRadius: 5, padding: '2px 7px' }}>נותב · {f.routedRows} שורות בדוחות</span>
              : <span style={{ fontSize: 10.5, fontWeight: 700, color: T.amber, background: T.amberBg, borderRadius: 5, padding: '2px 7px' }}>ממתין לניתוב</span>}
            <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={() => openRouting(f.id)} style={btn(f.routed ? 'ghost' : 'dark')}>{f.routed ? 'עריכת ניתוב' : 'ניתוב'}</button>
              <button title="מחיקת הקובץ" onClick={() => removeFile(f)}
                style={{ border: 'none', background: 'transparent', color: T.red, cursor: 'pointer', fontSize: 14, fontWeight: 700, padding: 0 }}>✕</button>
            </span>
          </div>
        ))}
      </div>

      {routing && (
        <RoutingModal data={routing} onClose={() => setRouting(null)}
          onDone={() => { setRouting(null); load(); onRouted(); }} />
      )}
    </section>
  );
}
