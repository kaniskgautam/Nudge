import type {
  AppState,
  BlockedPayload,
  FocusMode,
  FocusSession,
} from '../types/index.js';
import {
  appendSession,
  getAppState,
  getSettings,
  getTaskById,
  getTasks,
  recordCompletedTaskFocus,
  saveAppState,
  saveTasks,
} from './storage.js';
import { startTimer, stopTimer } from './timer.js';
import { isInternalUrl, shouldShowNudge } from './blocker.js';
import { endVisit, trackVisit } from './tracker.js';

// ─── Alarm Names ──────────────────────────────────────────────────────────────

export const ALARM_FOCUS = 'nudge-focus-timer';
export const ALARM_BREAK = 'nudge-break-timer';
export const ALARM_POMODORO_WORK = 'nudge-pomodoro-work';
export const ALARM_POMODORO_BREAK = 'nudge-pomodoro-break';

// ─── Per-tab visit tracking ───────────────────────────────────────────────────

/** Tracks the timestamp (ms) at which the current domain visit started. */
let currentVisitStart: number | null = null;
/** Tracks the domain currently being visited. */
let currentVisitDomain: string | null = null;

// ─── FocusEngine ──────────────────────────────────────────────────────────────

/**
 * FocusEngine — the core state machine of the Nudge extension.
 *
 * Orchestrates transitions between IDLE → FOCUSING → BREAK → PAUSED states,
 * delegates to storage, timer, blocker, and tracker modules.
 */
export class FocusEngine {
  // ── Public State Machine Methods ──────────────────────────────────────────

  /**
   * Transitions from IDLE/PAUSED to FOCUSING for the given task.
   * If resuming a task that already has focusTime, counts down only the leftover time!
   */
  async startFocus(taskId: string, mode: FocusMode): Promise<AppState> {
    const [task, settings, state] = await Promise.all([
      getTaskById(taskId),
      getSettings(),
      getAppState(),
    ]);

    if (!task) throw new Error(`Task ${taskId} not found`);

    // Stop any running timers from a previous session
    stopTimer(ALARM_FOCUS);
    stopTimer(ALARM_BREAK);

    const now = new Date().toISOString();
    // Calculate leftover time so resuming starts from remaining time!
    const leftoverMinutes = Math.max(
      1,
      (task.estimatedTime || settings.defaultFocusDuration) - (task.focusTime || 0),
    );
    const durationMinutes =
      mode === 'pomodoro'
        ? (task.pomodoroSettings?.workDuration ?? settings.defaultPomodoroWork)
        : leftoverMinutes;

    // Start alarm for leftover duration
    startTimer(durationMinutes, ALARM_FOCUS);

    // Build new session
    const session: FocusSession = state.currentSession ?? {
      taskId,
      startTime: now,
      websitesVisited: [],
    };

    // Update task status → active
    const tasks = await getTasks();
    const updatedTasks = tasks.map((t) =>
      t.id === taskId ? { ...t, status: 'active' as const } : t,
    );
    await saveTasks(updatedTasks);

    const newState: AppState = {
      ...state,
      currentTaskId: taskId,
      focusState: 'FOCUSING',
      focusMode: mode,
      blockingMode: settings.blockingMode,
      personality: settings.personality,
      timerStartedAt: now,
      timerDuration: durationMinutes,
      pomodoroSession:
        mode === 'pomodoro' ? (state.pomodoroSession || 0) + 1 : 0,
      currentSession: session,
    };

    await saveAppState(newState);
    return newState;
  }

