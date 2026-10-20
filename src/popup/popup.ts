/**
 * popup.ts — Single-page popup controller for the Nudge extension.
 *
 * Views:
 *  - TODAY      : Daily intentions list (clean and fresh each day)
 *  - FOCUS_LOCK : Live countdown with interactive blocklist/whitelist management
 *  - BREAK      : Break countdown in cozy cream paper & ink aesthetic
 *  - ADD_TASK   : Form with dynamic quick-add, whitelist/blacklist mode, NLP tagging & interactive tag panel
 *  - BLOCKLIST  : Global default blocklist manager
 *  - CALENDAR   : Historical focus breakdown by tags beneath selected date
 *  - ANALYTICS  : Phone screen-time style usage stats (Day donut, Week date vs time, Month week vs time)
 */

import type {
  AppState,
  DailyTagFocus,
  FocusState,
  Message,
  Task,
  TaskPriority,
  UserSettings,
  WebsiteUsageData,
} from '../types/index.js';
import { formatTime, getRemainingTime } from '../background/timer.js';
import { DEFAULT_BLOCKED_WEBSITES } from '../background/storage.js';

// ─── Types ────────────────────────────────────────────────────────────────────

type View = 'TODAY' | 'FOCUS_LOCK' | 'BREAK' | 'ADD_TASK' | 'BLOCKLIST' | 'CALENDAR' | 'ANALYTICS';
type AnalyticsTab = 'DAY' | 'WEEK' | 'MONTH';

interface TagInference {
  category: string;
  icon: string;
  tags: string[];
  priorityHint: TaskPriority | null;
}

// ─── Catalogs ─────────────────────────────────────────────────────────────────

const DISTRACTION_CATALOG: { domain: string; label: string }[] = [
  { domain: 'youtube.com', label: 'YouTube' },
  { domain: 'reddit.com', label: 'Reddit' },
  { domain: 'instagram.com', label: 'Instagram' },
  { domain: 'twitter.com', label: 'Twitter' },
  { domain: 'x.com', label: 'X' },
  { domain: 'tiktok.com', label: 'TikTok' },
  { domain: 'netflix.com', label: 'Netflix' },
  { domain: 'twitch.tv', label: 'Twitch' },
  { domain: 'discord.com', label: 'Discord' },
  { domain: 'facebook.com', label: 'Facebook' },
  { domain: 'linkedin.com', label: 'LinkedIn' },
  { domain: 'pinterest.com', label: 'Pinterest' },
  { domain: 'amazon.com', label: 'Amazon' },
  { domain: 'news.ycombinator.com', label: 'Hacker News' },
  { domain: 'disneyplus.com', label: 'Disney+' },
  { domain: 'hulu.com', label: 'Hulu' },
  { domain: 'buzzfeed.com', label: 'BuzzFeed' },
  { domain: 'quora.com', label: 'Quora' },
  { domain: 'steamcommunity.com', label: 'Steam' },
  { domain: 'roblox.com', label: 'Roblox' },
];

const WHITELIST_CATALOG: { domain: string; label: string }[] = [
  { domain: 'github.com', label: 'GitHub' },
  { domain: 'stackoverflow.com', label: 'Stack Overflow' },
  { domain: 'google.com', label: 'Google' },
  { domain: 'docs.python.org', label: 'Python Docs' },
  { domain: 'notion.so', label: 'Notion' },
  { domain: 'figma.com', label: 'Figma' },
  { domain: 'chatgpt.com', label: 'ChatGPT' },
  { domain: 'localhost', label: 'Localhost' },
  { domain: 'wikipedia.org', label: 'Wikipedia' },
  { domain: 'developer.mozilla.org', label: 'MDN Web Docs' },
];

const TAG_ICONS: Record<string, string> = {
  coding: '💻', python: '🐍', javascript: '⚡', backend: '⚙️', frontend: '🎨', bugfix: '🐛',
  learn: '📚', math: '📐', revision: '📝', exam: '🎯', reading: '📖',
  writing: '✍️', essay: '📄', blog: '🖋️', report: '📊',
  health: '🏃', cooking: '🍳', fitness: '💪',
  work: '💼', meeting: '👥',
  design: '🎨', figma: '📐',
  other: '🏷️',
};

// ─── State ────────────────────────────────────────────────────────────────────

let currentState: AppState | null = null;
let currentTasks: Task[] = [];
let userSettings: UserSettings | null = null;
let currentView: View = 'TODAY';
let timerInterval: ReturnType<typeof setInterval> | null = null;
let userName = 'Friend';
let globalBlockedSites: string[] = [...DEFAULT_BLOCKED_WEBSITES];

// Historical & Screen-Time Data
let dailyTagFocusData: DailyTagFocus = {};
let websiteUsageData: WebsiteUsageData = {};

// Calendar View State
let calCurrentYear: number = new Date().getFullYear();
let calCurrentMonth: number = new Date().getMonth(); // 0-11
let selectedCalDate: string = new Date().toISOString().split('T')[0];

// Analytics View State
let currentAnalyticsTab: AnalyticsTab = 'DAY';

// Form Draft State
let draftBlockedSites: string[] = [];
let draftAllowedSites: string[] = [];
let draftBlockMode: 'blacklist' | 'whitelist' = 'blacklist';
let draftCategory = '';
let draftTags: string[] = [];

// ─── Messaging ────────────────────────────────────────────────────────────────

async function sendMsg(message: Message): Promise<unknown> {
  return chrome.runtime.sendMessage(message);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  try {
    // Run daily rollover: prune past tasks from today view, archive their focus to calendar
    await sendMsg({ type: 'ARCHIVE_PAST_TASKS' });

    const [stateRes, storageRes, tagFocusRes, webUsageRes] = await Promise.all([
      sendMsg({ type: 'GET_STATE' }) as Promise<AppState>,
      chrome.storage.local.get(['tasks', 'settings', 'dailyTagFocus', 'websiteUsage']),
      sendMsg({ type: 'GET_DAILY_TAG_FOCUS' }) as Promise<DailyTagFocus>,
      sendMsg({ type: 'GET_WEBSITE_USAGE' }) as Promise<WebsiteUsageData>,
    ]);

    currentState = stateRes;
    const allTasks = (storageRes['tasks'] as Task[]) ?? [];
    const todayStr = new Date().toISOString().split('T')[0];

    // Main page is fresh each day: filter strictly for today's tasks
    currentTasks = allTasks.filter((t) => t.date === todayStr || !t.date);

    userSettings = (storageRes['settings'] as UserSettings) ?? null;
    userName = userSettings?.userName ?? 'Friend';
    globalBlockedSites = userSettings?.defaultBlockedWebsites && userSettings.defaultBlockedWebsites.length > 0
      ? [...userSettings.defaultBlockedWebsites]
      : [...DEFAULT_BLOCKED_WEBSITES];

    dailyTagFocusData = tagFocusRes || (storageRes['dailyTagFocus'] as DailyTagFocus) || {};
    websiteUsageData = webUsageRes || (storageRes['websiteUsage'] as WebsiteUsageData) || {};

    currentView = focusStateToView(currentState.focusState);
    render();
  } catch (err) {
    console.error('[Nudge Popup] Init error:', err);
    renderError();
  }
}

function focusStateToView(state: FocusState): View {
  if (state === 'FOCUSING') return 'FOCUS_LOCK';
  if (state === 'BREAK') return 'BREAK';
  return 'TODAY';
}

// ─── Router / Renderer ────────────────────────────────────────────────────────

function render(): void {
  stopTimer();

  switch (currentView) {
    case 'FOCUS_LOCK': renderFocusLock(); break;
    case 'BREAK':      renderBreak();     break;
    case 'ADD_TASK':   renderAddTask();   break;
    case 'BLOCKLIST':  renderBlocklist(); break;
    case 'CALENDAR':   renderCalendar();  break;
    case 'ANALYTICS':  renderAnalytics(); break;
    default:           renderToday();
  }
}

function getApp(): HTMLElement {
  return document.getElementById('app')!;
}

// ─── Bottom Navigation Bar ────────────────────────────────────────────────────

function renderNavBar(active: View): string {
  return `
    <nav class="popup-nav-bar">
      <button class="nav-item ${active === 'TODAY' ? 'active' : ''}" data-nav="TODAY" title="Today's Intentions">
        <span class="nav-icon">📋</span>
        <span class="nav-label">Today</span>
      </button>
      <button class="nav-item ${active === 'CALENDAR' ? 'active' : ''}" data-nav="CALENDAR" title="Focus Calendar by Tags">
        <span class="nav-icon">📅</span>
        <span class="nav-label">Calendar</span>
      </button>
      <button class="nav-item ${active === 'ANALYTICS' ? 'active' : ''}" data-nav="ANALYTICS" title="Screen Time Analytics">
        <span class="nav-icon">📊</span>
        <span class="nav-label">Screen Time</span>
      </button>
      <button class="nav-item ${active === 'BLOCKLIST' ? 'active' : ''}" data-nav="BLOCKLIST" title="Website Blocklist">
        <span class="nav-icon">🚫</span>
        <span class="nav-label">Blocklist</span>
      </button>
    </nav>
    <div class="popup-credit">
      <a href="https://kaniskgautam.com" target="_blank" rel="noopener noreferrer">Built by kaniskgautam.com</a>
    </div>
  `;
}

function bindNavBar(): void {
  document.querySelectorAll<HTMLButtonElement>('.nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset['nav'] as View;
      if (target && target !== currentView) {
        currentView = target;
        render();
      }
    });
  });
}

// ─── Today View ───────────────────────────────────────────────────────────────

function getGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

