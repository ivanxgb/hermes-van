/**
 * Recovery codes.
 *
 * Issued at user setup. Single-use. Stored as Argon2id hashes; raw codes
 * are shown to the user exactly once and are unrecoverable thereafter.
 *
 * Format: 10 codes per user, each 5 groups of 5 chars, base32-without-vowels
 * to avoid lookalike characters. Example: "K7M9X-PQR4N-J2WHY-DC8F3-V6BLT".
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";

// Crockford-ish base32 minus vowels and ambiguous chars (0/1/I/O).
const ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXYZ"; // 28 chars
const CODE_LENGTH = 25; // 5 groups of 5
const GROUP_SIZE = 5;
const TOTAL_CODES = 10;

// Argon2id parameters. Argon2id is the recommended variant in OWASP's
// password storage cheat sheet. Memory cost = 19 MB is the OWASP minimum.
// Algorithm enum value 2 = Argon2id (avoid const-enum import for
// isolatedModules compat).
const ARGON2_OPTIONS = {
  algorithm: 2 as const, // Argon2id
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

/** Generate a new random recovery code (uppercase, hyphenated). */
export function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    if (i > 0 && i % GROUP_SIZE === 0) out += "-";
    const byte = bytes[i];
    if (byte === undefined) throw new Error("RNG truncated");
    out += ALPHABET[byte % ALPHABET.length];
  }
  return out;
}

/** Generate a fresh batch of recovery codes for a user. */
export function generateBatch(): string[] {
  const codes = new Set<string>();
  while (codes.size < TOTAL_CODES) {
    codes.add(generateCode());
  }
  return Array.from(codes);
}

/** Normalize user input: strip whitespace, hyphens, uppercase. */
export function normalize(input: string): string {
  return input.replace(/[\s-]+/g, "").toUpperCase();
}

/** Hash a recovery code with Argon2id for storage. */
export async function hashCode(rawCode: string): Promise<string> {
  return hash(normalize(rawCode), ARGON2_OPTIONS);
}

/** Verify a raw code against a stored hash (constant time at the Argon2 level). */
export async function verifyCode(rawCode: string, storedHash: string): Promise<boolean> {
  try {
    return await verify(storedHash, normalize(rawCode));
  } catch {
    return false;
  }
}

/**
 * Constant-time equality of two strings.
 * Used for non-Argon2 token comparisons (CSRF, setup tokens).
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
