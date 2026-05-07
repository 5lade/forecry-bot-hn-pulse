import pino, { type Logger } from "pino";

const env = process.env.NODE_ENV;
const isProduction = env === "production";
const isTest = env === "test";

function resolveLevel(): pino.LevelWithSilent {
  const fromEnv = process.env.LOG_LEVEL;
  if (fromEnv) return fromEnv as pino.LevelWithSilent;
  if (isTest) return "silent";
  if (isProduction) return "info";
  return "debug";
}

function buildBaseOptions(): pino.LoggerOptions {
  return {
    level: resolveLevel(),
    base: undefined,
    formatters: {
      level: (label: string) => ({ level: label }),
    },
  };
}

function createLogger(): Logger {
  const opts = buildBaseOptions();
  if (isProduction || isTest) return pino(opts);
  try {
    return pino({
      ...opts,
      transport: {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "SYS:HH:MM:ss", ignore: "pid,hostname" },
      },
    });
  } catch {
    return pino(opts);
  }
}

export const logger: Logger = createLogger();

export type LogBindings = Record<string, unknown>;

export function childLogger(bindings: LogBindings): Logger {
  return logger.child(bindings);
}

export function loggerInfoSink(bindings?: LogBindings): (msg: string) => void {
  const target = bindings ? logger.child(bindings) : logger;
  return (msg) => target.info(msg);
}

export function loggerErrorSink(
  bindings?: LogBindings,
): (err: unknown, label: string) => void {
  const target = bindings ? logger.child(bindings) : logger;
  return (err, label) => {
    const msg = err instanceof Error ? err.message : String(err);
    target.error({ err, label }, msg);
  };
}

export function loggerWarnSink(
  bindings?: LogBindings,
): (err: unknown, label: string) => void {
  const target = bindings ? logger.child(bindings) : logger;
  return (err, label) => {
    const msg = err instanceof Error ? err.message : String(err);
    target.warn({ err, label }, msg);
  };
}