  /**
   * Stops the current focus session and transitions to IDLE.
   * Persists the elapsed focus time to the task record.
   * If task is completed (full estimated time reached), automatically deletes the task
   * and preserves stats for calendar/analytics.
   */
  async stopFocus(): Promise<AppState> {
    const state = await getAppState();

    stopTimer(ALARM_FOCUS);
    stopTimer(ALARM_BREAK);

    // Accumulate focus time onto the task
    if (state.currentTaskId && state.timerStartedAt) {
      const elapsedMinutes = Math.max(
        1,
        Math.round((Date.now() - new Date(state.timerStartedAt).getTime()) / 60_000),
      );
      const task = await getTaskById(state.currentTaskId);
      if (task) {
        const newFocusTime = (task.focusTime || 0) + elapsedMinutes;
        if (newFocusTime >= task.estimatedTime) {
          // Task reached or exceeded estimated time → auto-delete with stats saved!
          await recordCompletedTaskFocus({ ...task, focusTime: newFocusTime });
        } else {
          const tasks = await getTasks();
          const updatedTasks = tasks.map((t) =>
            t.id === task.id
              ? { ...t, focusTime: newFocusTime, status: 'active' as const }
              : t,
          );
          await saveTasks(updatedTasks);
        }
      }
    }

    // Finalise and archive the session
    if (state.currentSession) {
      const finishedSession: FocusSession = {
        ...state.currentSession,
        endTime: new Date().toISOString(),
        duration: state.timerDuration,
      };
      await appendSession(finishedSession);
    }

    const newState: AppState = {
      ...state,
      focusState: 'IDLE',
      currentTaskId: null,
      timerStartedAt: null,
      timerDuration: 0,
      currentSession: null,
      pomodoroSession: 0,
    };

    currentVisitDomain = null;
    currentVisitStart = null;

    await saveAppState(newState);
    return newState;
  }

  /**
   * Pauses an active focus session (keeps task/session alive).
   */
  async pauseFocus(): Promise<AppState> {
    const state = await getAppState();
    if (state.focusState !== 'FOCUSING') return state;

    stopTimer(ALARM_FOCUS);

    const newState: AppState = {
      ...state,
      focusState: 'PAUSED',
      // Remember remaining time by storing when we paused
      timerStartedAt: state.timerStartedAt, // keep original start for elapsed calc
    };

    await saveAppState(newState);
    return newState;
  }

  /**
   * Resumes a paused focus session.
   */
  async resumeFocus(): Promise<AppState> {
    const state = await getAppState();
    if (state.focusState !== 'PAUSED') return state;

    // Compute how much time was already spent
    const elapsed = state.timerStartedAt
      ? Math.floor(
          (Date.now() - new Date(state.timerStartedAt).getTime()) / 60_000,
        )
      : 0;
    const remaining = Math.max(0, state.timerDuration - elapsed);

    startTimer(remaining, ALARM_FOCUS);

    const newState: AppState = {
      ...state,
      focusState: 'FOCUSING',
      timerStartedAt: new Date(Date.now() - elapsed * 60_000).toISOString(),
      timerDuration: state.timerDuration,
    };

    await saveAppState(newState);
    return newState;
  }

  /**
   * Transitions to BREAK state with a countdown.
   */
  async startBreak(durationMinutes: number): Promise<AppState> {
    const state = await getAppState();

    stopTimer(ALARM_FOCUS);
    startTimer(durationMinutes, ALARM_BREAK);

    const newState: AppState = {
      ...state,
      focusState: 'BREAK',
      timerStartedAt: new Date().toISOString(),
      timerDuration: durationMinutes,
      breakTimeRemaining: durationMinutes * 60,
    };

    await saveAppState(newState);
    return newState;
  }

  /**
   * Ends the break early and resumes focus.
   */
  async endBreak(): Promise<AppState> {
    const state = await getAppState();
    stopTimer(ALARM_BREAK);

    if (!state.currentTaskId) {
      // No active task — go idle
      const newState: AppState = { ...state, focusState: 'IDLE' };
      await saveAppState(newState);
      return newState;
    }

    // Resume focus on the same task
    return this.startFocus(state.currentTaskId, state.focusMode);
  }

  // ── Tab Handling ──────────────────────────────────────────────────────────

