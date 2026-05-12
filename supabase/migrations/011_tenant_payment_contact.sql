-- Extra public + payment fields for the tenant. The bot uses these to give
-- transfer instructions when asking for the deposit, and to answer common
-- questions about address, social media and contact email.

ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS bank_alias text,
  ADD COLUMN IF NOT EXISTS bank_holder_name text,
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS maps_url text,
  ADD COLUMN IF NOT EXISTS instagram text,
  ADD COLUMN IF NOT EXISTS website text,
  ADD COLUMN IF NOT EXISTS contact_email text;
