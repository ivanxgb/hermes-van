/**
 * Structured logger with secret redaction.
 *
 * Every secret-bearing path gets censored before serialization. Pino's
 * redaction is fast and runs on the serialized object, not the string.
 */
import pino from "pino";
import { loadEnv } from "./env";

const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  "headers.authorization",
  "headers.cookie",
  "*.api_key",
  "*.apiKey",
  "*.token",
  "*.password",
  "*.recovery_code",
  "*.recoveryCode",
  "*.session_secret",
  "*.db_key",
  "*.dbKey",
  "*.upstream_run_id",
  "*.upstreamRunId",
  "*.run_id",
  "*.runId",
  "*.HERMES_API_KEY",
  "*.HERMES_WEB_DB_KEY",
  "*.HERMES_WEB_SESSION_SECRET",
];

let _logger: pino.Logger | null = null;

function build(): pino.Logger {
  const env = loadEnv();
  return pino({
    level: env.HERMES_WEB_LOG_LEVEL,
    base: { service: "hermes-van", env: env.NODE_ENV },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
    transport:
      env.NODE_ENV !== "production"
        ? {
            target: "pino-pretty",
            options: { colorize: true, translateTime: "HH:MM:ss.l" },
          }
        : undefined,
  });
}

/**
 * Lazy logger proxy. Loaded on first use so that importing this module
 * doesn't trigger env validation (handy for unit tests of unrelated code).
 */
export const logger = new Proxy({} as pino.Logger, {
  get(_target, prop: string | symbol) {
    if (!_logger) _logger = build();
    const value = _logger[prop as keyof pino.Logger];
    if (typeof value === "function") return value.bind(_logger);
    return value;
  },
});

/** Test helper to check redaction works. Returns serialized log entry. */
export function _serializeForTest(level: pino.Level, obj: object, msg: string): string {
  const chunks: string[] = [];
  const stream = {
    write(chunk: string) {
      chunks.push(chunk);
    },
  };
  const testLogger = pino(
    {
      redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
      timestamp: false,
      base: undefined,
    },
    stream,
  );
  testLogger[level](obj, msg);
  return chunks.join("");
}
