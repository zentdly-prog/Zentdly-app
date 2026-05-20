-- Timestamp of the last Calendar → DB import, used to throttle how often
-- the bot pulls externally-created Google Calendar events into reservations.

ALTER TABLE public.google_config
  ADD COLUMN IF NOT EXISTS last_calendar_import_at timestamptz;
