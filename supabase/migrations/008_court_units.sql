-- Physical court units and richer court descriptions.
-- court_types remains the scheduling/pricing group; court_units stores each
-- concrete court when the courts are not interchangeable.

alter table public.court_types
  add column if not exists description text,
  add column if not exists court_units jsonb not null default '[]'::jsonb;

alter table public.court_types
  drop constraint if exists court_types_court_units_array,
  add constraint court_types_court_units_array check (jsonb_typeof(court_units) = 'array');
