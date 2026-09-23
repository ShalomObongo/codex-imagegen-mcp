import { createHash, randomBytes } from "node:crypto";

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256 pair: 64 random bytes -> base64url verifier (86 chars), SHA-256 -> challenge. */
export function createPkce(): Pkce {
  const verifier = randomBytes(64).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Opaque CSRF state for the authorize round-trip. */
export function createState(): string {
  return randomBytes(32).toString("base64url");
}
