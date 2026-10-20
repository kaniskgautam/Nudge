/**
 * nudge-overlay.ts — Content script for the Nudge extension.
 *
 * Responsibilities:
 *  1. Active Screen-Time Heartbeat:
 *     Tracks active tab browsing time and sends RECORD_DOMAIN_USAGE heartbeats
 *     so screen-time stats work 100% reliably regardless of service worker lifecycle.
 *  2. Personality Reaction Engine:
 *     Adapts tone dynamically based on focus elapsed time & website:
 *      - < 2 min into focus: ANGRY / SCOLDING / RUDE ("10 seconds?! Are you serious?!")
 *      - ~Halfway: FIRM NUDGE & REMINDER ("Halfway there, don't drop the ball!")
 *      - > 70% done: GENTLE ADVICE & ENCOURAGING FINISH ("Just a few minutes left!")
 *      - Site-specific callouts for YouTube, Reddit, Twitter, Instagram, Netflix, etc.
 *  3. In-card Inline Name Editing:
 *     Clicking or double-clicking user name transforms it into an inline doodle input.
 *     Enter / ✓ saves and immediately updates settings across the extension.
 */

import type { BlockedPayload, Message } from '../types/index.js';

// ─── Guard: skip internal pages ───────────────────────────────────────────────

const currentUrl = window.location.href;
if (
  currentUrl.startsWith('chrome://') ||
  currentUrl.startsWith('chrome-extension://') ||
  currentUrl.startsWith('about:') ||
  currentUrl.startsWith('edge://')
) {
  throw new Error('[Nudge] Skipping internal page');
}

// ─── Constants ────────────────────────────────────────────────────────────────

const OVERLAY_ID = '__nudge_overlay__';

// ─── Screen-Time Heartbeat (Always-On Active Site Tracking) ───────────────────
// Requirements:
// 1. Always active across the browser (focusing or not).
// 2. Only add/record site after someone spends >= 10 seconds on it.
// 3. Hourly background alarm removes sites with < 60 seconds.
// 4. document.visibilityState === 'visible' tracks real engagement without
//    failing on YouTube video players, iframes, or mouse scrolling.

const currentHost = window.location.hostname.replace(/^www\./, '').toLowerCase().trim();
const isTrackableSite =
  Boolean(currentHost) &&
  !currentHost.includes('chrome-extension') &&
  !currentHost.startsWith('chrome');

let activeSecondsUnsent = 0;
let siteTotalSeconds = 0;
let hasQualified10Sec = false;

// Check sessionStorage so navigation between pages on the same website preserves time
try {
  const storedTotal = sessionStorage.getItem(`__nudge_time_${currentHost}__`);
  if (storedTotal) {
    siteTotalSeconds = parseInt(storedTotal, 10) || 0;
  }
  if (sessionStorage.getItem(`__nudge_qual_${currentHost}__`) === '1' || siteTotalSeconds >= 10) {
    hasQualified10Sec = true;
  }
} catch {
  // Session storage unavailable
}

function commitStoredProgress(): void {
  try {
    sessionStorage.setItem(`__nudge_time_${currentHost}__`, String(siteTotalSeconds));
    if (hasQualified10Sec) {
      sessionStorage.setItem(`__nudge_qual_${currentHost}__`, '1');
    }
  } catch {}
}

function flushActiveScreenTime(): void {
  if (!isTrackableSite || activeSecondsUnsent <= 0) return;
  // Strictly enforce: only add / record site once >= 10 seconds threshold is met!
  if (!hasQualified10Sec) return;

  const secondsToCommit = activeSecondsUnsent;
  activeSecondsUnsent = 0;
  commitStoredProgress();

  try {
    chrome.runtime.sendMessage(
      {
        type: 'RECORD_DOMAIN_USAGE',
        payload: { domain: currentHost, seconds: secondsToCommit },
      } satisfies Message,
      () => {
        if (chrome.runtime.lastError) {
          // SW context waking up or transitioning
        }
      },
    );
  } catch {
    // Service worker waking up or sleeping
  }
}

