"use node";

// The APNs provider token, alone in a file so it can be tested.
//
// Token-based auth is one .p8 signing key for the whole team rather than a
// per-app certificate that expires every year. The JWT is signed here rather
// than with a library because ES256 is exactly what `crypto.sign` does when
// told to emit the raw r||s pair JOSE wants instead of the DER wrapper OpenSSL
// defaults to. A dependency for one signature would be the larger thing to
// maintain.
import { createPrivateKey, sign as cryptoSign } from "node:crypto";

const b64url = (input: Buffer | string): string =>
  Buffer.from(input).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");

// Apple caps a provider token's life at one hour and rejects one minted more
// often than every 20 minutes, so this is memoised for the middle of that range.
let cachedJwt: { token: string; issued: number } | null = null;

// Tests mint several tokens in the same second; without this they would all be
// the first one, and every assertion after the first would be about a cache hit.
export function resetProviderToken(): void {
  cachedJwt = null;
}

export function providerToken(keyId: string, teamId: string, p8: string): string {
  const now = Math.floor(Date.now() / 1000);
  if (cachedJwt && now - cachedJwt.issued < 1800) return cachedJwt.token;

  const header = b64url(JSON.stringify({ alg: "ES256", kid: keyId }));
  const claims = b64url(JSON.stringify({ iss: teamId, iat: now }));
  const body = `${header}.${claims}`;
  // The env var carries the .p8 verbatim, and a dashboard field is a single
  // line, so a key pasted with literal backslash-n still parses.
  const pem = p8.includes("\\n") ? p8.replace(/\\n/g, "\n") : p8;
  const signature = cryptoSign("sha256", Buffer.from(body), {
    key: createPrivateKey(pem),
    dsaEncoding: "ieee-p1363",
  });
  const token = `${body}.${b64url(signature)}`;
  cachedJwt = { token, issued: now };
  return token;
}
