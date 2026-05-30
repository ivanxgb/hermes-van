/**
 * WebAuthn wrappers around @simplewebauthn/server.
 *
 * Two flows:
 *   1. Registration (setup) — generate options, verify response, persist credential.
 *   2. Authentication (login) — generate options, verify response, bump counter.
 *
 * Challenge storage: short-lived in-memory map keyed by session/setup token.
 * In Phase 1 we keep a process-local map; if the process restarts during the
 * (~60s) WebAuthn ceremony, the user has to retry. Phase 2 may move this to
 * the encrypted DB if needed.
 *
 * Counter validation: WebAuthn spec recommends rejecting authentications
 * where the new counter <= stored counter (clone detection). Most platform
 * authenticators no longer increment counters (counter stays at 0), in
 * which case we accept counter === 0 as a special case.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type GenerateRegistrationOptionsOpts,
  type GenerateAuthenticationOptionsOpts,
  type VerifyRegistrationResponseOpts,
  type VerifyAuthenticationResponseOpts,
} from "@simplewebauthn/server";
import { ulid } from "../lib/id";
import type { Env } from "../lib/env";

// Mirror of the simplewebauthn AuthenticatorTransportFuture type so we
// don't depend on the deep '@simplewebauthn/types' package.
type AuthenticatorTransportFuture =
  | "ble"
  | "cable"
  | "hybrid"
  | "internal"
  | "nfc"
  | "smart-card"
  | "usb";

// ─── Challenge ephemeral store ──────────────────────────────────────────

interface PendingChallenge {
  challenge: string;
  expiresAt: number;
  // For login flows, may carry the user being authenticated
  userId?: string;
  // For registration flows, the authenticator user handle
  webauthnUserId?: string;
}

const challenges = new Map<string, PendingChallenge>();
const CHALLENGE_TTL_MS = 5 * 60 * 1000;

function gcChallenges(): void {
  const now = Date.now();
  for (const [k, v] of challenges) {
    if (v.expiresAt < now) challenges.delete(k);
  }
}

export function rememberChallenge(
  key: string,
  data: Omit<PendingChallenge, "expiresAt">,
): void {
  gcChallenges();
  challenges.set(key, { ...data, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

export function consumeChallenge(key: string): PendingChallenge | null {
  gcChallenges();
  const data = challenges.get(key);
  if (!data) return null;
  challenges.delete(key);
  if (data.expiresAt < Date.now()) return null;
  return data;
}

// ─── Registration ──────────────────────────────────────────────────────

export async function buildRegistrationOptions(
  env: Env,
  user: { id: string; username: string; displayName: string },
  excludeCredentialIds: string[] = [],
) {
  // simplewebauthn v11 requires Uint8Array userIDs.
  const webauthnUserId = ulid();
  const opts: GenerateRegistrationOptionsOpts = {
    rpName: env.HERMES_WEB_RP_NAME,
    rpID: env.HERMES_WEB_RP_ID,
    userName: user.username,
    userDisplayName: user.displayName,
    userID: new TextEncoder().encode(webauthnUserId),
    timeout: 60_000,
    attestationType: "none",
    excludeCredentials: excludeCredentialIds.map((id) => ({
      id,
      transports: ["internal", "usb", "nfc", "ble", "hybrid"] as AuthenticatorTransportFuture[],
    })),
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "required",
    },
    supportedAlgorithmIDs: [-7, -257], // ES256, RS256
  };
  const options = await generateRegistrationOptions(opts);
  return { options, webauthnUserId };
}

interface VerifyRegistrationArgs {
  env: Env;
  expectedChallenge: string;
  response: Parameters<typeof verifyRegistrationResponse>[0]["response"];
}

export async function verifyRegistration({
  env,
  expectedChallenge,
  response,
}: VerifyRegistrationArgs) {
  const opts: VerifyRegistrationResponseOpts = {
    response,
    expectedChallenge,
    expectedOrigin: env.HERMES_WEB_RP_ORIGIN,
    expectedRPID: env.HERMES_WEB_RP_ID,
    requireUserVerification: true,
  };
  return verifyRegistrationResponse(opts);
}

// ─── Authentication ────────────────────────────────────────────────────

export async function buildAuthenticationOptions(
  env: Env,
  allowCredentialIds: string[] = [],
) {
  const opts: GenerateAuthenticationOptionsOpts = {
    rpID: env.HERMES_WEB_RP_ID,
    timeout: 60_000,
    userVerification: "required",
    allowCredentials: allowCredentialIds.map((id) => ({
      id,
      transports: ["internal", "usb", "nfc", "ble", "hybrid"] as AuthenticatorTransportFuture[],
    })),
  };
  return generateAuthenticationOptions(opts);
}

interface VerifyAuthenticationArgs {
  env: Env;
  expectedChallenge: string;
  response: Parameters<typeof verifyAuthenticationResponse>[0]["response"];
  credential: {
    id: string;
    publicKey: string; // base64url
    counter: number;
    transports?: string[];
  };
}

export async function verifyAuthentication({
  env,
  expectedChallenge,
  response,
  credential,
}: VerifyAuthenticationArgs) {
  const opts: VerifyAuthenticationResponseOpts = {
    response,
    expectedChallenge,
    expectedOrigin: env.HERMES_WEB_RP_ORIGIN,
    expectedRPID: env.HERMES_WEB_RP_ID,
    credential: {
      id: credential.id,
      publicKey: base64UrlToBuffer(credential.publicKey),
      counter: credential.counter,
      transports: (credential.transports ?? []) as AuthenticatorTransportFuture[],
    },
    requireUserVerification: true,
  };
  return verifyAuthenticationResponse(opts);
}

// ─── helpers ───────────────────────────────────────────────────────────

export function bufferToBase64Url(buf: Uint8Array): string {
  return Buffer.from(buf).toString("base64url");
}

export function base64UrlToBuffer(str: string): Uint8Array {
  return new Uint8Array(Buffer.from(str, "base64url"));
}