function renderToday(): void {
  const todayStr = new Date().toISOString().split('T')[0];
  const todayTasks = currentTasks.filter((t) => t.date === todayStr || !t.date);
  const streak = calcStreak();

  getApp().innerHTML = `
    <div class="view-today">
      <header class="popup-header">
        <div class="header-top">
          <div class="header-brand">
            <span class="logo-doodle">
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 19l7-7 3 3-7 7-3-3z"/>
                <path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/>
                <path d="M2 2l7.586 7.586"/>
                <circle cx="11" cy="11" r="2"/>
              </svg>
            </span>
            <span class="app-name">Nudge</span>
          </div>

          <button class="btn-header-sub" id="btn-quick-stats" title="Screen Time">
            📊 Stats
          </button>
        </div>

        <div class="greeting-row">
          <p class="greeting">
            ${getGreeting()}, 
            <button class="header-name-btn" id="header-user-name-btn" type="button" title="Click to change your name">
              ${escHtml(userName)} <span class="header-name-pencil">✏️</span>
            </button>
          </p>
          ${streak > 0 ? `<div class="streak-badge">🔥 ${streak}d streak</div>` : ''}
        </div>
      </header>

      <main class="popup-main">
        <div class="section-header">
          <div class="section-title-wrap">
            <span class="section-title">Today's intentions</span>
            <span class="section-auto-delete-hint">(Completed and previous day tasks are auto-deleted)</span>
          </div>
          <button class="btn-icon" id="btn-add-task" title="Add task">+</button>
        </div>

        <div class="task-list" id="task-list">
          ${todayTasks.length === 0 ? renderEmptyState() : todayTasks.map(renderTaskCard).join('')}
        </div>
      </main>

      <footer class="popup-footer">
        <button class="btn-primary btn-full btn-doodle-primary" id="btn-add-task-footer">
          + Add New Task
        </button>
      </footer>

      ${renderNavBar('TODAY')}
    </div>
  `;

  bindNavBar();

  // Wire in-header name editor
  const attachHeaderNameEditor = (): void => {
    const nameBtn = document.getElementById('header-user-name-btn') as HTMLButtonElement;
    if (!nameBtn) return;

    nameBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const wrap = document.createElement('span');
      wrap.className = 'header-name-edit-wrap';
      wrap.innerHTML = `
        <input type="text" id="header-name-input" class="header-name-input" value="${escHtml(userName)}" maxlength="20" />
        <button type="button" id="header-name-save-btn" class="header-name-save-btn" title="Save name">✓</button>
      `;

      nameBtn.replaceWith(wrap);

      const input = wrap.querySelector<HTMLInputElement>('#header-name-input');
      const saveBtn = wrap.querySelector<HTMLButtonElement>('#header-name-save-btn');

      if (input) {
        input.focus();
        input.select();

        const saveAndExit = async (): Promise<void> => {
          const val = input.value.trim();
          if (val && val !== userName) {
            userName = val;
            if (userSettings) userSettings.userName = val;
            await sendMsg({
              type: 'UPDATE_USER_NAME',
              payload: { userName: val },
            });
          }
          renderToday();
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
            renderToday();
          }
        });
      }
    });
  };

  attachHeaderNameEditor();

  document.getElementById('btn-quick-stats')?.addEventListener('click', () => {
    currentView = 'ANALYTICS';
    render();
  });

  const goAddTask = (): void => {
    draftBlockedSites = [...globalBlockedSites];
    draftAllowedSites = ['github.com', 'stackoverflow.com', 'google.com'];
    draftBlockMode = 'blacklist';
    draftCategory = '';
    draftTags = [];
    currentView = 'ADD_TASK';
    render();
  };
  document.getElementById('btn-add-task')?.addEventListener('click', goAddTask);
  document.getElementById('btn-add-task-footer')?.addEventListener('click', goAddTask);

  // Clicking ANYWHERE on a task card starts focus
  todayTasks.forEach((task) => {
    if (task.status === 'completed') return;

    const card = document.getElementById(`card-${task.id}`);
    card?.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.btn-focus')) return;
      startFocus(task.id);
    });

    document.getElementById(`focus-btn-${task.id}`)?.addEventListener('click', (e) => {
      e.stopPropagation();
      startFocus(task.id);
    });
  });
}

function renderEmptyState(): string {
  return `
    <div class="empty-state">
      <div class="empty-doodle-art">
        <svg width="70" height="70" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="14" y="14" width="36" height="42" rx="4" fill="#fff" stroke="#18181b" stroke-width="2.5"/>
          <rect x="22" y="10" width="20" height="8" rx="2" fill="#faf8f3" stroke="#18181b" stroke-width="2"/>
          <path d="M22 28H42" stroke="#18181b" stroke-width="2" stroke-linecap="round"/>
          <path d="M22 36H38" stroke="#18181b" stroke-width="2" stroke-linecap="round"/>
          <path d="M22 44H32" stroke="#18181b" stroke-width="2" stroke-linecap="round"/>
        </svg>
      </div>
      <p class="empty-text">Fresh day, fresh slate! ✨<br/>What are we getting done today?</p>
    </div>
  `;
}

function renderTaskCard(task: Task): string {
  const percent = task.estimatedTime > 0
    ? Math.min(100, Math.round((task.focusTime / task.estimatedTime) * 100))
    : 0;

  const leftoverMinutes = Math.max(1, task.estimatedTime - (task.focusTime || 0));
  const priorityClass = `priority-${task.priority}`;
  const statusClass   = task.status === 'completed' ? 'task-completed' : '';
  const btnLabel      = task.focusTime > 0 ? 'Resume' : 'Focus';
  const btnDisabled   = task.status === 'completed' ? 'disabled' : '';

  const isWhitelist = task.blockMode === 'whitelist';
  const blockSummary = isWhitelist
    ? `🔒 Strict (${(task.allowedWebsites || []).length} allowed)`
    : `🚫 ${(task.blockedWebsites || globalBlockedSites).length} blocked`;

  const categoryBadge = task.category
    ? `<span class="card-tag-badge">${escHtml(task.category)}</span>`
    : '';

  return `
    <div class="task-card ${statusClass}" id="card-${task.id}" title="Click anywhere to start focus session">
      <div class="task-card-top">
        <div class="task-info">
          <span class="priority-dot ${priorityClass}"></span>
          ${categoryBadge}
          <span class="task-title-text">${escHtml(task.title)}</span>
        </div>
        <button class="btn-focus" id="focus-btn-${task.id}" ${btnDisabled}>
          ${btnLabel}
        </button>
      </div>
      <div class="task-meta">
        <span class="task-time">⏱ ${task.focusTime}/${task.estimatedTime} min ${task.focusTime > 0 ? `(${leftoverMinutes}m left)` : ''}</span>
        <span class="task-status-text">${percent}% · ${blockSummary}</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${percent}%"></div>
      </div>
    </div>
  `;
}

// ─── Focus Lock View ──────────────────────────────────────────────────────────

function renderFocusLock(): void {
  if (!currentState) return;

  const task = currentTasks.find((t) => t.id === currentState!.currentTaskId);
  const taskTitle = task?.title ?? 'Focus Session';
  const isWhitelist = task?.blockMode === 'whitelist';

  const sites = isWhitelist
    ? (task?.allowedWebsites ?? ['github.com', 'stackoverflow.com', 'google.com'])
    : (task?.blockedWebsites && task.blockedWebsites.length > 0 ? task.blockedWebsites : globalBlockedSites);

  const percent = task && task.estimatedTime > 0
    ? Math.min(100, Math.round((task.focusTime / task.estimatedTime) * 100))
    : 0;

  getApp().innerHTML = `
    <div class="view-focus">
      <header class="focus-header">
        <div class="focus-badge">
          <span>🔒</span> ${isWhitelist ? 'Strict Whitelist Mode' : 'Focus Lock Active'}
        </div>
      </header>

      <main class="focus-main">
        <h2 class="focus-task-title">${escHtml(taskTitle)}</h2>

        <div class="focus-timer" id="focus-timer">--:--</div>

        <div class="focus-progress-wrap">
          <div class="progress-track progress-track-dark">
            <div class="progress-fill" id="focus-progress" style="width:${percent}%"></div>
          </div>
          <span class="focus-progress-label">${percent}% complete</span>
        </div>

        <!-- Live Website Control Box -->
        <div class="blocked-sites-box">
          <div class="blocked-sites-head">
            <span class="blocked-sites-label">
              ${isWhitelist ? `✅ Allowed Websites (${sites.length})` : `🚫 Blocked Websites (${sites.length})`}
            </span>
          </div>

          <div class="blocked-sites-chips" id="active-sites-chips">
            ${sites.map((site) => `
              <span class="site-chip site-chip-live site-chip-locked">
                ${escHtml(site)}
              </span>
            `).join('')}
          </div>

          <div class="block-quick-add-row">
            <input
              type="text"
              id="live-site-input"
              class="form-input form-input-dark"
              placeholder="${isWhitelist ? 'Allow another site (e.g. docs.rs)' : 'Block another site (e.g. twitch.tv)'}"
            />
            <button class="btn-doodle-sm" id="btn-live-site-add">
              ${isWhitelist ? 'Allow' : 'Block'}
            </button>
          </div>
        </div>
      </main>

      <footer class="focus-footer">
        <button class="btn-danger" id="btn-end-focus">End Focus</button>
        <button class="btn-secondary btn-break" id="btn-take-break">Take Break</button>
      </footer>

      <div class="popup-credit popup-credit-dark">
        <a href="https://kaniskgautam.com" target="_blank" rel="noopener noreferrer">Built by kaniskgautam.com</a>
      </div>
    </div>
  `;

  document.getElementById('btn-end-focus')?.addEventListener('click', stopFocus);
  document.getElementById('btn-take-break')?.addEventListener('click', takeBreak);

  // Wire live add
  const liveInput = document.getElementById('live-site-input') as HTMLInputElement;
  const addLiveSite = async (): Promise<void> => {
    const raw = cleanDomain(liveInput.value);
    if (!raw) return;

    if (isWhitelist && task) {
      if (!task.allowedWebsites) task.allowedWebsites = [];
      if (!task.allowedWebsites.includes(raw)) task.allowedWebsites.push(raw);
      await sendMsg({ type: 'UPDATE_TASK', payload: task });
    } else {
      await sendMsg({
        type: 'MODIFY_TASK_BLOCKLIST',
        payload: { taskId: task?.id, action: 'add', domain: raw },
      });
    }

    liveInput.value = '';
    await refreshData();
    renderFocusLock();
  };

  document.getElementById('btn-live-site-add')?.addEventListener('click', addLiveSite);
  liveInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addLiveSite();
  });

  startTimerDisplay();
}

