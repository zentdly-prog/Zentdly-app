-- Deposit receipts are now reviewed by a person, not by the bot.
--
-- Until now the agent looked at the image and confirmed the reservation on its
-- own. Money is involved, so a human at the business has to be the one who
-- decides: the bot records that a receipt arrived and emails it over, and the
-- reservation stays `pending` until somebody validates it from the panel.

alter table public.reservations
  add column if not exists deposit_receipt_at   timestamptz,
  add column if not exists deposit_receipt_note text,
  add column if not exists deposit_reviewed_at  timestamptz,
  add column if not exists deposit_reviewed_by  text;

comment on column public.reservations.deposit_receipt_at is
  'When the customer sent a payment receipt over WhatsApp. Null means none received.';
comment on column public.reservations.deposit_receipt_note is
  'What the agent read off the receipt (amount, bank, operation), to help the reviewer.';
comment on column public.reservations.deposit_reviewed_at is
  'When a person accepted or rejected the receipt from the panel.';
comment on column public.reservations.deposit_reviewed_by is
  'Panel username that reviewed the receipt.';

-- Reservations waiting on a human are the ones the panel surfaces first.
create index if not exists reservations_awaiting_review_idx
  on public.reservations (tenant_id, deposit_receipt_at)
  where deposit_receipt_at is not null and deposit_reviewed_at is null;
