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

function liteCanAccess(pathname: string): boolean {
  if (pathname === "/") return true; // negocios list — pick a complejo

  const tenantMatch = pathname.match(/^\/tenants\/([^/]+)(\/.*)?$/);
  if (!tenantMatch) return false; // any other top-level area is admin-only

  const suffix = tenantMatch[2] ?? "";
  return LITE_ALLOWED_TENANT_SUFFIXES.some((allowed) => suffix === allowed || suffix.startsWith(`${allowed}/`));
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function liteRedirectTarget(pathname: string, requestUrl: string): URL {
  const tenantMatch = pathname.match(/^\/tenants\/([^/]+)/);
  if (tenantMatch && UUID_RE.test(tenantMatch[1])) {
    return new URL(`/tenants/${tenantMatch[1]}/calendar`, requestUrl);
  }
  return new URL("/", requestUrl);
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

  // Role gate: lite users only reach calendar / reservations / inbox.
  if (session.role === "lite" && !liteCanAccess(pathname)) {
    return NextResponse.redirect(liteRedirectTarget(pathname, request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