let lastTickTime = Date.now();

// Tick every second to measure real active engagement
setInterval(() => {
  const now = Date.now();
  const deltaMs = now - lastTickTime;
  lastTickTime = now;

  // Cap delta to prevent huge jumps if device was sleeping
  const elapsedSec = Math.min(2, Math.max(0, Math.floor(deltaMs / 1000)));
  if (elapsedSec <= 0) return;

  // Track time whenever the page tab is actively visible to the user
  if (isTrackableSite && document.visibilityState === 'visible') {
    siteTotalSeconds += elapsedSec;
    activeSecondsUnsent += elapsedSec;

    // Check 10-second threshold
    if (!hasQualified10Sec) {
      if (siteTotalSeconds >= 10) {
        hasQualified10Sec = true;
        commitStoredProgress();
        // Threshold met: immediately record so site appears in stats!
        flushActiveScreenTime();
      }
    } else {
      // Already qualified: flush every 5 seconds to keep live stats updated
      if (activeSecondsUnsent >= 5) {
        flushActiveScreenTime();
      }
    }
  }
}, 1000);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    flushActiveScreenTime();
  } else {
    lastTickTime = Date.now();
  }
});

window.addEventListener('beforeunload', () => {
  flushActiveScreenTime();
});

window.addEventListener('pagehide', () => {
  flushActiveScreenTime();
});

// ─── Types & Reactions ────────────────────────────────────────────────────────

type ReactionStage = 'angry' | 'halfway' | 'gentle' | 'normal';

// ─── Tag-Aware & Subject-Aware Phrase Generator ────────────────────────────────

