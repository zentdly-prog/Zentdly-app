-- Agent operations: business policies, conversation state, handoff and logs.

create table if not exists public.tenant_bot_policies (
  id                         uuid primary key default gen_random_uuid(),
  tenant_id                  uuid not null references public.tenants(id) on delete cascade unique,
  cancellation_min_hours     integer not null default 0 check (cancellation_min_hours >= 0),
  reschedule_min_hours       integer not null default 0 check (reschedule_min_hours >= 0),
  requires_deposit           boolean not null default false,
  deposit_amount             numeric(10,2),
  deposit_percentage         integer check (deposit_percentage is null or deposit_percentage between 0 and 100),
  reservation_status_default text not null default 'confirmed' check (reservation_status_default in ('pending', 'confirmed')),
  audio_message              text not null default 'No puedo escuchar audios por acá. Escribime el día, horario y deporte y te ayudo.',
  human_handoff_message      text not null default 'Te derivo con una persona del equipo para ayudarte con eso.',
  updated_at                 timestamptz not null default now()
);

alter table public.conversations
  add column if not exists bot_paused boolean not null default false,
  add column if not exists requires_human boolean not null default false,
  add column if not exists human_reason text,
  add column if not exists agent_state jsonb not null default '{}'::jsonb;

create table if not exists public.agent_logs (
  id              uuid primary key default gen_random_uuid(),
  tenant_id       uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  customer_id     uuid references public.customers(id) on delete set null,
  event_type      text not null,
  intent          text,
  tool_name       text,
  payload         jsonb not null default '{}'::jsonb,
  error           text,
  created_at      timestamptz not null default now()
);

create index if not exists agent_logs_tenant_created_idx on public.agent_logs(tenant_id, created_at desc);
create index if not exists agent_logs_conversation_idx on public.agent_logs(conversation_id, created_at desc);

alter table public.tenant_bot_policies enable row level security;
alter table public.agent_logs enable row level security;

drop policy if exists "tenant_isolation" on public.tenant_bot_policies;
create policy "tenant_isolation" on public.tenant_bot_policies
  using (tenant_id = public.current_tenant_id());

drop policy if exists "tenant_isolation" on public.agent_logs;
create policy "tenant_isolation" on public.agent_logs
  using (tenant_id = public.current_tenant_id());
