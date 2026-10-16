// An AI answer on the screen: markdown (paragraphs, lists, emphasis, tables,
// code) with its math set as all math in the app is (MathText's texToHtml).
// Each formula comes through markdown as a code span marked as math
// (prepare.js) and is set as math here. Images are not shown (the AI has none
// to show, and a link to one would reach out of the app).

import React, { useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { texToHtml } from '../MathText.jsx';
import { DISPLAY, INLINE, prepare } from './prepare.js';

function Formula({ tex, display }) {
  const html = useMemo(() => texToHtml(tex, display), [tex, display]);
  if (html == null) return <code className="font-mono text-[0.9em]">{tex}</code>;
  return (
    <span
      className={display ? 'scrollbar-thin my-2 block overflow-x-auto overflow-y-hidden py-0.5' : undefined}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

const textOf = (node) => (node?.children || []).map((c) => (c.type === 'text' ? c.value : textOf(c))).join('');

const COMPONENTS = {
  p: ({ node, ...props }) => <p className="my-2.5 first:mt-0 last:mb-0" {...props} />,
  ul: ({ node, ...props }) => <ul className="my-2.5 list-disc space-y-1 pl-5 first:mt-0 last:mb-0 marker:text-muted-foreground" {...props} />,
  ol: ({ node, ...props }) => <ol className="my-2.5 list-decimal space-y-1 pl-5 first:mt-0 last:mb-0 marker:text-muted-foreground" {...props} />,
  li: ({ node, ...props }) => <li className="pl-0.5 [&>p]:my-1" {...props} />,
  // An answer in a chat has no use for big headings: a bold line reads better.
  h1: ({ node, ...props }) => <p className="mt-4 mb-1.5 font-semibold first:mt-0" {...props} />,
  h2: ({ node, ...props }) => <p className="mt-4 mb-1.5 font-semibold first:mt-0" {...props} />,
  h3: ({ node, ...props }) => <p className="mt-3 mb-1 font-semibold first:mt-0" {...props} />,
  h4: ({ node, ...props }) => <p className="mt-3 mb-1 font-semibold first:mt-0" {...props} />,
  strong: ({ node, ...props }) => <strong className="font-semibold" {...props} />,
  a: ({ node, ...props }) => <a target="_blank" rel="noreferrer noopener" className="font-medium underline underline-offset-2" {...props} />,
  blockquote: ({ node, ...props }) => <blockquote className="my-2.5 border-l-2 pl-3 text-muted-foreground" {...props} />,
  hr: ({ node, ...props }) => <hr className="my-4" {...props} />,
  table: ({ node, ...props }) => (
    <div className="scrollbar-thin my-2.5 overflow-x-auto">
      <table className="w-full border-collapse text-[13px]" {...props} />
    </div>
  ),
  th: ({ node, ...props }) => <th className="border bg-muted/60 px-2 py-1 text-left font-semibold" {...props} />,
  td: ({ node, ...props }) => <td className="border px-2 py-1 align-top" {...props} />,
  img: () => null,
  pre: ({ node, children, ...props }) => {
    // A ```math block is a formula too.
    const code = node?.children?.[0];
    if (code?.properties?.className?.includes('language-math')) return <Formula tex={textOf(code)} display />;
    return (
      <pre className="scrollbar-thin my-2.5 overflow-x-auto rounded-lg bg-muted px-3 py-2.5 font-mono text-[12.5px] leading-relaxed [&>code]:bg-transparent [&>code]:p-0" {...props}>
        {children}
      </pre>
    );
  },
  code: ({ node, children, className, ...props }) => {
    const text = String(children ?? '');
    if (text.startsWith(INLINE)) return <Formula tex={text.slice(1)} />;
    if (text.startsWith(DISPLAY)) return <Formula tex={text.slice(1)} display />;
    return <code className={className || 'rounded bg-muted px-1 py-0.5 font-mono text-[0.88em]'} {...props}>{children}</code>;
  },
};

const PLUGINS = [remarkGfm];

/** An AI answer, rendered; `partial` while it is still coming in, or when it was cut off. */
export function Reply({ text, partial = false }) {
  const source = useMemo(() => prepare(text, partial), [text, partial]);
  return (
    <div className="leading-relaxed break-words">
      <Markdown remarkPlugins={PLUGINS} components={COMPONENTS}>{source}</Markdown>
    </div>
  );
}
