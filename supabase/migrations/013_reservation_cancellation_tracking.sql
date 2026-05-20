-- Track when and by whom a reservation was cancelled, so the panel can show
-- monthly counters of AI-driven activity.
-- cancelled_by: 'ai' (bot via WhatsApp) | 'panel' (operator) | null

ALTER TABLE public.reservations
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by text;
