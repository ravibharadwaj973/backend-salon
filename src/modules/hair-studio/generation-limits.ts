/**
 * HOW A DAY'S PICTURE ALLOWANCE IS DIVIDED.
 *
 * Its own module, with no imports, for a reason worth stating: this is policy,
 * not plumbing. It is the answer to "who is this budget for", it is the thing
 * most likely to be argued about and changed, and it should be readable and
 * testable without starting a database — which is exactly what happened when it
 * lived in the service and a unit test of it opened a Prisma connection.
 */

/**
 * WHAT THE LOOK-BOOK MAY SPEND ON ITSELF, AS A SHARE OF THE DAY.
 *
 * ── Why the library gets a share rather than the same pot ─────────────────
 *
 * Two things spend this budget and they are not worth the same.
 *
 * One is a stand-in picture on a menu entry — a drawn face illustrating a cut
 * nobody has photographed yet. A photograph of the salon's own work does that
 * job better and for nothing, and uploading one has no limit at all.
 *
 * The other is a preview for the person sitting in the chair: her own
 * photograph, with the hair she is considering on it, while she is deciding.
 * That is what this feature is for.
 *
 * Share one pot and the first quietly eats the second. Filling in thirty empty
 * menu tiles on a slow Tuesday afternoon is precisely the activity that empties
 * a daily cap, and the salon discovers it at six o'clock with a customer
 * watching. So the reserve is structural rather than advisory: the library
 * cannot spend past its share however many times the button is pressed, and
 * what remains is there for customers by construction.
 */
export const LIBRARY_SHARE_OF_DAY = 0.25;

/**
 * The library's ceiling for one day, derived from the salon's daily cap.
 *
 * Never zero on a small cap — a salon setting up on day one with an empty menu
 * has to be able to draw at least one — and uncapped when the day itself is
 * uncapped, because 0 means "no limit" everywhere else in this codebase and a
 * second meaning for it here would be a trap.
 */
export function libraryAllowance(dailyLimit: number): number {
  if (dailyLimit <= 0) return 0;
  return Math.max(1, Math.floor(dailyLimit * LIBRARY_SHARE_OF_DAY));
}
