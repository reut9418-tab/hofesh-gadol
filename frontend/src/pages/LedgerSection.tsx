import { useEffect, useRef, useState } from 'react';
import { T } from '../theme';
import { btn, card } from '../ui';
import { getReportLedger, uploadLedgerFile, setLedgerCardBasket, deleteLedgerFile, setLedgerFilePayer, enrichMatchDocUrl, downloadEnrichMatchXlsx, LedgerData } from '../api';

const fmt = (n: number | null | undefined, d = 0) =>
  n == null ? '—' : n.toLocaleString('he-IL', { minimumFractionDigits: d, maximumFractionDigits: d });

/* כרטסות (צעד 6): קליטה, שיוך כרטיס→סל לפי שם (נלמד), והתאמה מול דוח העלות
   ודוח הביצוע — כולל כלל המע"מ (18%) ללקוחות חייבים. */
export default function LedgerSection({ reportId, onChange }: { reportId: number; onChange: () => void }) {
  const [data, setData] = useState<LedgerData | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => getReportLedger(reportId).then(setData).catch(() => setData(null));
  useEffect(() => { load(); }, [reportId]);

  const onPick = async (files: FileList | null) => {
    if (!files || !files.length) return;
    setBusy(true); setErr(null);
    try {
      for (const f of Array.from(files)) await uploadLedgerFile(reportId, f);
      await load(); onChange();
    } catch (e: any) { setErr(e?.response?.data?.error || 'העלאת הכרטסת נכשלה.'); }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ''; }
  };

  const setBasket = async (cardId: number, basket: string | null) => {
    await setLedgerCardBasket(cardId, basket);
    await load(); onChange();
  };
  const removeFile = async (fileId: number, name: string) => {
    if (!window.confirm(`למחוק את הכרטסת "${name}"?`)) return;
    await deleteLedgerFile(fileId); await load(); onChange();
  };

  const rec = data?.reconcile;
  const lvColor = (lv: string) => (lv === 'err' ? T.red : lv === 'warn' ? T.amber : T.green);
  const lvBg = (lv: string) => (lv === 'err' ? T.redBg : lv === 'warn' ? T.amberBg : T.greenBg);

  return (
    <section style={card}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 6 }}>
        <span style={{ fontWeight: 700, fontSize: 14 }}>כרטסות הנהלת חשבונות</span>
        <span style={{ fontSize: 11.5, color: T.inkSoft }}>כל כרטיס משויך לסל לפי שמו — והשיוך נלמד להעלאה הבאה.</span>
        <span style={{ marginInlineStart: 'auto', display: 'flex', gap: 8 }}>
          {(data?.cards || []).some((c) => c.basket_type === 'enrichment') && (
            <>
              <button onClick={async () => {
                setErr(null);
                try { await downloadEnrichMatchXlsx(reportId); }
                catch (e: any) { setErr(e?.response?.data?.error || 'הורדת דוח ההתאמה נכשלה.'); }
              }}
                title="ייחוס כרטסות ההעשרה למוסדות כקובץ אקסל מעוצב"
                style={btn('ghost')}>🎨 דוח התאמת העשרה (אקסל)</button>
              <button onClick={() => window.open(enrichMatchDocUrl(reportId), '_blank')}
                title="דוח ההתאמה כדף להדפסה / שמירה כ-PDF"
                style={btn('ghost')}>🖨 PDF</button>
            </>
          )}
          <input ref={inputRef} type="file" accept=".xlsx,.xls,.pdf" multiple style={{ display: 'none' }} onChange={(e) => onPick(e.target.files)} />
          <button onClick={() => inputRef.current?.click()} disabled={busy}
            style={{ ...btn(data?.cards.length ? 'ghost' : 'primary'), opacity: busy ? 0.6 : 1 }}>
            {busy ? 'קולט…' : '＋ העלאת כרטסת'}
          </button>
        </span>
      </div>
      {err && <div style={{ fontSize: 12.5, color: T.red, marginBottom: 8 }}>{err}</div>}
      {!data?.cards.length && !err && (
        <div style={{ fontSize: 13, color: T.inkSoft }}>
          טרם הועלו כרטסות. מעלים את כרטסות השכר/ההעשרה של התקופה, והמערכת משייכת כל כרטיס לסל ובודקת התאמה מול דוח העלות ודוח הביצוע.
        </div>
      )}

      {rec?.hasLedger && (
        <>
          {/* רשימת בדיקות שלב 2: כרטסת ↔ דוח עלות ↔ דוח ביצוע + העשרה + הכנסות */}
          <div style={{ fontWeight: 700, fontSize: 13, margin: '4px 0 6px' }}>בדיקות שלב 2</div>
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {(rec.checks || []).map((c) => (
              <div key={c.id} style={{ fontSize: 12.5, color: lvColor(c.level), background: lvBg(c.level), borderRadius: 6, padding: '7px 11px' }}>
                {c.level === 'ok' ? '✓' : '⚠'} {(c as any).title && <b>{(c as any).title}: </b>}{c.text}
              </div>
            ))}
            {data!.hasVat && (
              <div style={{ fontSize: 11.5, color: T.inkSoft }}>
                לקוח חייב במע"מ: הכרטסת ודוח העלות אמורים להתאים; מול דוח הביצוע צפוי פער של 18% (מע"מ).
              </div>
            )}
            {(rec.unassigned || 0) > 0 && (
              <div style={{ fontSize: 11.5, color: T.amber }}>
                {rec.unassigned} כרטיסים ללא שיוך לסל אינם נכללים בהתאמה — שייכי אותם בטבלה.
              </div>
            )}
          </div>

          {/* סכומי הכרטסת לפי סל */}
          {(rec.byBasket || []).length > 0 && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
              {(rec.byBasket || []).map((b) => (
                <span key={b.type} style={{ fontSize: 11.5, background: T.paper, borderRadius: 6, padding: '4px 10px' }}>
                  {b.label}: <b>₪{fmt(b.amount)}</b>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* השוואה פר משלם: דוח עלות ↔ כרטסת שכר ↔ המדווח בדוח הביצוע */}
      {(data?.payerMatrix?.rows.length || 0) > 0 && (() => {
        const pm = data!.payerMatrix!;
        const th = { padding: '6px 8px', fontWeight: 600, textAlign: 'center' as const };
        const td = { padding: '6px 8px', textAlign: 'center' as const };
        const sum = (f: (p: typeof pm.rows[0]) => number) => pm.rows.reduce((s, p) => s + (f(p) || 0), 0);
        return (
          <div style={{ margin: '4px 0 14px' }}>
            <div style={{ fontWeight: 700, fontSize: 13, margin: '4px 0 6px' }}>השוואה פר משלם — דוח עלות ↔ כרטסת שכר ↔ דוח ביצוע</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: T.inkSoft, fontSize: 11 }}>
                    <th style={{ ...th, textAlign: 'right' }}>משלם</th>
                    <th style={th}>עובדים</th><th style={th}>שעות</th>
                    <th style={th}>דוח עלות (עלות מעביד)</th>
                    <th style={th}>כרטסת שכר</th><th style={th}>פער</th>
                    <th style={th}>מדווח בדוח ביצוע{data!.hasVat ? ' (כולל מע"מ)' : ''}</th>
                  </tr>
                </thead>
                <tbody>
                  {pm.rows.map((p) => (
                    <tr key={p.payer} style={{ borderTop: `1px solid ${T.line}` }}>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{p.payer}</td>
                      <td style={td}>{p.rows}</td><td style={td}>{fmt(p.hours)}</td>
                      <td style={{ ...td, fontWeight: 600 }}>₪{fmt(p.costNet)}</td>
                      <td style={td}>{p.ledgerSalary != null ? `₪${fmt(p.ledgerSalary)}` : <span style={{ color: T.inkSoft }}>אין כרטסת</span>}</td>
                      <td style={{ ...td, fontWeight: 600, color: p.diff == null ? T.inkSoft : Math.abs(p.diff) <= 200 ? T.green : lvColor(p.level) }}>
                        {p.diff == null ? '—' : Math.abs(p.diff) <= 200 ? 'תואם ✓' : `₪${fmt(p.diff)}`}
                      </td>
                      <td style={td}>₪{fmt(p.reported)}</td>
                    </tr>
                  ))}
                  {pm.rows.length > 1 && (
                    <tr style={{ borderTop: `2px solid ${T.ink}`, fontWeight: 700, background: T.paper }}>
                      <td style={{ ...td, textAlign: 'right' }}>סה"כ</td>
                      <td style={td}>{sum((p) => p.rows)}</td><td style={td}>{fmt(sum((p) => p.hours))}</td>
                      <td style={td}>₪{fmt(sum((p) => p.costNet))}</td>
                      <td style={td}>₪{fmt(sum((p) => p.ledgerSalary || 0))}</td><td style={td}></td>
                      <td style={td}>₪{fmt(sum((p) => p.reported))}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 4 }}>
              המשלם נקבע בשדה "משלם" של כל קובץ עלות (במסך הלקוח) וכל כרטסת (כאן למטה). "מדווח בדוח ביצוע" = העלות המוכרת אחרי תקרת 140%{data!.hasVat ? ' כולל מע"מ' : ''} — מה שנרשם בייצוא תחת "הועסק ע"י".
            </div>
          </div>
        );
      })()}

      {/* השוואת העשרה/ארוחות בוקר: כרטסת מול מה שממולא בלשונית ההוצאות של הקובץ */}
      {(data?.expenseMatrix?.rows.length || 0) > 0 && (() => {
        const em = data!.expenseMatrix!;
        const th = { padding: '6px 8px', fontWeight: 600, textAlign: 'center' as const };
        const td = { padding: '6px 8px', textAlign: 'center' as const };
        return (
          <div style={{ margin: '4px 0 14px' }}>
            <div style={{ fontWeight: 700, fontSize: 13, margin: '4px 0 6px' }}>העשרה וארוחות בוקר — כרטסת מול דוח הביצוע</div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ color: T.inkSoft, fontSize: 11 }}>
                    <th style={{ ...th, textAlign: 'right' }}>סעיף</th>
                    <th style={th}>כרטסת (נטו)</th>
                    {data!.hasVat && <th style={th}>צפוי בדוח (כולל מע"מ)</th>}
                    <th style={th}>ממולא בלשונית "הוצאות בפועל"</th>
                    <th style={th}>פער</th>
                  </tr>
                </thead>
                <tbody>
                  {em.rows.map((p) => (
                    <tr key={p.key} style={{ borderTop: `1px solid ${T.line}` }}>
                      <td style={{ ...td, textAlign: 'right', fontWeight: 600 }}>{p.label}</td>
                      <td style={td}>₪{fmt(p.ledger)}</td>
                      {data!.hasVat && <td style={td}>₪{fmt(p.expected)}</td>}
                      <td style={td}>{p.file != null ? `₪${fmt(p.file)}` : <span style={{ color: T.inkSoft }}>טרם מולא</span>}</td>
                      <td style={{ ...td, fontWeight: 600, color: p.diff == null ? T.inkSoft : Math.abs(p.diff) <= 200 ? T.green : lvColor(p.level) }}>
                        {p.diff == null ? '—' : Math.abs(p.diff) <= 200 ? 'תואם ✓' : `₪${fmt(p.diff)}`}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 11, color: T.inkSoft, marginTop: 4 }}>
              הייצוא ממלא בלשונית ההוצאות רק תאים ריקים (לא דורס מה שהלקוח מילא): העשרה וארוחות בוקר לפי הכרטסות, ניהול ותפעול לפי התקציב — כולל מספרי הכרטסות.
            </div>
          </div>
        );
      })()}

      {/* קבצי הכרטסות — כולל מחיקה של כרטסת שהועלתה בטעות (מוחקת את כל כרטיסיה) */}
      {(data?.files.length || 0) > 0 && (
        <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
          {data!.files.map((f) => (
            <div key={f.id} style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 12, background: T.paper, borderRadius: 8, border: `1px solid ${T.line}`, padding: '7px 12px' }}>
              <span style={{ fontWeight: 600 }}>{f.filename}</span>
              <span style={{ color: T.inkSoft, fontSize: 11 }}>{f.card_count} כרטיסים</span>
              <input defaultValue={f.payer || ''} placeholder='משלם (מתנ"ס/רשות)'
                title="בספרי מי מתנהלת הכרטסת — מפריד את ההתאמות וההשוואה בין המשלמים"
                onBlur={async (e) => { const v = e.target.value.trim(); if (v !== (f.payer || '')) { await setLedgerFilePayer(f.id, v || null); await load(); onChange(); } }}
                style={{ padding: '3px 8px', fontSize: 11, width: 130, borderRadius: 6, fontFamily: 'inherit', border: `1px solid ${f.payer ? T.green : T.line}` }} />
              <button onClick={() => removeFile(f.id, f.filename)}
                title="מחיקת הכרטסת וכל הכרטיסים שנקלטו ממנה — לכרטסת שהועלתה בטעות או שאינה שייכת לפרויקט"
                style={{ ...btn('ghost'), marginInlineStart: 'auto', color: T.red, borderColor: T.red, fontSize: 11.5 }}>
                🗑 מחיקת כרטסת
              </button>
            </div>
          ))}
        </div>
      )}

      {(data?.cards.length || 0) > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'right', color: T.inkSoft, fontSize: 11 }}>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>כרטסת</th>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>מפתח חשבון</th>
                <th style={{ padding: '6px 8px', fontWeight: 600 }}>נטו (חובה−זכות)</th>
                <th style={{ padding: '6px 8px', fontWeight: 600, width: 190 }}>שיוך לסל</th>
              </tr>
            </thead>
            <tbody>
              {data!.cards.map((c) => (
                <tr key={c.id} style={{ borderTop: `1px solid ${T.line}` }}>
                  <td style={{ padding: '6px 8px', fontWeight: 600 }}>{c.card_name}</td>
                  <td style={{ padding: '6px 8px', color: T.inkSoft, direction: 'ltr', textAlign: 'right' }}>{c.card_key}</td>
                  <td style={{ padding: '6px 8px', fontWeight: 600, color: c.net < 0 ? T.red : T.ink }}>₪{fmt(c.net)}</td>
                  <td style={{ padding: '6px 8px' }}>
                    <select value={c.basket_type || ''}
                      onChange={(e) => setBasket(c.id, e.target.value || null)}
                      style={{ padding: '4px 6px', fontSize: 11.5, width: '100%', borderRadius: 6, fontFamily: 'inherit',
                        border: `1px solid ${c.basket_type ? T.green : T.amber}` }}>
                      <option value="">— לא רלוונטי —</option>
                      {data!.basketOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

    </section>
  );
}