function getActivityPhrases(
  taskTitle: string,
  tags: string[] = [],
  category: string = '',
): {
  wontDo: string;
  action: string;
} {
  const combined = `${taskTitle} ${(tags || []).join(' ')} ${category || ''}`.toLowerCase();

  // 1. Chemistry
  if (
    combined.includes('chemist') ||
    combined.includes('organic') ||
    combined.includes('periodic') ||
    combined.includes('reaction') ||
    combined.includes('molecule') ||
    combined.includes('acid')
  ) {
    return {
      wontDo: "won't revise chemistry for you",
      action: "chemistry revision",
    };
  }

  // 2. Physics
  if (
    combined.includes('physic') ||
    combined.includes('mechanic') ||
    combined.includes('quantum') ||
    combined.includes('thermodynamic') ||
    combined.includes('gravity') ||
    combined.includes('optics')
  ) {
    return {
      wontDo: "won't solve your physics equations",
      action: "physics problems",
    };
  }

  // 3. Math & Calculus
  if (
    combined.includes('calculus') ||
    combined.includes('integral') ||
    combined.includes('derivative')
  ) {
    return {
      wontDo: "won't solve your calculus integrals",
      action: "your calculus equations",
    };
  }

  if (
    combined.includes('math') ||
    combined.includes('algebra') ||
    combined.includes('geometry') ||
    combined.includes('equation') ||
    combined.includes('arithmetic') ||
    combined.includes('trig')
  ) {
    return {
      wontDo: "won't solve your math equations",
      action: "your math equations",
    };
  }

  // 4. Biology & Life Sciences
  if (
    combined.includes('bio') ||
    combined.includes('anatomy') ||
    combined.includes('genetics') ||
    combined.includes('cell') ||
    combined.includes('medical')
  ) {
    return {
      wontDo: "won't memorize biology concepts for you",
      action: "biology revision",
    };
  }

  // 5. Coding & Tech
  if (
    combined.includes('code') ||
    combined.includes('coding') ||
    combined.includes('program') ||
    combined.includes('python') ||
    combined.includes('javascript') ||
    combined.includes('typescript') ||
    combined.includes('react') ||
    combined.includes('rust') ||
    combined.includes('java') ||
    combined.includes('c++') ||
    combined.includes('backend') ||
    combined.includes('frontend') ||
    combined.includes('debug') ||
    combined.includes('git') ||
    combined.includes('bug') ||
    combined.includes('api') ||
    combined.includes('sql')
  ) {
    return {
      wontDo: "won't write your code",
      action: "shipping your code",
    };
  }

  // 6. Learning / Study / Exam / Homework
  if (
    combined.includes('exam') ||
    combined.includes('test') ||
    combined.includes('midterm') ||
    combined.includes('quiz')
  ) {
    return {
      wontDo: "won't pass that exam for you",
      action: "exam preparation",
    };
  }

  if (
    combined.includes('learn') ||
    combined.includes('study') ||
    combined.includes('revis') ||
    combined.includes('homework') ||
    combined.includes('lecture') ||
    combined.includes('course') ||
    combined.includes('school') ||
    combined.includes('college') ||
    combined.includes('syllabus') ||
    combined.includes('history') ||
    combined.includes('geography')
  ) {
    return {
      wontDo: "won't study for you",
      action: "your study session",
    };
  }

  // 7. Writing & Content
  if (
    combined.includes('write') ||
    combined.includes('writing') ||
    combined.includes('essay') ||
    combined.includes('paper') ||
    combined.includes('blog') ||
    combined.includes('draft') ||
    combined.includes('notes') ||
    combined.includes('article') ||
    combined.includes('thesis') ||
    combined.includes('report')
  ) {
    return {
      wontDo: "won't draft your writing",
      action: "finishing your draft",
    };
  }

  // 8. Design & Creative
  if (
    combined.includes('design') ||
    combined.includes('figma') ||
    combined.includes('sketch') ||
    combined.includes('doodle') ||
    combined.includes('art') ||
    combined.includes('logo') ||
    combined.includes('draw') ||
    combined.includes('ui') ||
    combined.includes('ux')
  ) {
    return {
      wontDo: "won't design your mockups",
      action: "your design project",
    };
  }

  // 9. Health & Fitness
  if (
    combined.includes('gym') ||
    combined.includes('workout') ||
    combined.includes('fitness') ||
    combined.includes('exercise') ||
    combined.includes('run') ||
    combined.includes('cook')
  ) {
    return {
      wontDo: "won't do your workout",
      action: "your fitness routine",
    };
  }

  // 10. Work & Professional
  if (
    combined.includes('work') ||
    combined.includes('client') ||
    combined.includes('meeting') ||
    combined.includes('sync') ||
    combined.includes('deck') ||
    combined.includes('slides') ||
    combined.includes('tax') ||
    combined.includes('invoice')
  ) {
    return {
      wontDo: "won't finish your work for you",
      action: "your work project",
    };
  }

  // Fallback: adapt dynamically to taskTitle
  const cleanTitle = taskTitle.trim();
  const displayTitle = cleanTitle.length > 25 ? `${cleanTitle.slice(0, 22)}...` : cleanTitle;
  return {
    wontDo: `won't finish "${displayTitle}" for you`,
    action: `completing "${displayTitle}"`,
  };
}

// ─── Personality & Reaction Analysis ──────────────────────────────────────────

