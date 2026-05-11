import { NextRequest, NextResponse } from "next/server";
import {
  SITE_AUTH_COOKIE,
  SITE_AUTH_MAX_AGE_SECONDS,
  createSiteAuthToken,
  getSiteAuthCredentials,
} from "@/lib/siteAuth";

function getSafeNextPath(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }

  if (value.startsWith("/login")) {
    return "/";
  }

  return value;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const username = formData.get("username");
  const password = formData.get("password");
  const nextPath = getSafeNextPath(formData.get("next"));
  const credentials = getSiteAuthCredentials();

  if (!credentials.username || !credentials.password) {
    return NextResponse.redirect(new URL("/login?error=config", request.url), 303);
  }

  if (username !== credentials.username || password !== credentials.password) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "invalid");
    loginUrl.searchParams.set("next", nextPath);

    return NextResponse.redirect(loginUrl, 303);
  }

  const response = NextResponse.redirect(new URL(nextPath, request.url), 303);
  const token = await createSiteAuthToken();

  response.cookies.set({
    name: SITE_AUTH_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SITE_AUTH_MAX_AGE_SECONDS,
  });

  return response;
}