function startTimerDisplay(): void {
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay(): void {
  if (!currentState?.timerStartedAt) return;

  const remaining = getRemainingTime(currentState.timerStartedAt, currentState.timerDuration);
  const el = document.getElementById('focus-timer');
  if (el) el.textContent = formatTime(remaining);

  if (remaining <= 0) {
    stopTimer();
    stopFocus();
  }
}

// ─── Break View (Warm Cream Paper & Ink Flow) ─────────────────────────────────

function renderBreak(): void {
  if (!currentState) return;

  getApp().innerHTML = `
    <div class="view-break">
      <header class="break-header">
        <div class="break-badge">☕ Cozy Break Time</div>
      </header>

      <main class="break-main">
        <div class="break-doodle-icon">
          <svg width="68" height="68" viewBox="0 0 64 64" fill="none" stroke="#18181b" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M16 22H42V42C42 47.5 37.5 52 32 52H26C20.5 52 16 47.5 16 42V22Z" fill="#fff"/>
            <path d="M42 26H48C51.3 26 54 28.7 54 32C54 35.3 51.3 38 48 38H42"/>
            <path d="M24 10C24 14 26 14 26 18"/>
            <path d="M34 10C34 14 36 14 36 18"/>
            <path d="M12 56H46" stroke-width="2.5"/>
          </svg>
        </div>

        <div class="break-timer" id="break-timer">--:--</div>
        <p class="break-message">Step away from the screen. 💧</p>
        <p class="break-sub">Stretch, grab some water, and relax your eyes.</p>
      </main>

      <footer class="break-footer">
        <button class="btn-primary btn-full btn-doodle-primary" id="btn-end-break">
          End Break Early ⚡
        </button>
      </footer>

      <div class="popup-credit">
        <a href="https://kaniskgautam.com" target="_blank" rel="noopener noreferrer">Built by kaniskgautam.com</a>
      </div>
    </div>
  `;

  document.getElementById('btn-end-break')?.addEventListener('click', endBreak);

  const updateBreakTimer = (): void => {
    if (!currentState?.timerStartedAt) return;
    const rem = getRemainingTime(currentState.timerStartedAt, currentState.timerDuration);
    const el = document.getElementById('break-timer');
    if (el) el.textContent = formatTime(rem);
  };

  updateBreakTimer();
  timerInterval = setInterval(updateBreakTimer, 1000);
}

// ─── Add Task View ────────────────────────────────────────────────────────────

function renderAddTask(): void {
  getApp().innerHTML = `
    <div class="view-add-task">
      <header class="popup-header popup-header-light">
        <button class="btn-back" id="btn-back">← Back</button>
        <h2 class="header-title">New Task</h2>
      </header>

      <main class="popup-main">
        <div class="form-group">
          <label class="form-label" for="task-input">What do you want to get done?</label>
          <input
            type="text"
            id="task-input"
            class="form-input"
            placeholder="e.g. Finish Python project, Learn calculus, Cook dinner…"
            autofocus
          />
        </div>

        <!-- Interactive Tag Panel: Click on any tag to edit/change directly -->
        <div class="form-group">
          <label class="form-label">Tags & Category</label>
          <div class="inferred-tags-container">
            <div class="inferred-tags-list" id="inferred-tags-list"></div>
          </div>
        </div>

        <div class="form-row">
          <div class="form-group form-group-half">
            <label class="form-label" for="task-time">Estimated (min)</label>
            <input type="number" id="task-time" class="form-input" placeholder="30" min="1" max="480" value="30" />
          </div>
          <div class="form-group form-group-half">
            <label class="form-label" for="task-priority">Priority</label>
            <select id="task-priority" class="form-input">
              <option value="low">🟢 Low</option>
              <option value="medium" selected>🟡 Medium</option>
              <option value="high">🔴 High</option>
            </select>
          </div>
        </div>

        <hr class="form-divider" />

        <!-- Mode Toggle Switch: Blacklist vs Strict Whitelist -->
        <div class="form-group">
          <label class="form-label">Blocking Mode</label>
          <div class="mode-switch-row">
            <button
              class="mode-switch-btn ${draftBlockMode === 'blacklist' ? 'active' : ''}"
              id="btn-mode-blacklist"
              type="button"
            >
              🚫 Block Distractions
            </button>
            <button
              class="mode-switch-btn ${draftBlockMode === 'whitelist' ? 'active' : ''}"
              id="btn-mode-whitelist"
              type="button"
            >
              🔒 Strict: Whitelist Only
            </button>
          </div>
        </div>

        <!-- Section 1: Blacklist Editor -->
        <div id="section-blacklist" style="${draftBlockMode === 'blacklist' ? 'display:block' : 'display:none'}">
          <div class="block-list-section">
            <div class="block-section-head">
              <span class="block-list-label">🚫 Blocked Sites (${draftBlockedSites.length})</span>
              <button class="btn-link" id="btn-clear-blocked-chips">Clear all</button>
            </div>

            <div class="block-list-chips" id="block-chips"></div>

            <!-- Dynamic suggestions: only shows sites NOT already added -->
            <div class="preset-suggestions">
              <span class="preset-label">Quick add (not yet in list):</span>
              <div class="preset-chips-wrap" id="block-suggestions-wrap"></div>
            </div>

            <div class="block-add-row">
              <input
                type="text"
                id="block-input"
                class="form-input"
                placeholder="Type domain (e.g. twitch.tv)"
              />
              <button class="btn-block-add" id="btn-block-add">Add to Blocklist</button>
            </div>
            <div id="block-input-msg" class="field-msg-hint" style="display:none"></div>
          </div>
        </div>

        <!-- Section 2: Whitelist Editor -->
        <div id="section-whitelist" style="${draftBlockMode === 'whitelist' ? 'display:block' : 'display:none'}">
          <div class="block-list-section">
            <div class="block-section-head">
              <span class="block-list-label">✅ Allowed Sites (All others blocked)</span>
              <button class="btn-link" id="btn-clear-allowed-chips">Clear all</button>
            </div>

            <div class="block-list-chips" id="allow-chips"></div>

            <div class="preset-suggestions">
              <span class="preset-label">Quick allow:</span>
              <div class="preset-chips-wrap" id="allow-suggestions-wrap"></div>
            </div>

            <div class="block-add-row">
              <input
                type="text"
                id="allow-input"
                class="form-input"
                placeholder="Type allowed domain (e.g. github.com)"
              />
              <button class="btn-allow-add" id="btn-allow-add">Allow Site</button>
            </div>
            <div id="allow-input-msg" class="field-msg-hint" style="display:none"></div>
          </div>
        </div>
      </main>

      <footer class="popup-footer">
        <button class="btn-primary btn-full btn-doodle-primary" id="btn-add-task-submit">
          Add Task ✓
        </button>
      </footer>

      <div class="popup-credit">
        <a href="https://kaniskgautam.com" target="_blank" rel="noopener noreferrer">Built by kaniskgautam.com</a>
      </div>
    </div>
  `;

  renderBlacklistChipsAndSuggestions();
  renderWhitelistChipsAndSuggestions();
  renderDraftTags();

  // Mode Switchers
  document.getElementById('btn-mode-blacklist')?.addEventListener('click', () => {
    draftBlockMode = 'blacklist';
    document.getElementById('btn-mode-blacklist')?.classList.add('active');
    document.getElementById('btn-mode-whitelist')?.classList.remove('active');
    document.getElementById('section-blacklist')!.style.display = 'block';
    document.getElementById('section-whitelist')!.style.display = 'none';
  });

  document.getElementById('btn-mode-whitelist')?.addEventListener('click', () => {
    draftBlockMode = 'whitelist';
    document.getElementById('btn-mode-whitelist')?.classList.add('active');
    document.getElementById('btn-mode-blacklist')?.classList.remove('active');
    document.getElementById('section-whitelist')!.style.display = 'block';
    document.getElementById('section-blacklist')!.style.display = 'none';
  });

  // NLP Tagging on Task Title Input
  const taskInput = document.getElementById('task-input') as HTMLInputElement;
  const prioritySel = document.getElementById('task-priority') as HTMLSelectElement;

  taskInput.addEventListener('input', () => {
    const val = taskInput.value.trim();
    if (!val) {
      draftCategory = '';
      draftTags = [];
      renderDraftTags();
      return;
    }

    const info = analyzeTaskIntent(val);
    draftCategory = info.category;
    draftTags = info.tags;
    renderDraftTags();

    if (info.priorityHint) {
      prioritySel.value = info.priorityHint;
    }
  });

  // Blacklist Add Site Action
  const blockInput = document.getElementById('block-input') as HTMLInputElement;
  const blockMsg = document.getElementById('block-input-msg') as HTMLDivElement;

  const handleAddBlocked = (domainToAdd?: string): void => {
    blockMsg.style.display = 'none';
    const raw = cleanDomain(domainToAdd || blockInput.value);

    if (!raw) {
      blockInput.focus();
      return;
    }

    if (draftBlockedSites.includes(raw)) {
      blockMsg.textContent = `⚠️ "${raw}" is already in your blocklist.`;
      blockMsg.style.display = 'block';
      blockInput.value = '';
      return;
    }

    draftBlockedSites.push(raw);
    blockInput.value = '';
    renderBlacklistChipsAndSuggestions();
    blockInput.focus();
  };

  document.getElementById('btn-block-add')?.addEventListener('click', () => handleAddBlocked());
  blockInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddBlocked();
  });

  document.getElementById('btn-clear-blocked-chips')?.addEventListener('click', () => {
    draftBlockedSites = [];
    renderBlacklistChipsAndSuggestions();
  });

  // Whitelist Add Site Action
  const allowInput = document.getElementById('allow-input') as HTMLInputElement;
  const allowMsg = document.getElementById('allow-input-msg') as HTMLDivElement;

  const handleAddAllowed = (domainToAdd?: string): void => {
    allowMsg.style.display = 'none';
    const raw = cleanDomain(domainToAdd || allowInput.value);

    if (!raw) {
      allowInput.focus();
      return;
    }

    if (draftAllowedSites.includes(raw)) {
      allowMsg.textContent = `⚠️ "${raw}" is already allowed.`;
      allowMsg.style.display = 'block';
      allowInput.value = '';
      return;
    }

    draftAllowedSites.push(raw);
    allowInput.value = '';
    renderWhitelistChipsAndSuggestions();
    allowInput.focus();
  };

  document.getElementById('btn-allow-add')?.addEventListener('click', () => handleAddAllowed());
  allowInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handleAddAllowed();
  });

  document.getElementById('btn-clear-allowed-chips')?.addEventListener('click', () => {
    draftAllowedSites = [];
    renderWhitelistChipsAndSuggestions();
  });

  // Back button
  document.getElementById('btn-back')?.addEventListener('click', () => {
    currentView = 'TODAY';
    render();
  });

  document.getElementById('btn-add-task-submit')?.addEventListener('click', submitAddTask);
}

