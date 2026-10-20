import type { FocusSession } from '../types/index.js';

/**
 * tracker.ts — Per-session website visit time tracking.
 *
 * The tracker records how many seconds each domain was visited during a focus
 * session. It works by storing the start time of each visit externally (e.g. in
 * the service worker) and calling `endVisit` when the user navigates away.
 */

// ─── Track Visit Start ────────────────────────────────────────────────────────

/**
 * Records (or refreshes) a domain entry in the session's websitesVisited list.
 * If the domain already exists it is left unchanged — call `endVisit` to
 * accumulate time before calling `trackVisit` again after a navigation.
 *
 * @param domain  - Hostname string (e.g. "github.com").
 * @param session - The active FocusSession to mutate.
 * @returns A new FocusSession object with the domain entry present.
 */
export function trackVisit(domain: string, session: FocusSession): FocusSession {
  if (!domain) return session;

  const existing = session.websitesVisited.find((v) => v.url === domain);
  if (existing) {
    // Already tracked — nothing to add yet (duration accumulates on endVisit)
    return session;
  }

  return {
    ...session,
    websitesVisited: [
      ...session.websitesVisited,
      { url: domain, duration: 0 },
    ],
  };
}

// ─── End Visit ────────────────────────────────────────────────────────────────

/**
 * Adds the time spent on a domain (from `startTime` to now) to the session.
 *
 * @param domain    - Hostname string.
 * @param startTime - Unix timestamp (ms) of when the visit started.
 * @param session   - The active FocusSession to update.
 * @returns A new FocusSession with accumulated duration for the domain.
 */
export function endVisit(
  domain: string,
  startTime: number,
  session: FocusSession,
): FocusSession {
  if (!domain) return session;

  const elapsed = Math.floor((Date.now() - startTime) / 1000); // seconds

  const updatedVisits = session.websitesVisited.map((v) => {
    if (v.url === domain) {
      return { ...v, duration: v.duration + elapsed };
    }
    return v;
  });

  // If the domain wasn't in the list yet, add it now
  const found = session.websitesVisited.some((v) => v.url === domain);
  if (!found) {
    updatedVisits.push({ url: domain, duration: elapsed });
  }

  return {
    ...session,
    websitesVisited: updatedVisits,
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Returns the total time (in seconds) spent on a specific domain in a session.
 *
 * @param domain  - Hostname to look up.
 * @param session - The session to query.
 */
export function getDomainTime(domain: string, session: FocusSession): number {
  const entry = session.websitesVisited.find((v) => v.url === domain);
  return entry?.duration ?? 0;
}

/**
 * Returns a sorted list of visited domains by time spent (descending).
 *
 * @param session - The session to summarise.
 */
export function getSortedVisits(
  session: FocusSession,
): { url: string; duration: number }[] {
  return [...session.websitesVisited].sort((a, b) => b.duration - a.duration);
}
