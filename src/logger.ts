import * as fs from "fs";
import * as path from "path";
import { createWriteStream } from "fs";

export enum LogLevel {
  Trace = 0,
  Debug = 1,
  Info = 2,
  Warn = 3,
  Error = 4,
}

export class Logger {
  private level: LogLevel = LogLevel.Info;
  private logStream: fs.WriteStream | null = null;
  private prefix: string;

  constructor(
    private name: string,
    level?: LogLevel,
    logFilePath?: string
  ) {
    this.prefix = `[${name}]`;

    if (level !== undefined) {
      this.level = level;
    }

    if (logFilePath) {
      // Create log directory if needed
      const dir = path.dirname(logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Create daily rolling log file
      const timestamp = new Date().toISOString().split("T")[0];
      const logFile = logFilePath.replace(".log", `.${timestamp}.log`);
      this.logStream = createWriteStream(logFile, { flags: "a" });
    }
  }

  private formatMessage(
    level: string,
    message: string,
    data?: unknown
  ): string {
    const timestamp = new Date().toISOString();
    const dataStr = data ? ` ${JSON.stringify(data)}` : "";
    return `${timestamp} ${level} ${this.prefix} ${message}${dataStr}`;
  }

  private log(level: LogLevel, levelName: string, message: string, data?: unknown): void {
    if (level < this.level) {
      return;
    }

    const formatted = this.formatMessage(levelName, message, data);

    // Write to stderr for all levels
    console.error(formatted);

    // Also write to file if configured
    if (this.logStream) {
      this.logStream.write(formatted + "\n");
    }
  }

  trace(message: string, data?: unknown): void {
    this.log(LogLevel.Trace, "TRACE", message, data);
  }

  debug(message: string, data?: unknown): void {
    this.log(LogLevel.Debug, "DEBUG", message, data);
  }

  info(message: string, data?: unknown): void {
    this.log(LogLevel.Info, "INFO ", message, data);
  }

  warn(message: string, data?: unknown): void {
    this.log(LogLevel.Warn, "WARN ", message, data);
  }

  error(message: string, data?: unknown): void {
    this.log(LogLevel.Error, "ERROR", message, data);
  }

  child(name: string): Logger {
    return new Logger(`${this.name}/${name}`, this.level, this.logStream?.path as string | undefined);
  }

  close(): void {
    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
  }
}

/**
 * Initialize global logger instance
 */
export function initializeLogger(level: string, logFilePath?: string): Logger {
  const levelMap: Record<string, LogLevel> = {
    trace: LogLevel.Trace,
    debug: LogLevel.Debug,
    info: LogLevel.Info,
    warn: LogLevel.Warn,
    error: LogLevel.Error,
  };

  const logLevel = levelMap[level.toLowerCase()] ?? LogLevel.Info;
  return new Logger("hc-matter", logLevel, logFilePath);
}
