import { useEffect, useRef, useState } from 'react';
import { T, STATUS_HE, STATUS_COLOR, BUCKET_COLOR } from '../theme';
import { btn, card, pill } from '../ui';
import { getReport, updateReport, getReportCosts, getReportBudget, uploadBudgetFile, stage2DocUrl, stage2DetailDocUrl, saveAuthorityEstimate, downloadExport, uploadFinalExecFile } from '../api';
import PrepSection from './PrepSection';
import LedgerSection from './LedgerSection';
import type { Nav } from '../App';

const fmt = (n: number, d = 0) =>
  n == null ? '—' : n.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });

/* ---------- תקציב הדוח (§9): נבנה מדוח הביצוע של המשרד, מול הניצול בפועל ---------- */
function BudgetSection({ reportId, onChange }: { reportId: number; onChange: () => void }) {
  const [data, setData] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const load = () => getReportBudget(reportId).then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, [reportId]);

  const onPick = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true); setErr(null); setWarn(null);
    try {
      const res = await uploadBudgetFile(reportId, files[0]);
      setWarn(res?.warning || null);
      await load(); onChange();
    }
    catch (e: any) { setErr(e?.response?.data?.error || 'העלאת דוח הביצוע נכשלה.'); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const has = data && data.institutions?.length > 0;
  const util = has && data.totalBudget > 0 ? data.totalActual / data.totalBudget : 0;

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: has ? 14 : 4 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>תקציב מול ניצול</span>
        <span style={{ fontSize: 11.5, color: T.inkSoft }}>התקציב נבנה אוטומטית מכמות הילדים שבדוח הביצוע של המשרד.</span>
        <span style={{ marginInlineStart: 'auto' }}>
          <input ref={inputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={(e) => onPick(e.target.files)} />
          <button onClick={() => inputRef.current?.click()} disabled={busy} style={{ ...btn(has ? 'ghost' : 'primary'), opacity: busy ? 0.6 : 1 }}>
            {busy ? 'בונה תקציב…' : has ? 'עדכון דוח ביצוע' : '＋ העלאת דוח ביצוע'}
          </button>
        </span>
      </div>
      {err && <div style={{ fontSize: 12.5, color: T.red, marginBottom: 8 }}>{err}</div>}
      {warn && <div style={{ fontSize: 12.5, color: T.amber, background: T.amberBg, borderRadius: 8, padding: '7px 11px', marginBottom: 8 }}>{warn}</div>}
      {!has && !err && <div style={{ fontSize: 13, color: T.inkSoft }}>טרם הועלה דוח ביצוע. מעלים את קובץ המשרד, והתקציב לכל מוסד ייבנה אוטומטית.</div>}

      {has && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 10, marginBottom: 12 }}>
            <div style={{ background: T.paper, borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ fontSize: 11, color: T.inkSoft }}>תקציב מאושר</div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>₪{fmt(data.totalBudget)}</div>
            </div>
            <div style={{ background: T.paper, borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ fontSize: 11, color: T.inkSoft }}>ניצול בפועל</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: T.teal }}>₪{fmt(data.totalActual)}</div>
            </div>
            <div style={{ background: T.paper, borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ fontSize: 11, color: T.inkSoft }}>תת-ניצול (כסף על השולחן)</div>
              <div style={{ fontSize: 17, fontWeight: 700, color: data.underUtilization > 0 ? T.amber : T.green }}>₪{fmt(data.underUtilization)}</div>
            </div>
          </div>
          <div style={{ height: 8, background: T.paper, borderRadius: 4, overflow: 'hidden', marginBottom: 4 }}>
            <div style={{ width: `${Math.min(100, util * 100)}%`, height: '100%', background: util > 1 ? T.red : T.teal }} />
          </div>
          <div style={{ fontSize: 11, color: T.inkSoft, marginBottom: 12 }}>ניצול {fmt(util * 100, 0)}% מהתקציב</div>

          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'right', color: T.inkSoft, fontSize: 11 }}>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>סמל</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>מוסד</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>גודל</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>ילדים</th>
                  <th style={{ padding: '6px 8px', fontWeight: 600 }}>תקציב</th>
                </tr>
              </thead>
              <tbody>
                {data.institutions.map((i: any, k: number) => (
                  <tr key={k} style={{ borderTop: `1px solid ${T.line}` }}>
                    <td style={{ padding: '6px 8px', color: T.inkSoft, direction: 'ltr', textAlign: 'right' }}>{i.symbol}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>{i.name || '—'}</td>
                    <td style={{ padding: '6px 8px', color: T.inkSoft }}>{i.size === 'large' ? 'גדול' : 'קטן'}</td>
                    <td style={{ padding: '6px 8px' }}>{i.children}</td>
                    <td style={{ padding: '6px 8px', fontWeight: 600 }}>₪{fmt(i.budget)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}

/* ---------- דוח העלות המנותב לדוח זה + בקרות ---------- */
function CostSection({ reportId }: { reportId: number }) {
  const [data, setData] = useState<any>(null);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => { getReportCosts(reportId).then(setData).catch(() => setData(null)); }, [reportId]);

  if (!data) return null;
  const { rows, summary } = data;
  if (!rows.length) {
    return (
      <section style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>דוח עלות שכר</div>
        <div style={{ fontSize: 13, color: T.inkSoft }}>
          טרם נותבו מחלקות לדוח זה. מעלים דוח עלות במסך הלקוח ומנתבים אליו את המחלקות הרלוונטיות.
        </div>
      </section>
    );
  }
  const flagColor = (lvl: string) => (lvl === 'err' ? T.red : T.amber);
  const shown = showAll ? rows : rows.slice(0, 12);

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>דוח עלות שכר (מנותב)</span>
        <span style={{ fontSize: 11.5, color: T.inkSoft }}>מחלקות: {summary.departments.join(' · ')}</span>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(120px,1fr))', gap: 10, marginBottom: 14 }}>
        {[
          { l: 'עובדים', v: fmt(summary.workers) },
          { l: summary.vatFactor > 1 ? 'עלות מעביד (נטו)' : 'עלות מעביד', v: '₪' + fmt(summary.totalCost) },
          // לקוח חייב מע"מ: העלות המוכרת מול המשרד = עלות × 1.18
          ...(summary.vatFactor > 1 ? [{ l: 'עלות מוכרת (כולל מע"מ)', v: '₪' + fmt(summary.totalCostRecognized), c: T.teal }] : []),
          { l: 'סה"כ שעות', v: fmt(summary.totalHours) },
          { l: 'שגיאות', v: fmt(summary.errors), c: summary.errors ? T.red : T.green },
          { l: 'אזהרות', v: fmt(summary.warnings), c: summary.warnings ? T.amber : T.green },
        ].map((m, i) => (
          <div key={i} style={{ background: T.paper, borderRadius: 8, padding: '8px 12px' }}>
            <div style={{ fontSize: 11, color: T.inkSoft }}>{m.l}</div>
            <div style={{ fontSize: 17, fontWeight: 700, color: (m as any).c || T.ink }}>{m.v}</div>
          </div>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ textAlign: 'right', color: T.inkSoft, fontSize: 11 }}>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>שם</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>ת.ז</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>מחלקה</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>ברוטו שעתי</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>שעות</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>בקרות</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r: any, i: number) => (
              <tr key={i} style={{ borderTop: `1px solid ${T.line}` }}>
                <td style={{ padding: '6px 8px', fontWeight: 600 }}>{r.name || '—'}</td>
                <td style={{ padding: '6px 8px', color: T.inkSoft, direction: 'ltr', textAlign: 'right' }}>{r.id}</td>
                <td style={{ padding: '6px 8px', color: T.inkSoft }}>{r.dept}</td>
                <td style={{ padding: '6px 8px' }}>{r.hourlyGross != null ? '₪' + fmt(r.hourlyGross, 1) : '—'}</td>
                <td style={{ padding: '6px 8px' }}>{r.hours != null ? fmt(r.hours, 1) : '—'}</td>
                <td style={{ padding: '6px 8px' }}>
                  {r.flags.length === 0
                    ? <span style={{ color: T.green }}>✓</span>
                    : r.flags.map((f: any, j: number) => (
                        <span key={j} style={{ display: 'inline-block', fontSize: 10.5, color: flagColor(f.level), background: f.level === 'err' ? T.redBg : T.amberBg, borderRadius: 4, padding: '1px 6px', marginInlineEnd: 4, marginBottom: 2 }}>{f.text}</span>
                      ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > 12 && (
        <button onClick={() => setShowAll((s) => !s)} style={{ ...btn('ghost'), marginTop: 10 }}>
          {showAll ? 'הצג פחות' : `הצג את כל ${rows.length} השורות`}
        </button>
      )}
    </section>
  );
}

/* ---------- הערכת עלות שכר רשות (כשהרשות לא מעבירה דוח עלות) — למכתב בלבד ---------- */
function AuthorityEstimateSection({ rep, onChange }: { rep: any; onChange: () => void }) {
  const isGardens = rep.framework === 'gardens';
  const initSplit = (() => {
    try { return Object.entries(JSON.parse(rep.authority_estimate_split || '{}')).map(([symbol, amount]) => ({ symbol, amount: String(amount) })); }
    catch { return []; }
  })();
  const [amount, setAmount] = useState(rep.authority_estimate ? String(rep.authority_estimate) : '');
  const [rows, setRows] = useState<{ symbol: string; amount: string }[]>(initSplit.length ? initSplit : [{ symbol: '', amount: '' }]);
  const [basket, setBasket] = useState(rep.authority_estimate_basket || 'instruction');
  const [note, setNote] = useState(rep.authority_estimate_note || '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const num = (s: string) => Number(String(s).replace(/[,₪\s]/g, '')) || 0;
  const total = isGardens ? num(amount) : rows.reduce((s, r) => s + num(r.amount), 0);
  const saved = isGardens ? Number(rep.authority_estimate) || 0
    : initSplit.reduce((s, r) => s + num(r.amount), 0);
  // דוח עלות עם משלם "רשות" כבר נקלט — סכנת ספירה כפולה
  const authorityPayer = (rep.cost_payers || []).find((p: string) => /רשות|עירי|מועצ/.test(p) || (rep.authority?.name && p.includes(rep.authority.name)));
  const symbols: { symbol: string; name: string }[] = rep.institutions || [];

  const save = async (clear = false) => {
    setBusy(true); setErr(null); setMsg(null);
    try {
      const split = isGardens || clear ? null
        : Object.fromEntries(rows.filter((r) => r.symbol.trim() && num(r.amount) > 0).map((r) => [r.symbol.trim(), num(r.amount)]));
      await saveAuthorityEstimate(rep.id, { amount: clear ? 0 : (isGardens ? num(amount) : 0), basket, note: clear ? '' : note, split });
      if (clear) { setAmount(''); setRows([{ symbol: '', amount: '' }]); setNote(''); }
      setMsg(clear ? 'ההערכה הוסרה.' : 'נשמר — המכתב יחושב עם ההערכה.');
      onChange();
    } catch (e: any) { setErr(e?.response?.data?.error || 'השמירה נכשלה.'); }
    finally { setBusy(false); }
  };

  const input = { padding: '5px 8px', fontSize: 12.5, borderRadius: 6, fontFamily: 'inherit', border: `1px solid ${T.line}` } as const;

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>הערכת עלות שכר רשות (טרם התקבל דוח עלות)</span>
        {saved > 0 && <span style={pill(T.amber)}>פעיל במכתב: ₪{fmt(saved)}</span>}
      </div>
      <div style={{ fontSize: 11.5, color: T.inkSoft, marginBottom: 12, lineHeight: 1.6 }}>
        הסכום הסופי כפי שיופיע בדוח הביצוע (בלי תוספת מע"מ ובלי תקרת 140%). משפיע <b>על המכתב בלבד</b> — ניצול השכר מול הסלים, הסל הגמיש והיתרות.
        לא נכתב לקובץ המשרד ולא נכנס ליעדי הכרטסות. דוח הביצוע יושפע רק כשיועלה דוח עלות של הרשות.
      </div>
      {authorityPayer && saved > 0 && (
        <div style={{ fontSize: 12.5, color: T.red, background: T.redBg, borderRadius: 8, padding: '7px 11px', marginBottom: 10 }}>
          ⚠ כבר נקלט לדוח זה דוח עלות עם המשלם "{authorityPayer}" — ייתכן שההערכה נספרת פעמיים. אם זה דוח העלות של הרשות, יש להסיר את ההערכה.
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {isGardens ? (
          <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
            סכום ההערכה (₪)
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" placeholder="למשל 320000" style={{ ...input, width: 150 }} />
          </label>
        ) : (
          <div style={{ display: 'grid', gap: 6, fontSize: 12 }}>
            <span>שיוך לסמל מוסד</span>
            {rows.map((r, i) => (
              <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <select value={r.symbol} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, symbol: e.target.value } : x)))} style={{ ...input, width: 230 }}>
                  <option value="">— בחירת מוסד —</option>
                  {symbols.map((s) => <option key={s.symbol} value={String(s.symbol)}>{s.symbol} — {s.name}</option>)}
                </select>
                <input value={r.amount} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))}
                  inputMode="numeric" placeholder="סכום ₪" style={{ ...input, width: 120 }} />
                {rows.length > 1 && <button onClick={() => setRows(rows.filter((_, j) => j !== i))} style={{ ...btn('ghost'), padding: '3px 8px' }}>✕</button>}
              </div>
            ))}
            <button onClick={() => setRows([...rows, { symbol: '', amount: '' }])} style={{ ...btn('ghost'), justifySelf: 'start' }}>＋ מוסד נוסף</button>
          </div>
        )}
        <label style={{ display: 'grid', gap: 4, fontSize: 12 }}>
          סל
          <select value={basket} onChange={(e) => setBasket(e.target.value)} style={{ ...input, width: 190 }}>
            <option value="instruction">{isGardens ? 'שכר מובילות וסייעות' : 'שכר צוות חינוכי'}</option>
            <option value="coordinator">{isGardens ? 'שכר רכזות גנים' : 'שכר רכזים'}</option>
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 12, flex: '1 1 200px' }}>
          הערה (תופיע במכתב)
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="למשל: לפי שנה קודמת" style={{ ...input }} />
        </label>
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 12, flexWrap: 'wrap' }}>
        <button onClick={() => save(false)} disabled={busy || !(total > 0)} style={{ ...btn('primary'), opacity: busy || !(total > 0) ? 0.6 : 1 }}>
          {busy ? 'שומר…' : `שמירה${total > 0 ? ` (₪${fmt(total)})` : ''}`}
        </button>
        {saved > 0 && <button onClick={() => save(true)} disabled={busy} style={btn('ghost')}>הסרת ההערכה</button>}
        {msg && <span style={{ fontSize: 12, color: T.green }}>{msg}</span>}
        {err && <span style={{ fontSize: 12, color: T.red }}>{err}</span>}
      </div>
    </section>
  );
}

