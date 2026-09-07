import { useEffect, useRef, useState } from 'react';
import { T } from '../theme';
import { btn, card } from '../ui';
import { getReportLedger, uploadLedgerFile, setLedgerCardBasket, deleteLedgerFile, setLedgerFilePayer, LedgerData } from '../api';

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
        <span style={{ marginInlineStart: 'auto' }}>
          <input ref={inputRef} type="file" accept=".xlsx,.xls" multiple style={{ display: 'none' }} onChange={(e) => onPick(e.target.files)} />
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
          {/* התאמה תלת-כיוונית: כרטסת ↔ דוח עלות ↔ דוח ביצוע */}
          <div style={{ display: 'grid', gap: 6, marginBottom: 12 }}>
            {(rec.checks || []).map((c) => (
              <div key={c.id} style={{ fontSize: 12.5, color: lvColor(c.level), background: lvBg(c.level), borderRadius: 6, padding: '7px 11px' }}>
                {c.level === 'ok' ? '✓' : '⚠'} {c.text}
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

      {(data?.files.length || 0) > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
          {data!.files.map((f) => (
            <span key={f.id} style={{ fontSize: 11, color: T.inkSoft, background: T.paper, borderRadius: 6, padding: '3px 9px', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
              {f.filename} · {f.card_count} כרטיסים
              <input defaultValue={f.payer || ''} placeholder='משלם (מתנ"ס/רשות)'
                title="בספרי מי מתנהלת הכרטסת — מפריד את ההתאמות בין המשלמים"
                onBlur={async (e) => { const v = e.target.value.trim(); if (v !== (f.payer || '')) { await setLedgerFilePayer(f.id, v || null); await load(); onChange(); } }}
                style={{ padding: '2px 7px', fontSize: 10.5, width: 120, borderRadius: 5, fontFamily: 'inherit', border: `1px solid ${f.payer ? T.green : T.line}` }} />
              <button onClick={() => removeFile(f.id, f.filename)}
                style={{ border: 'none', background: 'transparent', color: T.red, cursor: 'pointer', fontSize: 12, fontWeight: 700, padding: 0 }}>✕</button>
            </span>
          ))}
        </div>
      )}
    </section>
  );
}
