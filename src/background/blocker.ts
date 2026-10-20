/**
 * blocker.ts — Website blocking logic for the Nudge extension.
 *
 * All functions are pure (no side effects) so they can be unit tested easily
 * and reused in both the service worker and any utility contexts.
 */

// ─── Domain Extraction ────────────────────────────────────────────────────────

/**
 * Extracts the hostname from a full URL string.
 * Returns an empty string if the URL is invalid or uses a non-http(s) scheme.
 *
 * @example
 * extractDomain("https://www.youtube.com/watch?v=abc") // → "www.youtube.com"
 */
export function extractDomain(url: string): string {
  try {
    const parsed = new URL(url);
    // Only handle http / https
    if (!parsed.protocol.startsWith('http')) return '';
    return parsed.hostname;
  } catch {
    return '';
  }
}

/**
 * Alias for extractDomain — kept for semantic clarity at call sites.
 */
export function getDomainFromUrl(url: string): string {
  return extractDomain(url);
}

// ─── Block Checking ───────────────────────────────────────────────────────────

/**
 * Normalises a domain pattern (strips leading "www." for loose matching).
 */
function normaliseDomain(domain: string): string {
  return domain.toLowerCase().replace(/^www\./, '');
}

/**
 * Returns `true` if the given URL's domain (or its parent domain) appears
 * in `blockedList`.
 *
 * Matching is domain-aware — "youtube.com" in the list will match
 * "www.youtube.com" and "m.youtube.com".
 *
 * @param url         - Full URL to test.
 * @param blockedList - Array of domain strings (e.g. ["youtube.com", "twitter.com"]).
 */
export function isWebsiteBlocked(url: string, blockedList: string[]): boolean {
  const hostname = extractDomain(url);
  if (!hostname) return false;

  const normHost = normaliseDomain(hostname);

  return blockedList.some((entry) => {
    const normEntry = normaliseDomain(entry);
    // Exact match or subdomain match
    return normHost === normEntry || normHost.endsWith(`.${normEntry}`);
  });
}

/**
 * Determines whether the Nudge overlay should be shown for a given URL.
 *
 * Rules:
 * 1. If internal/browser URL → do NOT nudge (false).
 * 2. If the URL is in the allowed list → do NOT nudge (false).
 * 3. If blockAllExceptAllowed (whitelist mode) is true → nudge (true) for all other URLs.
 * 4. Otherwise → nudge if URL is in blockedList.
 *
 * @param url                    - Full URL of the page being visited.
 * @param blockedList            - Domains the user wants to block during focus.
 * @param allowedList            - Domains always allowed (e.g. reference sites).
 * @param blockAllExceptAllowed  - When true, blocks ALL sites except allowedList.
 */
export function shouldShowNudge(
  url: string,
  blockedList: string[],
  allowedList: string[],
  blockAllExceptAllowed = false,
): boolean {
  if (isInternalUrl(url)) return false;

  // Explicit allow overrides everything (whitelisted)
  if (isWebsiteBlocked(url, allowedList)) return false;

  // In whitelist mode, everything else is blocked
  if (blockAllExceptAllowed) return true;

  return isWebsiteBlocked(url, blockedList);
}

// ─── URL Safety Check ─────────────────────────────────────────────────────────

/**
 * Returns `true` for URLs that are internal browser pages or extension pages
 * where content scripts and scripting injection are not permitted.
 */
export function isInternalUrl(url: string): boolean {
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('moz-extension://') ||
    url === '' ||
    url === 'about:blank'
  );
}


  