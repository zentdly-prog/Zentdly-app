import { NextRequest, NextResponse } from "next/server";
import {
  SITE_AUTH_COOKIE,
  SITE_AUTH_MAX_AGE_SECONDS,
  createSiteAuthToken,
  getSiteAuthCredentials,
  type PanelRole,
} from "@/lib/siteAuth";
import { authenticatePanelUser } from "@/lib/panelUsers";

function getSafeNextPath(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.startsWith("/") || value.startsWith("//")) {
    return "/";
  }
  if (value.startsWith("/login")) return "/";
  return value;
}

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const username = typeof formData.get("username") === "string" ? (formData.get("username") as string).trim() : "";
  const password = typeof formData.get("password") === "string" ? (formData.get("password") as string) : "";
  const nextPath = getSafeNextPath(formData.get("next"));
  const credentials = getSiteAuthCredentials();

  if (!credentials.username || !credentials.password) {
    return NextResponse.redirect(new URL("/login?error=config", request.url), 303);
  }

  let role: PanelRole | null = null;
  let authedUsername = username;

  // 1. Env bootstrap super-admin
  if (username === credentials.username && password === credentials.password) {
    role = "admin";
  } else {
    // 2. panel_users table
    const panelUser = await authenticatePanelUser(username.toLowerCase(), password);
    if (panelUser) {
      role = panelUser.role;
      authedUsername = panelUser.username;
    }
  }

  if (!role) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "invalid");
    loginUrl.searchParams.set("next", nextPath);
    return NextResponse.redirect(loginUrl, 303);
  }

  // Lite users land on a usable page, not the admin overview.
  const destination = role === "lite" && nextPath === "/" ? "/" : nextPath;
  const response = NextResponse.redirect(new URL(destination, request.url), 303);
  const token = await createSiteAuthToken(role, authedUsername);

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
