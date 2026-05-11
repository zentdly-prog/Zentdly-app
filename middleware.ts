import { NextRequest, NextResponse } from "next/server";
import { SITE_AUTH_COOKIE, verifySiteAuthToken } from "@/lib/siteAuth";

const PUBLIC_FILE = /\.[^/]+$/;

function isPublicPath(pathname: string) {
  return (
    pathname === "/login" ||
    pathname.startsWith("/api/") ||
    pathname.startsWith("/_next/") ||
    pathname === "/favicon.ico" ||
    PUBLIC_FILE.test(pathname)
  );
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const token = request.cookies.get(SITE_AUTH_COOKIE)?.value;
  const isAuthenticated = await verifySiteAuthToken(token);

  if (pathname === "/login") {
    if (isAuthenticated) {
      return NextResponse.redirect(new URL("/", request.url));
    }

    return NextResponse.next();
  }

  if (isPublicPath(pathname) || isAuthenticated) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${search}`);

  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
