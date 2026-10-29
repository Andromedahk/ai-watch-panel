/** Zhanyu keeps four agents on its left face. RYUO's wider left area can show
 * two, four or six cards. Both profiles keep cards away from the companion area even
 * when a preview happens to be square or portrait. */
export function screenLayout(width: number, height: number, count: number, _mascot: boolean, device = 'zhanyu', agentsPerPage = 4) {
  const limit = device === 'ryuo4' && [2, 6].includes(agentsPerPage) ? agentsPerPage : 4;
  const capacity = Math.max(1, Math.min(count, limit));
  return { capacity, columns: Math.min(limit === 6 ? 3 : 2, capacity), portrait: height > width };
}