/* הורדת דוח הביצוע הממולא גם משלב 2 — אחרי העלאת כרטסות (ההוצאות בפועל
   מהכרטסות נכתבות לקובץ) בלי לחזור לשלב 1 (בקשת רעות 5.10) */
function Stage2ExportButton({ reportId }: { reportId: number }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const run = async () => {
    setBusy(true); setMsg(null);
    try { await downloadExport(reportId); setMsg('✓ הקובץ ירד לתיקיית ההורדות.'); }
    catch (e: any) {
      // שגיאה מהשרת מגיעה כ-blob (responseType) — קוראים את הטקסט
      let text = 'ההורדה נכשלה — נסי שוב.';
      try { const t = await e?.response?.data?.text?.(); if (t) text = JSON.parse(t).error || text; } catch { /* נשאר הכללי */ }
      setMsg(text);
    } finally { setBusy(false); }
  };
  return (
    <>
      <button onClick={run} disabled={busy} style={{ ...btn('primary'), opacity: busy ? 0.6 : 1 }}>
        {busy ? '⏳ מכין את הקובץ…' : '⬇ הורדת דוח ביצוע ממולא'}
      </button>
      {msg && <span style={{ fontSize: 12, color: msg.startsWith('✓') ? T.green : T.red, flexBasis: '100%' }}>{msg}</span>}
    </>
  );
}

