-- panel_users stayed readable by anon after enabling RLS, so the exposure came
-- from a table-level GRANT rather than a policy: PostgREST reaches the table as
-- the anon role, and a grant is what lets it in before policies are consulted.
--
-- Revoking the privilege is the definitive fix and does not depend on getting a
-- policy right. The service role is unaffected: it bypasses both grants applied
-- to anon/authenticated and RLS.

do $$
declare pol record;
begin
  for pol in select policyname from pg_policies
             where schemaname = 'public' and tablename = 'panel_users'
  loop
    execute format('drop policy if exists %I on public.panel_users', pol.policyname);
  end loop;
end $$;

revoke all on public.panel_users   from anon, authenticated;
revoke all on public.app_settings  from anon, authenticated;
revoke all on public.google_config from anon, authenticated;

-- Same treatment for the tables holding integration secrets and business data.
revoke all on public.whatsapp_config      from anon, authenticated;
revoke all on public.tenant_bot_policies  from anon, authenticated;
revoke all on public.agent_logs           from anon, authenticated;

alter table public.panel_users enable row level security;
alter table public.panel_users force row level security;
