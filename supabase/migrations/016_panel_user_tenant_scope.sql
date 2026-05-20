-- Scope a panel user to a single tenant. Lite operators belong to one
-- business; admins keep tenant_id NULL (access to all).

ALTER TABLE public.panel_users
  ADD COLUMN IF NOT EXISTS tenant_id uuid REFERENCES public.tenants(id) ON DELETE CASCADE;
