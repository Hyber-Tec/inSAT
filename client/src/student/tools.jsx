// In-test tools: a basic scientific calculator and the SAT math reference
// sheet. Their content only: the runner sets each in a tool window.

import React, { useState, useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';

// Desmos graphing calculator (the SAT's on-screen calculator). Loaded lazily
// from Desmos's CDN using VITE_DESMOS_API_KEY; falls back to the built-in
// scientific calculator below when no key is configured or the load fails.
const DESMOS_KEY = import.meta.env.VITE_DESMOS_API_KEY;
const DESMOS_VERSION = 'v1.10';
let desmosLoad = null;
function loadDesmos() {
  if (typeof window !== 'undefined' && window.Desmos) return Promise.resolve(window.Desmos);
  if (!DESMOS_KEY) return Promise.reject(new Error('no Desmos key'));
  if (desmosLoad) return desmosLoad;
  desmosLoad = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.desmos.com/api/${DESMOS_VERSION}/calculator.js?apiKey=${encodeURIComponent(DESMOS_KEY)}`;
    s.async = true;
    s.onload = () => (window.Desmos ? resolve(window.Desmos) : reject(new Error('Desmos load failed')));
    s.onerror = () => reject(new Error('Desmos load failed'));
    document.head.appendChild(s);
  });
  return desmosLoad;
}

function DesmosCalculator() {
  const host = useRef(null);
  const calc = useRef(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    loadDesmos()
      .then((Desmos) => {
        if (!alive || !host.current) return;
        calc.current = Desmos.GraphingCalculator(host.current, { expressionsCollapsed: false, settingsMenu: false, border: false });
      })
      .catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; if (calc.current) { try { calc.current.destroy(); } catch { /* ignore */ } } };
  }, []);
  if (failed) return <Calculator />;
  return (
    <div className="h-120 w-115 max-w-[calc(100vw-2rem)]">
      <div ref={host} className="size-full" />
    </div>
  );
}

// The math-section calculator: Desmos when a key is set, else the built-in one.
export function MathCalculator() {
  return DESMOS_KEY ? <DesmosCalculator /> : <Calculator />;
}

export function Calculator() {
  const [display, setDisplay] = useState('0');
  const [expr, setExpr] = useState('');

  const press = (v) => {
    if (display === '0' && /[0-9.]/.test(v)) {
      setDisplay(v);
      setExpr((e) => (e === '0' || e === '' ? v : e + v));
    } else if (display === 'Error') {
      if (/[0-9.]/.test(v)) { setDisplay(v); setExpr(v); }
    } else {
      setDisplay((d) => d + v);
      setExpr((e) => e + v);
    }
  };
  const clearAll = () => { setDisplay('0'); setExpr(''); };
  const back = () => {
    setExpr((e) => e.slice(0, -1));
    setDisplay((d) => (d.length <= 1 ? '0' : d.slice(0, -1)));
  };
  const evaluate = () => {
    try {
      const safe = expr
        .replace(/π/g, 'Math.PI').replace(/√\(/g, 'Math.sqrt(').replace(/√/g, 'Math.sqrt')
        .replace(/×/g, '*').replace(/÷/g, '/').replace(/\^/g, '**');
      if (!/^[0-9+\-*/().,\s*MathPIsqrt]+$/.test(safe)) throw new Error();
      // eslint-disable-next-line no-new-func
      const r = Function('"use strict"; return (' + safe + ')')();
      if (typeof r !== 'number' || !isFinite(r)) throw new Error();
      const rounded = Math.round(r * 1e10) / 1e10;
      setDisplay(String(rounded)); setExpr(String(rounded));
    } catch { setDisplay('Error'); }
  };

  const Key = ({ children, onPress, variant = 'num' }) => (
    <button
      type="button"
      onClick={() => onPress(children)}
      className={cn('h-10 rounded-md border text-[15px] font-medium transition-colors', {
        num: 'bg-background hover:bg-muted',
        op: 'bg-muted hover:bg-muted/70',
        fn: 'bg-muted text-muted-foreground hover:bg-muted/70 hover:text-foreground',
        eq: 'border-primary bg-primary text-primary-foreground hover:bg-primary/85',
      }[variant])}
    >
      {children}
    </button>
  );

  return (
    <div className="w-66 p-3">
      <div className={cn('min-h-12 overflow-hidden rounded-md border bg-muted/50 px-3 py-2 text-right font-mono text-2xl font-medium tabular-nums', display === 'Error' && 'text-destructive')}>
        {display}
      </div>
      <div className="mt-1 h-4 truncate text-right font-mono text-[11px] text-muted-foreground">{expr}</div>
      <div className="mt-2 grid grid-cols-4 gap-1.5">
        <Key onPress={clearAll} variant="op">AC</Key>
        <Key onPress={back} variant="op">⌫</Key>
        <Key onPress={() => press('(')} variant="op">(</Key>
        <Key onPress={() => press(')')} variant="op">)</Key>
        <Key onPress={() => press('√(')} variant="fn">√</Key>
        <Key onPress={() => press('^2')} variant="fn">x²</Key>
        <Key onPress={() => press('^')} variant="fn">^</Key>
        <Key onPress={() => press('÷')} variant="op">÷</Key>
        <Key onPress={press}>7</Key><Key onPress={press}>8</Key><Key onPress={press}>9</Key>
        <Key onPress={() => press('×')} variant="op">×</Key>
        <Key onPress={press}>4</Key><Key onPress={press}>5</Key><Key onPress={press}>6</Key>
        <Key onPress={() => press('-')} variant="op">−</Key>
        <Key onPress={press}>1</Key><Key onPress={press}>2</Key><Key onPress={press}>3</Key>
        <Key onPress={() => press('+')} variant="op">+</Key>
        <Key onPress={() => press('π')} variant="fn">π</Key>
        <Key onPress={press}>0</Key>
        <Key onPress={() => press('.')}>.</Key>
        <Key onPress={evaluate} variant="eq">=</Key>
      </div>
    </div>
  );
}

const RefItem = ({ label, formula, sub }) => (
  <div>
    <div className="mb-1 text-xs text-muted-foreground">{label}</div>
    <div className="font-mono text-sm">{formula}</div>
    {sub && <div className="mt-0.5 font-mono text-xs text-muted-foreground">{sub}</div>}
  </div>
);

export function Reference() {
  return (
    <div className="scrollbar-thin max-h-108 w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-4">
      <div className="flex flex-col gap-3.5">
        <RefItem label="Area of a circle" formula="A = πr²" />
        <RefItem label="Circumference" formula="C = 2πr" />
        <RefItem label="Area of a triangle" formula="A = ½bh" />
        <RefItem label="Pythagorean theorem" formula="a² + b² = c²" />
        <RefItem label="Special right triangles" formula="30-60-90 : x, x√3, 2x" sub="45-45-90 : s, s, s√2" />
        <RefItem label="Volume of a cylinder" formula="V = πr²h" />
        <RefItem label="Volume of a sphere" formula="V = (4/3)πr³" />
        <RefItem label="Volume of a cone" formula="V = (1/3)πr²h" />
        <RefItem label="Quadratic formula" formula="x = (−b ± √(b² − 4ac)) / 2a" />
        <div className="border-t pt-3 text-xs text-muted-foreground">
          Sum of interior angles of a polygon with n sides: (n − 2) · 180°
        </div>
      </div>
    </div>
  );
}

export const formatTime = (s) => {
  const m = Math.max(0, Math.floor(s / 60));
  const sec = Math.max(0, s % 60);
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
};

export const LETTERS = ['A', 'B', 'C', 'D'];
