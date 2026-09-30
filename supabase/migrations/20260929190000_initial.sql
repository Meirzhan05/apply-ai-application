create table if not exists public.jobs (
  id text primary key,
  source text not null,
  source_id text not null,
  active boolean not null default true,
  discovered_at timestamptz not null default now(),
  data jsonb not null
);

create index if not exists jobs_active_discovered_idx on public.jobs (active, discovered_at desc);

create table if not exists public.app_states (
  user_id uuid primary key references auth.users(id) on delete cascade,
  revision bigint not null default 1,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

alter table public.jobs enable row level security;
alter table public.app_states enable row level security;

grant select on public.jobs to authenticated;
revoke all on public.app_states from anon, authenticated;

create policy "Authenticated users can read active jobs" on public.jobs
  for select to authenticated using (active = true);

create policy "Users can read their own state" on public.app_states
  for select to authenticated using ((select auth.uid()) = user_id);

create policy "Users can insert their own state" on public.app_states
  for insert to authenticated with check ((select auth.uid()) = user_id);

create policy "Users can update their own state" on public.app_states
  for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Users can delete their own state" on public.app_states
  for delete to authenticated using ((select auth.uid()) = user_id);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('resumes', 'resumes', false, 5242880, array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'])
on conflict (id) do nothing;

create policy "Users can upload their own resumes" on storage.objects
  for insert to authenticated with check (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users can read their own resumes" on storage.objects
  for select to authenticated using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy "Users can delete their own resumes" on storage.objects
  for delete to authenticated using (bucket_id = 'resumes' and (storage.foldername(name))[1] = (select auth.uid())::text);

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('form-shots', 'form-shots', false, 10485760, array['image/png'])
on conflict (id) do nothing;

create table if not exists public.service_budget (
  month text primary key,
  reserved_usd numeric(12, 4) not null default 0
);
create table if not exists public.service_budget_reservations (
  reservation_id text primary key,
  month text not null references public.service_budget(month),
  reserved_usd numeric(12, 4) not null,
  created_at timestamptz not null default now()
);
alter table public.service_budget enable row level security;
alter table public.service_budget_reservations enable row level security;
revoke all on public.service_budget, public.service_budget_reservations from anon, authenticated;

create or replace function public.reserve_service_budget(p_reservation_id text, p_month text, p_amount numeric, p_limit numeric)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare current_total numeric;
begin
  if p_amount <= 0 or p_limit <= 0 or p_month !~ '^[0-9]{4}-[0-9]{2}$' then return false; end if;
  if exists (select 1 from public.service_budget_reservations where reservation_id = p_reservation_id) then return true; end if;
  insert into public.service_budget(month, reserved_usd) values (p_month, 0) on conflict (month) do nothing;
  select reserved_usd into current_total from public.service_budget where month = p_month for update;
  if exists (select 1 from public.service_budget_reservations where reservation_id = p_reservation_id) then return true; end if;
  if current_total + p_amount > p_limit then return false; end if;
  update public.service_budget set reserved_usd = reserved_usd + p_amount where month = p_month;
  insert into public.service_budget_reservations(reservation_id, month, reserved_usd) values (p_reservation_id, p_month, p_amount)
  on conflict (reservation_id) do nothing;
  return true;
end;
$$;
revoke all on function public.reserve_service_budget(text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reserve_service_budget(text, text, numeric, numeric) to service_role;
