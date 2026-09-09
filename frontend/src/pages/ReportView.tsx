import { useEffect, useRef, useState } from 'react';
import { T, STATUS_HE, STATUS_COLOR, BUCKET_COLOR } from '../theme';
import { btn, card, pill } from '../ui';
import { getReport, updateReport, getReportCosts, getReportBudget, uploadBudgetFile } from '../api';
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
  const load = () => getReport(reportId).then(setRep).catch(() => setRep(null));
  useEffect(() => { load(); }, [reportId]);

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
          {rep.program === 'extension' && <span>ימי הרחבה: {rep.extension_days}</span>}
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

      <BudgetSection reportId={reportId} onChange={load} />

      <CostSection reportId={reportId} />

      <LedgerSection reportId={reportId} onChange={load} />

      <PrepSection reportId={reportId} />

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
