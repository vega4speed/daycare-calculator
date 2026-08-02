// formats.js — value <-> input-string conversions for the setting control.
// A setting stores raw values (a rate is 0.10, not "10"); the UI shows friendly text.

export const formats = {
  percent: {
    prefix: '',
    suffix: '%',
    // 0.105 -> "10.5"  (trim floating noise)
    toStr: (v) => (v == null || v === '' ? '' : String(+(v * 100).toFixed(4))),
    parse: (s) => (s.trim() === '' ? undefined : Number(s) / 100),
    display: (v) => (v == null ? '—' : `${+(v * 100).toFixed(4)}%`),
  },
  money: {
    prefix: '$',
    suffix: '',
    toStr: (v) => (v == null || v === '' ? '' : String(v)),
    parse: (s) => (s.trim() === '' ? undefined : Number(s)),
    display: (v) => (v == null ? '—' : `$${Number(v).toLocaleString()}`),
  },
  number: {
    prefix: '',
    suffix: '',
    toStr: (v) => (v == null || v === '' ? '' : String(v)),
    parse: (s) => (s.trim() === '' ? undefined : Number(s)),
    display: (v) => (v == null ? '—' : String(v)),
  },
};

export const getFormat = (kind) => formats[kind] || formats.number;