function renderDraftTags(): void {
  const container = document.getElementById('inferred-tags-list');
  if (!container) return;

  if (draftTags.length === 0 && !draftCategory) {
    draftTags = ['other'];
    draftCategory = 'Other';
  }

  const categoryHtml = draftCategory
    ? `<span class="tag-badge tag-badge-primary" title="Category">${getCategoryIcon(draftCategory)} ${escHtml(draftCategory)}</span>`
    : '';

  const tagsHtml = draftTags.map((tag) => `
    <span class="tag-interactive-chip tag-chip-editable" data-tag="${escHtml(tag)}" title="Click to change #${escHtml(tag)}">
      #${escHtml(tag)} ✏️
      <button type="button" class="btn-tag-del" data-deltag="${escHtml(tag)}" title="Remove tag">×</button>
    </span>
  `).join('');

  const plusBtnHtml = `<button type="button" class="btn-tag-plus" id="btn-add-tag-inline" title="Add another tag">+ tag</button>`;

  container.innerHTML = `${categoryHtml} ${tagsHtml} ${plusBtnHtml}`;

  // Click on any tag chip (including #other) to edit directly in place
  container.querySelectorAll<HTMLElement>('.tag-chip-editable').forEach((chip) => {
    chip.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.btn-tag-del')) return;
      e.stopPropagation();

      const oldTag = chip.dataset['tag'];
      if (!oldTag) return;

      chip.classList.add('tag-chip-editing');
      chip.innerHTML = `
        <input type="text" class="tag-chip-input" value="${escHtml(oldTag)}" autofocus />
        <button type="button" class="btn-tag-save">✓</button>
      `;

      const input = chip.querySelector<HTMLInputElement>('.tag-chip-input');
      const saveBtn = chip.querySelector<HTMLButtonElement>('.btn-tag-save');
      if (input) {
        input.focus();
        input.select();

        const commitTag = (): void => {
          const val = input.value.trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_-]/g, '');
          if (val) {
            draftTags = draftTags.map((t) => (t === oldTag ? val : t));
            if (!draftCategory || draftCategory.toLowerCase() === oldTag.toLowerCase() || draftCategory === 'Other') {
              draftCategory = val.charAt(0).toUpperCase() + val.slice(1);
            }
          }
          renderDraftTags();
        };

        saveBtn?.addEventListener('click', (ev) => {
          ev.stopPropagation();
          commitTag();
        });

        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            commitTag();
          } else if (ev.key === 'Escape') {
            renderDraftTags();
          }
        });
      }
    });
  });

  // Click on "+ tag" pill
  const plusBtn = document.getElementById('btn-add-tag-inline');
  plusBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const wrap = document.createElement('span');
    wrap.className = 'tag-interactive-chip tag-chip-editing';
    wrap.innerHTML = `
      <input type="text" class="tag-chip-input" placeholder="new tag" autofocus />
      <button type="button" class="btn-tag-save">✓</button>
    `;
    plusBtn.replaceWith(wrap);

    const input = wrap.querySelector<HTMLInputElement>('.tag-chip-input');
    const saveBtn = wrap.querySelector<HTMLButtonElement>('.btn-tag-save');

    if (input) {
      input.focus();
      const commitNew = (): void => {
        const val = input.value.trim().toLowerCase().replace(/^#/, '').replace(/[^a-z0-9_-]/g, '');
        if (val && !draftTags.includes(val)) {
          draftTags.push(val);
          if (!draftCategory || draftCategory === 'Other') {
            draftCategory = val.charAt(0).toUpperCase() + val.slice(1);
          }
        }
        renderDraftTags();
      };

      saveBtn?.addEventListener('click', (ev) => {
        ev.stopPropagation();
        commitNew();
      });

      input.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commitNew();
        } else if (ev.key === 'Escape') {
          renderDraftTags();
        }
      });
    }
  });

  // Delete button
  container.querySelectorAll<HTMLButtonElement>('.btn-tag-del').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const tagToRemove = btn.dataset['deltag'];
      if (!tagToRemove) return;
      draftTags = draftTags.filter((t) => t !== tagToRemove);
      if (draftTags.length === 0) {
        draftTags = ['other'];
        draftCategory = 'Other';
      }
      renderDraftTags();
    });
  });
}

function getCategoryIcon(cat: string): string {
  const c = cat.toLowerCase();
  if (c.includes('code') || c.includes('dev')) return '💻';
  if (c.includes('learn') || c.includes('study')) return '📚';
  if (c.includes('write')) return '✍️';
  if (c.includes('health') || c.includes('gym')) return '🏃';
  if (c.includes('work')) return '💼';
  if (c.includes('design')) return '🎨';
  return '🏷️';
}

// ─── Dynamic Blacklist Chips & Suggestions ───────────────────────────────────

function renderBlacklistChipsAndSuggestions(): void {
  const chipsContainer = document.getElementById('block-chips');
  const suggestionsWrap = document.getElementById('block-suggestions-wrap');

  if (chipsContainer) {
    if (draftBlockedSites.length === 0) {
      chipsContainer.innerHTML = `<span class="chips-empty-hint">No sites blocked yet. Add from quick list below!</span>`;
    } else {
      chipsContainer.innerHTML = draftBlockedSites
        .map((site, idx) => `
          <span class="block-chip">
            ${escHtml(site)}
            <button class="block-chip-remove" data-idx="${idx}" title="Remove">×</button>
          </span>
        `)
        .join('');

      chipsContainer.querySelectorAll<HTMLButtonElement>('.block-chip-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset['idx'] ?? '0', 10);
          draftBlockedSites.splice(idx, 1);
          renderBlacklistChipsAndSuggestions();
        });
      });
    }
  }

  if (suggestionsWrap) {
    const unaddedSuggestions = DISTRACTION_CATALOG.filter(
      (item) => !draftBlockedSites.includes(item.domain),
    );

    if (unaddedSuggestions.length === 0) {
      suggestionsWrap.innerHTML = `<span class="preset-label">All common distractions added! 👍</span>`;
    } else {
      suggestionsWrap.innerHTML = unaddedSuggestions
        .map((item) => `
          <button class="btn-preset btn-preset-add" data-site="${escHtml(item.domain)}" type="button">
            + ${escHtml(item.label)}
          </button>
        `)
        .join('');

      suggestionsWrap.querySelectorAll<HTMLButtonElement>('.btn-preset-add').forEach((btn) => {
        btn.addEventListener('click', () => {
          const site = btn.dataset['site'];
          if (site && !draftBlockedSites.includes(site)) {
            draftBlockedSites.push(site);
            renderBlacklistChipsAndSuggestions();
          }
        });
      });
    }
  }
}

// ─── Dynamic Whitelist Chips & Suggestions ───────────────────────────────────

function renderWhitelistChipsAndSuggestions(): void {
  const chipsContainer = document.getElementById('allow-chips');
  const suggestionsWrap = document.getElementById('allow-suggestions-wrap');

  if (chipsContainer) {
    if (draftAllowedSites.length === 0) {
      chipsContainer.innerHTML = `<span class="chips-empty-hint">No websites allowed yet. In strict mode, everything is blocked!</span>`;
    } else {
      chipsContainer.innerHTML = draftAllowedSites
        .map((site, idx) => `
          <span class="allow-chip">
            ${escHtml(site)}
            <button class="allow-chip-remove" data-idx="${idx}" title="Remove">×</button>
          </span>
        `)
        .join('');

      chipsContainer.querySelectorAll<HTMLButtonElement>('.allow-chip-remove').forEach((btn) => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset['idx'] ?? '0', 10);
          draftAllowedSites.splice(idx, 1);
          renderWhitelistChipsAndSuggestions();
        });
      });
    }
  }

  if (suggestionsWrap) {
    const unadded = WHITELIST_CATALOG.filter(
      (item) => !draftAllowedSites.includes(item.domain),
    );

    suggestionsWrap.innerHTML = unadded
      .map((item) => `
        <button class="btn-preset btn-preset-allow" data-site="${escHtml(item.domain)}" type="button">
          + ${escHtml(item.label)}
        </button>
      `)
      .join('');

    suggestionsWrap.querySelectorAll<HTMLButtonElement>('.btn-preset-allow').forEach((btn) => {
      btn.addEventListener('click', () => {
        const site = btn.dataset['site'];
        if (site && !draftAllowedSites.includes(site)) {
          draftAllowedSites.push(site);
          renderWhitelistChipsAndSuggestions();
        }
      });
    });
  }
}

