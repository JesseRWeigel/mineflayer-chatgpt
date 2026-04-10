/**
 * Structured debug logger with color-coded bot prefixes and timestamps.
 *
 * Toggle via LOG_LEVEL env var:
 *   LOG_LEVEL=debug  — verbose output (full LLM prompts, raw responses, parsed actions)
 *   LOG_LEVEL=info   — normal output (default, same as current behavior)
 *   LOG_LEVEL=warn   — warnings and errors only
 *   LOG_LEVEL=error  — errors only
 *
 * Shortcut: DEBUG=1 or DEBUG=true is equivalent to LOG_LEVEL=debug.
 */

type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ANSI color codes for bot name prefixes — cycles through distinct colors
const BOT_COLORS = [
  "\x1b[36m", // cyan
  "\x1b[33m", // yellow
  "\x1b[35m", // magenta
  "\x1b[32m", // green
  "\x1b[34m", // blue
];
const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: "\x1b[90m", // gray
  info: "", // default
  warn: "\x1b[33m", // yellow
  error: "\x1b[31m", // red
};

function resolveLogLevel(): LogLevel {
  const debug = process.env.DEBUG;
  if (debug === "1" || debug === "true") return "debug";

  const level = (process.env.LOG_LEVEL || "info").toLowerCase();
  if (level in LEVEL_ORDER) return level as LogLevel;
  return "info";
}

let currentLevel = resolveLogLevel();

/** Color assignment cache — each bot name gets a stable color */
const botColorMap = new Map<string, string>();
let colorIndex = 0;

function getBotColor(botName: string): string {
  let color = botColorMap.get(botName);
  if (!color) {
    color = BOT_COLORS[colorIndex % BOT_COLORS.length];
    botColorMap.set(botName, color);
    colorIndex++;
  }
  return color;
}

function timestamp(): string {
  const now = new Date();
  const h = String(now.getHours()).padStart(2, "0");
  const m = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatPrefix(level: LogLevel, tag: string, botName?: string): string {
  const ts = `${DIM}${timestamp()}${RESET}`;
  const levelColor = LEVEL_COLORS[level];
  const levelStr = level === "info" ? "" : ` ${levelColor}${level.toUpperCase()}${RESET}`;

  if (botName) {
    const color = getBotColor(botName);
    return `${ts}${levelStr} ${color}[${botName}]${RESET} [${tag}]`;
  }
  return `${ts}${levelStr} [${tag}]`;
}

export interface Logger {
  debug(tag: string, message: string, ...args: unknown[]): void;
  info(tag: string, message: string, ...args: unknown[]): void;
  warn(tag: string, message: string, ...args: unknown[]): void;
  error(tag: string, message: string, ...args: unknown[]): void;
  isDebug(): boolean;
}

/**
 * Create a logger scoped to a bot name. Pass no name for system-level logging.
 */
export function createLogger(botName?: string): Logger {
  return {
    debug(tag: string, message: string, ...args: unknown[]) {
      if (!shouldLog("debug")) return;
      console.log(formatPrefix("debug", tag, botName), message, ...args);
    },
    info(tag: string, message: string, ...args: unknown[]) {
      if (!shouldLog("info")) return;
      console.log(formatPrefix("info", tag, botName), message, ...args);
    },
    warn(tag: string, message: string, ...args: unknown[]) {
      if (!shouldLog("warn")) return;
      console.warn(formatPrefix("warn", tag, botName), message, ...args);
    },
    error(tag: string, message: string, ...args: unknown[]) {
      if (!shouldLog("error")) return;
      console.error(formatPrefix("error", tag, botName), message, ...args);
    },
    isDebug() {
      return currentLevel === "debug";
    },
  };
}

/** System-level logger (no bot name) */
export const log = createLogger();

/** Re-read LOG_LEVEL from environment (useful for testing) */
export function refreshLogLevel(): void {
  currentLevel = resolveLogLevel();
}