function getReactionDetails(payload: BlockedPayload): {
  stage: ReactionStage;
  title: string;
  message: string;
} {
  const { userName, taskTitle, domain, tags = [], category = '' } = payload;
  const elapsedSec = payload.sessionElapsedSeconds ?? 0;
  const totalMin = payload.sessionTotalMinutes ?? 30;
  const totalSec = totalMin * 60;
  const elapsedMin = Math.floor(elapsedSec / 60);
  const leftMin = Math.max(1, totalMin - elapsedMin);
  const progressRatio = totalSec > 0 ? elapsedSec / totalSec : 0;

  const domLower = (domain || '').toLowerCase().replace(/^www\./, '');
  const isYouTube = domLower.includes('youtube');
  const isReddit = domLower.includes('reddit');
  const isInstagram = domLower.includes('instagram');
  const isTwitter = domLower.includes('twitter') || domLower.includes('x.com');
  const isNetflix = domLower.includes('netflix');
  const isTwitch = domLower.includes('twitch');
  const isTikTok = domLower.includes('tiktok');

  const { wontDo, action } = getActivityPhrases(taskTitle, tags, category);

  const nameBtn = `<button class="nudge-name-clickable" id="nudge-edit-name" type="button" title="Click or double-click to change your name">${escapeHtml(userName)} <span class="nudge-pencil-icon">✏️</span></button>`;
  const taskSpan = `<em>${escapeHtml(taskTitle)}</em>`;
  const siteSpan = `<strong>${escapeHtml(domLower)}</strong>`;

  // 1. Stage: ANGRY (< 120 seconds into focus)
  // Rude / scolding / sarcastic because they just started!
  if (elapsedSec < 120) {
    let title = 'Are you serious right now?! 💀';
    let msg = '';

    if (elapsedSec <= 30) {
      title = `${elapsedSec} seconds?! Really?! 💀`;
    } else if (isYouTube || isNetflix) {
      title = 'Bro... you just started! 😤';
    }

    if (isYouTube) {
      msg = `${nameBtn}, you literally clicked focus less than 2 minutes ago and immediately opened YouTube?! Watching videos ${wontDo}! Close this tab! 🛑`;
    } else if (isReddit) {
      msg = `Did you really just open Reddit ${elapsedSec}s into ${taskSpan}?! Doomscrolling comments ${wontDo}, ${nameBtn}! Close it!`;
    } else if (isInstagram) {
      msg = `${nameBtn}! You started focusing 1 minute ago and your thumb went straight to Instagram?! Watching reels ${wontDo}! Close it right now! 🤦`;
    } else if (isTwitter) {
      msg = `Whatever hot take is on X right now can wait. Arguing online ${wontDo}, ${nameBtn}! Back to ${taskSpan}! 😤`;
    } else if (isNetflix) {
      msg = `Netflix?! ${elapsedSec} seconds after clicking focus?! Binge-watching shows ${wontDo}, ${nameBtn}! Close this immediately!`;
    } else if (isTwitch || isTikTok) {
      msg = `Watching streams barely a minute into ${taskSpan}?! That stream ${wontDo}, ${nameBtn}! 🛑`;
    } else {
      msg = `${nameBtn}, you've been 'focusing' on ${taskSpan} for barely ${Math.max(5, elapsedSec)} seconds and you already opened ${siteSpan}?! Browsing ${siteSpan} ${wontDo}! Back to work! 😤`;
    }

    return { stage: 'angry', title, message: msg };
  }

  // 2. Stage: GENTLE ADVICE (> 70% completed, near finish line)
  // Gentle encouraging advice since they are almost done!
  if (progressRatio >= 0.70) {
    const title = 'Almost at the finish line! 🏁';
    let msg = '';

    if (isYouTube) {
      msg = `You've already conquered ${elapsedMin} minutes of ${taskSpan}, ${nameBtn}! Only ${leftMin} minutes left—finish strong with ${action}, then watch YouTube guilt-free! 🎉`;
    } else if (isReddit) {
      msg = `So close, ${nameBtn}! You've put in ${elapsedMin} solid minutes. Just ${leftMin} more minutes until ${taskSpan} is complete. Power through and finish ${action}! 💪`;
    } else {
      msg = `Gentle reminder, ${nameBtn}: you've already powered through ${elapsedMin} minutes of ${taskSpan}. You're just ${leftMin} minutes from finishing ${action}—don't quit now! 🌱`;
    }

    return { stage: 'gentle', title, message: msg };
  }

  // 3. Stage: HALFWAY (35% to 69% completed)
  // Firm nudge & reminder!
  if (progressRatio >= 0.35) {
    const title = 'Halfway there, hold the line! 👀';
    let msg = '';

    if (isYouTube) {
      msg = `${nameBtn}, you're halfway through ${taskSpan} (${elapsedMin}m in). One 'quick' YouTube video is going to turn into 40 minutes—don't let it steal your momentum on ${action}!`;
    } else if (isReddit) {
      msg = `You're at the halfway mark on ${taskSpan} (${elapsedMin}m done), ${nameBtn}. Reddit's rabbit holes can wait until you've finished ${action}!`;
    } else {
      msg = `${nameBtn}, you're halfway through ${taskSpan} (${elapsedMin}m of ${totalMin}m done). You're building great momentum—don't let ${siteSpan} sabotage ${action}! ⏱️`;
    }

    return { stage: 'halfway', title, message: msg };
  }

  // 4. Stage: NORMAL (2 to 10 minutes in)
  return {
    stage: 'normal',
    title: 'Why are we here? 👀',
    message: `${nameBtn}, you're browsing ${siteSpan} while ${taskSpan} needs your attention. Browsing ${siteSpan} ${wontDo}!`,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Character Doodle Face SVG ────────────────────────────────────────────────

function renderDoodleFace(stage: ReactionStage): string {
  if (stage === 'angry') {
    return `
      <svg width="68" height="68" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Angry face doodle: red-tint paper, furrowed angry eyebrows, grimace -->
        <circle cx="32" cy="32" r="28" stroke="#18181b" stroke-width="2.5" fill="#fee2e2"/>
        <!-- Angry furrowed eyebrows -->
        <path d="M18 21L28 26" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M46 21L36 26" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
        <!-- Glaring Eyes -->
        <circle cx="23" cy="30" r="3.5" fill="#18181b"/>
        <circle cx="41" cy="30" r="3.5" fill="#18181b"/>
        <!-- Angry steam puffs -->
        <path d="M12 14C12 11 15 9 17 11" stroke="#dc2626" stroke-width="2" stroke-linecap="round"/>
        <path d="M52 14C52 11 49 9 47 11" stroke="#dc2626" stroke-width="2" stroke-linecap="round"/>
        <!-- Zigzag mouth -->
        <path d="M22 45L27 41L32 45L37 41L42 45" stroke="#18181b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    `;
  }

  if (stage === 'halfway') {
    return `
      <svg width="68" height="68" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Halfway face: yellow-tint paper, skeptical side-eye, arched brow -->
        <circle cx="32" cy="32" r="28" stroke="#18181b" stroke-width="2.5" fill="#fef9c3"/>
        <!-- Arched eyebrow left, flat eyebrow right -->
        <path d="M18 19C22 16 27 18 28 21" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M36 24H46" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
        <!-- Side-eye pupils looking sideways -->
        <circle cx="21" cy="28" r="3.5" fill="#18181b"/>
        <circle cx="39" cy="28" r="3.5" fill="#18181b"/>
        <!-- Skeptical mouth -->
        <path d="M26 42C30 44 38 41 40 38" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    `;
  }

  if (stage === 'gentle') {
    return `
      <svg width="68" height="68" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <!-- Cheerful gentle face: green-tint paper, happy eyes, wide smile -->
        <circle cx="32" cy="32" r="28" stroke="#18181b" stroke-width="2.5" fill="#ecfdf5"/>
        <!-- Happy curved eyes ^ ^ -->
        <path d="M19 28C22 24 26 24 28 28" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
        <path d="M36 28C39 24 43 24 45 28" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
        <!-- Soft blush -->
        <circle cx="16" cy="36" r="3" fill="#86efac" opacity="0.6"/>
        <circle cx="48" cy="36" r="3" fill="#86efac" opacity="0.6"/>
        <!-- Big cheering smile -->
        <path d="M23 38C28 46 36 46 41 38" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
      </svg>
    `;
  }

  // Classic doodle face
  return `
    <svg width="68" height="68" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="32" cy="32" r="28" stroke="#18181b" stroke-width="2.5" fill="#faf8f3"/>
      <circle cx="23" cy="28" r="3" fill="#18181b"/>
      <circle cx="41" cy="28" r="3" fill="#18181b"/>
      <path d="M19 22C22 20 27 21 28 23" stroke="#18181b" stroke-width="2" stroke-linecap="round"/>
      <path d="M45 22C42 20 37 21 36 23" stroke="#18181b" stroke-width="2" stroke-linecap="round"/>
      <path d="M49 32C51 34 51 37 49 38C47 39 45 37 46 35L49 32Z" fill="#3b82f6" stroke="#18181b" stroke-width="1.5"/>
      <path d="M24 43C28 40 36 40 40 43" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
    </svg>
  `;
}

// ─── Overlay Helpers ──────────────────────────────────────────────────────────

function removeExistingOverlay(): void {
  document.getElementById(OVERLAY_ID)?.remove();
  document.getElementById('__nudge_soft_block__')?.remove();
  document.getElementById('__nudge_hard_block__')?.remove();
  document.querySelectorAll('.nudge-overlay').forEach((el) => el.remove());
}

function safeAttach(overlay: HTMLElement): void {
  if (document.body) {
    document.body.appendChild(overlay);
  } else {
    const onReady = (): void => {
      if (document.body && !document.body.contains(overlay)) {
        document.body.appendChild(overlay);
      }
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', onReady, { once: true });
    }
    (document.documentElement || document.head).appendChild(overlay);
  }
}

// ─── Soft Overlay (Doodle Card with Reactive Personality) ─────────────────────

function createSoftOverlay(payload: BlockedPayload): void {
  removeExistingOverlay();

  const { stage, title, message } = getReactionDetails(payload);

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = `nudge-overlay nudge-soft stage-${stage}`;

  overlay.innerHTML = `
    <div class="nudge-card nudge-card-${stage}">
      <div class="nudge-header-tag">
        <span class="nudge-doodle-icon">✏️</span>
        <span class="nudge-tag-text">Nudge Focus</span>
      </div>

      <div class="nudge-character-doodle">
        ${renderDoodleFace(stage)}
      </div>

      <h2 class="nudge-title">${title}</h2>
      <p class="nudge-message" id="nudge-msg-paragraph">${message}</p>

      <div class="nudge-task-pill">
        <span class="nudge-task-pill-label">Working on:</span>
        <strong class="nudge-task-pill-name">${escapeHtml(payload.taskTitle)}</strong>
      </div>

      <div class="nudge-actions">
        <button class="nudge-btn-primary" id="nudge-back-btn">
          Back to Work ✊
        </button>
        <button class="nudge-btn-secondary" id="nudge-dismiss-btn">
          I'll be quick (3 min)
        </button>
      </div>
    </div>
  `;

  safeAttach(overlay);
  bindButtons(overlay, payload);
}

// ─── Hard Overlay (Focus Lock) ────────────────────────────────────────────────

function createHardOverlay(payload: BlockedPayload): void {
  removeExistingOverlay();

  const { stage, title, message } = getReactionDetails(payload);

  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.className = `nudge-overlay nudge-hard stage-${stage}`;

  overlay.innerHTML = `
    <div class="nudge-card nudge-card-hard nudge-card-${stage}">
      <div class="nudge-header-tag nudge-header-tag-dark">
        <span class="nudge-doodle-icon">🔒</span>
        <span class="nudge-tag-text">Focus Lock Active</span>
      </div>

      <div class="nudge-character-doodle">
        <svg width="72" height="72" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="16" y="26" width="32" height="28" rx="4" fill="#faf8f3" stroke="#18181b" stroke-width="3"/>
          <path d="M22 26V18C22 12.4772 26.4772 8 32 8C37.5228 8 42 12.4772 42 18V26" stroke="#18181b" stroke-width="3" stroke-linecap="round"/>
          <circle cx="32" cy="38" r="3" fill="#18181b"/>
          <path d="M32 41V46" stroke="#18181b" stroke-width="2.5" stroke-linecap="round"/>
        </svg>
      </div>

      <h1 class="nudge-title">${title}</h1>
      <p class="nudge-message" id="nudge-msg-paragraph">${message}</p>

      <div class="nudge-task-pill">
        <span class="nudge-task-pill-label">Committed task:</span>
        <strong class="nudge-task-pill-name">${escapeHtml(payload.taskTitle)}</strong>
      </div>

      <div class="nudge-actions">
        <button class="nudge-btn-primary" id="nudge-back-btn">
          Back to Work ✊
        </button>
      </div>
    </div>
  `;

  safeAttach(overlay);
  bindButtons(overlay, payload);
}

// ─── Button & Inline Name Edit Binding ────────────────────────────────────────

function bindButtons(overlay: HTMLElement, payload: BlockedPayload): void {
  overlay.querySelector('#nudge-back-btn')?.addEventListener('click', () => {
    removeExistingOverlay();
    try {
      history.back();
    } catch {
      window.location.href = 'about:blank';
    }
  });

  overlay.querySelector('#nudge-dismiss-btn')?.addEventListener('click', () => {
    removeExistingOverlay();
  });

  // ── Bulletproof Inline Name Editor (Single AND Double Click) ─────────────────
  const attachNameEditor = (): void => {
    const editBtn = overlay.querySelector<HTMLButtonElement>('#nudge-edit-name');
    if (!editBtn) return;

    const startEditing = (e: Event): void => {
      e.preventDefault();
      e.stopPropagation();

      const current = payload.userName;
      const wrap = document.createElement('span');
      wrap.className = 'nudge-inline-name-box';
      wrap.innerHTML = `
        <input type="text" id="nudge-name-input" class="nudge-name-input" value="${escapeHtml(current)}" maxlength="20" />
        <button type="button" id="nudge-name-save-btn" class="nudge-name-save-btn" title="Save name">✓</button>
      `;

      editBtn.replaceWith(wrap);

      const input = wrap.querySelector<HTMLInputElement>('#nudge-name-input');
      const saveBtn = wrap.querySelector<HTMLButtonElement>('#nudge-name-save-btn');

      if (input) {
        input.focus();
        input.select();

        const saveAndExit = (): void => {
          const val = input.value.trim();
          if (val && val !== payload.userName) {
            payload.userName = val;
            try {
              chrome.runtime.sendMessage({
                type: 'UPDATE_USER_NAME',
                payload: { userName: val },
              } satisfies Message);
            } catch {
              // Service worker waking up
            }
          }
          // Re-render message with updated name
          const msgEl = overlay.querySelector('#nudge-msg-paragraph');
          if (msgEl) {
            const { message } = getReactionDetails(payload);
            msgEl.innerHTML = message;
            attachNameEditor();
          }
        };

        saveBtn?.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          saveAndExit();
        });

        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            saveAndExit();
          } else if (ev.key === 'Escape') {
            ev.preventDefault();
            const msgEl = overlay.querySelector('#nudge-msg-paragraph');
            if (msgEl) {
              const { message } = getReactionDetails(payload);
              msgEl.innerHTML = message;
              attachNameEditor();
            }
          }
        });
      }
    };

    // Support both single click AND double click!
    editBtn.addEventListener('click', startEditing);
    editBtn.addEventListener('dblclick', startEditing);
  };

  attachNameEditor();
}

