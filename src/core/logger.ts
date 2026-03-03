/**
 * Minimal structured logger. No external dependencies.
 * Outputs JSON lines for easy parsing and monitoring.
 */

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = 'info';
let suppressed = false;

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

/** Suppress all log output (used during interactive setup). */
export function suppressLogs(): void { suppressed = true; }

/** Resume log output. */
export function unsuppressLogs(): void { suppressed = false; }

function log(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): void {
  if (suppressed || LEVELS[level] < LEVELS[minLevel]) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    module,
    msg: message,
    ...data,
  };
  const out = level === 'error' ? process.stderr : process.stdout;
  out.write(JSON.stringify(entry) + '\n');
}

export const createLogger = (module: string) => ({
  debug: (msg: string, data?: Record<string, unknown>) => log('debug', module, msg, data),
  info: (msg: string, data?: Record<string, unknown>) => log('info', module, msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log('warn', module, msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log('error', module, msg, data),
});