// ─── Calendar View (Tag Focus Breakdown) ──────────────────────────────────────

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function getFocusForDate(dateStr: string): { totalMins: number; tagMap: Record<string, number> } {
  const tagMap: Record<string, number> = {};
  let totalMins = 0;

  // 1. From historical archived dailyTagFocus
  if (dailyTagFocusData[dateStr]) {
    for (const [tag, mins] of Object.entries(dailyTagFocusData[dateStr])) {
      tagMap[tag] = (tagMap[tag] || 0) + mins;
      totalMins += mins;
    }
  }

  // 2. From today's active tasks if date is today
  const todayStr = new Date().toISOString().split('T')[0];
  if (dateStr === todayStr) {
    for (const task of currentTasks) {
      if (task.focusTime > 0) {
        const tags = (task.tags && task.tags.length > 0)
          ? task.tags
          : (task.category ? [task.category.toLowerCase()] : ['other']);
        const minsPerTag = Math.max(1, Math.round(task.focusTime / tags.length));
        for (const t of tags) {
          tagMap[t] = (tagMap[t] || 0) + minsPerTag;
          totalMins += minsPerTag;
        }
      }
    }
  }

  return { totalMins, tagMap };
}

function renderCalendar(): void {
  const monthName = MONTH_NAMES[calCurrentMonth];
  const firstDayIndex = new Date(calCurrentYear, calCurrentMonth, 1).getDay();
  const daysInMonth = new Date(calCurrentYear, calCurrentMonth + 1, 0).getDate();
  const todayStr = new Date().toISOString().split('T')[0];

  // Build Day cells
  const dayCellsHtml: string[] = [];
  for (let i = 0; i < firstDayIndex; i++) {
    dayCellsHtml.push(`<div class="cal-cell cal-empty"></div>`);
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const monthFormatted = String(calCurrentMonth + 1).padStart(2, '0');
    const dayFormatted = String(d).padStart(2, '0');
    const cellDate = `${calCurrentYear}-${monthFormatted}-${dayFormatted}`;

    const isToday = cellDate === todayStr;
    const isSelected = cellDate === selectedCalDate;
    const { totalMins } = getFocusForDate(cellDate);
    const hasFocus = totalMins > 0;

    dayCellsHtml.push(`
      <div
        class="cal-cell ${isToday ? 'cal-today' : ''} ${isSelected ? 'cal-selected' : ''} ${hasFocus ? 'cal-has-focus' : ''}"
        data-date="${cellDate}"
        title="${cellDate}: ${formatFocusMinutes(totalMins)}"
      >
        <span>${d}</span>
      </div>
    `);
  }

  // Selected date breakdown
  const { totalMins: selTotal, tagMap: selTagMap } = getFocusForDate(selectedCalDate);
  const tagEntries = Object.entries(selTagMap).sort((a, b) => b[1] - a[1]);

  const selectedDateObj = new Date(selectedCalDate + 'T00:00:00');
  const formattedSelectedDate = selectedDateObj.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  getApp().innerHTML = `
    <div class="view-calendar">
      <header class="popup-header popup-header-light">
        <h2 class="header-title">📅 Focus Calendar</h2>
      </header>

      <main class="popup-main" style="gap:12px;">
        <div class="calendar-card">
          <div class="cal-header-row">
            <span class="cal-month-title">${monthName} ${calCurrentYear}</span>
            <div style="display:flex; gap:4px;">
              <button class="cal-nav-btn" id="cal-prev" title="Previous month">◀</button>
              <button class="cal-nav-btn" id="cal-today-btn" title="Jump to Today">Today</button>
              <button class="cal-nav-btn" id="cal-next" title="Next month">▶</button>
            </div>
          </div>

          <div class="cal-grid">
            <div class="cal-day-name">Su</div>
            <div class="cal-day-name">Mo</div>
            <div class="cal-day-name">Tu</div>
            <div class="cal-day-name">We</div>
            <div class="cal-day-name">Th</div>
            <div class="cal-day-name">Fr</div>
            <div class="cal-day-name">Sa</div>
            ${dayCellsHtml.join('')}
          </div>
        </div>

        <!-- Tag Breakdown Details Card for Selected Date -->
        <div class="cal-details-card">
          <div class="cal-details-head">
            <span class="cal-details-date">${formattedSelectedDate}</span>
            <span class="cal-total-time">${formatFocusMinutes(selTotal)} total</span>
          </div>

          <div class="tag-breakdown-list">
            ${tagEntries.length === 0 ? `
              <p class="chips-empty-hint" style="text-align:center; padding:8px 0;">
                No focus recorded on this day. ☕ Take a break or start a new task!
              </p>
            ` : tagEntries.map(([tag, mins]) => {
              const icon = TAG_ICONS[tag] || '🏷️';
              const pct = selTotal > 0 ? Math.round((mins / selTotal) * 100) : 0;
              return `
                <div class="tag-breakdown-row">
                  <div class="tag-name-box">
                    <span>${icon}</span>
                    <span>#${escHtml(tag)}</span>
                  </div>
                  <div style="display:flex; align-items:center; gap:8px;">
                    <span class="site-time-str">${pct}%</span>
                    <span class="tag-time-val">${formatFocusMinutes(mins)}</span>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </div>
      </main>

      ${renderNavBar('CALENDAR')}
    </div>
  `;

  bindNavBar();

  // Wire month navigation
  document.getElementById('cal-prev')?.addEventListener('click', () => {
    calCurrentMonth--;
    if (calCurrentMonth < 0) {
      calCurrentMonth = 11;
      calCurrentYear--;
    }
    renderCalendar();
  });

  document.getElementById('cal-next')?.addEventListener('click', () => {
    calCurrentMonth++;
    if (calCurrentMonth > 11) {
      calCurrentMonth = 0;
      calCurrentYear++;
    }
    renderCalendar();
  });

  document.getElementById('cal-today-btn')?.addEventListener('click', () => {
    const now = new Date();
    calCurrentYear = now.getFullYear();
    calCurrentMonth = now.getMonth();
    selectedCalDate = now.toISOString().split('T')[0];
    renderCalendar();
  });

  // Wire cell selection
  document.querySelectorAll<HTMLElement>('.cal-cell[data-date]').forEach((cell) => {
    cell.addEventListener('click', () => {
      const d = cell.dataset['date'];
      if (d) {
        selectedCalDate = d;
        renderCalendar();
      }
    });
  });
}

function formatFocusMinutes(mins: number): string {
  if (mins <= 0) return '0 min';
  if (mins < 60) return `${mins}m`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

// ─── Analytics / Screen-Time View ─────────────────────────────────────────────

function formatDurationSec(sec: number): string {
  if (sec < 60) return `${sec}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m`;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function getUsageForDate(dateStr: string): Record<string, number> {
  const raw = websiteUsageData[dateStr] || {};
  const cleaned: Record<string, number> = {};
  for (const [dom, sec] of Object.entries(raw)) {
    if (sec > 0) {
      cleaned[dom] = sec;
    }
  }
  return cleaned;
}

async function renderAnalytics(): Promise<void> {
  try {
    const freshUsage = (await sendMsg({ type: 'GET_WEBSITE_USAGE' })) as WebsiteUsageData;
    if (freshUsage) websiteUsageData = freshUsage;
  } catch {
    // Fall back to cached
  }

  getApp().innerHTML = `
    <div class="view-analytics">
      <header class="popup-header popup-header-light">
        <h2 class="header-title">📊 Website Screen Time</h2>
      </header>

      <main class="popup-main" style="gap:10px;">
        <div class="analytics-tabs">
          <button class="tab-btn ${currentAnalyticsTab === 'DAY' ? 'active' : ''}" id="tab-day">Day</button>
          <button class="tab-btn ${currentAnalyticsTab === 'WEEK' ? 'active' : ''}" id="tab-week">Week</button>
          <button class="tab-btn ${currentAnalyticsTab === 'MONTH' ? 'active' : ''}" id="tab-month">Month</button>
        </div>

        ${renderAnalyticsBody()}
      </main>

      ${renderNavBar('ANALYTICS')}
    </div>
  `;

  bindNavBar();

  document.getElementById('tab-day')?.addEventListener('click', () => {
    currentAnalyticsTab = 'DAY';
    renderAnalytics();
  });
  document.getElementById('tab-week')?.addEventListener('click', () => {
    currentAnalyticsTab = 'WEEK';
    renderAnalytics();
  });
  document.getElementById('tab-month')?.addEventListener('click', () => {
    currentAnalyticsTab = 'MONTH';
    renderAnalytics();
  });
}

function renderAnalyticsBody(): string {
  switch (currentAnalyticsTab) {
    case 'WEEK':  return renderWeekAnalytics();
    case 'MONTH': return renderMonthAnalytics();
    default:      return renderDayAnalytics();
  }
}

// ── 1. Day View (Donut SVG Chart + Comparison vs Yesterday + Phone List) ──────
function renderDayAnalytics(): string {
  const todayStr = new Date().toISOString().split('T')[0];
  const dYesterday = new Date();
  dYesterday.setDate(dYesterday.getDate() - 1);
  const yesterdayStr = dYesterday.toISOString().split('T')[0];

  const todayUsage = getUsageForDate(todayStr);
  const yesterdayUsage = getUsageForDate(yesterdayStr);

  const todayTotalSec = Object.values(todayUsage).reduce((acc, s) => acc + s, 0);
  const yestTotalSec = Object.values(yesterdayUsage).reduce((acc, s) => acc + s, 0);

  // Comparison vs Yesterday
  let compBadge = '';
  if (yestTotalSec > 0) {
    const diff = todayTotalSec - yestTotalSec;
    if (diff > 0) {
      compBadge = `<div class="comparison-badge" style="color:#b91c1c;">+${formatDurationSec(diff)} vs yesterday ⬆️</div>`;
    } else if (diff < 0) {
      compBadge = `<div class="comparison-badge" style="color:#15803d;">-${formatDurationSec(Math.abs(diff))} vs yesterday ⬇️</div>`;
    } else {
      compBadge = `<div class="comparison-badge">Same as yesterday</div>`;
    }
  } else {
    compBadge = `<div class="comparison-badge">Today's active time</div>`;
  }

  // Donut SVG Slices
  const sortedSites = Object.entries(todayUsage).sort((a, b) => b[1] - a[1]);
  const palette = ['#fef08a', '#93c5fd', '#86efac', '#f9a8d4', '#c4b5fd', '#fca5a5', '#d1d5db'];

  const circumference = 2 * Math.PI * 45; // ~282.74
  let cumulativeOffset = 0;
  const svgCircles: string[] = [];

  if (todayTotalSec > 0) {
    sortedSites.slice(0, 6).forEach(([_, sec], idx) => {
      const color = palette[idx % palette.length];
      const strokeDash = (sec / todayTotalSec) * circumference;
      const strokeGap = circumference - strokeDash;
      const offset = cumulativeOffset;
      cumulativeOffset += strokeDash;

      svgCircles.push(`
        <circle
          cx="70" cy="70" r="45"
          fill="none"
          stroke="${color}"
          stroke-width="16"
          stroke-dasharray="${strokeDash.toFixed(2)} ${strokeGap.toFixed(2)}"
          stroke-dashoffset="${(-offset).toFixed(2)}"
          transform="rotate(-90 70 70)"
        />
      `);
    });
  } else {
    // Empty donut ring
    svgCircles.push(`
      <circle
        cx="70" cy="70" r="45"
        fill="none"
        stroke="rgba(24,24,27,0.12)"
        stroke-width="14"
        stroke-dasharray="4 4"
      />
    `);
  }

  return `
    <div style="display:flex; justify-content:center;">
      ${compBadge}
    </div>

    <div class="chart-card">
      <div class="donut-svg-wrap">
        <svg width="140" height="140" viewBox="0 0 140 140">
          ${svgCircles.join('')}
        </svg>
        <div class="donut-center-info">
          <span class="donut-center-val">${formatDurationSec(todayTotalSec)}</span>
          <span class="donut-center-sub">Screen Time</span>
        </div>
      </div>
    </div>

    <!-- Phone-style Screen Time Website List -->
    <div class="screen-time-list">
      <span class="preset-label" style="margin-left:2px;">Apps & Websites (${sortedSites.length})</span>
      ${sortedSites.length === 0 ? `
        <p class="chips-empty-hint" style="text-align:center; padding:14px 10px; line-height:1.4;">
          No websites recorded yet today.<br/>
          Spend at least 10s on any website to see it appear here! 🌐
        </p>
      ` : sortedSites.map(([domain, sec]) => {
        const pct = Math.round((sec / todayTotalSec) * 100);
        return `
          <div class="site-usage-row">
            <div class="site-usage-header">
              <span class="site-domain-name">
                <span>🌐</span> ${escHtml(domain)}
              </span>
              <span class="site-time-str">${formatDurationSec(sec)} (${pct}%)</span>
            </div>
            <div class="site-usage-bar-track">
              <div class="site-usage-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ── 2. Week View (Date vs Time Spent Per Day Bar Chart: M, T, W, Th, F, S, Su) ─
