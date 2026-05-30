/**
 * Environment validation.
 *
 * All environment variables are validated at boot. The server refuses to
 * start if anything is missing, malformed, or weak (e.g. dev secrets in
 * production). Zod schemas live here so a single source of truth defines
 * what's required.
 *
 * Usage:
 *   import { env } from "~/server/lib/env";
 *   env.HERMES_VAN_GATEWAY_URL  // typed string
 */
import { z } from "zod";

const HEX_32 = /^[0-9a-f]{64}$/i;

const schema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

    // Hermes gateway
    HERMES_VAN_GATEWAY_URL: z.string().url().default("http://127.0.0.1:8765"),
    HERMES_VAN_GATEWAY_KEY: z.string().min(16, "HERMES_VAN_GATEWAY_KEY must be at least 16 chars"),

    // Local DB
    HERMES_VAN_DB_PATH: z.string().min(1).default("./data/hermes-van.db"),
    HERMES_VAN_DB_KEY: z
      .string()
      .regex(HEX_32, "HERMES_VAN_DB_KEY must be 32 bytes hex (64 chars)"),

    // Session signing
    HERMES_VAN_SESSION_SECRET: z
      .string()
      .regex(HEX_32, "HERMES_VAN_SESSION_SECRET must be 32 bytes hex (64 chars)"),

    // WebAuthn relying party
    HERMES_VAN_RP_ID: z.string().min(1).default("localhost"),
    HERMES_VAN_RP_ORIGIN: z.string().url().default("http://localhost:3015"),
    HERMES_VAN_RP_NAME: z.string().min(1).default("hermes-van"),

    // Bind
    HERMES_VAN_PORT: z.coerce.number().int().min(1).max(65535).default(3015),
    HERMES_VAN_HOST: z.string().min(1).default("127.0.0.1"),

    // Logging
    HERMES_VAN_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace"])
      .default("info"),
  })
  .superRefine((data, ctx) => {
    // Defense in depth: never accept default placeholder secrets in production
    if (data.NODE_ENV === "production") {
      const placeholders = [
        "replace-with-32-byte-hex-from-openssl-rand",
        "0".repeat(64),
        "f".repeat(64),
      ];
      if (placeholders.includes(data.HERMES_VAN_DB_KEY.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["HERMES_VAN_DB_KEY"],
          message: "Cannot use placeholder DB key in production",
        });
      }
      if (placeholders.includes(data.HERMES_VAN_SESSION_SECRET.toLowerCase())) {
        ctx.addIssue({
          code: "custom",
          path: ["HERMES_VAN_SESSION_SECRET"],
          message: "Cannot use placeholder session secret in production",
        });
      }
      if (data.HERMES_VAN_RP_ORIGIN.startsWith("http://") && !data.HERMES_VAN_RP_ORIGIN.includes("localhost")) {
        ctx.addIssue({
          code: "custom",
          path: ["HERMES_VAN_RP_ORIGIN"],
          message: "Production RP_ORIGIN must use HTTPS",
        });
      }
    }
  });

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

/**
 * Parse and validate environment. Cached after first call.
 *
 * @throws ZodError with all validation issues if env is invalid.
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;
  const result = schema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  • ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Environment validation failed:\n${issues}`);
  }
  cached = result.data;
  return cached;
}

/** Reset cache. Test-only. */
export function _resetEnvCache(): void {
  cached = null;
}

/**
 * Lazy proxy. Calling `env.HERMES_VAN_GATEWAY_URL` triggers validation on first
 * access — convenient for code paths that don't import this at boot.
 */
export const env = new Proxy({} as Env, {
  get(_target, prop: string) {
    return loadEnv()[prop as keyof Env];
  },
});
