import type { ReactElement, ReactNode } from 'react';

/**
 * Minimal, dependency-free Markdown renderer used for editor previews.
 *
 * Security-first: it never emits raw HTML. `dangerouslySetInnerHTML` is not
 * used anywhere — every construct becomes a real React element, and link/image
 * URLs are restricted to safe schemes. The subset covered is what the CMS
 * editor authors: headings, emphasis, inline code, links, images, lists,
 * blockquotes, fenced code and horizontal rules.
 */

const SAFE_URL = /^(https?:|mailto:|\/|#|\.\/|\.\.\/)/i;

function safeUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!SAFE_URL.test(trimmed)) return null;
  return trimmed;
}

/** Inline formatting for a single line of text. */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern =
    /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(!\[[^\]]*\]\([^)]+\))|(\[[^\]]+\]\([^)]+\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let index = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${index++}`;
    if (token.startsWith('`')) {
      nodes.push(
        <code
          key={key}
          className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.85em] text-foreground"
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith('**')) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {renderInline(token.slice(2, -2), key)}
        </strong>,
      );
    } else if (token.startsWith('![')) {
      const parsed = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(token);
      const url = parsed ? safeUrl(parsed[2] ?? '') : null;
      if (parsed && url) {
        nodes.push(
          <img
            key={key}
            src={url}
            alt={parsed[1] ?? ''}
            className="my-2 max-h-96 rounded-lg border"
          />,
        );
      } else {
        nodes.push(token);
      }
    } else if (token.startsWith('[')) {
      const parsed = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(token);
      const url = parsed ? safeUrl(parsed[2] ?? '') : null;
      if (parsed && url) {
        nodes.push(
          <a
            key={key}
            href={url}
            target="_blank"
            rel="noreferrer noopener"
            className="font-medium text-primary underline underline-offset-2"
          >
            {renderInline(parsed[1] ?? '', key)}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    } else {
      nodes.push(
        <em key={key} className="italic">
          {renderInline(token.slice(1, -1), key)}
        </em>,
      );
    }
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-6 mb-3 text-2xl font-bold tracking-tight',
  2: 'mt-6 mb-3 text-xl font-semibold tracking-tight',
  3: 'mt-5 mb-2 text-lg font-semibold',
  4: 'mt-4 mb-2 text-base font-semibold',
  5: 'mt-4 mb-2 text-sm font-semibold',
  6: 'mt-4 mb-2 text-sm font-semibold text-muted-foreground',
};

/** Render a Markdown document into a React fragment. */
export function renderMarkdown(source: string): ReactElement {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const blocks: ReactElement[] = [];
  let index = 0;
  let key = 0;

  while (index < lines.length) {
    const line = lines[index] ?? '';

    // Blank line.
    if (line.trim() === '') {
      index += 1;
      continue;
    }

    // Fenced code block.
    const fence = /^```(.*)$/.exec(line);
    if (fence) {
      const body: string[] = [];
      const cursor = index + 1;
      let end = cursor;
      while (end < lines.length && !/^```/.test(lines[end] ?? '')) {
        body.push(lines[end] ?? '');
        end += 1;
      }
      blocks.push(
        <pre
          key={`b${key++}`}
          className="my-3 overflow-x-auto rounded-xl border bg-muted/50 p-3 text-xs leading-relaxed"
        >
          <code className="font-mono">{body.join('\n')}</code>
        </pre>,
      );
      index = end < lines.length ? end + 1 : end;
      continue;
    }

    // Horizontal rule.
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={`b${key++}`} className="my-5 border-border" />);
      index += 1;
      continue;
    }

    // Heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1]?.length ?? 1;
      const Tag = (`h${level}` as 'h1');
      blocks.push(
        <Tag key={`b${key++}`} className={HEADING_CLASS[level]}>
          {renderInline(heading[2] ?? '', `b${key}`)}
        </Tag>,
      );
      index += 1;
      continue;
    }

    // Blockquote.
    if (/^\s*>\s?/.test(line)) {
      const body: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index] ?? '')) {
        body.push((lines[index] ?? '').replace(/^\s*>\s?/, ''));
        index += 1;
      }
      blocks.push(
        <blockquote
          key={`b${key++}`}
          className="my-3 border-l-2 border-primary/50 bg-muted/30 px-4 py-1 text-sm text-muted-foreground"
        >
          {renderInline(body.join(' '), `b${key}`)}
        </blockquote>,
      );
      continue;
    }

    // Unordered list.
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*[-*+]\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ul key={`b${key++}`} className="my-3 list-disc space-y-1 pl-6 text-sm">
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `b${key}-${i}`)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Ordered list.
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^\s*\d+\.\s+/, ''));
        index += 1;
      }
      blocks.push(
        <ol key={`b${key++}`} className="my-3 list-decimal space-y-1 pl-6 text-sm">
          {items.map((item, i) => (
            <li key={i}>{renderInline(item, `b${key}-${i}`)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Paragraph: consume until a blank line or the next block starter.
    const paragraph: string[] = [];
    while (index < lines.length) {
      const current = lines[index] ?? '';
      if (
        current.trim() === '' ||
        /^```/.test(current) ||
        /^(#{1,6})\s+/.test(current) ||
        /^\s*>\s?/.test(current) ||
        /^\s*[-*+]\s+/.test(current) ||
        /^\s*\d+\.\s+/.test(current) ||
        /^\s*([-*_])(\s*\1){2,}\s*$/.test(current)
      ) {
        break;
      }
      paragraph.push(current);
      index += 1;
    }
    blocks.push(
      <p key={`b${key++}`} className="my-3 text-sm leading-7">
        {renderInline(paragraph.join('\n'), `b${key}`)}
      </p>,
    );
  }

  return <div className="break-words">{blocks}</div>;
}