/* העלאת דוח הביצוע הסופי (רעות 6.10): מורידים את הדוח הממולא, פותחים ושומרים
   באקסל (שם מחושבות נוסחאות המשרד) ומעלים חזרה — סכומי התשלום במכתבים
   נלקחים ממנו */
function FinalFileUpload({ rep, onChange }: { rep: any; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pick = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true); setMsg(null);
    try {
      const r = await uploadFinalExecFile(rep.id, files[0]);
      setMsg(r.warning ? { ok: false, text: r.warning }
        : { ok: true, text: `✓ הדוח הסופי נקלט — סכום לתשלום לפי הקובץ: ₪${fmt(r.paymentTotal || 0)}. המכתבים מעודכנים.` });
      onChange();
    } catch (e: any) { setMsg({ ok: false, text: e?.response?.data?.error || 'העלאת הדוח נכשלה.' }); }
    finally { setBusy(false); if (ref.current) ref.current.value = ''; }
  };
  const when = rep.final_file_at ? new Date(rep.final_file_at).toLocaleString('he-IL', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' }) : null;
  return (
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', marginTop: 10, paddingTop: 10, borderTop: `1px dashed ${T.line}` }}>
      <input ref={ref} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={(e) => pick(e.target.files)} />
      <button onClick={() => ref.current?.click()} disabled={busy} style={{ ...btn(when ? 'ghost' : 'primary'), opacity: busy ? 0.6 : 1 }}
        title="אחרי הורדת הדוח הממולא: לפתוח באקסל, לשמור (Ctrl+S) ולהעלות כאן — סכומי התשלום יילקחו כפי שהאקסל חישב">
        {busy ? 'קולט…' : '⬆ העלאת דוח ביצוע סופי'}
      </button>
      <span style={{ fontSize: 11.5, color: when ? T.green : T.inkSoft }}>
        {when ? `✓ דוח סופי הועלה ב-${when} — סכומי התשלום נלקחים ממנו` : 'מורידים את הדוח הממולא ← פותחים ושומרים באקסל ← מעלים כאן. סכומי התשלום במכתבים יילקחו ממנו.'}
      </span>
      {msg && <div style={{ flexBasis: '100%', fontSize: 12.5, color: msg.ok ? T.green : T.amber, background: msg.ok ? T.greenBg : T.amberBg, borderRadius: 8, padding: '6px 10px' }}>{msg.text}</div>}
    </div>
  );
}

