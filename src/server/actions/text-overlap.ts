/*
  Token overlap scoring shared by relevance rankers (breakout context snippets,
  agent memory recall). Latin words 3+ chars plus CJK runs and their bigrams,
  deduped, all lowercase.
*/

export function tokenizeForOverlap(text: string): string[] {
  const normalized = text.toLowerCase();
  const latin = normalized.match(/[a-z0-9][a-z0-9_-]{2,}/g) || [];
  const cjk = normalized.match(/[一-鿿]{2,}/g) || [];
  const cjkBigrams = cjk.flatMap((chunk) => {
    const tokens: string[] = [];
    for (let index = 0; index < chunk.length - 1; index += 1) tokens.push(chunk.slice(index, index + 2));
    return tokens;
  });
  return Array.from(new Set([...latin, ...cjk, ...cjkBigrams]));
}

export function overlapScore(query: Set<string>, text: string): number {
  return tokenizeForOverlap(text).filter((token) => query.has(token)).length;
}
