-- Panel users with roles. The env SITE_AUTH_USERNAME/PASSWORD remains the
-- bootstrap super-admin; additional users (typically "lite" operators) live
-- here. Accessed only via the service role from server actions.

CREATE TABLE IF NOT EXISTS public.panel_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username      text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  salt          text NOT NULL,
  role          text NOT NULL DEFAULT 'lite' CHECK (role IN ('admin', 'lite')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.panel_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role full access" ON public.panel_users;
CREATE POLICY "service role full access" ON public.panel_users
  USING (true) WITH CHECK (true);