// ─── Message Listener (Push from Background) ──────────────────────────────────

chrome.runtime.onMessage.addListener((message: Message, _sender, sendResponse) => {
  if (message.type === 'WEBSITE_BLOCKED') {
    const payload = message.payload as BlockedPayload;
    if (payload.blockingMode === 'hard') {
      createHardOverlay(payload);
    } else {
      createSoftOverlay(payload);
    }
    sendResponse({ received: true });
    return true;
  }

  if (message.type === 'STOP_FOCUS' || message.type === 'STATE_UPDATED') {
    removeExistingOverlay();
  }

  return false;
});

// ─── Proactive Check (Pull on Page Load) ───────────────────────────────────────

function checkCurrentPage(): void {
  try {
    chrome.runtime.sendMessage(
      {
        type: 'CHECK_BLOCKED',
        payload: { url: window.location.href },
      } satisfies Message,
      (response: unknown) => {
        if (chrome.runtime.lastError) return;
        const res = response as {
          blocked?: boolean;
          payload?: BlockedPayload;
        };
        if (res && res.blocked && res.payload) {
          if (res.payload.blockingMode === 'hard') {
            createHardOverlay(res.payload);
          } else {
            createSoftOverlay(res.payload);
          }
        }
      },
    );
  } catch {
    // Service worker might be starting
  }
}

checkCurrentPage();
