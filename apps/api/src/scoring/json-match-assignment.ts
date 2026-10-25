/**
 * Pairing the unmatched items of a json_match list compared without order:
 * an optimal assignment, and the greedy fallback for very long lists.
 * Credit is 0 to 1 per pair; rows are the shorter side.
 */

const filled = <T>(length: number, value: T): T[] => Array.from({ length }, () => value);

/**
 * Maximum-credit pairing of rows to columns (Hungarian method with
 * potentials), rows ≤ columns. Returns the column of each row.
 */
export function maxCreditAssignment(credit: number[][]): number[] {
  const n = credit.length;
  const m = n === 0 ? 0 : credit[0]!.length;
  if (n > m) throw new RangeError('more rows than columns');
  const INF = Number.POSITIVE_INFINITY;
  // 1-based arrays, as in the textbook form; cost = 1 − credit.
  const u = filled(n + 1, 0);
  const v = filled(m + 1, 0);
  const owner = filled(m + 1, 0);
  const way = filled(m + 1, 0);
  for (let i = 1; i <= n; i++) {
    owner[0] = i;
    let j0 = 0;
    const minv = filled(m + 1, INF);
    const used = filled(m + 1, false);
    do {
      used[j0] = true;
      const i0 = owner[j0]!;
      let delta = INF;
      let j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = 1 - credit[i0 - 1]![j - 1]! - u[i0]! - v[j]!;
        if (cur < minv[j]!) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j]! < delta) {
          delta = minv[j]!;
          j1 = j;
        }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) {
          u[owner[j]!]! += delta;
          v[j]! -= delta;
        } else {
          minv[j]! -= delta;
        }
      }
      j0 = j1;
    } while (owner[j0] !== 0);
    do {
      const j1 = way[j0]!;
      owner[j0] = owner[j1]!;
      j0 = j1;
    } while (j0 !== 0);
  }
  const result = filled(n, -1);
  for (let j = 1; j <= m; j++) if (owner[j]! > 0) result[owner[j]! - 1] = j - 1;
  return result;
}

/** Pairs by highest credit first, ties by position: the fallback for very long lists. */
export function greedyAssignment(credit: number[][]): number[] {
  const cells: Array<[number, number, number]> = [];
  credit.forEach((row, i) => row.forEach((c, j) => cells.push([c, i, j])));
  cells.sort((a, b) => b[0] - a[0] || a[1] - b[1] || a[2] - b[2]);
  const result = filled(credit.length, -1);
  const taken = new Set<number>();
  for (const [, i, j] of cells) {
    if (result[i] !== -1 || taken.has(j)) continue;
    result[i] = j;
    taken.add(j);
  }
  return result;
}