const STATUSES = ['draft', 'in_progress', 'blocked', 'ready', 'submitted'];

function Flag({ on, label }: { on: boolean; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
      <span style={{ width: 18, height: 18, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        background: on ? T.greenBg : T.paper, color: on ? T.green : T.inkSoft, border: `1px solid ${on ? T.green : T.line}`, fontWeight: 700, fontSize: 12 }}>
        {on ? '✓' : '○'}
      </span>
      {label}
    </div>
  );
}

export default function ReportView({ reportId, clientId, go }: { reportId: number; clientId: number; go: (n: Nav) => void }) {
  const [rep, setRep] = useState<any>(null);
  // שלב 1 — הכנה, בדיקות ומכתב; שלב 2 — כרטסות והצלבה (אחרי שהלקוח שלח כרטסות)
  const [stage, setStage] = useState<1 | 2>(1);
  const load = () => getReport(reportId).then(setRep).catch(() => setRep(null));
  useEffect(() => { load(); setStage(1); }, [reportId]);

  if (!rep) return <div style={{ color: T.inkSoft, padding: 20 }}>טוען…</div>;

  const setStatus = async (status: string) => { await updateReport(reportId, { status }); load(); };
  const toggle = async (key: string) => { await updateReport(reportId, { [key]: !rep.ingest[keyToFlag(key)] }); load(); };
  const health = rep.health;
  const todos: string[] = health?.todos || [];

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <section style={card}>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10 }}>
          <span style={{ fontWeight: 700, fontSize: 18 }}>{rep.label}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, color: STATUS_COLOR[rep.status], fontWeight: 700 }}>
            <span style={{ width: 9, height: 9, borderRadius: '50%', background: STATUS_COLOR[rep.status] }} />
            {STATUS_HE[rep.status]}
          </span>
          <span style={{ marginInlineStart: 'auto', fontSize: 12, color: T.inkSoft }}>
            {rep.client?.name}{rep.authority ? ` · ${rep.authority.name}` : ''}
          </span>
        </div>
        <div style={{ fontSize: 12.5, color: T.inkSoft, marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
          <span>סוג תוכנית: {rep.program_type === 'summer_prep' ? 'מכינות קיץ' : 'בתי ספר וגנים'}</span>
          <span>תקרת ברוטו שעתי: {rep.program_type === 'summer_prep' ? '150' : '120'} ₪</span>
          {rep.client?.has_vat && <span style={{ color: T.amber }}>לקוח חייב במע"מ (18%)</span>}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            ימי הפעלה:
            <input type="number" min={0} max={60} key={rep.extension_days}
              defaultValue={rep.extension_days || (rep.program === 'extension' ? 6 : 15)}
              title="כמות ימי ההפעלה של הפרויקט — ניתן לעריכה"
              onBlur={async (e) => {
                const v = parseInt(e.target.value) || 0;
                if (v !== rep.extension_days) { await updateReport(reportId, { extension_days: v }); load(); }
              }}
              style={{ width: 52, padding: '2px 6px', fontSize: 12, borderRadius: 5, fontFamily: 'inherit', border: `1px solid ${T.line}`, textAlign: 'center' }} />
          </span>
        </div>
        {health && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
              <span style={pill(BUCKET_COLOR[health.bucket])}>{health.bucketLabel}</span>
              <span style={{ fontSize: 12, color: T.inkSoft }}>השלמה {health.completion}%</span>
              {health.exceptions.errors > 0 && <span style={{ fontSize: 12, color: T.red, fontWeight: 700 }}>· {health.exceptions.errors} חריגות</span>}
              {health.exceptions.warnings > 0 && <span style={{ fontSize: 12, color: T.amber }}>· {health.exceptions.warnings} אזהרות</span>}
            </div>
            <div style={{ height: 7, background: T.paper, borderRadius: 4, overflow: 'hidden' }}>
              <div style={{ width: `${health.completion}%`, height: '100%', background: BUCKET_COLOR[health.bucket], transition: 'width 0.3s' }} />
            </div>
          </div>
        )}
      </section>

      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(260px,1fr))', gap: 18 }}>
        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>קלטים שנקלטו</div>
          <div style={{ display: 'grid', gap: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Flag on={rep.ingest.participants} label="נתוני משתתפים (דוח ביצוע)" />
              <span style={{ fontSize: 10.5, color: T.inkSoft }}>אוטומטי (תקציב)</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Flag on={rep.ingest.cost_report} label="דוח עלות שכר" />
              <span style={{ fontSize: 10.5, color: T.inkSoft }}>אוטומטי (ניתוב)</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Flag on={rep.ingest.ledger} label="כרטסת" />
              <span style={{ fontSize: 10.5, color: T.inkSoft }}>אוטומטי (קליטה)</span>
            </div>
          </div>
        </div>

        <div style={card}>
          <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 12 }}>מה חסר לעשות</div>
          <ul style={{ margin: 0, paddingInlineStart: 18, display: 'grid', gap: 6 }}>
            {todos.map((t, i) => <li key={i} style={{ fontSize: 13, lineHeight: 1.5 }}>{t}</li>)}
          </ul>
        </div>
      </section>

      {/* לשוניות שלב 1 / שלב 2 — כדי שלא יהיה יותר מדי מידע במסך אחד */}
      <div style={{ display: 'flex', gap: 8 }}>
        {([[1, 'שלב 1 — הכנה, בדיקות ומכתב'], [2, 'שלב 2 — כרטסות והצלבה']] as [1 | 2, string][]).map(([s, label]) => (
          <button key={s} onClick={() => setStage(s)}
            style={{ ...btn(stage === s ? 'primary' : 'ghost'), fontSize: 13.5, padding: '8px 18px', fontWeight: 700 }}>
            {label}
          </button>
        ))}
      </div>

      {stage === 1 && <>
        <BudgetSection reportId={reportId} onChange={load} />
        <CostSection reportId={reportId} />
        <AuthorityEstimateSection key={rep.id} rep={rep} onChange={load} />
        <PrepSection reportId={reportId} />
      </>}

      {stage === 2 && <>
        <LedgerSection reportId={reportId} onChange={load} />
        <section style={card}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span style={{ fontWeight: 700, fontSize: 14 }}>הפלט של שלב 2</span>
            <span style={{ fontSize: 11.5, color: T.inkSoft }}>הבקרות שבוצעו והפערים · ניצול מול תקציב בכל סל · התשלום הצפוי מהמשרד פר מוסד ולפרויקט</span>
            <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <button onClick={() => window.open(stage2DocUrl(reportId), '_blank')}
                title="מכתב קצר ללקוח — כמה כסף צפוי להתקבל בפרויקט ומאיזה גורם"
                style={btn('primary')}>✉ מכתב תשלום צפוי</button>
              <button onClick={() => window.open(stage2DetailDocUrl(reportId), '_blank')}
                title="דוח הבקרות המפורט (פנימי): פערים, השוואה פר משלם, ניצול מול תקציב ופירוט ההכרה"
                style={btn('ghost')}>📋 פירוט בקרות</button>
              <Stage2ExportButton reportId={reportId} />
            </span>
          </div>
          <FinalFileUpload rep={rep} onChange={load} />
        </section>
      </>}

      <section style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10 }}>סטטוס הדוח</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {STATUSES.map((s) => (
            <button key={s} onClick={() => setStatus(s)}
              style={{ ...btn(s === rep.status ? 'primary' : 'ghost') }}>
              {STATUS_HE[s]}
            </button>
          ))}
        </div>
      </section>

      <section style={card}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>מוסדות בדוח</div>
        {rep.institutions?.length ? (
          <div style={{ fontSize: 13 }}>{rep.institutions.map((i: any) => `${i.symbol} — ${i.name}`).join(' · ')}</div>
        ) : (
          <div style={{ fontSize: 13, color: T.inkSoft }}>טרם הוגדרו מוסדות. יתווספו אוטומטית בקליטת נתוני המשתתפים (צעד הבא).</div>
        )}
      </section>

      <div>
        <button onClick={() => go({ view: 'client', clientId })} style={btn('ghost')}>‹ חזרה ללקוח</button>
      </div>
    </div>
  );
}

function keyToFlag(key: string): string {
  return key === 'has_cost_report' ? 'cost_report' : key === 'has_ledger' ? 'ledger' : 'participants';
}
