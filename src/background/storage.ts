import type {
  AppState,
  DailyTagFocus,
  FocusSession,
  StorageData,
  Task,
  UserSettings,
} from '../types/index.js';

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const DEFAULT_BLOCKED_WEBSITES = [
  'youtube.com',
  'reddit.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'facebook.com',
  'netflix.com',
];

export const DEFAULT_SETTINGS: UserSettings = {
  userName: 'Friend',
  personality: 'normal',
  blockingMode: 'soft',
  defaultPomodoroWork: 25,
  defaultPomodoroBreak: 5,
  defaultFocusDuration: 50,
  enableBreakReminders: true,
  breakReminderInterval: 50,
  defaultBlockedWebsites: DEFAULT_BLOCKED_WEBSITES,
};

export const DEFAULT_APP_STATE: AppState = {
  currentTaskId: null,
  focusState: 'IDLE',
  focusMode: 'normal',
  blockingMode: 'soft',
  personality: 'normal',
  timerStartedAt: null,
  timerDuration: 0,
  breakTimeRemaining: 0,
  pomodoroSession: 0,
  currentSession: null,
};

const DEFAULT_STORAGE: StorageData = {
  tasks: [],
  appState: DEFAULT_APP_STATE,
  sessions: [],
  settings: DEFAULT_SETTINGS,
  websiteUsage: {},
  dailyTagFocus: {},
};

// ─── Core get/set ─────────────────────────────────────────────────────────────

/**
 * Reads the entire StorageData from chrome.storage.local, filling in defaults
 * for any keys that are missing (first-run scenario).
 */
export async function getStorageData(): Promise<StorageData> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (raw) => {
      const data = raw as Partial<StorageData>;
      resolve({
        tasks: data.tasks ?? DEFAULT_STORAGE.tasks,
        appState: data.appState ?? DEFAULT_STORAGE.appState,
        sessions: data.sessions ?? DEFAULT_STORAGE.sessions,
        settings: data.settings ?? DEFAULT_STORAGE.settings,
        websiteUsage: data.websiteUsage ?? {},
        dailyTagFocus: data.dailyTagFocus ?? {},
      });
    });
  });
}

/**
 * Saves a partial StorageData object. Only the provided keys are updated;
 * the rest remain untouched.
 */
export async function saveStorageData(data: Partial<StorageData>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(data, () => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve();
      }
    });
  });
}

// ─── Tasks ────────────────────────────────────────────────────────────────────

/** Returns the full task list. */
export async function getTasks(): Promise<Task[]> {
  const data = await getStorageData();
  return data.tasks;
}

/** Returns a single task by its id, or undefined if not found. */
export async function getTaskById(id: string): Promise<Task | undefined> {
  const tasks = await getTasks();
  return tasks.find((t) => t.id === id);
}

/** Overwrites the task list in storage. */
export async function saveTasks(tasks: Task[]): Promise<void> {
  await saveStorageData({ tasks });
}

// ─── App State ────────────────────────────────────────────────────────────────

/** Returns the current application state. */
export async function getAppState(): Promise<AppState> {
  const data = await getStorageData();
  return data.appState;
}

/** Overwrites the entire application state in storage. */
export async function saveAppState(state: AppState): Promise<void> {
  await saveStorageData({ appState: state });
}

// ─── Settings ─────────────────────────────────────────────────────────────────

/** Returns user settings, falling back to defaults. */
export async function getSettings(): Promise<UserSettings> {
  const data = await getStorageData();
  return { ...DEFAULT_SETTINGS, ...data.settings };
}

/** Overwrites user settings in storage. */
export async function saveSettings(settings: UserSettings): Promise<void> {
  await saveStorageData({ settings });
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

/** Returns all recorded focus sessions. */
export async function getSessions(): Promise<FocusSession[]> {
  const data = await getStorageData();
  return data.sessions;
}

/** Appends a completed session to the session log. */
export async function appendSession(session: FocusSession): Promise<void> {
  const sessions = await getSessions();
  sessions.push(session);
  await saveStorageData({ sessions });
}

// ─── Website Usage Tracking ───────────────────────────────────────────────────

import type { WebsiteUsageData } from '../types/index.js';

/** Returns recorded website usage data grouped by YYYY-MM-DD. */
export async function getWebsiteUsage(): Promise<WebsiteUsageData> {
  const data = await getStorageData();
  return data.websiteUsage ?? {};
}

/**
 * Records elapsed seconds spent on a domain for a specific date (defaults to today).
 */
export async function recordDomainUsage(
  domain: string,
  seconds: number,
  dateStr?: string,
): Promise<void> {
  if (!domain || seconds <= 0) return;
  const cleanDomain = domain.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].trim();
  if (!cleanDomain || cleanDomain.startsWith('chrome') || cleanDomain.includes('extension')) return;

  const today = dateStr || new Date().toISOString().split('T')[0];
  const usage = await getWebsiteUsage();

  if (!usage[today]) {
    usage[today] = {};
  }
  usage[today][cleanDomain] = (usage[today][cleanDomain] || 0) + seconds;

  await saveStorageData({ websiteUsage: usage });
}

