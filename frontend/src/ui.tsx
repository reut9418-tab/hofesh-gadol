import React from 'react';
import { T } from './theme';

export const btn = (variant: 'primary' | 'dark' | 'ghost' | 'danger' = 'primary'): React.CSSProperties => ({
  padding: '7px 14px', borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  border: variant === 'ghost' ? `1px solid ${T.line}` : 'none',
  background: variant === 'primary' ? T.teal : variant === 'dark' ? T.ink : variant === 'danger' ? T.redBg : T.paper,
  color: variant === 'ghost' ? T.ink : variant === 'danger' ? T.red : '#fff',
});

export const card: React.CSSProperties = {
  background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: '16px 20px',
};

export const input: React.CSSProperties = {
  padding: '8px 12px', borderRadius: 7, border: `1px solid ${T.line}`, fontFamily: 'inherit', fontSize: 13,
};

export function Metric({ label, value, color }: { label: string; value: React.ReactNode; color?: string }) {
  return (
    <div style={{ background: T.card, border: `1px solid ${T.line}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 12, color: T.inkSoft, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: color || T.ink }}>{value}</div>
    </div>
  );
}
