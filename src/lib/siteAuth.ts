const encoder = new TextEncoder();

export const SITE_AUTH_COOKIE = "zentdly_site_session";
export const SITE_AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function base64Url(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sign(value: string, secret: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return base64Url(signature);
}

function getAuthSecret() {
  return process.env.SITE_AUTH_SECRET;
}

export function getSiteAuthCredentials() {
  return {
    username: process.env.SITE_AUTH_USERNAME,
    password: process.env.SITE_AUTH_PASSWORD,
  };
}

export async function createSiteAuthToken() {
  const secret = getAuthSecret();

  if (!secret) {
    throw new Error("SITE_AUTH_SECRET is not configured");
  }

  const issuedAt = Math.floor(Date.now() / 1000).toString();
  const signature = await sign(issuedAt, secret);

  return `${issuedAt}.${signature}`;
}

export async function verifySiteAuthToken(token: string | undefined) {
  const secret = getAuthSecret();

  if (!secret || !token) {
    return false;
  }

  const [issuedAt, signature] = token.split(".");
  const issuedAtNumber = Number(issuedAt);

  if (!issuedAt || !signature || !Number.isFinite(issuedAtNumber)) {
    return false;
  }

  const ageSeconds = Math.floor(Date.now() / 1000) - issuedAtNumber;

  if (ageSeconds < 0 || ageSeconds > SITE_AUTH_MAX_AGE_SECONDS) {
    return false;
  }

  const expectedSignature = await sign(issuedAt, secret);

  return signature === expectedSignature;
}
