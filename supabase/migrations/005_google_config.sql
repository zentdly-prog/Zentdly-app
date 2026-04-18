-- Google integration config per tenant
create table public.google_config (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade unique,
  service_account  jsonb,
  calendar_id      text        not null default '',
  spreadsheet_id   text        not null default '',
  sheet_name       text        not null default 'Reservas',
  calendar_enabled boolean     not null default false,
  sheets_enabled   boolean     not null default false,
  updated_at       timestamptz not null default now()
);

alter table public.google_config enable row level security;
create policy "service role full access" on public.google_config
  using (true) with check (true);
