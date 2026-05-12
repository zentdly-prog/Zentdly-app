-- Per-court structured info that the bot exposes to customers.
-- Today the free-form `description` column captures some of this, but
-- separating equipment rental and rain policy lets the operator fill
-- only what applies and lets the bot answer cleanly when asked.

ALTER TABLE public.court_types
  ADD COLUMN IF NOT EXISTS equipment_rental text,
  ADD COLUMN IF NOT EXISTS rain_policy text;
