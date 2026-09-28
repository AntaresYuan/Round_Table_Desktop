// Cheap line-level change stats between two versions of a text file. Trims the
// common prefix and suffix and counts what's left on each side — the standard
// approximation for +N/−N badges. It can over-count interleaved edits (it
// reports the whole span between the first and last differing line), which is
// acceptable for attribution display; it is NOT a real diff.
export type LineChange = { added: number; removed: number };

export function lineChangeStats(before: string, after: string): LineChange {
  if (before === after) return { added: 0, removed: 0 };
  const a = before === '' ? [] : before.split('\n');
  const b = after === '' ? [] : after.split('\n');
  let start = 0;
  const maxStart = Math.min(a.length, b.length);
  while (start < maxStart && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }
  return { added: endB - start, removed: endA - start };
}
