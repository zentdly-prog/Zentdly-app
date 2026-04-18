import { NextRequest, NextResponse } from "next/server";
import postgres from "postgres";

const REGIONS = [
  "us-east-1", "us-west-1", "us-east-2", "us-west-2",
  "eu-west-1", "eu-west-2", "eu-central-1",
  "ap-southeast-1", "ap-northeast-1", "sa-east-1",
];

export async function POST(req: NextRequest) {
  const auth = req.headers.get("x-key");
  if (auth !== "zentdly-migrate-2024") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ref = "xohixwweuwcxvexbetvq";
  const pwd = "1%C3%B12%C3%B13%C3%B14%C3%B1%40%2AMb";
  const errors: Record<string, string> = {};

  for (const region of REGIONS) {
    const connStr = `postgresql://postgres.${ref}:${pwd}@aws-0-${region}.pooler.supabase.com:6543/postgres`;
    const sql = postgres(connStr, { ssl: "require", max: 1, connect_timeout: 5 });
    try {
      await sql`SELECT 1`;
      // Connected! Run migration
      await sql`create table if not exists public.google_config (
        id               uuid        primary key default gen_random_uuid(),
        tenant_id        uuid        not null references public.tenants(id) on delete cascade unique,
        service_account  jsonb,
        calendar_id      text        not null default '',
        spreadsheet_id   text        not null default '',
        sheet_name       text        not null default 'Reservas',
        calendar_enabled boolean     not null default false,
        sheets_enabled   boolean     not null default false,
        updated_at       timestamptz not null default now()
      )`;
      await sql`alter table public.google_config enable row level security`;
      await sql`do $$ begin if not exists (select 1 from pg_policies where tablename='google_config' and policyname='service role full access') then create policy "service role full access" on public.google_config using (true) with check (true); end if; end $$`;
      await sql.end();
      return NextResponse.json({ ok: true, region });
    } catch (e) {
      errors[region] = String(e).slice(0, 80);
      await sql.end().catch(() => null);
    }
  }

  return NextResponse.json({ error: "All regions failed", errors }, { status: 500 });
}

async function _unused() {
  const connStr = process.env.POSTGRES_URL!;
  const sql = postgres(connStr, { ssl: "require", max: 1 });

  try {
    await sql`
      create table if not exists public.google_config (
        id               uuid        primary key default gen_random_uuid(),
        tenant_id        uuid        not null references public.tenants(id) on delete cascade unique,
        service_account  jsonb,
        calendar_id      text        not null default '',
        spreadsheet_id   text        not null default '',
        sheet_name       text        not null default 'Reservas',
        calendar_enabled boolean     not null default false,
        sheets_enabled   boolean     not null default false,
        updated_at       timestamptz not null default now()
      )
    `;
    await sql`alter table public.google_config enable row level security`;
    await sql`
      do $$ begin
        if not exists (
          select 1 from pg_policies
          where tablename = 'google_config'
          and policyname = 'service role full access'
        ) then
          create policy "service role full access" on public.google_config
            using (true) with check (true);
        end if;
      end $$
    `;
    await sql.end();
    return NextResponse.json({ ok: true });
  } catch (e) {
    await sql.end().catch(() => null);
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
