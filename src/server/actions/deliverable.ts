/* ============================================================================
   deliverable.ts — extract the real deliverable from a chat model response.

   Chat models wrap deliverables in markdown fences, add prose around them, and
   get truncated mid-document when they hit max_tokens. Extraction must not
   depend on the model being well-behaved: for HTML we locate the document
   boundaries directly (<!doctype …>/<html …> through </html>), which makes
   fences, chatter, and truncation irrelevant. When no document exists at all
   the caller gets null and must FAIL the task (feeding the review→fix loop)
   instead of shipping prose in a .html artifact.
   ============================================================================ */

/**
 * Slice a complete-or-truncated HTML document out of a model response.
 * Tolerates markdown fences, prose before/after, and missing </html> (a
 * truncated page still renders — browsers auto-close). Returns null when the
 * response contains no HTML document, or when the document has no <body>: a
 * page cut off while still inside <head> is valid HTML that renders as a
 * blank screen, which is worse than failing the task.
 */
export function extractHtmlDocument(raw: string): string | null {
  const startMatch = raw.match(/<!doctype\s+html[^>]*>|<html[\s>]/i);
  if (startMatch === null || startMatch.index === undefined) return null;
  const fromStart = raw.slice(startMatch.index);
  if (!/<body[\s>]/i.test(fromStart)) return null;
  const endMatch = fromStart.match(/<\/html>/i);
  const document = endMatch?.index !== undefined
    ? fromStart.slice(0, endMatch.index + endMatch[0].length)
    // Truncated output: keep what we have, minus any trailing fence backticks.
    : fromStart.replace(/`+\s*$/, '');
  return document.trim() || null;
}

/**
 * Remove a single wrapping markdown fence from a code deliverable. Handles the
 * unterminated case (truncated output) by stripping the opening fence line and
 * any trailing backticks, so a fence never ends up inside a source file.
 */
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  const complete = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/);
  if (complete) return complete[1]!.trim();
  const unterminated = trimmed.match(/^```[a-zA-Z0-9]*\n([\s\S]*)$/);
  if (unterminated) return unterminated[1]!.replace(/`+\s*$/, '').trim();
  return trimmed;
}

/**
 * The deliverable for a target artifact path, or null when the response holds
 * no usable content for that kind. Markdown keeps its fences (documents may
 * legitimately contain code snippets); HTML is sliced out of the response;
 * everything else gets a defensive fence strip.
 */
export function deliverableText(raw: string, path: string): string | null {
  const trimmed = raw.trim();
  if (path.endsWith('.md')) return trimmed;
  if (path.endsWith('.html')) return extractHtmlDocument(trimmed);
  return stripCodeFence(trimmed);
}