function renderWeekAnalytics(): string {
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];

  // In JavaScript: 0=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu, 5=Fri, 6=Sat
  // Compute how many days back to Monday of the current week:
  const dayOfWeek = now.getDay();
  const diffToMonday = (dayOfWeek + 6) % 7; // Mon=0, Tue=1, ..., Sun=6

  const monday = new Date(now);
  monday.setDate(now.getDate() - diffToMonday);
  monday.setHours(0, 0, 0, 0);

  // Exact labels: M, T, W, Th, F, S, Su
  const dayLabels = ['M', 'T', 'W', 'Th', 'F', 'S', 'Su'];
  const days: {
    dateStr: string;
    label: string;
    fullLabel: string;
    sec: number;
    isToday: boolean;
  }[] = [];

  let thisWeekTotalSec = 0;
  const weekDomainMap: Record<string, number> = {};

  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const isToday = dateStr === todayStr;

    const usage = getUsageForDate(dateStr);
    const sec = Object.values(usage).reduce((acc, s) => acc + s, 0);
    thisWeekTotalSec += sec;

    for (const [dom, s] of Object.entries(usage)) {
      weekDomainMap[dom] = (weekDomainMap[dom] || 0) + s;
    }

    const fullLabel = d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });

    days.push({
      dateStr,
      label: dayLabels[i],
      fullLabel,
      sec,
      isToday,
    });
  }

  // Previous week (previous Monday to previous Sunday) for comparison
  const prevMonday = new Date(monday);
  prevMonday.setDate(monday.getDate() - 7);

  let prevWeekTotalSec = 0;
  for (let i = 0; i < 7; i++) {
    const d = new Date(prevMonday);
    d.setDate(prevMonday.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const usage = getUsageForDate(dateStr);
    prevWeekTotalSec += Object.values(usage).reduce((acc, s) => acc + s, 0);
  }

  let compBadge = '';
  if (prevWeekTotalSec > 0) {
    const diff = thisWeekTotalSec - prevWeekTotalSec;
    if (diff > 0) {
      compBadge = `<div class="comparison-badge" style="color:#b91c1c;">+${formatDurationSec(diff)} vs last week ⬆️</div>`;
    } else if (diff < 0) {
      compBadge = `<div class="comparison-badge" style="color:#15803d;">-${formatDurationSec(Math.abs(diff))} vs last week ⬇️</div>`;
    } else {
      compBadge = `<div class="comparison-badge">Same as last week</div>`;
    }
  } else {
    compBadge = `<div class="comparison-badge">Current Week Overview</div>`;
  }

  const maxSec = Math.max(...days.map((d) => d.sec), 1);
  const sortedWeekSites = Object.entries(weekDomainMap).sort((a, b) => b[1] - a[1]);

  return `
    <div style="display:flex; justify-content:center;">
      ${compBadge}
    </div>

    <!-- Date vs Time Bar Graph -->
    <div class="chart-card">
      <div style="width:100%; display:flex; justify-content:space-between; align-items:center;">
        <span class="preset-label">Weekly Screen Time</span>
        <strong style="font-family:var(--font-hand); font-size:16px;">${formatDurationSec(thisWeekTotalSec)} total</strong>
      </div>

      <div class="bar-chart-wrap">
        ${days.map((d) => {
          const heightPct = d.sec > 0 ? Math.max(8, Math.round((d.sec / maxSec) * 100)) : 4;
          return `
            <div class="bar-item">
              <span class="bar-val-label">${d.sec > 0 ? formatDurationSec(d.sec) : '0'}</span>
              <div
                class="bar-pillar ${d.isToday ? 'today-bar' : ''}"
                style="height:${heightPct}%;"
                title="${d.fullLabel}: ${formatDurationSec(d.sec)}"
              ></div>
              <span class="bar-x-label ${d.isToday ? 'today-x-label' : ''}">${escHtml(d.label)}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Phone-style List for Week -->
    <div class="screen-time-list">
      <span class="preset-label" style="margin-left:2px;">Top Websites This Week</span>
      ${sortedWeekSites.length === 0 ? `
        <p class="chips-empty-hint" style="text-align:center; padding:12px 0;">
          No website usage recorded this week yet.
        </p>
      ` : sortedWeekSites.slice(0, 10).map(([domain, sec]) => {
        const pct = thisWeekTotalSec > 0 ? Math.round((sec / thisWeekTotalSec) * 100) : 0;
        return `
          <div class="site-usage-row">
            <div class="site-usage-header">
              <span class="site-domain-name">
                <span>🌐</span> ${escHtml(domain)}
              </span>
              <span class="site-time-str">${formatDurationSec(sec)} (${pct}%)</span>
            </div>
            <div class="site-usage-bar-track">
              <div class="site-usage-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ── 3. Month View (Time Spent Per Week Bar Chart: W1, W2, W3, W4) ─────────────
function renderMonthAnalytics(): string {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth(); // 0-based
  const currentDate = now.getDate(); // 1-31
  const todayStr = now.toISOString().split('T')[0];
  const daysInMonth = new Date(currentYear, currentMonth + 1, 0).getDate();

  // Determine which week of the month today falls into:
  // Day 1-7   -> W1 (index 0)
  // Day 8-14  -> W2 (index 1)
  // Day 15-21 -> W3 (index 2)
  // Day 22-end-> W4 (index 3)
  let currentWeekIndex = 0;
  if (currentDate <= 7) {
    currentWeekIndex = 0;
  } else if (currentDate <= 14) {
    currentWeekIndex = 1;
  } else if (currentDate <= 21) {
    currentWeekIndex = 2;
  } else {
    currentWeekIndex = 3;
  }

  const weekRanges = [
    { label: 'W1', startDay: 1, endDay: 7 },
    { label: 'W2', startDay: 8, endDay: 14 },
    { label: 'W3', startDay: 15, endDay: 21 },
    { label: 'W4', startDay: 22, endDay: daysInMonth },
  ];

  const weeks: {
    label: string;
    rangeStr: string;
    sec: number;
    isCurrent: boolean;
  }[] = [];

  let monthTotalSec = 0;
  const monthDomainMap: Record<string, number> = {};
  const monthName = now.toLocaleDateString(undefined, { month: 'long' });
  const monthShort = now.toLocaleDateString(undefined, { month: 'short' });

  weekRanges.forEach((wr, idx) => {
    let weekSec = 0;
    const isCurrent = idx === currentWeekIndex;

    for (let day = wr.startDay; day <= wr.endDay; day++) {
      const monthFormatted = String(currentMonth + 1).padStart(2, '0');
      const dayFormatted = String(day).padStart(2, '0');
      const dateStr = `${currentYear}-${monthFormatted}-${dayFormatted}`;

      if (dateStr <= todayStr) {
        const usage = getUsageForDate(dateStr);
        for (const [dom, s] of Object.entries(usage)) {
          weekSec += s;
          monthDomainMap[dom] = (monthDomainMap[dom] || 0) + s;
        }
      }
    }

    monthTotalSec += weekSec;
    weeks.push({
      label: wr.label, // W1, W2, W3, W4
      rangeStr: `${monthShort} ${wr.startDay}–${wr.endDay}`,
      sec: weekSec,
      isCurrent,
    });
  });

  const maxWeekSec = Math.max(...weeks.map((w) => w.sec), 1);

  // Compare with previous month
  const prevMonthDate = new Date(currentYear, currentMonth - 1, 1);
  const prevMonthDays = new Date(prevMonthDate.getFullYear(), prevMonthDate.getMonth() + 1, 0).getDate();
  let prevMonthTotalSec = 0;
  for (let d = 1; d <= prevMonthDays; d++) {
    const mStr = String(prevMonthDate.getMonth() + 1).padStart(2, '0');
    const dStr = String(d).padStart(2, '0');
    const prevDateStr = `${prevMonthDate.getFullYear()}-${mStr}-${dStr}`;
    const usage = getUsageForDate(prevDateStr);
    prevMonthTotalSec += Object.values(usage).reduce((acc, s) => acc + s, 0);
  }

  let compBadge = '';
  if (prevMonthTotalSec > 0) {
    const diff = monthTotalSec - prevMonthTotalSec;
    if (diff > 0) {
      compBadge = `<div class="comparison-badge" style="color:#b91c1c;">+${formatDurationSec(diff)} vs last month ⬆️</div>`;
    } else if (diff < 0) {
      compBadge = `<div class="comparison-badge" style="color:#15803d;">-${formatDurationSec(Math.abs(diff))} vs last month ⬇️</div>`;
    } else {
      compBadge = `<div class="comparison-badge">Same as last month</div>`;
    }
  } else {
    compBadge = `<div class="comparison-badge">${monthName} Overview</div>`;
  }

  const sortedMonthSites = Object.entries(monthDomainMap).sort((a, b) => b[1] - a[1]);

  return `
    <div style="display:flex; justify-content:center;">
      ${compBadge}
    </div>

    <!-- Time vs Week Bar Graph -->
    <div class="chart-card">
      <div style="width:100%; display:flex; justify-content:space-between; align-items:center;">
        <span class="preset-label">${monthName} Screen Time</span>
        <strong style="font-family:var(--font-hand); font-size:16px;">${formatDurationSec(monthTotalSec)} total</strong>
      </div>

      <div class="bar-chart-wrap">
        ${weeks.map((w) => {
          const heightPct = w.sec > 0 ? Math.max(8, Math.round((w.sec / maxWeekSec) * 100)) : 4;
          return `
            <div class="bar-item">
              <span class="bar-val-label">${w.sec > 0 ? formatDurationSec(w.sec) : '0'}</span>
              <div
                class="bar-pillar ${w.isCurrent ? 'today-bar' : ''}"
                style="height:${heightPct}%;"
                title="${w.label} (${w.rangeStr}): ${formatDurationSec(w.sec)}"
              ></div>
              <span class="bar-x-label ${w.isCurrent ? 'today-x-label' : ''}">${escHtml(w.label)}</span>
            </div>
          `;
        }).join('')}
      </div>
    </div>

    <!-- Phone-style List for Month -->
    <div class="screen-time-list">
      <span class="preset-label" style="margin-left:2px;">Top Websites in ${monthName}</span>
      ${sortedMonthSites.length === 0 ? `
        <p class="chips-empty-hint" style="text-align:center; padding:12px 0;">
          No website usage recorded this month yet.
        </p>
      ` : sortedMonthSites.slice(0, 10).map(([domain, sec]) => {
        const pct = monthTotalSec > 0 ? Math.round((sec / monthTotalSec) * 100) : 0;
        return `
          <div class="site-usage-row">
            <div class="site-usage-header">
              <span class="site-domain-name">
                <span>🌐</span> ${escHtml(domain)}
              </span>
              <span class="site-time-str">${formatDurationSec(sec)} (${pct}%)</span>
            </div>
            <div class="site-usage-bar-track">
              <div class="site-usage-bar-fill" style="width:${pct}%"></div>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

// ─── Global Blocklist View ────────────────────────────────────────────────────

function renderBlocklist(): void {
  getApp().innerHTML = `
    <div class="view-blocklist">
      <header class="popup-header popup-header-light">
        <h2 class="header-title">🚫 Default Blocklist</h2>
      </header>

      <main class="popup-main">
        <p class="blocklist-intro">
          Websites in this default list will be blocked during any focus session (unless Strict Whitelist mode is used).
        </p>

        <div class="block-list-chips" id="global-block-chips"></div>

        <div class="preset-suggestions" style="margin-top:10px;">
          <span class="preset-label">Quick add to default blocklist:</span>
          <div class="preset-chips-wrap" id="global-suggestions-wrap"></div>
        </div>

        <div class="block-add-row" style="margin-top:12px;">
          <input
            type="text"
            id="global-block-input"
            class="form-input"
            placeholder="Add website (e.g. reddit.com)"
          />
          <button class="btn-block-add" id="btn-global-block-add">Block</button>
        </div>
      </main>

      <footer class="popup-footer">
        <button class="btn-primary btn-full btn-doodle-primary" id="btn-done-blocklist">
          Done ✓
        </button>
      </footer>

      ${renderNavBar('BLOCKLIST')}
    </div>
  `;

  bindNavBar();

  document.getElementById('btn-done-blocklist')?.addEventListener('click', () => {
    currentView = 'TODAY';
    render();
  });

  const renderGlobalChips = (): void => {
    const container = document.getElementById('global-block-chips');
    const suggestionsWrap = document.getElementById('global-suggestions-wrap');

    if (container) {
      if (globalBlockedSites.length === 0) {
        container.innerHTML = `<span class="chips-empty-hint">Blocklist is empty.</span>`;
      } else {
        container.innerHTML = globalBlockedSites
          .map((site) => `
            <span class="block-chip">
              ${escHtml(site)}
              <button class="block-chip-remove global-chip-del" data-site="${escHtml(site)}" title="Remove">×</button>
            </span>
          `)
          .join('');

        container.querySelectorAll<HTMLButtonElement>('.global-chip-del').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const site = btn.dataset['site'];
            if (!site) return;
            globalBlockedSites = globalBlockedSites.filter((s) => s !== site);
            await sendMsg({
              type: 'MODIFY_TASK_BLOCKLIST',
              payload: { action: 'remove', domain: site },
            });
            renderGlobalChips();
          });
        });
      }
    }

    if (suggestionsWrap) {
      const unadded = DISTRACTION_CATALOG.filter(
        (item) => !globalBlockedSites.includes(item.domain),
      );

      suggestionsWrap.innerHTML = unadded
        .map((item) => `
          <button class="btn-preset btn-preset-global" data-site="${escHtml(item.domain)}" type="button">
            + ${escHtml(item.label)}
          </button>
        `)
        .join('');

      suggestionsWrap.querySelectorAll<HTMLButtonElement>('.btn-preset-global').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const site = btn.dataset['site'];
          if (site && !globalBlockedSites.includes(site)) {
            globalBlockedSites.push(site);
            await sendMsg({
              type: 'MODIFY_TASK_BLOCKLIST',
              payload: { action: 'add', domain: site },
            });
            renderGlobalChips();
          }
        });
      });
    }
  };

  renderGlobalChips();

  const globalInput = document.getElementById('global-block-input') as HTMLInputElement;
  const addGlobal = async (): Promise<void> => {
    const raw = cleanDomain(globalInput.value);
    if (!raw || globalBlockedSites.includes(raw)) {
      globalInput.value = '';
      return;
    }
    globalBlockedSites.push(raw);
    await sendMsg({
      type: 'MODIFY_TASK_BLOCKLIST',
      payload: { action: 'add', domain: raw },
    });
    globalInput.value = '';
    renderGlobalChips();
  };

  document.getElementById('btn-global-block-add')?.addEventListener('click', addGlobal);
  globalInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addGlobal();
  });
}

// ─── Comprehensive NLP Tag & Category Engine ──────────────────────────────────

function analyzeTaskIntent(input: string): TagInference {
  const text = input.toLowerCase();
  const words = text.split(/[\s,._-]+/);

  const tags = new Set<string>();
  let category = '';
  let icon = '🏷️';
  let priorityHint: TaskPriority | null = null;

  // 1. Coding & Tech
  const codingWords = [
    'python', 'javascript', 'typescript', 'js', 'ts', 'code', 'coding', 'program',
    'programming', 'backend', 'frontend', 'fullstack', 'api', 'database', 'sql',
    'postgres', 'mongo', 'debug', 'bug', 'fix', 'refactor', 'test', 'git', 'github',
    'pr', 'deploy', 'docker', 'algo', 'algorithm', 'leetcode', 'react', 'vue',
    'angular', 'node', 'fastapi', 'flask', 'django', 'rust', 'golang', 'java', 'html', 'css',
  ];
  if (codingWords.some((w) => text.includes(w))) {
    category = 'Coding';
    icon = '💻';
    tags.add('coding');
    if (text.includes('python')) tags.add('python');
    if (text.includes('js') || text.includes('javascript') || text.includes('ts')) tags.add('javascript');
    if (text.includes('backend') || text.includes('api')) tags.add('backend');
    if (text.includes('frontend') || text.includes('ui')) tags.add('frontend');
    if (text.includes('bug') || text.includes('fix') || text.includes('debug')) tags.add('bugfix');
  }

  // 2. Learning & Study
  const learningWords = [
    'learn', 'learning', 'study', 'studying', 'revise', 'revision', 'read',
    'reading', 'book', 'chapter', 'course', 'class', 'lecture', 'lesson',
    'tutorial', 'notes', 'exam', 'quiz', 'midterm', 'finals', 'calculus',
    'math', 'mathematics', 'physics', 'chemistry', 'biology', 'history',
    'paper', 'thesis', 'research',
  ];
  if (learningWords.some((w) => text.includes(w))) {
    if (!category) {
      category = 'Learning';
      icon = '📚';
    }
    tags.add('learn');
    if (text.includes('chemistry')) tags.add('chemistry');
    if (text.includes('physics')) tags.add('physics');
    if (text.includes('biology') || text.includes('bio')) tags.add('biology');
    if (text.includes('calculus') || text.includes('math')) tags.add('math');
    if (text.includes('revise') || text.includes('revision')) tags.add('revision');
    if (text.includes('exam') || text.includes('finals') || text.includes('quiz')) tags.add('exam');
    if (text.includes('read') || text.includes('book')) tags.add('reading');
  }

  // 3. Writing & Content
  const writingWords = [
    'write', 'writing', 'essay', 'draft', 'blog', 'article', 'copy',
    'copywriting', 'story', 'proposal', 'report', 'newsletter', 'journal',
    'documentation', 'docs',
  ];
  if (writingWords.some((w) => text.includes(w))) {
    if (!category) {
      category = 'Writing';
      icon = '✍️';
    }
    tags.add('writing');
    if (text.includes('essay')) tags.add('essay');
    if (text.includes('blog') || text.includes('article')) tags.add('blog');
    if (text.includes('report')) tags.add('report');
  }

  // 4. Fitness & Health
  const healthWords = [
    'gym', 'workout', 'exercise', 'run', 'running', 'walk', 'cardio',
    'lift', 'lifting', 'stretch', 'yoga', 'meditate', 'meditation',
    'cook', 'cooking', 'dinner', 'lunch', 'meal', 'diet',
  ];
  if (healthWords.some((w) => text.includes(w))) {
    if (!category) {
      category = 'Health';
      icon = '🏃';
    }
    tags.add('health');
    if (text.includes('cook') || text.includes('dinner') || text.includes('meal')) tags.add('cooking');
    if (text.includes('gym') || text.includes('workout') || text.includes('run')) tags.add('fitness');
  }

  // 5. Work & Professional
  const workWords = [
    'meeting', 'sync', 'call', 'zoom', 'client', 'presentation',
    'slides', 'deck', 'invoice', 'taxes', 'interview', 'hiring',
  ];
  if (workWords.some((w) => text.includes(w))) {
    if (!category) {
      category = 'Work';
      icon = '💼';
    }
    tags.add('work');
    if (text.includes('meeting') || text.includes('call') || text.includes('zoom')) tags.add('meeting');
  }

  // 6. Design & Creative
  const designWords = [
    'design', 'figma', 'sketch', 'draw', 'doodle', 'illustration',
    'logo', 'animation', 'video', 'editing',
  ];
  if (designWords.some((w) => text.includes(w))) {
    if (!category) {
      category = 'Design';
      icon = '🎨';
    }
    tags.add('design');
    if (text.includes('figma')) tags.add('figma');
  }

  // Fallback to "Other" / "#other" if nothing matched
  if (!category && tags.size === 0) {
    category = 'Other';
    icon = '🏷️';
    tags.add('other');
  }

  // Priority Hints
  if (['urgent', 'asap', 'critical', 'immediately', 'emergency'].some((w) => words.includes(w))) {
    priorityHint = 'high';
  } else if (['important', 'key', 'must'].some((w) => words.includes(w))) {
    priorityHint = 'medium';
  } else if (['quick', 'fast', 'small', 'tiny', 'minor'].some((w) => words.includes(w))) {
    priorityHint = 'low';
  }

  return {
    category,
    icon,
    tags: Array.from(tags),
    priorityHint,
  };
}

// ─── Clean Domain Utility ─────────────────────────────────────────────────────

function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '')
    .replace(/[^a-z0-9.-]/g, '');
}

// ─── Submit Task ──────────────────────────────────────────────────────────────

async function submitAddTask(): Promise<void> {
  const titleEl    = document.getElementById('task-input')    as HTMLInputElement;
  const timeEl     = document.getElementById('task-time')     as HTMLInputElement;
  const priorityEl = document.getElementById('task-priority') as HTMLSelectElement;

  const title = titleEl.value.trim();
  if (!title) {
    titleEl.classList.add('input-error');
    titleEl.focus();
    return;
  }

  const estimatedTime = parseInt(timeEl.value, 10) || 30;
  const priority      = priorityEl.value as TaskPriority;

  // If no tags were set, default to 'other'
  const finalTags = draftTags.length > 0 ? [...draftTags] : ['other'];
  const finalCategory = draftCategory || 'Other';

  const task: Task = {
    id: crypto.randomUUID(),
    title,
    date: new Date().toISOString().split('T')[0],
    estimatedTime,
    priority,
    status: 'pending',
    focusTime: 0,
    blockMode: draftBlockMode,
    allowedWebsites: [...draftAllowedSites],
    blockedWebsites: [...draftBlockedSites],
    category: finalCategory,
    tags: finalTags,
    createdAt: new Date().toISOString(),
  };

  await sendMsg({ type: 'ADD_TASK', payload: task });

  currentTasks.push(task);
  draftBlockedSites = [];
  draftAllowedSites = [];
  draftCategory = '';
  draftTags = [];

  currentView = 'TODAY';
  render();
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function startFocus(taskId: string): Promise<void> {
  const state = await sendMsg({
    type: 'START_FOCUS',
    payload: { taskId, mode: 'normal' },
  }) as AppState;

  currentState = state;
  currentView  = 'FOCUS_LOCK';
  render();
}

async function stopFocus(): Promise<void> {
  const state = await sendMsg({ type: 'STOP_FOCUS' }) as AppState;
  currentState = state;
  currentView  = 'TODAY';

  await refreshData();
  render();
}

async function takeBreak(): Promise<void> {
  const state = await sendMsg({
    type: 'START_BREAK',
    payload: { duration: 5 },
  }) as AppState;
  currentState = state;
  currentView  = 'BREAK';
  render();
}

async function endBreak(): Promise<void> {
  const state = await sendMsg({ type: 'END_BREAK' }) as AppState;
  currentState = state;
  currentView  = focusStateToView(state.focusState);
  render();
}

async function refreshData(): Promise<void> {
  const [storage, tagFocusRes, webUsageRes] = await Promise.all([
    chrome.storage.local.get(['tasks', 'settings', 'dailyTagFocus', 'websiteUsage']),
    sendMsg({ type: 'GET_DAILY_TAG_FOCUS' }) as Promise<DailyTagFocus>,
    sendMsg({ type: 'GET_WEBSITE_USAGE' }) as Promise<WebsiteUsageData>,
  ]);
  const allTasks = (storage['tasks'] as Task[]) ?? [];
  const todayStr = new Date().toISOString().split('T')[0];
  currentTasks = allTasks.filter((t) => t.date === todayStr || !t.date);
  userSettings = (storage['settings'] as UserSettings) ?? null;
  userName = userSettings?.userName ?? 'Friend';
  dailyTagFocusData = tagFocusRes || (storage['dailyTagFocus'] as DailyTagFocus) || {};
  websiteUsageData = webUsageRes || (storage['websiteUsage'] as WebsiteUsageData) || {};
}

// ─── Timer Helpers ────────────────────────────────────────────────────────────

function stopTimer(): void {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
}

// ─── Streak Calculation ───────────────────────────────────────────────────────

function calcStreak(): number {
  const completedDates = new Set(
    currentTasks
      .filter((t) => t.status === 'completed' && t.date)
      .map((t) => t.date),
  );

  let streak = 0;
  const d = new Date();
  while (true) {
    const key = d.toISOString().split('T')[0];
    if (completedDates.has(key)) {
      streak++;
      d.setDate(d.getDate() - 1);
    } else {
      break;
    }
  }
  return streak;
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderError(): void {
  getApp().innerHTML = `
    <div class="error-state">
      <p>⚠️ Could not connect to Nudge service worker.</p>
      <p>Try reloading the extension.</p>
    </div>
  `;
}

// ─── Listen for background-pushed STATE_UPDATED ───────────────────────────────

chrome.runtime.onMessage.addListener((message: Message) => {
  if (message.type === 'STATE_UPDATED') {
    currentState = message.payload as AppState;
    const nextView = focusStateToView(currentState.focusState);
    if (nextView !== currentView) {
      currentView = nextView;
      render();
    }
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
