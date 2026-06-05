/**
 * Re-export simplewebauthn/browser entry points and the option types
 * with the strict shape the library expects. The server's typed responses
 * use a looser local mirror; we cast at this boundary.
 */
export { startRegistration, startAuthentication } from "@simplewebauthn/browser";
export type {
  PublicKeyCredentialCreationOptionsJSON as WebAuthnRegistrationOptions,
  PublicKeyCredentialRequestOptionsJSON as WebAuthnAuthenticationOptions,
} from "@simplewebauthn/types";
