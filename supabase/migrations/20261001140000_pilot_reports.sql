-- Immutable service-owned captures of the invited autonomy pilot gate.
-- The application state remains the source of per-owner attempts/events; this
-- table is only the durable report snapshot and its input identity.
create table if not exists public.pilot_reports (
  id text primary key,
  owner_id text,
  created_by text not null,
  created_at timestamptz not null default now(),
  cutoff_at timestamptz not null,
  gate_version text not null,
  status text not null check (status in ('insufficient-real-evidence', 'review-incomplete', 'failed', 'passed')),
  snapshot_hash text not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object')
);

create index if not exists pilot_reports_owner_created_idx
  on public.pilot_reports (owner_id, created_at desc, id desc);
create index if not exists pilot_reports_created_idx
  on public.pilot_reports (created_at desc, id desc);

alter table public.pilot_reports enable row level security;
revoke all on public.pilot_reports from public, anon, authenticated;
grant select, insert on public.pilot_reports to service_role;

create or replace function public.prevent_pilot_report_mutation()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'pilot reports are immutable';
end;
$$;

drop trigger if exists pilot_reports_immutable on public.pilot_reports;
create trigger pilot_reports_immutable
before update or delete on public.pilot_reports
for each row execute function public.prevent_pilot_report_mutation();

revoke all on function public.prevent_pilot_report_mutation() from public, anon, authenticated;
grant execute on function public.prevent_pilot_report_mutation() to service_role;
