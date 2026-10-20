// ─── Core Enumerations ────────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'active' | 'completed' | 'skipped';
export type TaskPriority = 'low' | 'medium' | 'high';
export type FocusMode = 'normal' | 'pomodoro';
export type BlockingMode = 'soft' | 'hard';
export type FocusState = 'IDLE' | 'FOCUSING' | 'BREAK' | 'PAUSED';
export type PersonalityMode = 'gentle' | 'normal' | 'strict' | 'brutal';

// ─── Settings ─────────────────────────────────────────────────────────────────

export interface PomodoroSettings {
  /** Work interval in minutes */
  workDuration: number;
  /** Short break interval in minutes */
  breakDuration: number;
  /** Long break interval in minutes */
  longBreakDuration: number;
  /** Number of pomodoro sessions before a long break */
  sessionsBeforeLongBreak: number;
}

export interface UserSettings {
  userName: string;
  personality: PersonalityMode;
  blockingMode: BlockingMode;
  defaultPomodoroWork: number;    // minutes
  defaultPomodoroBreak: number;   // minutes
  defaultFocusDuration: number;   // minutes
  enableBreakReminders: boolean;
  breakReminderInterval: number;  // minutes
  defaultBlockedWebsites: string[];
}

// ─── Task ─────────────────────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  description?: string;
  /** ISO date string YYYY-MM-DD */
  date: string;
  /** Estimated time to complete in minutes */
  estimatedTime: number;
  priority: TaskPriority;
  status: TaskStatus;
  /** Actual focused time accumulated in minutes */
  focusTime: number;
  /** Domains that are always allowed during this task */
  allowedWebsites: string[];
  /** Domains to block during this task */
  blockedWebsites: string[];
  /** Mode: 'blacklist' (block selected) or 'whitelist' (block ALL except allowed) */
  blockMode?: 'blacklist' | 'whitelist';
  /** Categorization & tags */
  category?: string;
  tags?: string[];
  pomodoroSettings?: PomodoroSettings;
  /** ISO timestamp of when this task was created */
  createdAt: string;
}

// ─── Sessions ─────────────────────────────────────────────────────────────────

export interface FocusSession {
  taskId: string;
  startTime: string;   // ISO timestamp
  endTime?: string;    // ISO timestamp
  duration?: number;   // minutes
  websitesVisited: { url: string; duration: number }[];
}

// ─── Application State ────────────────────────────────────────────────────────

export interface AppState {
  currentTaskId: string | null;
  focusState: FocusState;
  focusMode: FocusMode;
  blockingMode: BlockingMode;
  personality: PersonalityMode;
  /** ISO timestamp of when the current timer was started */
  timerStartedAt: string | null;
  /** Total duration of the current timer in minutes */
  timerDuration: number;
  /** Seconds remaining on the break timer */
  breakTimeRemaining: number;
  /** Current pomodoro session number (1-based) */
  pomodoroSession: number;
  currentSession: FocusSession | null;
}

// ─── Website Tracking ────────────────────────────────────────────────────────

export interface DailyDomainUsage {
  [domain: string]: number; // seconds spent on this domain on that date
}

export interface WebsiteUsageData {
  // key is ISO date string YYYY-MM-DD
  [date: string]: DailyDomainUsage;
}

export interface DailyTagFocus {
  // key is ISO date string YYYY-MM-DD -> { tagName: minutes }
  [date: string]: { [tag: string]: number };
}

// ─── Persisted Storage ────────────────────────────────────────────────────────

export interface StorageData {
  tasks: Task[];
  appState: AppState;
  sessions: FocusSession[];
  settings: UserSettings;
  websiteUsage?: WebsiteUsageData;
  dailyTagFocus?: DailyTagFocus;
}

// ─── Messaging ────────────────────────────────────────────────────────────────

export type MessageType =
  | 'START_FOCUS'
  | 'STOP_FOCUS'
  | 'PAUSE_FOCUS'
  | 'RESUME_FOCUS'
  | 'COMPLETE_TASK'
  | 'START_BREAK'
  | 'END_BREAK'
  | 'GET_STATE'
  | 'ADD_TASK'
  | 'UPDATE_TASK'
  | 'DELETE_TASK'
  | 'CHECK_BLOCKED'
  | 'MODIFY_TASK_BLOCKLIST'
  | 'UPDATE_USER_NAME'
  | 'GET_WEBSITE_USAGE'
  | 'RECORD_DOMAIN_USAGE'
  | 'GET_DAILY_TAG_FOCUS'
  | 'ARCHIVE_PAST_TASKS'
  | 'WEBSITE_BLOCKED'
  | 'TAB_CHANGED'
  | 'STATE_UPDATED';

export interface BlockedPayload {
  taskTitle: string;
  userName: string;
  blockingMode: BlockingMode;
  personalityMode: PersonalityMode;
  domain: string;
  timeSpentSeconds: number;
  sessionElapsedSeconds?: number;
  sessionTotalMinutes?: number;
  tags?: string[];
  category?: string;
}

export interface Message {
  type: MessageType;
  payload?: unknown;
}
