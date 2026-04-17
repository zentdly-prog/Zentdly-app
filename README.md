# Zentdly

WhatsApp automation for sports court reservations. Customers book courts by chatting; Zentdly handles intent detection, availability validation, reservation creation, and sync to Google Calendar or Sheets.

## Stack

| Layer | Tech |
|---|---|
| Frontend / API | Next.js 15, TypeScript, Tailwind CSS |
| Database | Supabase (PostgreSQL + RLS) |
| AI | OpenAI `gpt-4o-mini` (intent extraction only) |
| Messaging | Meta WhatsApp Cloud API |
| Integrations | Google Sheets, Google Calendar |
| Deploy | Vercel (web) + Supabase (DB) |

## Project structure

```
src/
  app/                   Next.js App Router
    (admin)/             Admin panel pages
    api/
      availability/      GET available slots
      reservations/      CRUD reservations
      webhooks/
        whatsapp/        Meta Cloud API webhook
  domain/
    booking/             Availability engine + reservation service
    conversation/        Conversation state machine
  infrastructure/
    supabase/            DB clients (public + server)
    repositories/        Data access layer
  integrations/
    ai/                  OpenAI intent extractor + Zod schemas
    google/              Sheets + Calendar providers + orchestrator
    whatsapp/            Sender, types, message orchestrator
  lib/
    errors/              Typed error classes
    utils/               Date/timezone helpers
  types/                 Shared TypeScript types
supabase/
  migrations/            SQL migrations (run in order)
  seed.sql               Demo data for local dev
```

## Quick start

### 1. Clone and install

```bash
git clone https://github.com/your-org/zentdly.git
cd zentdly
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env.local
# Fill in all values in .env.local
```

### 3. Set up Supabase

1. Create a project at [supabase.com](https://supabase.com)
2. Run migrations in the SQL editor in order:
   - `supabase/migrations/001_initial_schema.sql`
   - `supabase/migrations/002_rls.sql`
3. Optionally run `supabase/seed.sql` for local demo data.

### 4. Run dev server

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) — redirects to `/dashboard`.

## WhatsApp setup (Meta Cloud API)

1. Create a Meta App at [developers.facebook.com](https://developers.facebook.com)
2. Add the **WhatsApp** product
3. Set your webhook URL to `https://your-domain.com/api/webhooks/whatsapp`
4. Set `hub.verify_token` to match `WHATSAPP_VERIFY_TOKEN` in your env
5. Subscribe to the `messages` webhook field

## API reference

### `GET /api/availability`

| Param | Required | Description |
|---|---|---|
| `tenant_id` | ✓ | UUID |
| `venue_id` | ✓ | UUID |
| `date` | ✓ | `YYYY-MM-DD` in tenant timezone |
| `sport_id` | — | Filter by sport |
| `duration_minutes` | — | Override slot duration |
| `timezone` | — | Default: `America/Argentina/Buenos_Aires` |

### `POST /api/reservations`

```json
{
  "tenant_id": "uuid",
  "venue_id": "uuid",
  "court_id": "uuid",
  "sport_id": "uuid",
  "customer_phone": "+5491112345678",
  "customer_name": "Juan García",
  "date": "2026-04-20",
  "time": "20:00",
  "duration_minutes": 60,
  "source": "panel"
}
```

### `DELETE /api/reservations/:id`

Cancel. Optional body: `{ "reason": "string" }`.

### `PATCH /api/reservations/:id`

Reschedule. Body: `{ "date", "time", "duration_minutes", "timezone" }`.

## Business rules

- No double-booking enforced at DB level (partial unique index) + service layer.
- The AI extracts intent and data only — booking service owns the decision.
- All times stored in UTC, displayed in tenant timezone.
- Google integrations are idempotent and non-blocking.
- Multi-tenant: every row scoped to `tenant_id`; Supabase RLS enforces isolation.

## Roadmap

- [x] Phase 1 — Base: schema, domain services, AI module, WhatsApp webhook, Google integrations, API routes, admin shell
- [ ] Phase 2 — Court/schedule CRUD in admin panel (server actions)
- [ ] Phase 3 — Full WhatsApp conversation flow with court resolver
- [ ] Phase 4 — Google Sheets auto-setup + Calendar OAuth flow
- [ ] Phase 5 — Dashboard metrics, audit log viewer
