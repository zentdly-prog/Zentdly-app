const encoder = new TextEncoder();

export const SITE_AUTH_COOKIE = "zentdly_site_session";
export const SITE_AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

export type PanelRole = "admin" | "lite";

export interface SiteSession {
  valid: boolean;
  role: PanelRole;
  username: string;
  tenantId: string | null;
}

function base64Url(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeField(value: string) {
  return btoa(unescape(encodeURIComponent(value))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeField(value: string) {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/");
    return decodeURIComponent(escape(atob(padded)));
  } catch {
    return "";
  }
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

export async function createSiteAuthToken(
  role: PanelRole = "admin",
  username = "admin",
  tenantId: string | null = null,
) {
  const secret = getAuthSecret();
  if (!secret) {
    throw new Error("SITE_AUTH_SECRET is not configured");
  }

  const issuedAt = Math.floor(Date.now() / 1000).toString();
  const userField = encodeField(username);
  const tenantField = tenantId ?? "all";
  const payload = `${issuedAt}.${role}.${userField}.${tenantField}`;
  const signature = await sign(payload, secret);
  return `${payload}.${signature}`;
}

export async function verifySiteAuthSession(token: string | undefined): Promise<SiteSession> {
  const invalid: SiteSession = { valid: false, role: "lite", username: "", tenantId: null };
  const secret = getAuthSecret();
  if (!secret || !token) return invalid;

  const parts = token.split(".");

  // Legacy token format: {issuedAt}.{signature} → treat as admin
  if (parts.length === 2) {
    const [issuedAt, signature] = parts;
    if (!(await isFreshAndSigned(issuedAt, issuedAt, signature, secret))) return invalid;
    return { valid: true, role: "admin", username: "admin", tenantId: null };
  }

  // Previous format: {issuedAt}.{role}.{userB64}.{signature} → no tenant scope
  if (parts.length === 4) {
    const [issuedAt, role, userField, signature] = parts;
    const payload = `${issuedAt}.${role}.${userField}`;
    if (!(await isFreshAndSigned(issuedAt, payload, signature, secret))) return invalid;
    if (role !== "admin" && role !== "lite") return invalid;
    return { valid: true, role: role as PanelRole, username: decodeField(userField) || "usuario", tenantId: null };
  }

  // Current format: {issuedAt}.{role}.{userB64}.{tenant}.{signature}
  if (parts.length !== 5) return invalid;
  const [issuedAt, role, userField, tenantField, signature] = parts;
  const payload = `${issuedAt}.${role}.${userField}.${tenantField}`;
  if (!(await isFreshAndSigned(issuedAt, payload, signature, secret))) return invalid;
  if (role !== "admin" && role !== "lite") return invalid;

  return {
    valid: true,
    role: role as PanelRole,
    username: decodeField(userField) || "usuario",
    tenantId: tenantField && tenantField !== "all" ? tenantField : null,
  };
}

async function isFreshAndSigned(issuedAt: string, payload: string, signature: string, secret: string) {
  const issuedAtNumber = Number(issuedAt);
  if (!issuedAt || !signature || !Number.isFinite(issuedAtNumber)) return false;

  const ageSeconds = Math.floor(Date.now() / 1000) - issuedAtNumber;
  if (ageSeconds < 0 || ageSeconds > SITE_AUTH_MAX_AGE_SECONDS) return false;

  const expected = await sign(payload, secret);
  return signature === expected;
}

// Back-compat helper used by middleware that only needs a yes/no.
export async function verifySiteAuthToken(token: string | undefined): Promise<boolean> {
  return (await verifySiteAuthSession(token)).valid;
}
