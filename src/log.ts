import fs from "node:fs";
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const MAX_LOG_BYTES = 5 * 1024 * 1024;

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Append log lines to this file (best effort). */
  file?: string;
  /** Also write to stderr. Never stdout: stdout carries the MCP protocol. */
  stderr?: boolean;
}

function serializeMeta(meta: Record<string, unknown> | undefined): string {
  if (!meta || Object.keys(meta).length === 0) return "";
  try {
    return ` ${JSON.stringify(meta, (_k, v: unknown) => (v instanceof Error ? { name: v.name, message: v.message } : v))}`;
  } catch {
    return " [unserializable meta]";
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = ORDER[options.level];
  let fileOk = Boolean(options.file);
  if (options.file) {
    try {
      fs.mkdirSync(path.dirname(options.file), { recursive: true, mode: 0o700 });
      const st = fs.statSync(options.file, { throwIfNoEntry: false });
      if (st && st.size > MAX_LOG_BYTES) fs.renameSync(options.file, `${options.file}.1`);
    } catch {
      fileOk = false;
    }
  }
  const write = (level: Exclude<LogLevel, "silent">, message: string, meta?: Record<string, unknown>) => {
    if (ORDER[level] < threshold) return;
    const line = `${new Date().toISOString()} [${level}] ${message}${serializeMeta(meta)}\n`;
    if (options.stderr) {
      try {
        process.stderr.write(line);
      } catch {
        /* ignore */
      }
    }
    if (fileOk && options.file) {
      try {
        fs.appendFileSync(options.file, line, { mode: 0o600 });
      } catch {
        fileOk = false;
      }
    }
  };
  return {
    debug: (m, meta) => write("debug", m, meta),
    info: (m, meta) => write("info", m, meta),
    warn: (m, meta) => write("warn", m, meta),
    error: (m, meta) => write("error", m, meta),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
