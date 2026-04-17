-- Zentdly initial schema
-- Run in order on your Supabase project

create extension if not exists pgcrypto;

-- ─── Tenants ───────────────────────────────────────────────────────────────
create table public.tenants (
  id         uuid        primary key default gen_random_uuid(),
  name       text        not null,
  slug       text        unique not null,
  timezone   text        not null default 'America/Argentina/Buenos_Aires',
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);

-- ─── Venues ────────────────────────────────────────────────────────────────
create table public.venues (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  name       text        not null,
  address    text,
  active     boolean     not null default true,
  created_at timestamptz not null default now()
);
create index venues_tenant_idx on public.venues(tenant_id);

-- ─── Sports ────────────────────────────────────────────────────────────────
create table public.sports (
  id                       uuid    primary key default gen_random_uuid(),
  tenant_id                uuid    not null references public.tenants(id) on delete cascade,
  name                     text    not null,
  default_duration_minutes integer not null default 60,
  created_at               timestamptz not null default now()
);
create index sports_tenant_idx on public.sports(tenant_id);

-- ─── Courts ────────────────────────────────────────────────────────────────
create table public.courts (
  id         uuid    primary key default gen_random_uuid(),
  tenant_id  uuid    not null references public.tenants(id) on delete cascade,
  venue_id   uuid    not null references public.venues(id) on delete cascade,
  sport_id   uuid    not null references public.sports(id) on delete restrict,
  name       text    not null,
  capacity   integer,
  active     boolean not null default true,
  created_at timestamptz not null default now()
);
create index courts_tenant_idx on public.courts(tenant_id);
create index courts_venue_idx  on public.courts(venue_id);

-- ─── Business Hours ────────────────────────────────────────────────────────
create table public.business_hours (
  id                   uuid    primary key default gen_random_uuid(),
  tenant_id            uuid    not null references public.tenants(id) on delete cascade,
  venue_id             uuid    not null references public.venues(id) on delete cascade,
  day_of_week          integer not null check (day_of_week between 0 and 6),
  open_time            time    not null,
  close_time           time    not null,
  slot_duration_minutes integer not null default 60,
  constraint business_hours_valid_range check (close_time > open_time),
  unique (venue_id, day_of_week)
);

-- ─── Closures ──────────────────────────────────────────────────────────────
create table public.closures (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  venue_id   uuid        not null references public.venues(id) on delete cascade,
  court_id   uuid        references public.courts(id) on delete cascade,
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  reason     text,
  constraint closures_valid_range check (ends_at > starts_at)
);
create index closures_venue_idx on public.closures(venue_id, starts_at, ends_at);

-- ─── Customers ─────────────────────────────────────────────────────────────
create table public.customers (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references public.tenants(id) on delete cascade,
  name       text,
  phone_e164 text        not null,
  notes      text,
  created_at timestamptz not null default now(),
  unique (tenant_id, phone_e164)
);
create index customers_tenant_idx on public.customers(tenant_id);

-- ─── Conversations ─────────────────────────────────────────────────────────
create table public.conversations (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references public.tenants(id) on delete cascade,
  customer_id      uuid        not null references public.customers(id) on delete cascade,
  channel          text        not null default 'whatsapp',
  external_chat_id text        not null,
  status           text        not null default 'active',
  last_message_at  timestamptz not null default now(),
  unique (tenant_id, external_chat_id)
);
create index conversations_customer_idx on public.conversations(customer_id);

-- ─── Messages ──────────────────────────────────────────────────────────────
create table public.messages (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.conversations(id) on delete cascade,
  direction       text        not null check (direction in ('inbound', 'outbound')),
  content         text        not null,
  raw_payload     jsonb       not null default '{}',
  created_at      timestamptz not null default now()
);
create index messages_conversation_idx on public.messages(conversation_id, created_at);

-- ─── Reservations ──────────────────────────────────────────────────────────
create table public.reservations (
  id                    uuid        primary key default gen_random_uuid(),
  tenant_id             uuid        not null references public.tenants(id) on delete cascade,
  venue_id              uuid        not null references public.venues(id) on delete restrict,
  court_id              uuid        not null references public.courts(id) on delete restrict,
  customer_id           uuid        not null references public.customers(id) on delete restrict,
  sport_id              uuid        not null references public.sports(id) on delete restrict,
  starts_at             timestamptz not null,
  ends_at               timestamptz not null,
  status                text        not null default 'confirmed',
  source                text        not null default 'whatsapp',
  external_event_id     text,
  external_sheet_row_id text,
  notes                 text,
  created_at            timestamptz not null default now(),
  constraint reservations_valid_range check (ends_at > starts_at)
);

-- Prevents double-booking: same court, overlapping time, active status
create unique index reservations_unique_slot
  on public.reservations (court_id, starts_at, ends_at)
  where status in ('pending', 'confirmed');

create index reservations_court_time_idx on public.reservations(court_id, starts_at, ends_at);
create index reservations_tenant_idx     on public.reservations(tenant_id, starts_at);

-- ─── Reservation Audit Log ─────────────────────────────────────────────────
create table public.reservation_audit_log (
  id             uuid        primary key default gen_random_uuid(),
  reservation_id uuid        not null references public.reservations(id) on delete cascade,
  action         text        not null,
  payload        jsonb       not null default '{}',
  created_at     timestamptz not null default now()
);
create index audit_reservation_idx on public.reservation_audit_log(reservation_id);

-- ─── Integration Settings ──────────────────────────────────────────────────
create table public.integration_settings (
  id        uuid    primary key default gen_random_uuid(),
  tenant_id uuid    not null references public.tenants(id) on delete cascade,
  provider  text    not null,
  config    jsonb   not null default '{}',
  active    boolean not null default false,
  unique (tenant_id, provider)
);

-- ─── AI Sessions ───────────────────────────────────────────────────────────
create table public.ai_sessions (
  id              uuid        primary key default gen_random_uuid(),
  conversation_id uuid        not null references public.conversations(id) on delete cascade unique,
  state           jsonb       not null default '{}',
  extracted_data  jsonb,
  missing_fields  text[]      not null default '{}',
  updated_at      timestamptz not null default now()
);
