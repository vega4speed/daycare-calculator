// chart-utils.js — small formatting/scale helpers shared by every chart in the UI
// (projection-view.js's own chart, and the Phase 7 scenario-comparison chart), plus the fixed
// non-categorical tokens (ink/grid/status colors) that every chart uses regardless of its own
// series palette.

export const COL = {
  ink: '#0b0b0b',
  ink2: '#52514e',
  muted: '#898781',
  grid: '#e1e0d9',
  base: '#c3c2b7',
  good: '#0ca30c',      // fixed status palette — never themed
  critical: '#d03b3b',
};

// Sign goes OUTSIDE the currency symbol: -$21,101, never $-21,101.
export const usd = (v) => {
  const n = Math.round(v);
  const a = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (a >= 1e6) return sign + '$' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '') + 'M';
  if (a >= 1e3) return sign + '$' + Math.round(a / 1e3) + 'k';
  return sign + '$' + a.toLocaleString();
};
export const usdFull = (v) => {
  const n = Math.round(v);
  return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString();
};

/** Decimal hour -> "7:30am". */
export function clockTime(v) {
  const hh = Math.floor(v);
  const mm = Math.round((v - hh) * 60);
  const ampm = hh >= 12 ? 'pm' : 'am';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${mm ? ':' + String(mm).padStart(2, '0') : ''}${ampm}`;
}

export function niceCeil(v) {
  if (v <= 0) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  const f = v / base;
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * base;
}

export function xTickYears(baseYear, endYear) {
  const span = endYear - baseYear;
  if (span <= 0) return [baseYear];
  const step = span <= 12 ? 2 : span <= 30 ? 5 : 10;
  const out = [];
  for (let y = baseYear; y <= endYear; y += step) out.push(y);
  if (out[out.length - 1] !== endYear) out.push(endYear);
  return out;
}
