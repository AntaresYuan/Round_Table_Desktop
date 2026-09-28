import { describe, expect, it } from 'vitest';
import {
  deliverableText,
  extractHtmlDocument,
  stripCodeFence,
} from '../src/server/actions/deliverable.js';

const PAGE = '<!DOCTYPE html>\n<html lang="zh-CN">\n<head><title>真鲜</title></head>\n<body><h1>鲜入为主</h1></body>\n</html>';

describe('extractHtmlDocument — tolerant of fences, prose, and truncation', () => {
  it('passes through a clean HTML document', () => {
    expect(extractHtmlDocument(PAGE)).toBe(PAGE);
  });

  it('unwraps a complete markdown fence', () => {
    expect(extractHtmlDocument('```html\n' + PAGE + '\n```')).toBe(PAGE);
  });

  it('recovers a truncated page as long as visible content exists', () => {
    // Cut after the body opened: incomplete but renderable — keep it.
    const truncated = '```html\n<!DOCTYPE html>\n<html><head></head><body><h1>真鲜</h1><p>每一天，从产地到';
    const extracted = extractHtmlDocument(truncated);
    expect(extracted).not.toBeNull();
    expect(extracted!.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(extracted).not.toContain('```');
  });

  it('rejects a page cut before <body> — it renders as a blank screen', () => {
    // The exact production failure: the model wrote a giant <style> block and
    // hit the token ceiling while still inside <head>. Valid HTML, zero pixels.
    const headOnly = '<!DOCTYPE html>\n<html><head><style>.back-top { bottom: 20';
    expect(extractHtmlDocument(headOnly)).toBeNull();
  });

  it('drops prose before and after the document', () => {
    const wrapped = `Here is the corrected page:\n\n${PAGE}\n\nSummary of changes:\n- fixed nav`;
    expect(extractHtmlDocument(wrapped)).toBe(PAGE);
  });

  it('drops prose around a fenced document', () => {
    const wrapped = 'Sure! Here you go:\n```html\n' + PAGE + '\n```\nLet me know if you need more.';
    expect(extractHtmlDocument(wrapped)).toBe(PAGE);
  });

  it('accepts a document that starts at <html> without a doctype', () => {
    const bare = '<html><body>hi</body></html>';
    expect(extractHtmlDocument(bare)).toBe(bare);
  });

  it('returns null when there is no HTML document at all', () => {
    expect(extractHtmlDocument('I cannot generate that page, sorry.')).toBeNull();
    expect(extractHtmlDocument('')).toBeNull();
  });

  it('is case-insensitive about the doctype', () => {
    const lower = '<!doctype html><html><body>x</body></html>';
    expect(extractHtmlDocument(lower)).toBe(lower);
  });
});

describe('stripCodeFence — code deliverables', () => {
  it('unwraps a complete single fence', () => {
    expect(stripCodeFence('```ts\nconst a = 1;\n```')).toBe('const a = 1;');
  });

  it('strips an unterminated fence instead of leaving it in the file', () => {
    expect(stripCodeFence('```ts\nconst a = 1;')).toBe('const a = 1;');
  });

  it('leaves unfenced text alone', () => {
    expect(stripCodeFence('const a = 1;')).toBe('const a = 1;');
  });
});

describe('deliverableText — routes by artifact path', () => {
  it('keeps markdown as-is (fences are legitimate in docs)', () => {
    const md = '# Report\n\n```js\nsnippet\n```\n';
    expect(deliverableText(md, 'runs/review/report.md')).toBe(md.trim());
  });

  it('extracts the HTML document for .html paths', () => {
    expect(deliverableText('```html\n' + PAGE + '\n```', 'runs/work/site.html')).toBe(PAGE);
  });

  it('returns null for .html paths when no document is present', () => {
    expect(deliverableText('no page here', 'runs/work/site.html')).toBeNull();
  });
});
