create table if not exists public.service_cost_records (
  id text primary key,
  provider text not null,
  invoice_id text not null,
  line_id text not null,
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  category text not null check (category in ('model', 'browser', 'hosting', 'runtime', 'database', 'storage', 'email')),
  amount_usd numeric(18, 6) not null check (amount_usd >= 0),
  data jsonb not null,
  created_at timestamptz not null default now(),
  unique (provider, invoice_id, line_id)
);

-- Evidence ownership is separate from the JSON invoice row so two concurrent
-- imports cannot both claim the same measured component.
create table if not exists public.service_cost_evidence_coverage (
  evidence_id text primary key,
  service_cost_id text not null references public.service_cost_records(id) on delete cascade,
  provider text not null,
  category text not null check (category in ('model', 'browser')),
  period text not null check (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  created_at timestamptz not null default now()
);

alter table public.service_cost_evidence_coverage enable row level security;
revoke all on table public.service_cost_evidence_coverage from anon, authenticated;
grant select, insert on table public.service_cost_evidence_coverage to service_role;

insert into public.service_cost_evidence_coverage (evidence_id, service_cost_id, provider, category, period)
select covered.value, records.id, records.provider, records.category, records.period
from public.service_cost_records records
cross join lateral jsonb_array_elements_text(coalesce(records.data->'reconciles', '[]'::jsonb)) covered
where records.category in ('model', 'browser')
on conflict (evidence_id) do nothing;

create table if not exists public.service_budget_queue_reservations (
  queued_id text primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  application_id text not null,
  reservation_id text not null unique,
  month text not null check (month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  projected_usd numeric(12, 4) not null check (projected_usd > 0),
  status text not null default 'held' check (status in ('held', 'claimed', 'terminal_pending', 'released')),
  terminal_at timestamptz,
  released_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.service_budget_queue_reservations enable row level security;
revoke all on table public.service_budget_queue_reservations from anon, authenticated;
grant select, insert, update on table public.service_budget_queue_reservations to service_role;

alter table public.service_budget_reservations add column if not exists released_at timestamptz;

create or replace function public.reserve_service_budget(p_reservation_id text, p_month text, p_amount numeric, p_limit numeric)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare current_total numeric; existing_release timestamptz;
begin
  if p_amount <= 0 or p_limit <= 0 or p_month !~ '^[0-9]{4}-[0-9]{2}$' then return false; end if;
  select released_at into existing_release from public.service_budget_reservations where reservation_id = p_reservation_id;
  if found then return existing_release is null; end if;
  insert into public.service_budget(month, reserved_usd) values (p_month, 0) on conflict (month) do nothing;
  select reserved_usd into current_total from public.service_budget where month = p_month for update;
  select released_at into existing_release from public.service_budget_reservations where reservation_id = p_reservation_id;
  if found then return existing_release is null; end if;
  if current_total + p_amount > p_limit then return false; end if;
  update public.service_budget set reserved_usd = reserved_usd + p_amount where month = p_month;
  insert into public.service_budget_reservations(reservation_id, month, reserved_usd) values (p_reservation_id, p_month, p_amount);
  return true;
end;
$$;

revoke all on function public.reserve_service_budget(text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reserve_service_budget(text, text, numeric, numeric) to service_role;

create or replace function public.reserve_queued_service_budget(p_queued_id text, p_owner_id uuid, p_application_id text, p_month text, p_amount numeric, p_limit numeric)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare current_total numeric; existing public.service_budget_queue_reservations%rowtype;
begin
  if nullif(trim(p_queued_id), '') is null or p_owner_id is null or nullif(trim(p_application_id), '') is null or p_month !~ '^[0-9]{4}-[0-9]{2}$' or p_amount <= 0 or p_limit <= 0 then return null; end if;
  -- A missing row cannot be locked with SELECT FOR UPDATE. Serialize all
  -- first reservations for the stable queued identity before rechecking it.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_queued_id, 0));
  select * into existing from public.service_budget_queue_reservations where queued_id = p_queued_id for update;
  if found then
    if existing.owner_id <> p_owner_id or existing.application_id <> p_application_id then raise exception 'queued reservation owner mismatch'; end if;
    if existing.status <> 'held' then return null; end if;
    return jsonb_build_object('queuedId', existing.queued_id, 'reservationId', existing.reservation_id, 'month', existing.month, 'ownerId', existing.owner_id, 'applicationId', existing.application_id, 'projectedUsd', existing.projected_usd);
  end if;
  insert into public.service_budget(month, reserved_usd) values (p_month, 0) on conflict (month) do nothing;
  select reserved_usd into current_total from public.service_budget where month = p_month for update;
  if current_total + p_amount > p_limit then return null; end if;
  insert into public.service_budget_reservations(reservation_id, month, reserved_usd) values ('queued:' || p_queued_id, p_month, p_amount);
  insert into public.service_budget_queue_reservations(queued_id, owner_id, application_id, reservation_id, month, projected_usd)
    values (p_queued_id, p_owner_id, p_application_id, 'queued:' || p_queued_id, p_month, p_amount);
  update public.service_budget set reserved_usd = reserved_usd + p_amount where month = p_month;
  return jsonb_build_object('queuedId', p_queued_id, 'reservationId', 'queued:' || p_queued_id, 'month', p_month, 'ownerId', p_owner_id, 'applicationId', p_application_id, 'projectedUsd', p_amount);
end;
$$;

revoke all on function public.reserve_queued_service_budget(text, uuid, text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reserve_queued_service_budget(text, uuid, text, text, numeric, numeric) to service_role;

create or replace function public.claim_queued_service_budget(p_queued_id text, p_owner_id uuid, p_application_id text)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  update public.service_budget_queue_reservations set status = 'claimed'
    where queued_id = p_queued_id and owner_id = p_owner_id and application_id = p_application_id and status = 'held';
  return found;
end;
$$;
revoke all on function public.claim_queued_service_budget(text, uuid, text) from public, anon, authenticated;
grant execute on function public.claim_queued_service_budget(text, uuid, text) to service_role;

create or replace function public.mark_queued_service_budget_terminal(p_queued_id text, p_owner_id uuid, p_application_id text, p_month text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare reservation public.service_budget_queue_reservations%rowtype; state jsonb; application jsonb;
begin
  select * into reservation from public.service_budget_queue_reservations
    where queued_id = p_queued_id and owner_id = p_owner_id and application_id = p_application_id and month = p_month
    for update;
  if not found or reservation.status <> 'held' then return false; end if;
  select data into state from public.app_states where user_id = p_owner_id for update;
  select item into application from jsonb_array_elements(coalesce(state->'applications', '[]'::jsonb)) item
    where item->>'id' = p_application_id;
  if application is null
    or (application->'budgetReservation'->>'reservationId') is distinct from ('queued:' || p_queued_id)
    or (application->'budgetReservation'->>'status') is distinct from 'release_pending'
    or (application->'budgetReservation'->>'month') is distinct from p_month
    or (application->'budgetReservation'->>'ownerId') is distinct from p_owner_id::text
    or (application->'budgetReservation'->>'applicationId') is distinct from p_application_id
    or (application ? 'userId' and application->>'userId' is distinct from p_owner_id::text)
    or coalesce(jsonb_typeof(application->'queuedRun'), '') = 'object'
    or (application->>'runToken') is not distinct from p_queued_id then return false;
  end if;
  update public.service_budget_queue_reservations set status = 'terminal_pending', terminal_at = now() where queued_id = p_queued_id;
  return true;
end;
$$;
revoke all on function public.mark_queued_service_budget_terminal(text, uuid, text, text) from public, anon, authenticated;
grant execute on function public.mark_queued_service_budget_terminal(text, uuid, text, text) to service_role;

create or replace function public.release_queued_service_budget(p_queued_id text, p_owner_id uuid, p_application_id text, p_month text, p_terminal_token text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare held numeric; state text; reservation text := 'queued:' || p_queued_id;
    app_state jsonb; application jsonb;
begin
  if p_terminal_token is null or p_terminal_token <> p_queued_id then raise exception 'terminal compensation proof does not match queued identity'; end if;
  select status into state from public.service_budget_queue_reservations where queued_id = p_queued_id and owner_id = p_owner_id and application_id = p_application_id and month = p_month for update;
  if not found or state = 'claimed' or state = 'held' then return false; end if;
  if state = 'released' then return true; end if;
  select data into app_state from public.app_states where user_id = p_owner_id for update;
  select item into application from jsonb_array_elements(coalesce(app_state->'applications', '[]'::jsonb)) item
    where item->>'id' = p_application_id;
  if application is null
    or (application->'budgetReservation'->>'reservationId') is distinct from ('queued:' || p_queued_id)
    or (application->'budgetReservation'->>'status') is distinct from 'release_pending'
    or (application->'budgetReservation'->>'month') is distinct from p_month
    or (application->'budgetReservation'->>'ownerId') is distinct from p_owner_id::text
    or (application->'budgetReservation'->>'applicationId') is distinct from p_application_id
    or (application ? 'userId' and application->>'userId' is distinct from p_owner_id::text)
    or coalesce(jsonb_typeof(application->'queuedRun'), '') = 'object'
    or (application->>'runToken') is not distinct from p_queued_id then return false;
  end if;
  update public.service_budget_reservations set released_at = now()
    where reservation_id = reservation and month = p_month and released_at is null
    returning reserved_usd into held;
  if held is null then return false; end if;
  update public.service_budget set reserved_usd = greatest(0, reserved_usd - held) where month = p_month;
  update public.service_budget_queue_reservations set status = 'released', released_at = now() where queued_id = p_queued_id;
  return true;
end;
$$;
revoke all on function public.release_queued_service_budget(text, uuid, text, text, text) from public, anon, authenticated;
grant execute on function public.release_queued_service_budget(text, uuid, text, text, text) to service_role;

alter table public.service_cost_records enable row level security;
revoke all on table public.service_cost_records from anon, authenticated;
grant select, insert on table public.service_cost_records to service_role;

create or replace function public.record_service_cost(p_record jsonb)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  record_id text := p_record->>'id';
  saved jsonb;
  covered text;
  covered_exists boolean;
  coverage_count integer;
begin
  -- Serialize replay deliveries before the immutable-row lookup. This keeps
  -- same-ID retries idempotent even when both transactions start together.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(coalesce(record_id, ''), 0));
  select data into saved from public.service_cost_records where id = record_id;
  if found then return saved; end if;
  if record_id is null or nullif(trim(p_record->>'provider'), '') is null or nullif(trim(p_record->>'invoiceId'), '') is null or nullif(trim(p_record->>'lineId'), '') is null
    or p_record->>'currency' <> 'USD' or p_record->>'period' !~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
    or p_record->>'category' not in ('model', 'browser', 'hosting', 'runtime', 'database', 'storage', 'email')
    or p_record->>'amountUsd' is null or (p_record->>'amountUsd')::numeric < 0
    or p_record->>'importedAt' is null or jsonb_typeof(p_record->'allocations') <> 'array' or jsonb_typeof(p_record->'reconciles') <> 'array' then
    raise exception 'invalid service cost record';
  end if;
  if p_record->>'allocationMethod' not in ('none', 'direct-owner', 'equal-active-users', 'confirmed-submissions') then raise exception 'invalid allocation method'; end if;
  if p_record->>'allocationMethod' = 'none' and jsonb_array_length(p_record->'allocations') <> 0 then raise exception 'unallocated line cannot have owner allocations'; end if;
  if p_record->>'category' not in ('model', 'browser') and jsonb_array_length(p_record->'reconciles') <> 0 then raise exception 'fixed service costs cannot reconcile usage evidence'; end if;
  if jsonb_array_length(p_record->'reconciles') <> (select count(distinct value) from jsonb_array_elements_text(p_record->'reconciles') values(value)) then raise exception 'reconciliation evidence identities must be unique'; end if;
  if p_record->>'allocationMethod' <> 'none' and abs((select coalesce(sum((allocation->>'amountUsd')::numeric), 0) from jsonb_array_elements(p_record->'allocations') allocation) - (p_record->>'amountUsd')::numeric) > 0.000001 then raise exception 'owner allocations must equal amount'; end if;
  for covered in select jsonb_array_elements_text(p_record->'reconciles') loop
    if p_record->>'category' = 'model' then
      select exists(
        with canonical as (
          select distinct on (coalesce(nullif(data->>'responseId', ''), 'id:' || (data->>'id'))) data
          from public.model_usage_records
          -- The first delivery owns the stable identity and billing month;
          -- report completeness is merged by the read-side canonicalizer.
          order by coalesce(nullif(data->>'responseId', ''), 'id:' || (data->>'id')), data->>'startedAt' asc, data->>'id' asc
        )
        select 1 from canonical
        where data->>'id' = covered and data->>'provider' = p_record->>'provider' and left(data->>'startedAt', 7) = p_record->>'period'
          and exists(select 1 from jsonb_array_elements(p_record->'allocations') allocation where allocation->>'userId' = data->>'userId')
      ) into covered_exists;
    elsif p_record->>'category' = 'browser' then
      select exists(
        with candidates as (
          select data,
            case when data->>'sessionId' is null then left(data->>'occurredAt', 7)
            else left(coalesce(
              (select min(started.data->'report'->>'startedAt') from public.browser_usage_records started where started.data->>'provider' = data->>'provider' and started.data->>'sessionId' = data->>'sessionId' and started.data->'report'->>'startedAt' is not null),
              (select min(events.data->>'occurredAt') from public.browser_usage_records events where events.data->>'provider' = data->>'provider' and events.data->>'sessionId' = data->>'sessionId')
            ), 7) end as canonical_period
          from public.browser_usage_records
        )
        select 1 from candidates
        where data->>'provider' = p_record->>'provider' and (
          (data->>'sessionId' is not null and (('browser:' || (data->>'provider') || ':' || (data->>'sessionId') || ':browser') = covered or ('browser:' || (data->>'provider') || ':' || (data->>'sessionId') || ':proxy') = covered))
          or (data->>'sessionId' is null and (('browser:event:' || (data->>'id')) = covered or ('browser:event:' || (data->>'id') || ':proxy') = covered))
        ) and canonical_period = p_record->>'period'
          and exists(select 1 from jsonb_array_elements(p_record->'allocations') allocation where allocation->>'userId' = data->>'userId')
      ) into covered_exists;
    end if;
    if not covered_exists then raise exception 'reconciliation evidence is missing or does not match provider and period'; end if;
  end loop;
  insert into public.service_cost_records (id, provider, invoice_id, line_id, period, category, amount_usd, data)
  values (record_id, p_record->>'provider', p_record->>'invoiceId', p_record->>'lineId', p_record->>'period', p_record->>'category', (p_record->>'amountUsd')::numeric, p_record)
  on conflict (id) do nothing;
  if p_record->>'category' in ('model', 'browser') then
    insert into public.service_cost_evidence_coverage (evidence_id, service_cost_id, provider, category, period)
    select covered.value, record_id, p_record->>'provider', p_record->>'category', p_record->>'period'
    from jsonb_array_elements_text(p_record->'reconciles') covered;
    get diagnostics coverage_count = row_count;
    if coverage_count <> jsonb_array_length(p_record->'reconciles') then raise exception 'an evidence identity is already reconciled'; end if;
  end if;
  select data into saved from public.service_cost_records where id = record_id;
  return saved;
end;
$$;

revoke all on function public.record_service_cost(jsonb) from public, anon, authenticated;
grant execute on function public.record_service_cost(jsonb) to service_role;
