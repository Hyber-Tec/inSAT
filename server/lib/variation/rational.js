// Exact rational arithmetic on BigInt. The variation engine computes every
// answer key with these, never with floating point, so a key can be compared
// with the source's key exactly and a fraction never turns into 0.30000000004.

const big = (v) => (typeof v === 'bigint' ? v : BigInt(v));
const absBig = (n) => (n < 0n ? -n : n);
function gcdBig(a, b) {
  a = absBig(a);
  b = absBig(b);
  while (b) [a, b] = [b, a % b];
  return a;
}

// Coefficients stay far below this in any SAT question; a value past it means a
// runaway computation (an exponent on a large base), which is refused rather
// than carried into a question.
const LIMIT = 10n ** 30n;

/** A reduced fraction n/d with d > 0. */
export function Q(n, d = 1n) {
  n = big(n);
  d = big(d);
  if (d === 0n) throw new RangeError('division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const g = gcdBig(n, d) || 1n;
  n /= g;
  d /= g;
  if (absBig(n) > LIMIT || d > LIMIT) throw new RangeError('arithmetic limit exceeded');
  return Object.freeze({ n, d });
}

export const ZERO = Q(0);
export const ONE = Q(1);

export const add = (a, b) => Q(a.n * b.d + b.n * a.d, a.d * b.d);
export const sub = (a, b) => Q(a.n * b.d - b.n * a.d, a.d * b.d);
export const mul = (a, b) => Q(a.n * b.n, a.d * b.d);
export const div = (a, b) => Q(a.n * b.d, a.d * b.n);
export const neg = (a) => Q(-a.n, a.d);
export const inv = (a) => Q(a.d, a.n);
export const eq = (a, b) => a.n === b.n && a.d === b.d;
export const cmp = (a, b) => { const x = a.n * b.d - b.n * a.d; return x < 0n ? -1 : x > 0n ? 1 : 0; };
export const sign = (a) => (a.n < 0n ? -1 : a.n > 0n ? 1 : 0);
export const isZero = (a) => a.n === 0n;
export const isInt = (a) => a.d === 1n;
export const abs = (a) => (a.n < 0n ? neg(a) : a);
export const toNumber = (a) => Number(a.n) / Number(a.d);

/** a^k for an integer k (negative allowed for a nonzero base). */
export function pow(a, k) {
  if (!Number.isInteger(k)) throw new RangeError('non-integer exponent');
  if (k < 0) return pow(inv(a), -k);
  if (k > 64) throw new RangeError('exponent too large');
  let out = ONE;
  for (let i = 0; i < k; i += 1) out = mul(out, a);
  return out;
}

/** The exact square root when a is the square of a rational, else null. */
export function sqrt(a) {
  if (a.n < 0n) return null;
  const r = (x) => {
    if (x < 2n) return x;
    let y = BigInt(Math.floor(Math.sqrt(Number(x))));
    while (y * y > x) y -= 1n;
    while ((y + 1n) * (y + 1n) <= x) y += 1n;
    return y * y === x ? y : null;
  };
  const n = r(a.n);
  const d = r(a.d);
  return n === null || d === null ? null : Q(n, d);
}

/** A decimal literal ("12.50", "-0.3", "1,200") as an exact rational. */
export function fromDecimal(text) {
  const s = String(text).replace(/,/g, '');
  const m = /^(-?)(\d*)(?:\.(\d+))?$/.exec(s);
  if (!m || (!m[2] && !m[3])) throw new SyntaxError(`not a decimal: ${text}`);
  const places = m[3] ? m[3].length : 0;
  const digits = BigInt(`${m[2] || '0'}${m[3] || ''}`);
  return Q(m[1] ? -digits : digits, 10n ** BigInt(places));
}

/** Whether a has a terminating decimal expansion, and how many places it needs. */
export function decimalPlaces(a) {
  let d = a.d;
  let twos = 0;
  let fives = 0;
  while (d % 2n === 0n) { d /= 2n; twos += 1; }
  while (d % 5n === 0n) { d /= 5n; fives += 1; }
  return d === 1n ? Math.max(twos, fives) : null;
}

/** Exact decimal string with `places` digits after the point (a must terminate within them). */
export function toFixed(a, places) {
  const scale = 10n ** BigInt(places);
  const scaled = a.n * scale;
  if (scaled % a.d !== 0n) throw new RangeError('value does not terminate at that many places');
  const v = scaled / a.d;
  const negative = v < 0n;
  const digits = absBig(v).toString().padStart(places + 1, '0');
  const body = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  return `${negative ? '-' : ''}${body}`;
}

/** The shortest exact decimal ("0.25"), or null when a does not terminate. */
export function toDecimal(a) {
  const places = decimalPlaces(a);
  return places === null ? null : toFixed(a, places);
}

/** Rounded (half away from zero) or truncated decimal with `places` digits. */
export function approx(a, places, mode = 'round') {
  const scale = 10n ** BigInt(places);
  const num = absBig(a.n) * scale;
  let q = num / a.d;
  const rem = num % a.d;
  if (mode === 'round' && rem * 2n >= a.d) q += 1n;
  const digits = q.toString().padStart(places + 1, '0');
  const body = places ? `${digits.slice(0, -places)}.${digits.slice(-places)}` : digits;
  return `${a.n < 0n && q !== 0n ? '-' : ''}${body}`;
}

/** "7", "-3/4": the plain form a student could type into a grid-in. */
export const toPlain = (a) => (a.d === 1n ? `${a.n}` : `${a.n}/${a.d}`);

/** Stable key for maps and sets. */
export const key = toPlain;

/** Parse "7", "-3/4", "0.25". */
export function parse(text) {
  const s = String(text).trim();
  const m = /^(-?\d+)\/(\d+)$/.exec(s);
  if (m) return Q(BigInt(m[1]), BigInt(m[2]));
  return fromDecimal(s);
}
