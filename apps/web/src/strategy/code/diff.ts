/*
 * A line diff of two versions of a strategy's source: the longest common subsequence of their lines,
 * shown as unchanged, removed and added lines with both versions' line numbers. Quadratic in the line
 * counts, so two very long versions are not diffed (lineDiff answers null).
 */

export interface DiffLine {
  kind: "same" | "del" | "add";
  text: string;
  /** The line's number in the older version; null for an added line. */
  oldNo: number | null;
  /** The line's number in the newer version; null for a removed line. */
  newNo: number | null;
}

/** The most cells (older lines x newer lines) a diff computes. */
export const MAX_DIFF_CELLS = 4_000_000;

/** `older` to `newer` line by line, or null when the two are too long to diff. */
export function lineDiff(older: string, newer: string): DiffLine[] | null {
  const a = older.split("\n");
  const b = newer.split("\n");
  if (a.length * b.length > MAX_DIFF_CELLS) return null;
  const n = a.length;
  const m = b.length;
  // lcs[i][j]: the common lines of a[i..] and b[j..], in one flat array
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1]! + 1 : Math.max(lcs[(i + 1) * (m + 1) + j]!, lcs[i * (m + 1) + j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: "same", text: a[i]!, oldNo: i + 1, newNo: j + 1 });
      i++;
      j++;
    } else if (i < n && (j === m || lcs[(i + 1) * (m + 1) + j]! >= lcs[i * (m + 1) + j + 1]!)) {
      out.push({ kind: "del", text: a[i]!, oldNo: i + 1, newNo: null });
      i++;
    } else {
      out.push({ kind: "add", text: b[j]!, oldNo: null, newNo: j + 1 });
      j++;
    }
  }
  return out;
}

/** How many lines `diff` adds and removes. */
export function diffCounts(diff: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diff) {
    if (d.kind === "add") added++;
    else if (d.kind === "del") removed++;
  }
  return { added, removed };
}
