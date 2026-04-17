-- Row Level Security policies for multi-tenant isolation
-- All backend access uses the service_role key which bypasses RLS.
-- These policies protect against accidental client-side cross-tenant leaks.

alter table public.tenants             enable row level security;
alter table public.venues              enable row level security;
alter table public.sports              enable row level security;
alter table public.courts              enable row level security;
alter table public.business_hours      enable row level security;
alter table public.closures            enable row level security;
alter table public.customers           enable row level security;
alter table public.conversations       enable row level security;
alter table public.messages            enable row level security;
alter table public.reservations        enable row level security;
alter table public.reservation_audit_log enable row level security;
alter table public.integration_settings enable row level security;
alter table public.ai_sessions         enable row level security;

-- Helper: extract tenant_id from JWT claim set by app
create or replace function public.current_tenant_id()
returns uuid language sql stable as $$
  select nullif(current_setting('app.tenant_id', true), '')::uuid;
$$;

-- Generic tenant-scoped policy template applied to all multi-tenant tables
do $$
declare
  tbl text;
begin
  foreach tbl in array array[
    'venues','sports','courts','business_hours','closures',
    'customers','conversations','reservations','integration_settings'
  ] loop
    execute format(
      'create policy "tenant_isolation" on public.%I
       using (tenant_id = public.current_tenant_id())', tbl
    );
  end loop;
end $$;

-- messages: via conversation
create policy "tenant_isolation" on public.messages
  using (
    conversation_id in (
      select id from public.conversations
      where tenant_id = public.current_tenant_id()
    )
  );

-- audit_log: via reservation
create policy "tenant_isolation" on public.reservation_audit_log
  using (
    reservation_id in (
      select id from public.reservations
      where tenant_id = public.current_tenant_id()
    )
  );

-- ai_sessions: via conversation
create policy "tenant_isolation" on public.ai_sessions
  using (
    conversation_id in (
      select id from public.conversations
      where tenant_id = public.current_tenant_id()
    )
  );

-- tenants: each tenant can only see itself
create policy "tenant_isolation" on public.tenants
  using (id = public.current_tenant_id());
