-- Store business owner/contact email for support handoffs
ALTER TABLE public.tenants
  ADD COLUMN IF NOT EXISTS contact_email text;

-- Index for easy querying
CREATE INDEX IF NOT EXISTS idx_tenants_contact_email
  ON public.tenants(contact_email)
  WHERE contact_email IS NOT NULL;
