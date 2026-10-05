// Seeded randomness for template-built questions. A template plus a seed always
// produces the identical question, so a generated bank is reproducible and a
// bad item can be traced back to the exact template + seed that made it.

/** mulberry32 - small, fast, well-distributed 32-bit PRNG. */
export function rng(seed) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    /** Integer in [min, max] inclusive. */
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    /** Integer in [min, max] excluding 0 - for coefficients that must not vanish. */
    nonZero(min, max) {
      for (;;) {
        const v = this.int(min, max);
        if (v !== 0) return v;
      }
    },
    /** One element of `list`. */
    pick(list) {
      return list[this.int(0, list.length - 1)];
    },
    /** Fisher-Yates, returns a new array. */
    shuffle(list) {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i -= 1) {
        const j = this.int(0, i);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    /** true with probability p. */
    chance(p) {
      return next() < p;
    },
  };
}

/** Signed term like "- 3x" / "+ x" for building readable expressions. */
export function term(coef, symbol) {
  const sign = coef < 0 ? '-' : '+';
  const mag = Math.abs(coef);
  const body = symbol ? `${mag === 1 ? '' : mag}${symbol}` : String(mag);
  return `${sign} ${body}`;
}

/** Leading term - no leading "+". */
export function lead(coef, symbol) {
  const mag = Math.abs(coef);
  const body = symbol ? `${mag === 1 ? '' : mag}${symbol}` : String(mag);
  return `${coef < 0 ? '-' : ''}${body}`;
}

/** Exact fraction in LaTeX, reduced, integer when it divides evenly. */
export function frac(num, den) {
  if (den === 0) return String(num);
  const g = gcd(Math.abs(num), Math.abs(den));
  let n = num / g;
  let d = den / g;
  if (d < 0) { n = -n; d = -d; }
  if (d === 1) return String(n);
  return n < 0 ? `-\\frac{${-n}}{${d}}` : `\\frac{${n}}{${d}}`;
}

export function gcd(a, b) {
  return b === 0 ? a : gcd(b, a % b);
}

/** Round to at most `places` decimals without trailing zeros. */
export function round(value, places = 2) {
  return Number(value.toFixed(places));
}
