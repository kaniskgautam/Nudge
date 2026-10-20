/**
 * timer.ts — Alarm-backed timer helpers for the Nudge extension.
 *
 * chrome.alarms is used for persistence across service-worker restarts.
 * For live countdown display, the popup computes elapsed time client-side
 * from the `timerStartedAt` timestamp stored in AppState.
 */

// ─── Alarm Management ─────────────────────────────────────────────────────────

/**
 * Creates (or replaces) a chrome.alarm with the given name.
 * @param durationMinutes - How many minutes from now the alarm should fire.
 * @param alarmName       - Unique alarm identifier (e.g. 'focus-timer', 'break-timer').
 */
export function startTimer(durationMinutes: number, alarmName: string): void {
  chrome.alarms.create(alarmName, {
    delayInMinutes: durationMinutes,
  });
}

/**
 * Cancels an existing chrome.alarm by name. No-op if the alarm doesn't exist.
 * @param alarmName - The alarm identifier to cancel.
 */
export function stopTimer(alarmName: string): void {
  chrome.alarms.clear(alarmName);
}

// ─── Time Computation ─────────────────────────────────────────────────────────

/**
 * Computes how many seconds remain on a timer that was started at `startedAt`
 * and runs for `durationMinutes`.
 *
 * Returns 0 if the timer has already expired.
 *
 * @param startedAt       - ISO timestamp string of when the timer started.
 * @param durationMinutes - Total timer duration in minutes.
 */
export function getRemainingTime(
  startedAt: string,
  durationMinutes: number,
): number {
  const startMs = new Date(startedAt).getTime();
  const durationMs = durationMinutes * 60 * 1000;
  const endMs = startMs + durationMs;
  const remainingMs = endMs - Date.now();
  return Math.max(0, Math.floor(remainingMs / 1000));
}

/**
 * Formats a duration in seconds to a human-readable MM:SS string.
 *
 * @param seconds - Total seconds to format.
 * @returns A string like "04:32" or "01:00:00" for values ≥ 1 hour.
 */
export function formatTime(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const secs = s % 60;

  const mm = String(minutes).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');

  if (hours > 0) {
    const hh = String(hours).padStart(2, '0');
    return `${hh}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}

/**
 * Returns the elapsed time in seconds since `startedAt`.
 *
 * @param startedAt - ISO timestamp string of when the timer started.
 */
export function getElapsedTime(startedAt: string): number {
  const startMs = new Date(startedAt).getTime();
  return Math.floor((Date.now() - startMs) / 1000);
}
