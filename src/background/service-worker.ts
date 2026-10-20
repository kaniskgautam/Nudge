/**
 * service-worker.ts — Main MV3 service worker for the Nudge extension.
 *
 * Responsibilities:
 *  - Initialise storage on install
 *  - Dispatch chrome.runtime.onMessage to the FocusEngine
 *  - Handle tab changes (onUpdated / onActivated) to detect blocked sites
 *  - Handle chrome.alarms.onAlarm for timer events
 *  - Broadcast STATE_UPDATED to popup after every state change
 *  - Inject blocking UI (soft = content-script message, hard = scripting)
 */

import type { AppState, BlockedPayload, Message, Task } from '../types/index.js';
import {
  ALARM_BREAK,
  ALARM_FOCUS,
  focusEngine,
} from './focus-engine.js';
import {
  archivePastDayTasks,
  getAppState,
  getDailyTagFocus,
  getSettings,
  getStorageData,
  getWebsiteUsage,
  initStorage,
  pruneWebsiteUsageLessThan,
  recordCompletedTaskFocus,
  recordDomainUsage,
  saveStorageData,
  saveTasks,
} from './storage.js';

// ─── Install / Startup ────────────────────────────────────────────────────────

/**
 * Automatically injects the tracking content script into existing open web tabs
 * so users don't need to manually refresh all their tabs after loading the extension.
 */
async function injectContentScriptIntoExistingTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] });
    for (const tab of tabs) {
      if (tab.id) {
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/content/nudge-overlay.js'],
        }).catch(() => {});
      }
    }
  } catch {
    // Ignore restricted tabs
  }
}

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    console.log('[Nudge] First install — initialising storage');
    await initStorage();
  }
  await archivePastDayTasks();
  // Schedule hourly pruning of websites visited for <60 seconds
  chrome.alarms.create('nudge-hourly-prune', { periodInMinutes: 60 });
  await injectContentScriptIntoExistingTabs();
});

// Clean up past days on startup
archivePastDayTasks().catch(() => {});

// Ensure content scripts are active on startup
injectContentScriptIntoExistingTabs().catch(() => {});

// Also ensure the prune alarm exists on startup
chrome.alarms.get('nudge-hourly-prune', (alarm) => {
  if (!alarm) {
    chrome.alarms.create('nudge-hourly-prune', { periodInMinutes: 60 });
  }
});

// ─── Broadcast helpers ────────────────────────────────────────────────────────

/**
 * Sends STATE_UPDATED to the popup (if open). Fails silently.
 */
