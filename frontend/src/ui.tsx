import React from 'react';
import { T } from './theme';

export const btn = (variant: 'primary' | 'dark' | 'ghost' | 'danger' = 'primary'): React.CSSProperties => ({
  padding: '8px 16px', borderRadius: 10, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  border: variant === 'ghost' ? `1px solid ${T.line}` : variant === 'primary' ? `1px solid ${T.gold}` : 'none',
  background: variant === 'primary' ? T.goldSoft : variant === 'dark' ? T.graphite : variant === 'danger' ? T.redBg : '#fff',
  color: variant === 'primary' ? '#6B5A28' : variant === 'ghost' ? T.ink : variant === 'danger' ? T.red : '#fff',
  boxShadow: variant === 'ghost' || variant === 'danger' ? 'none' : '0 1px 3px rgba(74,68,58,0.10)',
  transition: 'filter 0.15s',
});

export const card: React.CSSProperties = {
  background: T.card, border: `1px solid ${T.line}`, borderRadius: 14, padding: '16px 20px',
  boxShadow: '0 1px 4px rgba(55,50,42,0.05)',
};

export const input: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 9, border: `1px solid ${T.line}`, fontFamily: 'inherit', fontSize: 13,
  background: '#fff',
};

/* תגית פסטל רכה: רקע בהיר בגוון הצבע + טקסט צבעוני (במקום רקע מלא וטקסט לבן) */
export const pill = (color: string): React.CSSProperties => ({
  fontSize: 10.5, fontWeight: 700, color, background: `${color}26`,
  border: `1px solid ${color}55`, borderRadius: 999, padding: '2px 10px',
});

export function Metric({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ ...card, padding: '14px 16px', borderTop: color ? `3px solid ${color}` : (card.border as string) }}>
      <div style={{ fontSize: 12, color: T.inkSoft, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || T.ink }}>{value}</div>
    </div>
  );
}

/* הלוגו של גוטליב את ביטון — שני ריבועים משולבים (זהב + גרפיט) בגרסה וקטורית */
export function FirmLogo({ size = 40 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-label="גוטליב את ביטון">
      <g transform="rotate(45 24 24)">
        <rect x="15" y="7" width="26" height="26" rx="3.5" fill="#55504A" />
        <rect x="18.5" y="10.5" width="19" height="7" rx="2" fill="#3E3830" />
        <rect x="18.5" y="22.5" width="19" height="7" rx="2" fill="#3E3830" />
        <rect x="7" y="15" width="26" height="26" rx="3.5" fill="#C9A03C" />
        <rect x="10.5" y="18.5" width="19" height="7.5" rx="2" fill="#B08A2E" />
        <rect x="10.5" y="30" width="19" height="7.5" rx="2" fill="#B08A2E" />
        <rect x="19" y="21.5" width="14" height="5" rx="1.5" fill="#55504A" />
      </g>
    </svg>
  );
}
