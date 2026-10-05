// Renders items handed in by scripts/check-rendering.mjs with the app's own
// MathText, one element per field, tagged for the check to read.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { MathText } from '../src/MathText.jsx';

function Items({ items }) {
  return items.map((item) => (
    <section key={item.id}>
      {item.fields.map(([name, text]) => (
        <div key={name} data-check={`${item.id}|${name}`}><MathText text={text} /></div>
      ))}
    </section>
  ));
}

const root = createRoot(document.getElementById('root'));
window.renderItems = (items) => {
  flushSync(() => root.render(<Items items={items} />));
  return true;
};