async function broadcastState(state: AppState): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'STATE_UPDATED',
      payload: state,
    } satisfies Message);
  } catch {
    // Popup not open — expected, silently ignore
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener(
  (
    message: Message,
    _sender,
    sendResponse: (response: unknown) => void,
  ): boolean => {
    handleMessage(message)
      .then(sendResponse)
      .catch((err) => {
        console.error('[Nudge SW] Message error:', err);
        sendResponse({ error: String(err) });
      });

    // Return true to keep the message channel open for async sendResponse
    return true;
  },
);

async function handleMessage(message: Message): Promise<unknown> {
  switch (message.type) {
    // ── Focus Control ──────────────────────────────────────────────────────
    case 'START_FOCUS': {
      const { taskId, mode } = message.payload as {
        taskId: string;
        mode: 'normal' | 'pomodoro';
      };
      const state = await focusEngine.startFocus(taskId, mode);
      await broadcastState(state);
      return state;
    }

    case 'STOP_FOCUS': {
      const state = await focusEngine.stopFocus();
      await broadcastState(state);
      return state;
    }

    case 'PAUSE_FOCUS': {
      const state = await focusEngine.pauseFocus();
      await broadcastState(state);
      return state;
    }

    case 'RESUME_FOCUS': {
      const state = await focusEngine.resumeFocus();
      await broadcastState(state);
      return state;
    }

    case 'START_BREAK': {
      const { duration } = (message.payload as { duration: number }) ?? {
        duration: 5,
      };
      const state = await focusEngine.startBreak(duration);
      await broadcastState(state);
      return state;
    }

    case 'END_BREAK': {
      const state = await focusEngine.endBreak();
      await broadcastState(state);
      return state;
    }

    case 'COMPLETE_TASK': {
      const { taskId } = message.payload as { taskId: string };
      const data = await getStorageData();
      const task = data.tasks.find((t: Task) => t.id === taskId);
      if (task) {
        await recordCompletedTaskFocus({
          ...task,
          focusTime: task.focusTime > 0 ? task.focusTime : task.estimatedTime,
          status: 'completed' as const,
        });
      }
      const state = await focusEngine.stopFocus();
      await broadcastState(state);
      return state;
    }

    // ── State Query ───────────────────────────────────────────────────────
    case 'GET_STATE': {
      const state = await focusEngine.getState();
      return state;
    }

    // ── Task CRUD ─────────────────────────────────────────────────────────
    case 'ADD_TASK': {
      const task = message.payload as Task;
      const data = await getStorageData();
      data.tasks.push(task);
      await saveTasks(data.tasks);
      return { success: true, task };
    }

    case 'UPDATE_TASK': {
      const updated = message.payload as Task;
      const data = await getStorageData();
      const tasks = data.tasks.map((t: Task) =>
        t.id === updated.id ? { ...t, ...updated } : t,
      );
      await saveTasks(tasks);
      return { success: true };
    }

    case 'DELETE_TASK': {
      const { taskId } = message.payload as { taskId: string };
      const data = await getStorageData();
      const tasks = data.tasks.filter((t: Task) => t.id !== taskId);
      await saveTasks(tasks);
      return { success: true };
    }

    case 'CHECK_BLOCKED': {
      const { url } = (message.payload as { url: string }) ?? { url: '' };
      const result = await focusEngine.checkUrlBlocked(url);
      return result;
    }

    case 'MODIFY_TASK_BLOCKLIST': {
      const { taskId, action, domain } = message.payload as {
        taskId?: string;
        action: 'add' | 'remove';
        domain: string;
      };
      const cleanDomain = domain.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      if (!cleanDomain) return { success: false };

      const data = await getStorageData();

      if (taskId) {
        const task = data.tasks.find((t: Task) => t.id === taskId);
        if (task) {
          if (!task.blockedWebsites) task.blockedWebsites = [];
          if (action === 'add' && !task.blockedWebsites.includes(cleanDomain)) {
            task.blockedWebsites.push(cleanDomain);
          } else if (action === 'remove') {
            task.blockedWebsites = task.blockedWebsites.filter((d: string) => d !== cleanDomain);
          }
          await saveTasks(data.tasks);
        }
      }

      if (!data.settings.defaultBlockedWebsites) {
        data.settings.defaultBlockedWebsites = [];
      }
      if (action === 'add' && !data.settings.defaultBlockedWebsites.includes(cleanDomain)) {
        data.settings.defaultBlockedWebsites.push(cleanDomain);
      } else if (action === 'remove' && !taskId) {
        data.settings.defaultBlockedWebsites = data.settings.defaultBlockedWebsites.filter((d: string) => d !== cleanDomain);
      }
      await saveStorageData({ settings: data.settings });

      // Broadcast update
      const state = await focusEngine.getState();
      await broadcastState(state);
      return { success: true };
    }

    case 'UPDATE_USER_NAME': {
      const { userName } = (message.payload as { userName: string }) ?? { userName: 'Friend' };
      const settings = await getSettings();
      settings.userName = userName.trim() || 'Friend';
      await saveStorageData({ settings });
      return { success: true, userName: settings.userName };
    }

    case 'GET_WEBSITE_USAGE': {
      const usage = await getWebsiteUsage();
      return usage;
    }

    case 'RECORD_DOMAIN_USAGE': {
      const { domain, seconds } = (message.payload as { domain: string; seconds: number }) ?? {};
      if (domain && seconds > 0) {
        await recordDomainUsage(domain, seconds);
      }
      return { success: true };
    }

    case 'GET_DAILY_TAG_FOCUS': {
      const tagFocus = await getDailyTagFocus();
      return tagFocus;
    }

    case 'ARCHIVE_PAST_TASKS': {
      await archivePastDayTasks();
      return { success: true };
    }

    default:
      return { error: `Unknown message type: ${(message as Message).type}` };
  }
}

// ─── Real-Time Website Screen-Time Tracking ───────────────────────────────────

// ─── Tab Tracking & Blocking ──────────────────────────────────────────────────

/**
 * Shared tab-change handler. Gets the URL of the given tab and asks the
 * focus engine whether it should be nudged/blocked.
 */
async function onTabChanged(tabId: number, url?: string): Promise<void> {
  if (!url) {
    try {
      const tab = await chrome.tabs.get(tabId);
      url = tab.url ?? '';
    } catch {
      return;
    }
  }

  if (!url || focusEngine.isAllowedUrl(url)) return;

  try {
    const { blocked } = await focusEngine.handleTabChange(url);
    if (!blocked) return;

    const [state, settings] = await Promise.all([getAppState(), getSettings()]);
    const data = await import('./storage.js').then((m) => m.getStorageData());
    const task = data.tasks.find((t: Task) => t.id === state.currentTaskId);

    const { extractDomain } = await import('./blocker.js');
    const domain = extractDomain(url);

    const sessionElapsedSeconds = state.timerStartedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(state.timerStartedAt).getTime()) / 1000))
      : 0;
    const sessionTotalMinutes = state.timerDuration || task?.estimatedTime || 30;

    const payload: BlockedPayload = {
      taskTitle: task?.title ?? 'Focus Session',
      userName: settings.userName,
      blockingMode: state.blockingMode,
      personalityMode: state.personality,
      domain,
      timeSpentSeconds: 0,
      sessionElapsedSeconds,
      sessionTotalMinutes,
      tags: task?.tags ?? [],
      category: task?.category ?? '',
    };

    // Send message to the tab content script which handles both soft and hard overlays
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'WEBSITE_BLOCKED',
        payload,
      } satisfies Message);
    } catch {
      // If content script is still mounting, its proactive CHECK_BLOCKED call on load
      // will retrieve the blocked status and display the overlay with zero duplicates.
    }
  } catch (err) {
    console.error('[Nudge SW] onTabChanged error:', err);
  }
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  const currentUrl = changeInfo.url || tab.url;
  if (currentUrl) {
    onTabChanged(tabId, currentUrl);
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  onTabChanged(tabId);
});

