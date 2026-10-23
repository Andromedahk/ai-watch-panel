/** Select reset rows from a list already filtered to future resets and sorted by time. */
export function selectResetRows<T extends { view: { id: string }; quota: { model: string } }>(rows: T[], expanded: boolean): { rows: T[]; hiddenCount: number } {
  const antigravityIndexes = rows.flatMap((row, index) => row.view.id === 'antigravity' ? [index] : []);
  const primaryIndex = antigravityIndexes.find(index => rows[index].quota.model.trim().replace(/\s+/g, ' ').toLowerCase() === 'gemini 4 argon') ?? antigravityIndexes[0];
  const otherLimit = antigravityIndexes.length ? 7 : 8;
  let otherCount = 0;

  return {
    rows: rows.filter((row, index) => row.view.id === 'antigravity'
      ? expanded || index === primaryIndex
      : otherCount++ < otherLimit),
    hiddenCount: Math.max(0, antigravityIndexes.length - 1),
  };
}
