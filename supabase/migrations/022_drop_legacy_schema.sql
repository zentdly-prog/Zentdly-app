-- Removes the abandoned first-generation schema.
--
-- The live booking path works off court_types via AgentAvailabilityService.
-- The tables below belong to an earlier design (venues -> courts -> sports)
-- that nothing instantiates any more: the repositories that queried them are
-- imported only as types, by services that are themselves never constructed.
-- All of them are empty except app_settings, which has 12 rows and zero code
-- references.
--
-- reservations still carried venue_id, court_id and sport_id from that design.
-- All three are null in every one of the 94 existing rows, and they were the
-- only thing keeping these tables reachable.

alter table public.reservations
  drop column if exists venue_id,
  drop column if exists court_id,
  drop column if exists sport_id;

drop table if exists public.reservation_audit_log cascade;
drop table if exists public.closures             cascade;
drop table if exists public.business_hours       cascade;
drop table if exists public.courts               cascade;
drop table if exists public.sports               cascade;
drop table if exists public.venues               cascade;
drop table if exists public.integration_settings cascade;
drop table if exists public.app_settings         cascade;

-- ai_sessions is deliberately kept: the Meta Cloud API path still reads and
-- writes it through ConversationHandler.