// Also monitor webNavigation for instant reaction before page renders
if (chrome.webNavigation && chrome.webNavigation.onCommitted) {
  chrome.webNavigation.onCommitted.addListener((details) => {
    if (details.frameId === 0 && details.url) {
      onTabChanged(details.tabId, details.url);
    }
  });
}

// ─── Alarm Handler ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  console.log('[Nudge SW] Alarm fired:', alarm.name);

  // Hourly prune of sites visited for less than 60 seconds
  if (alarm.name === 'nudge-hourly-prune') {
    console.log('[Nudge SW] Running hourly website usage prune (<60s)');
    await pruneWebsiteUsageLessThan(60);
  }

  if (alarm.name === ALARM_FOCUS) {
    const state = await focusEngine.onFocusAlarm();
    await broadcastState(state);

    // Show a notification
    chrome.notifications.create('nudge-focus-done', {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Focus session complete! 🎉',
      message: 'Great work! Time for a break.',
    });
  }

  if (alarm.name === ALARM_BREAK) {
    const state = await focusEngine.onBreakAlarm();
    await broadcastState(state);

    chrome.notifications.create('nudge-break-done', {
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: "Break's over!",
      message: 'Ready to get back to work?',
    });
  }
});

console.log('[Nudge] Service worker registered ✅');

