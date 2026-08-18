-- Reservation lifecycle: close out reservations whose slot has already passed.
--
-- Until now nothing ever moved a reservation past `confirmed`, so the calendar
-- showed months of finished bookings as if they were still upcoming and the
-- "realizada" (blue) state was unreachable.
--
-- Only `confirmed` becomes `completed`. A `pending` reservation whose slot
-- passed never received its deposit, so calling it "completed" would claim a
-- match happened that nobody paid for — those are left alone deliberately.

create or replace function public.complete_past_reservations()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  affected integer;
begin
  update public.reservations
     set status = 'completed'
   where status = 'confirmed'
     and ends_at < now();

  get diagnostics affected = row_count;
  return affected;
end;
$$;

comment on function public.complete_past_reservations is
  'Marks confirmed reservations whose end time has passed as completed. Scheduled hourly via pg_cron.';

-- Align the stored default with how the agent actually behaves: when a business
-- requires a deposit, new reservations are created as `pending` and only become
-- `confirmed` once the deposit is confirmed. Leaving these rows on 'confirmed'
-- made the configuration read as if deposits were ignored.
update public.tenant_bot_policies
   set reservation_status_default = 'pending'
 where requires_deposit = true
   and reservation_status_default <> 'pending';

-- Backfill: close out everything already in the past.
select public.complete_past_reservations();

do $$
begin
  perform cron.unschedule('complete-past-reservations');
exception
  when others then null; -- job did not exist yet
end;
$$;

select cron.schedule(
  'complete-past-reservations',
  '5 * * * *', -- hourly, at minute 5
  $$select public.complete_past_reservations();$$
);
