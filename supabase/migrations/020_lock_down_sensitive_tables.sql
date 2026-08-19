-- Security fix: three tables were readable with the public anon key.
--
-- The anon key ships inside the browser bundle, so anything it can read is
-- effectively public. With it, anyone could fetch:
--   * panel_users    -> username, password_hash and salt of every panel login
--   * google_config  -> the Google service account credentials
--   * app_settings   -> arbitrary configuration values
--
-- panel_users and app_settings had no row level security at all. google_config
-- had RLS enabled but its policy was `using (true)`, which despite the name
-- "service role full access" grants access to every role, anon included.
--
-- All three are only ever touched server-side through the service role key,
-- and that key bypasses RLS entirely. So the correct configuration is RLS on
-- with no policy: every other role is denied, the server keeps working.

alter table public.panel_users  enable row level security;
alter table public.app_settings enable row level security;

drop policy if exists "service role full access" on public.google_config;

-- Force RLS so the tables' owner is subject to it as well.
alter table public.panel_users   force row level security;
alter table public.app_settings  force row level security;
alter table public.google_config force row level security;

-- Same hole, narrower blast radius: whatsapp_config holds the Evolution API
-- key and court_types is business data. Their tenant_isolation policies rely on
-- current_tenant_id(), which is null for anon, so they already denied reads —
-- forcing RLS keeps that true even for the table owner.
alter table public.whatsapp_config force row level security;
alter table public.tenant_bot_policies force row level security;
