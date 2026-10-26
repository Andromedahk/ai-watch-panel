/** The current 90° curved device has two equal physical faces in its unfolded frame.
 * Keep four agents on the left face; never move a card across the bend or move the
 * right-hand panels below it because a preview happens to be square/portrait. */
export function screenLayout(width: number, height: number, count: number, _mascot: boolean) {
  const capacity = Math.max(1, Math.min(count, 4));
  return { capacity, columns: Math.min(2, capacity), portrait: height > width };
}
