-- Data retention: keep the database small automatically.
--
-- agent_logs is pure telemetry (one row per inbound message, tool call, error).
-- It has no business value once an issue is past, so it expires quickly.
-- messages is customer conversation history — business data — so it gets a
-- much longer window and is only trimmed to stop unbounded growth.
--
-- Windows are centralised here so they can be changed in one place.

create extension if not exists pg_cron;

create or replace function public.purge_old_data()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  agent_logs_days constant int := 30;
  messages_days   constant int := 180;
begin
  delete from public.agent_logs
  where created_at < now() - (agent_logs_days || ' days')::interval;

  -- Never delete a conversation's most recent messages: the agent reads the
  -- last 30 for context, so trimming those would make the bot forget an
  -- active chat. Only rows outside the window AND outside that tail go.
  delete from public.messages m
  where m.created_at < now() - (messages_days || ' days')::interval
    and m.id not in (
      select id from (
        select id,
               row_number() over (partition by conversation_id order by created_at desc) as rn
        from public.messages
      ) ranked
      where ranked.rn <= 30
    );
end;
$$;

comment on function public.purge_old_data is
  'Deletes agent_logs older than 30d and messages older than 180d (keeping each conversation''s last 30 messages). Scheduled nightly via pg_cron.';

-- Re-schedulable: drop an existing job with the same name before creating it.
do $$
begin
  perform cron.unschedule('purge-old-data');
exception
  when others then null; -- job did not exist yet
end;
$$;

select cron.schedule(
  'purge-old-data',
  '15 4 * * *', -- 04:15 UTC daily (~01:15 Argentina), off-peak
  $$select public.purge_old_data();$$
);
