import { NextResponse } from "next/server";
import { SITE_AUTH_COOKIE } from "@/lib/siteAuth";

export async function POST(request: Request) {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);

  response.cookies.set({
    name: SITE_AUTH_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });

  return response;
}