  /**
   * Called whenever the active tab changes or a page loads.
   * Returns whether the site is blocked and whether to show the nudge overlay.
   *
   * Also accumulates visit time on the previous domain.
   */
  async handleTabChange(
    url: string,
  ): Promise<{ blocked: boolean; nudge: boolean }> {
    if (!url || this.isAllowedUrl(url)) {
      return { blocked: false, nudge: false };
    }

    const state = await getAppState();

    if (state.focusState !== 'FOCUSING') {
      return { blocked: false, nudge: false };
    }

    const task = state.currentTaskId
      ? await getTaskById(state.currentTaskId)
      : undefined;

    // Accumulate time on the domain we're leaving
    if (currentVisitDomain && currentVisitStart && state.currentSession) {
      const updatedSession = endVisit(
        currentVisitDomain,
        currentVisitStart,
        state.currentSession,
      );
      await saveAppState({ ...state, currentSession: updatedSession });
    }

    // Extract new domain and start tracking it
    const { extractDomain } = await import('./blocker.js');
    const newDomain = extractDomain(url);
    currentVisitDomain = newDomain;
    currentVisitStart = Date.now();

    // Update session with new domain entry
    if (state.currentSession && newDomain) {
      const updatedSession = trackVisit(newDomain, state.currentSession);
      await saveAppState({ ...state, currentSession: updatedSession });
    }

    const settings = await getSettings();
    const blockedList = (task?.blockedWebsites && task.blockedWebsites.length > 0)
      ? task.blockedWebsites
      : (settings.defaultBlockedWebsites ?? []);
    const allowedList = task?.allowedWebsites ?? [];
    const isWhitelist = task?.blockMode === 'whitelist';

    const nudge = shouldShowNudge(url, blockedList, allowedList, isWhitelist);
    return { blocked: nudge, nudge };
  }

  /**
   * Proactively checks whether a given URL is blocked in the current state,
   * returning details needed by content scripts to display the overlay.
   */
  async checkUrlBlocked(url: string): Promise<{
    blocked: boolean;
    payload?: BlockedPayload;
  }> {
    if (!url || this.isAllowedUrl(url)) {
      return { blocked: false };
    }

    const state = await getAppState();
    if (state.focusState !== 'FOCUSING') {
      return { blocked: false };
    }

    const task = state.currentTaskId
      ? await getTaskById(state.currentTaskId)
      : undefined;
    const settings = await getSettings();

    const blockedList = (task?.blockedWebsites && task.blockedWebsites.length > 0)
      ? task.blockedWebsites
      : (settings.defaultBlockedWebsites ?? []);
    const allowedList = task?.allowedWebsites ?? [];
    const isWhitelist = task?.blockMode === 'whitelist';

    const isBlocked = shouldShowNudge(url, blockedList, allowedList, isWhitelist);
    if (!isBlocked) return { blocked: false };

    const { extractDomain } = await import('./blocker.js');
    const domain = extractDomain(url);

    const sessionElapsedSeconds = state.timerStartedAt
      ? Math.max(0, Math.floor((Date.now() - new Date(state.timerStartedAt).getTime()) / 1000))
      : 0;
    const sessionTotalMinutes = state.timerDuration || task?.estimatedTime || 30;

    return {
      blocked: true,
      payload: {
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
      },
    };
  }

  // ── Getters ───────────────────────────────────────────────────────────────

  /** Returns the current AppState from storage. */
  async getState(): Promise<AppState> {
    return getAppState();
  }

  /**
   * Returns true for URLs that should never be inspected or blocked
   * (browser-internal, extension, blank pages, etc.).
   */
  isAllowedUrl(url: string): boolean {
    return isInternalUrl(url);
  }

  // ── Alarm Handlers ────────────────────────────────────────────────────────

  /**
   * Called by the service worker when the focus alarm fires.
   * Marks the current task as completed, saves stats, and automatically deletes the task!
   */
  async onFocusAlarm(): Promise<AppState> {
    const state = await getAppState();

    if (state.currentTaskId) {
      const task = await getTaskById(state.currentTaskId);
      if (task) {
        await recordCompletedTaskFocus({
          ...task,
          focusTime: task.estimatedTime,
          status: 'completed' as const,
        });
      }
    }

    stopTimer(ALARM_FOCUS);
    stopTimer(ALARM_BREAK);

    if (state.currentSession) {
      const finishedSession: FocusSession = {
        ...state.currentSession,
        endTime: new Date().toISOString(),
        duration: state.timerDuration,
      };
      await appendSession(finishedSession);
    }

    const newState: AppState = {
      ...state,
      focusState: 'IDLE',
      currentTaskId: null,
      timerStartedAt: null,
      timerDuration: 0,
      currentSession: null,
      pomodoroSession: 0,
    };

    await saveAppState(newState);
    return newState;
  }

  /**
   * Called by the service worker when the break alarm fires.
   */
  async onBreakAlarm(): Promise<AppState> {
    return this.endBreak();
  }
}

/** Singleton engine instance shared across the service worker module. */
export const focusEngine = new FocusEngine();
