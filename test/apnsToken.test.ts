import { createPublicKey, generateKeyPairSync, verify as cryptoVerify } from "node:crypto";
import { describe, expect, it, beforeEach } from "vitest";
import { providerToken, resetProviderToken } from "../convex/apnsToken";

// A throwaway P-256 key, the same curve Apple issues a .p8 on. Nothing here
// touches a real key: the point is that what this signs is a JWT APNs would
// accept, and that is checkable without one.
const { privateKey } = generateKeyPairSync("ec", {
  namedCurve: "prime256v1",
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

describe("the APNs provider token", () => {
  beforeEach(() => resetProviderToken());

  it("says ES256 and carries the key id in the header, where APNs reads it", () => {
    const [header] = providerToken("KEY123", "TEAM45", privateKey).split(".");
    expect(decode(header)).toEqual({ alg: "ES256", kid: "KEY123" });
  });

  it("issues to the team, with an iat APNs will not call stale", () => {
    const [, claims] = providerToken("KEY123", "TEAM45", privateKey).split(".");
    const body = decode(claims);
    expect(body.iss).toBe("TEAM45");
    expect(Math.abs(body.iat - Math.floor(Date.now() / 1000))).toBeLessThan(5);
  });

  it("signs in the format JOSE wants, not the DER openssl defaults to", () => {
    const [h, c, sig] = providerToken("KEY123", "TEAM45", privateKey).split(".");
    const signature = Buffer.from(sig, "base64url");
    // r and s, 32 bytes each, no ASN.1 wrapper. A DER signature is ~70 bytes
    // and variable, and APNs rejects it as InvalidProviderToken.
    expect(signature.length).toBe(64);
    expect(
      cryptoVerify("sha256", Buffer.from(`${h}.${c}`), {
        key: createPublicKey(privateKey),
        dsaEncoding: "ieee-p1363",
      }, signature),
    ).toBe(true);
  });

  it("accepts a key whose newlines survived as literal backslash-n", () => {
    // Which is what a .p8 pasted into a single-line dashboard field becomes.
    const flattened = privateKey.replace(/\n/g, "\\n");
    expect(() => providerToken("KEY123", "TEAM45", flattened)).not.toThrow();
  });

  it("reuses one token rather than minting per push, which Apple rate limits", () => {
    const first = providerToken("KEY123", "TEAM45", privateKey);
    expect(providerToken("KEY123", "TEAM45", privateKey)).toBe(first);
  });
});
