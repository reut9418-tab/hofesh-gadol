import { useEffect, useMemo, useState } from 'react';
import { T } from '../theme';
import { btn, card, input } from '../ui';
import { getReportPrep, saveReportPrep, exportReportUrl, downloadExport, stage1DocUrl, costMatchDocUrl, applyMove, applyBumps, autoAssign, PrepData, Assignment } from '../api';

const fmt = (n: number | null, d = 0) =>
  n == null ? '—' : n.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });

/* הכנת דוח הביצוע (§9): שיוך כל עובד לגן/מוסד + איש צוות + תפקיד,
   ואז ייצוא קובץ המשרד עם גיליון "פירוט עלויות כח אדם" ממולא. */
export default function PrepSection({ reportId }: { reportId: number }) {
  const [data, setData] = useState<PrepData | null>(null);
  const [assign, setAssign] = useState<Record<string, Assignment>>({});
  const [deptFilter, setDeptFilter] = useState('');
  const [bulk, setBulk] = useState<Assignment>({ symbol: null, staffType: null, role: null });
  const [busy, setBusy] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    getReportPrep(reportId).then((d) => {
      setData(d);
      const init: Record<string, Assignment> = {};
      d.rows.forEach((r) => { init[r.rowId] = { symbol: r.symbol, staffType: r.staffType, role: r.role }; });
      setAssign(init);
    }).catch(() => setData(null));
  useEffect(() => { load(); }, [reportId]);

  const depts = useMemo(() => [...new Set((data?.rows || []).map((r) => r.dept))], [data]);
  const shown = (data?.rows || []).filter((r) => !deptFilter || r.dept === deptFilter);
  const missing = (data?.rows || []).filter((r) => {
    const a = assign[r.rowId] || {};
    return !a.symbol || !a.staffType || !a.role;
  }).length;

  if (!data || data.rows.length === 0) return null;

  const set = (rowId: number, patch: Partial<Assignment>) =>
    setAssign((p) => ({ ...p, [rowId]: { ...p[rowId], ...patch } }));

  const applyBulk = () => {
    setAssign((p) => {
      const next = { ...p };
      shown.forEach((r) => {
        next[r.rowId] = {
          symbol: bulk.symbol ?? next[r.rowId]?.symbol ?? null,
          staffType: bulk.staffType ?? next[r.rowId]?.staffType ?? null,
          role: bulk.role ?? next[r.rowId]?.role ?? null,
        };
      });
      return next;
    });
  };

  const save = async () => {
    setBusy(true); setMsg(null);
    try { await saveReportPrep(reportId, assign); await load(); setMsg('השיוכים נשמרו.'); }
    catch { setMsg('השמירה נכשלה.'); }
    finally { setBusy(false); }
  };

  const doExport = async () => {
    if (exporting) return;
    // התרעה על חריגת שכר לפני העברת הנתונים לדוח הביצוע
    const sal = data.salary;
    if (sal && (sal.overflow > 0 || sal.unfunded > 0)) {
      const lines = sal.alerts.map((a) => '• ' + a.text).join('\n');
      if (!window.confirm(`שימי לב — נמצאה חריגה בשכר:\n\n${lines}\n\nלהמשיך בייצוא בכל זאת?`)) return;
    }
    setExporting(true); setMsg('שומר שיוכים ומכין את הקובץ…');
    try {
      await saveReportPrep(reportId, assign); // שמירה בלי לרענן את כל המסך
      await downloadExport(reportId); // הורדה ישירה — בלי window.open שנחסם
      setMsg('✓ הקובץ ירד לתיקיית ההורדות.');
      load(); // רענון הבדיקות ברקע, אחרי שההורדה כבר בידיים
    } catch (e: any) {
      setMsg(e?.response?.data?.error || 'הייצוא נכשל — נסי שוב.');
    } finally { setExporting(false); }
  };

  const rolesFor = (staffType: string | null) =>
    (data.staffTypes.find((s) => s.type === staffType) || { roles: [] as string[] }).roles;

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>הכנת דוח הביצוע — פירוט עלויות כח אדם</span>
        <span style={{ fontSize: 11.5, color: T.inkSoft }}>
          משייכים כל עובד לגן/מוסד, איש צוות ותפקיד — והמערכת ממלאת את קובץ המשרד.
        </span>
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {data.framework === 'gardens' && missing > 0 && (
            <button style={btn('ghost')}
              title='משלים סמלים לעובדים שטרם שויכו, כך שבכל גן תהיה גננת וסייעת — ובקרת "איוש משרות" של המשרד תעבור'
              onClick={async () => {
                if (!window.confirm(`להשלים שיוך אוטומטית? ${missing} עובדים ללא שיוך יחולקו בין הגנים מלשונית דוח הביצוע, עם גננת וסייעת בכל גן. אפשר לתקן ידנית אחר כך.`)) return;
                setBusy(true);
                try { const r = await autoAssign(reportId); await load(); setMsg(`שויכו ${r.assigned} עובדים בין ${r.gardens} גנים.`); }
                catch (e: any) { setMsg(e?.response?.data?.error || 'השיוך האוטומטי נכשל.'); }
                finally { setBusy(false); }
              }}>
              🪄 השלמת שיוך אוטומטית
            </button>
          )}
          <button onClick={() => window.open(stage1DocUrl(reportId), '_blank')} style={btn('ghost')}
            title="סיכום הבדיקות ללקוח — להדפסה או שמירה כ-PDF">📄 מסמך שלב 1 ללקוח</button>
          <button onClick={() => window.open(costMatchDocUrl(reportId), '_blank')} style={btn('ghost')}
            title="הסבר למשרד החינוך: העלות השעתית שדווחה = הנמוך מבין עלות + מע&quot;מ לבין ברוטו + 40%">🧾 דוח התאמה לדוח עלות</button>
          <button onClick={save} disabled={busy} style={btn('ghost')}>{busy ? 'שומר…' : 'שמירת שיוכים'}</button>
          <button onClick={doExport} disabled={busy || exporting || !data.hasBudgetFile}
            title={data.hasBudgetFile ? '' : 'קודם מעלים דוח ביצוע של המשרד (בסקשן התקציב)'}
            style={{ ...btn('primary'), opacity: busy || exporting || !data.hasBudgetFile ? 0.6 : 1 }}>
            {exporting ? '⏳ מכין את הקובץ…' : '⬇ הורדת דוח ביצוע ממולא'}
          </button>
        </span>
      </div>
      <div style={{ fontSize: 12, marginBottom: 10, color: missing ? T.amber : T.green }}>
        {missing
          ? `${missing} מתוך ${data.rows.length} עובדים עדיין חסרים סמל / איש צוות / תפקיד.`
          : `כל ${data.rows.length} העובדים משויכים במלואם — אפשר לייצא.`}
        {msg && <span style={{ marginInlineStart: 10, color: T.inkSoft }}>{msg}</span>}
      </div>

      {/* בקרת שכר: ניצול סלי השכר מול התקציב + הסל הגמיש (לפני הגשה) */}
      {data.salary?.hasBudget && (
        <div style={{ border: `1px solid ${T.line}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>בקרת שכר מול תקציב הסלים</div>
          <div style={{ display: 'grid', gap: 6 }}>
            {data.salary.items.map((it) => {
              const pct = it.budget > 0 ? it.actual / it.budget : 0;
              const over = it.over > 0;
              return (
                <div key={it.type}>
                  <div style={{ display: 'flex', gap: 8, fontSize: 12, marginBottom: 2, flexWrap: 'wrap' }}>
                    <span style={{ fontWeight: 600 }}>{it.label}</span>
                    <span style={{ color: T.inkSoft }}>₪{fmt(it.actual)} מתוך ₪{fmt(it.budget)}</span>
                    {over
                      ? <span style={{ color: T.red, fontWeight: 700 }}>חריגה ₪{fmt(it.over)}</span>
                      : it.under > 0 && <span style={{ color: T.inkSoft }}>יתרה ₪{fmt(it.under)}</span>}
                  </div>
                  <div style={{ height: 6, background: T.paper, borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${Math.min(100, pct * 100)}%`, height: '100%', background: over ? T.red : T.teal }} />
                  </div>
                </div>
              );
            })}
            <div style={{ display: 'flex', gap: 8, fontSize: 12, flexWrap: 'wrap', paddingTop: 6, borderTop: `1px dashed ${T.line}` }}>
              <span style={{ fontWeight: 600 }}>סל גמיש בגין שכר:</span>
              <span style={{ color: data.salary.flexUsedForSalary > 0 ? T.amber : T.inkSoft, fontWeight: 600 }}>
                נוצלו ₪{fmt(data.salary.flexUsedForSalary)} מתוך ₪{fmt(data.salary.flexBudget)}
              </span>
              {data.salary.flexRemaining > 0 && <span style={{ color: T.inkSoft }}>(יתרת סל: ₪{fmt(data.salary.flexRemaining)})</span>}
            </div>
            {data.salary.alerts.map((a, i) => (
              <div key={i} style={{ fontSize: 12, color: a.level === 'err' ? T.red : T.amber, background: a.level === 'err' ? T.redBg : T.amberBg, borderRadius: 6, padding: '6px 10px' }}>
                ⚠ {a.text}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* המלצות ניוד בין סמלי מוסד (§5, בתי"ס) — סוגרות חריגה במוסד אחד מיתרה באחר */}
      {data.recommendations?.relevant && (data.recommendations.moves?.length || 0) > 0 && (
        <div style={{ border: `1px solid ${T.teal}`, background: T.tealSoft, borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>המלצות ניוד בין מוסדות למיצוי התקציב</span>
            <span style={{ fontSize: 11.5, color: T.inkSoft }}>
              יחזירו להכרה ₪{fmt(data.recommendations.recovered || 0)} מתוך חריגה של ₪{fmt(data.recommendations.overflowBefore || 0)}
            </span>
            <button style={{ ...btn('primary'), marginInlineStart: 'auto' }}
              onClick={async () => {
                setAssign((p) => {
                  const next = { ...p };
                  (data.recommendations.moves || []).forEach((m) => { next[m.rowId] = { ...next[m.rowId], symbol: m.to }; });
                  return next;
                });
                setMsg('ההמלצות הוחלו — לחצי "שמירת שיוכים" לרענון הבדיקה.');
              }}>
              החלת כל ההמלצות
            </button>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {(data.recommendations.moves || []).map((m) => (
              <div key={m.rowId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
                <span>↔</span>
                <span style={{ fontWeight: 600 }}>{m.name}</span>
                <span style={{ color: T.inkSoft }}>₪{fmt(m.cost)}</span>
                <span>מ-{m.fromName || m.from} ({m.from}) ל-{m.toName || m.to} ({m.to})</span>
                <span style={{ color: T.green, fontSize: 11.5 }}>מקטין חריגה ב-₪{fmt(m.reduces)}</span>
                <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 6 }}>
                  <button style={{ ...btn('primary'), padding: '3px 10px', fontSize: 11.5 }}
                    title="דוח העלות יעודכן כאילו העובד דווח מההתחלה בסמל היעד"
                    onClick={async () => {
                      if (!window.confirm(`הלקוח אישר? ${m.name} יועבר לסמל ${m.to} ודוח העלות יעודכן בהתאם.`)) return;
                      await applyMove(reportId, m.rowId, 'move', m.to);
                      await load();
                      setMsg(`${m.name} נויד/ה לסמל ${m.to} — דוח העלות עודכן.`);
                    }}>
                    הלקוח אישר — ביצוע
                  </button>
                  <button style={{ ...btn('ghost'), padding: '3px 10px', fontSize: 11.5 }}
                    onClick={async () => { await applyMove(reportId, m.rowId, 'decline'); await load(); setMsg(`הניוד של ${m.name} נדחה — לא יוצע שוב.`); }}>
                    נדחה
                  </button>
                </span>
              </div>
            ))}
          </div>
          {(data.recommendations.overflowAfter || 0) > 0 && (
            <div style={{ fontSize: 11.5, color: T.amber, marginTop: 6 }}>
              גם אחרי הניוד תישאר חריגה של ₪{fmt(data.recommendations.overflowAfter || 0)} שאין לה יתרה מתאימה.
            </div>
          )}
          {(data.recommendations.unassigned || 0) > 0 && (
            <div style={{ fontSize: 11.5, color: T.inkSoft, marginTop: 4 }}>
              ({data.recommendations.unassigned} עובדים ללא סמל אינם חלק מהחישוב — שייכי אותם קודם.)
            </div>
          )}
          <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 6 }}>
            ההמלצות מבוססות על השיוכים השמורים ועל תקרת שכר פר-מוסד = סל שכר הצוות + הסל הגמיש. ההחלטה הסופית שלך.
          </div>
        </div>
      )}

      {/* התאמות ברוטו (עד 5 ₪ לשעה) — מיישרות את בקרת ה-140% של המשרד בלי לוותר על הכרה */}
      {(data.bumps || []).filter((b) => !b.applied).length > 0 && (
        <div style={{ border: `1px solid ${T.blue}`, background: T.blueBg, borderRadius: 8, padding: '10px 14px', marginBottom: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <span style={{ fontWeight: 700, fontSize: 12.5 }}>התאמות ברוטו — עד ₪5 לשעה</span>
            <span style={{ fontSize: 11.5, color: T.inkSoft }}>
              העלות (כולל מע"מ) חורגת מ-140% מהברוטו; הגדלה קטנה של הברוטו מיישרת את בקרת המשרד ומכירה במלוא העלות.
            </span>
            <button style={{ ...btn('primary'), marginInlineStart: 'auto' }}
              onClick={async () => {
                const list = (data.bumps || []).filter((b) => !b.applied);
                if (!window.confirm(`לאשר הגדלת ברוטו ל-${list.length} עובדים (עד ₪5 לשעה כל אחד)? הברוטו המעודכן ייכתב בדוח הביצוע.`)) return;
                await applyBumps(reportId, list.map((b) => b.rowId));
                await load();
                setMsg('התאמות הברוטו אושרו — ייכתבו בייצוא הבא.');
              }}>
              אישור כולן
            </button>
          </div>
          <div style={{ display: 'grid', gap: 4 }}>
            {(data.bumps || []).filter((b) => !b.applied).map((b) => (
              <div key={b.rowId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, flexWrap: 'wrap' }}>
                <span style={{ fontWeight: 600 }}>{b.name}</span>
                <span style={{ color: T.inkSoft }}>{b.dept}</span>
                <span>ברוטו ₪{b.hourlyGross} → ₪{(Math.round((b.hourlyGross + b.bump) * 100) / 100)}</span>
                <span style={{ color: T.inkSoft, fontSize: 11.5 }}>(עלות שעתית כולל מע"מ: ₪{b.hourlyCostVat})</span>
                <button style={{ ...btn('ghost'), padding: '3px 10px', fontSize: 11.5, marginInlineStart: 'auto' }}
                  onClick={async () => {
                    if (!window.confirm(`להגדיל את הברוטו של ${b.name} ב-₪${b.bump} לשעה?`)) return;
                    await applyBumps(reportId, [b.rowId]);
                    await load();
                  }}>
                  אישור
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {(data.bumps || []).some((b) => b.applied) && (
        <div style={{ fontSize: 11.5, color: T.green, background: T.greenBg, borderRadius: 8, padding: '6px 11px', marginBottom: 12 }}>
          ✓ {(data.bumps || []).filter((b) => b.applied).length} התאמות ברוטו מאושרות — נכתבות בייצוא.
        </div>
      )}

      {/* שיוך קבוצתי — לפי מחלקה */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', background: T.paper, borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
        <span style={{ fontSize: 12, color: T.inkSoft }}>שיוך קבוצתי:</span>
        <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} style={{ ...input, padding: '6px 8px', fontSize: 12 }}>
          <option value="">כל המחלקות ({data.rows.length})</option>
          {depts.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <input list={`inst-${reportId}`} placeholder="סמל גן/מוסד" value={bulk.symbol || ''}
          onChange={(e) => setBulk((b) => ({ ...b, symbol: e.target.value || null }))}
          style={{ ...input, padding: '6px 8px', fontSize: 12, width: 130 }} />
        <select value={bulk.staffType || ''} onChange={(e) => {
          const st = e.target.value || null;
          setBulk((b) => ({ ...b, staffType: st, role: st && rolesFor(st).length === 1 ? rolesFor(st)[0] : b.role }));
        }} style={{ ...input, padding: '6px 8px', fontSize: 12 }}>
          <option value="">איש צוות…</option>
          {data.staffTypes.map((s) => <option key={s.type} value={s.type}>{s.type}</option>)}
        </select>
        <select value={bulk.role || ''} onChange={(e) => setBulk((b) => ({ ...b, role: e.target.value || null }))}
          style={{ ...input, padding: '6px 8px', fontSize: 12 }}>
          <option value="">תפקיד…</option>
          {rolesFor(bulk.staffType).map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <button onClick={applyBulk} style={btn('dark')}>החלה על {shown.length} המוצגים</button>
      </div>

      <datalist id={`inst-${reportId}`}>
        {data.institutions.map((i) => <option key={i.symbol} value={i.symbol}>{i.name}</option>)}
      </datalist>

      <div style={{ maxHeight: '52vh', overflowY: 'auto', overflowX: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ position: 'sticky', top: 0, background: T.tealSoft, textAlign: 'right', color: T.ink, fontSize: 11, zIndex: 1 }}>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>עובד</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>מחלקה</th>
              <th style={{ padding: '6px 8px', fontWeight: 600, width: 130 }}>סמל מקום פעילות</th>
              <th style={{ padding: '6px 8px', fontWeight: 600, width: 130 }}>איש צוות</th>
              <th style={{ padding: '6px 8px', fontWeight: 600, width: 170 }}>תפקיד</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>שעות</th>
              <th style={{ padding: '6px 8px', fontWeight: 600 }}>ברוטו שעתי</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const a = assign[r.rowId] || { symbol: null, staffType: null, role: null };
              const complete = a.symbol && a.staffType && a.role;
              const instName = data.institutions.find((i) => i.symbol === a.symbol)?.name;
              return (
                <tr key={r.rowId} style={{ borderTop: `1px solid ${T.line}`, background: complete ? T.greenBg + '44' : undefined }}>
                  <td style={{ padding: '5px 8px', fontWeight: 600, whiteSpace: 'nowrap' }}>{r.name || `${r.firstName || ''} ${r.lastName || ''}`}</td>
                  <td style={{ padding: '5px 8px', color: T.inkSoft, fontSize: 11 }}>{r.dept}</td>
                  <td style={{ padding: '5px 8px' }}>
                    <input list={`inst-${reportId}`} value={a.symbol || ''} placeholder="סמל…"
                      onChange={(e) => set(r.rowId, { symbol: e.target.value || null })}
                      title={instName || ''}
                      style={{ ...input, padding: '4px 6px', fontSize: 11.5, width: '100%', borderColor: a.symbol ? T.green : T.line }} />
                  </td>
                  <td style={{ padding: '5px 8px' }}>
                    <select value={a.staffType || ''} onChange={(e) => {
                      const st = e.target.value || null;
                      set(r.rowId, { staffType: st, role: st && rolesFor(st).length === 1 ? rolesFor(st)[0] : null });
                    }} style={{ ...input, padding: '4px 6px', fontSize: 11.5, width: '100%', borderColor: a.staffType ? T.green : T.line }}>
                      <option value="">—</option>
                      {data.staffTypes.map((s) => <option key={s.type} value={s.type}>{s.type}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '5px 8px' }}>
                    <select value={a.role || ''} onChange={(e) => set(r.rowId, { role: e.target.value || null })}
                      style={{ ...input, padding: '4px 6px', fontSize: 11.5, width: '100%', borderColor: a.role ? T.green : T.line }}>
                      <option value="">—</option>
                      {rolesFor(a.staffType).map((ro) => <option key={ro} value={ro}>{ro}</option>)}
                    </select>
                  </td>
                  <td style={{ padding: '5px 8px' }}>{fmt(r.hours, 1)}</td>
                  <td style={{ padding: '5px 8px' }}>{r.hourlyGross != null ? '₪' + fmt(r.hourlyGross, 1) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 8 }}>
        המילוי נכתב ישירות לקובץ המשרד ({data.budgetFileName || 'דוח הביצוע שהועלה'}) — נוסחאות "שם מוסד" ו"עלות שכר לתקופה"
        וכל עמודות הבקרה של המשרד מחושבות מעצמן עם פתיחת הקובץ ב-Excel.
      </div>
    </section>
  );
}
