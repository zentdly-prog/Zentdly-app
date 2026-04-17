import { createClient } from "@supabase/supabase-js";

/**
 * Server-only client using service role key.
 * Never import this in client-side code.
 */
export function createServerClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    throw new Error("Missing Supabase server environment variables");
  }

  return createClient(url, key, {
    auth: { persistSession: false },
  });
}
