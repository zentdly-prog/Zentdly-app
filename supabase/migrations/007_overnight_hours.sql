-- Allow overnight hours (e.g. 08:00 to 03:00 next day)
-- Previous constraint required close_time > open_time, blocking cross-midnight schedules.
alter table public.court_types drop constraint if exists court_types_valid_hours;
