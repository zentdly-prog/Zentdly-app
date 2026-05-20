import { NextRequest, NextResponse } from "next/server";
import { SITE_AUTH_COOKIE, verifySiteAuthSession } from "@/lib/siteAuth";

const PUBLIC_FILE = /\.[^/]+$/;

// Tabs a "lite" operator may access within a tenant.
const LITE_ALLOWED_TENANT_SUFFIXES = ["/calendar", "/reservations", "/inbox"];

function isPublicPath(pathname: string) {
  return (
    pathname === "/login" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    PUBLIC_FILE.test(pathname)
  );
}

function liteCanAccess(pathname: string, tenantId: string | null): boolean {
  if (!tenantId) return false; // lite must be scoped to a tenant

  const tenantMatch = pathname.match(/^\/tenants\/([^/]+)(\/.*)?$/);
  if (!tenantMatch) return false; // only their tenant's pages

  // Must be THEIR tenant
  if (tenantMatch[1] !== tenantId) return false;

  const suffix = tenantMatch[2] ?? "";
  return LITE_ALLOWED_TENANT_SUFFIXES.some((allowed) => suffix === allowed || suffix.startsWith(`${allowed}/`));
}

function liteRedirectTarget(tenantId: string | null, requestUrl: string): URL {
  if (tenantId) return new URL(`/tenants/${tenantId}/calendar`, requestUrl);
  // No tenant scope → session is unusable; force re-login.
  const loginUrl = new URL("/login", requestUrl);
  loginUrl.searchParams.set("error", "config");
  return loginUrl;
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SITE_AUTH_COOKIE)?.value;
  const session = await verifySiteAuthSession(token);

  if (pathname === "/login") {
    if (session.valid) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (isPublicPath(pathname)) return NextResponse.next();

  if (!session.valid) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(loginUrl);
  }

  // Role gate: lite users only reach their own tenant's calendar / reservations / inbox.
  if (session.role === "lite" && !liteCanAccess(pathname, session.tenantId)) {
    return NextResponse.redirect(liteRedirectTarget(session.tenantId, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