/**
 * Prunes entries where total time spent on a domain is less than minSeconds (e.g. 60s).
 * Runs hourly as requested.
 */
export async function pruneWebsiteUsageLessThan(minSeconds = 60): Promise<void> {
  const usage = await getWebsiteUsage();
  let changed = false;

  for (const date of Object.keys(usage)) {
    const dayData = usage[date];
    for (const domain of Object.keys(dayData)) {
      if (dayData[domain] < minSeconds) {
        delete dayData[domain];
        changed = true;
      }
    }
  }

  if (changed) {
    await saveStorageData({ websiteUsage: usage });
  }
}

// ─── Tag Focus & Historical Archiving ─────────────────────────────────────────

/**
 * Archives focus stats for a completed task and removes the task from the active list.
 * Values needed for calendar and stats are preserved; task itself is deleted.
 */
export async function recordCompletedTaskFocus(task: Task): Promise<void> {
  const data = await getStorageData();
  const today = task.date || new Date().toISOString().split('T')[0];
  const tagFocus: DailyTagFocus = { ...(data.dailyTagFocus ?? {}) };
  if (!tagFocus[today]) {
    tagFocus[today] = {};
  }
  const tags = (task.tags && task.tags.length > 0)
    ? task.tags
    : (task.category ? [task.category.toLowerCase()] : ['other']);
  const minutes = task.focusTime > 0 ? task.focusTime : (task.estimatedTime || 25);
  const minutesPerTag = Math.max(1, Math.round(minutes / tags.length));
  for (const t of tags) {
    tagFocus[today][t] = (tagFocus[today][t] || 0) + minutesPerTag;
  }
  // Remove task from active tasks list
  const remainingTasks = data.tasks.filter((t) => t.id !== task.id);
  await saveStorageData({ tasks: remainingTasks, dailyTagFocus: tagFocus });
}

/**
 * Returns recorded focus minutes grouped by date and tag.
 */
export async function getDailyTagFocus(): Promise<DailyTagFocus> {
  const data = await getStorageData();
  return data.dailyTagFocus ?? {};
}

/**
 * Archives tasks from previous days to keep the main view clean and fresh each day.
 * Only the tag name, time spent, and date are preserved in dailyTagFocus;
 * the rest of the past task details are pruned from the active task list.
 */
export async function archivePastDayTasks(): Promise<void> {
  const data = await getStorageData();
  const today = new Date().toISOString().split('T')[0];
  const tagFocus: DailyTagFocus = { ...(data.dailyTagFocus ?? {}) };
  let tasksChanged = false;

  const activeTodayTasks: Task[] = [];
  for (const task of data.tasks) {
    if (task.date && task.date < today) {
      tasksChanged = true;
      if (task.focusTime > 0) {
        const taskDate = task.date;
        if (!tagFocus[taskDate]) {
          tagFocus[taskDate] = {};
        }
        const tags = (task.tags && task.tags.length > 0)
          ? task.tags
          : (task.category ? [task.category.toLowerCase()] : ['other']);
        const minutesPerTag = Math.max(1, Math.round(task.focusTime / tags.length));
        for (const t of tags) {
          tagFocus[taskDate][t] = (tagFocus[taskDate][t] || 0) + minutesPerTag;
        }
      }
    } else {
      activeTodayTasks.push(task);
    }
  }

  if (tasksChanged) {
    await saveStorageData({ tasks: activeTodayTasks, dailyTagFocus: tagFocus });
  }
}

/** Initialises storage with defaults on first install. */
export async function initStorage(): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.get(null, (raw) => {
      const patch: Partial<StorageData> = {};
      if (!raw['tasks']) patch.tasks = [];
      if (!raw['sessions']) patch.sessions = [];
      if (!raw['appState']) patch.appState = DEFAULT_APP_STATE;
      if (!raw['settings']) patch.settings = DEFAULT_SETTINGS;
      if (!raw['websiteUsage']) patch.websiteUsage = {};
      if (!raw['dailyTagFocus']) patch.dailyTagFocus = {};
      if (Object.keys(patch).length > 0) {
        chrome.storage.local.set(patch, () => resolve());
      } else {
        resolve();
      }
    });
  });
}
