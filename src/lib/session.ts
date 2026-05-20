import { cookies } from "next/headers";
import { SITE_AUTH_COOKIE, verifySiteAuthSession, type SiteSession } from "@/lib/siteAuth";

export async function getSession(): Promise<SiteSession> {
  const store = await cookies();
  const token = store.get(SITE_AUTH_COOKIE)?.value;
  return verifySiteAuthSession(token);
}
