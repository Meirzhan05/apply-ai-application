-- Per-account lifecycle coordination. The lock is deliberately durable until
-- auth.users is deleted; leases admit work only while no deletion is pending.
create table public.account_deletion_locks (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now()
);

create table public.account_operation_leases (
  lease_id uuid primary key,
  owner_id uuid not null references auth.users(id) on delete cascade,
  operation text not null,
  reference text,
  acquired_at timestamptz not null default now()
);

create index account_operation_leases_owner_idx
  on public.account_operation_leases(owner_id, acquired_at);

alter table public.account_deletion_locks enable row level security;
alter table public.account_operation_leases enable row level security;
revoke all on public.account_deletion_locks, public.account_operation_leases from public, anon, authenticated;
grant select on public.account_deletion_locks, public.account_operation_leases to service_role;

create or replace function public.begin_account_deletion(p_owner_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_owner_id is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  if not exists (select 1 from auth.users where id = p_owner_id) then return false; end if;
  insert into public.account_deletion_locks(owner_id) values (p_owner_id)
  on conflict (owner_id) do nothing;
  return true;
end;
$$;
revoke all on function public.begin_account_deletion(uuid) from public, anon, authenticated;
grant execute on function public.begin_account_deletion(uuid) to service_role;

create or replace function public.acquire_account_operation(
  p_owner_id uuid,
  p_lease_id uuid,
  p_operation text,
  p_reference text default null
)
returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  if p_owner_id is null or p_lease_id is null or nullif(trim(p_operation), '') is null then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  if not exists (select 1 from auth.users where id = p_owner_id)
    or exists (select 1 from public.account_deletion_locks where owner_id = p_owner_id) then
    return false;
  end if;
  insert into public.account_operation_leases(lease_id, owner_id, operation, reference)
  values (p_lease_id, p_owner_id, left(p_operation, 40), left(p_reference, 160));
  return true;
end;
$$;
revoke all on function public.acquire_account_operation(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.acquire_account_operation(uuid, uuid, text, text) to service_role;

create or replace function public.release_account_operation(p_lease_id uuid)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare removed integer;
begin
  delete from public.account_operation_leases where lease_id = p_lease_id;
  get diagnostics removed = row_count;
  return removed = 1;
end;
$$;
revoke all on function public.release_account_operation(uuid) from public, anon, authenticated;
grant execute on function public.release_account_operation(uuid) to service_role;

-- Application state uses a CAS write inside the same advisory-lock domain as
-- deletion admission. A stale worker can neither race the tombstone nor
-- recreate a row after account cleanup has started.
create or replace function public.save_account_state(
  p_owner_id uuid,
  p_expected_revision bigint,
  p_data jsonb
)
returns bigint
language plpgsql security definer set search_path = '' as $$
declare saved_revision bigint;
begin
  if p_owner_id is null or p_data is null then raise exception 'invalid account state'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  if exists (select 1 from public.account_deletion_locks where owner_id = p_owner_id)
    or not exists (select 1 from auth.users where id = p_owner_id) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;
  if p_expected_revision is null then
    insert into public.app_states(user_id, data, revision, updated_at)
    values (p_owner_id, p_data, 1, now())
    on conflict (user_id) do nothing
    returning revision into saved_revision;
  else
    update public.app_states
    set data = p_data, revision = revision + 1, updated_at = now()
    where user_id = p_owner_id and revision = p_expected_revision
    returning revision into saved_revision;
  end if;
  return saved_revision;
end;
$$;
revoke all on function public.save_account_state(uuid, bigint, jsonb) from public, anon, authenticated;
grant execute on function public.save_account_state(uuid, bigint, jsonb) to service_role;

-- Supabase Storage writes are fenced at the database boundary. Acquiring the
-- same transaction advisory lock means an upload admitted before deletion
-- commits before the lock is set; later uploads see the lock and fail.
create or replace function public.prevent_owner_storage_write_during_deletion()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner_prefix text; owner_uuid uuid;
begin
  if new.bucket_id not in ('resumes', 'application-files', 'form-shots') then return new; end if;
  owner_prefix := split_part(new.name, '/', 1);
  if owner_prefix !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return new; end if;
  owner_uuid := owner_prefix::uuid;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_uuid::text, 0));
  if exists (select 1 from public.account_deletion_locks where owner_id = owner_uuid)
    or not exists (select 1 from auth.users where id = owner_uuid) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;
  return new;
end;
$$;
revoke all on function public.prevent_owner_storage_write_during_deletion() from public, anon, authenticated;
drop trigger if exists prevent_owner_storage_write_during_deletion on storage.objects;
create trigger prevent_owner_storage_write_during_deletion
before insert or update of bucket_id, name on storage.objects
for each row execute function public.prevent_owner_storage_write_during_deletion();

-- Immutable pilot snapshots may be redacted or removed only inside the
-- service-role erasure transaction. Ordinary service-role writes remain
-- immutable as before.
create or replace function public.prevent_pilot_report_mutation()
returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if current_user = 'postgres'
    and nullif(current_setting('app.account_erasure_owner', true), '') is not null then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'pilot reports are immutable';
end;
$$;
revoke all on function public.prevent_pilot_report_mutation() from public, anon, authenticated;
grant execute on function public.prevent_pilot_report_mutation() to service_role;

create or replace function public.erase_account_owned_data(p_owner_id uuid, p_redacted_reports jsonb)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  report jsonb;
  report_id text;
  redacted_snapshot jsonb;
  owner_evidence_ids text[];
  owner_apps text[];
  allocation record;
  next_allocations jsonb;
  next_reconciles jsonb;
begin
  if p_owner_id is null or jsonb_typeof(p_redacted_reports) <> 'array' then
    raise exception 'invalid account erasure request';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  if not exists (select 1 from public.account_deletion_locks where owner_id = p_owner_id) then
    raise exception 'account deletion lock is required';
  end if;
  if exists (select 1 from public.account_operation_leases where owner_id = p_owner_id) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_OPERATIONS_ACTIVE';
  end if;

  -- Remove full owner-only reports and replace shared snapshots with the
  -- caller-computed form that retains every other owner's attempts.
  perform pg_catalog.set_config('app.account_erasure_owner', p_owner_id::text, true);
  for report in select value from jsonb_array_elements(p_redacted_reports) as rows(value) loop
    report_id := report->>'id';
    if report->>'delete' = 'true' then
      delete from public.pilot_reports
      where id = report_id and owner_id = p_owner_id::text
        and snapshot_hash = report->>'originalSnapshotHash';
      if not found then raise exception using errcode = 'P0001', message = 'ACCOUNT_REPORT_CONFLICT'; end if;
    else
      redacted_snapshot := report->'snapshot';
      if redacted_snapshot is null or redacted_snapshot->'attempts' @> jsonb_build_array(jsonb_build_object('ownerId', p_owner_id::text))
        or coalesce(redacted_snapshot->'sourceManifest'->'stateOwnerIds', '[]'::jsonb) @> jsonb_build_array(p_owner_id::text) then
        raise exception 'pilot report still contains erased owner';
      end if;
      update public.pilot_reports
      set snapshot = redacted_snapshot, snapshot_hash = report->>'snapshotHash',
        created_by = case when created_by = p_owner_id::text then '__deleted_account__' else created_by end
      where id = report_id and owner_id is distinct from p_owner_id::text
        and snapshot_hash = report->>'originalSnapshotHash';
      if not found then raise exception using errcode = 'P0001', message = 'ACCOUNT_REPORT_CONFLICT'; end if;
    end if;
  end loop;

  -- Remove owner-level cost evidence links. Invoice amounts and each line's
  -- total allocation stay intact; the erased share is combined into a
  -- non-account sentinel that can never be a Supabase Auth UUID.
  select coalesce(array_agg(identity), array[]::text[]) into owner_evidence_ids from (
    select data->>'id' as identity
    from public.model_usage_records where user_id = p_owner_id
    union
    select case
      when data->>'sessionId' is null then 'browser:event:' || (data->>'id')
      else 'browser:' || (data->>'provider') || ':' || (data->>'sessionId') || ':browser'
    end as identity
    from public.browser_usage_records where user_id = p_owner_id
    union
    select case
      when data->>'sessionId' is null then 'browser:event:' || (data->>'id') || ':proxy'
      else 'browser:' || (data->>'provider') || ':' || (data->>'sessionId') || ':proxy'
    end as identity
    from public.browser_usage_records where user_id = p_owner_id
  ) evidence where identity is not null;
  delete from public.service_cost_evidence_coverage where evidence_id = any(owner_evidence_ids);

  for allocation in
    select id, data from public.service_cost_records
    where exists (
      select 1 from jsonb_array_elements(coalesce(data->'allocations', '[]'::jsonb)) item
      where item->>'userId' = p_owner_id::text
    ) for update
  loop
    select coalesce(jsonb_agg(jsonb_build_object('userId', grouped.user_id, 'amountUsd', grouped.amount_usd) order by grouped.user_id), '[]'::jsonb)
    into next_allocations
    from (
      select case when item->>'userId' = p_owner_id::text then '__deleted_account__' else item->>'userId' end as user_id,
        sum((item->>'amountUsd')::numeric) as amount_usd
      from jsonb_array_elements(coalesce(allocation.data->'allocations', '[]'::jsonb)) item
      group by case when item->>'userId' = p_owner_id::text then '__deleted_account__' else item->>'userId' end
    ) grouped;
    select coalesce(jsonb_agg(to_jsonb(identity)), '[]'::jsonb) into next_reconciles
    from jsonb_array_elements_text(coalesce(allocation.data->'reconciles', '[]'::jsonb)) identity
    where not (identity = any(owner_evidence_ids));
    update public.service_cost_records
    set data = jsonb_set(jsonb_set(allocation.data, '{allocations}', next_allocations, true), '{reconciles}', next_reconciles, true)
    where id = allocation.id;
  end loop;

  select coalesce(array_agg(value->>'id'), array[]::text[]) into owner_apps
  from public.app_states state
  cross join lateral jsonb_array_elements(coalesce(state.data->'applications', '[]'::jsonb)) value
  where state.user_id = p_owner_id and value->>'id' is not null;

  -- Erase owner-linked reservation identities. Return budget only for proven
  -- unspent holds: queued rows that never reached a worker, and explicit
  -- imported-preflight compensation markers. Consumed/uncertain projected
  -- spend remains in the shared cap even after its private key is removed.
  with queue_owned as materialized (
    select queued.reservation_id, queued.month, queued.status
    from public.service_budget_queue_reservations queued where queued.owner_id = p_owner_id
  ), unused_preflight as materialized (
    select distinct reservation.month || ':' || (compensation.marker->>'reservationId') as reservation_id, reservation.month
    from public.app_states state
    cross join lateral jsonb_array_elements(coalesce(state.data->'applications', '[]'::jsonb)) app
    cross join lateral (select app->'importedPreflight'->'budgetReleasePending' as marker) compensation
    join public.service_budget_reservations reservation
      on reservation.reservation_id = reservation.month || ':' || (compensation.marker->>'reservationId')
    where state.user_id = p_owner_id
      and compensation.marker->>'kind' = 'unused'
      and app->'importedPreflight'->>'budgetReservationId' = compensation.marker->>'reservationId'
      and (compensation.marker->>'month') = reservation.month
  ), owner_reservations as materialized (
    select reservation.reservation_id, reservation.month,
      case
        when queue_owned.status in ('held', 'terminal_pending') and reservation.released_at is null then reservation.reserved_usd
        when unused_preflight.reservation_id is not null and reservation.released_at is null then reservation.reserved_usd
        else 0
      end as releasable_usd
    from public.service_budget_reservations reservation
    left join queue_owned on queue_owned.reservation_id = reservation.reservation_id and queue_owned.month = reservation.month
    left join unused_preflight on unused_preflight.reservation_id = reservation.reservation_id and unused_preflight.month = reservation.month
    where queue_owned.reservation_id is not null or unused_preflight.reservation_id is not null
      or reservation.reservation_id like reservation.month || ':match:' || p_owner_id::text || ':%'
      or exists (
        select 1 from unnest(owner_apps) app_id
        where reservation.reservation_id like reservation.month || ':browser:' || app_id || ':%'
          or reservation.reservation_id like reservation.month || ':browser-essays:' || app_id || ':%'
      )
  ), removed as (
    delete from public.service_budget_reservations reservation
    using owner_reservations owned
    where reservation.reservation_id = owned.reservation_id
    returning reservation.reservation_id, reservation.month, reservation.reserved_usd, reservation.released_at
  ), adjustments as (
    select removed.month, coalesce(sum(owned.releasable_usd) filter (where removed.released_at is null), 0) as amount
    from removed join owner_reservations owned using (reservation_id, month)
    group by removed.month
  )
  update public.service_budget budget
  set reserved_usd = greatest(0, budget.reserved_usd - adjustments.amount)
  from adjustments where budget.month = adjustments.month;
  delete from public.service_budget_queue_reservations where owner_id = p_owner_id;
  delete from public.model_usage_records where user_id = p_owner_id;
  delete from public.browser_usage_records where user_id = p_owner_id;
  if exists (
    select 1 from public.pilot_reports report
    where report.owner_id = p_owner_id::text
      or report.created_by = p_owner_id::text
      or report.snapshot->'createdBy'->>'userId' = p_owner_id::text
      or coalesce(report.snapshot->'sourceManifest'->'stateOwnerIds', '[]'::jsonb) @> jsonb_build_array(p_owner_id::text)
      or exists (
        select 1 from jsonb_array_elements(coalesce(report.snapshot->'sourceManifest'->'stateRows', '[]'::jsonb)) state_row
        where state_row->>'ownerId' = p_owner_id::text
      )
      or exists (
        select 1 from jsonb_array_elements(coalesce(report.snapshot->'attempts', '[]'::jsonb)) attempt
        where attempt->>'ownerId' = p_owner_id::text
      )
  ) then raise exception using errcode = 'P0001', message = 'ACCOUNT_REPORT_CONFLICT'; end if;
  delete from public.app_states where user_id = p_owner_id;
  return true;
end;
$$;
revoke all on function public.erase_account_owned_data(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.erase_account_owned_data(uuid, jsonb) to service_role;

-- All new owner budget holds participate in the same admission lock. Retire
-- the owner-blind RPC so an older deployed worker fails closed during rollout.
revoke all on function public.reserve_service_budget(text, text, numeric, numeric) from service_role;
create or replace function public.reserve_account_service_budget(
  p_owner_id uuid,
  p_reservation_id text,
  p_month text,
  p_amount numeric,
  p_limit numeric
)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare current_total numeric; existing_release timestamptz;
begin
  if p_owner_id is null or p_amount <= 0 or p_limit <= 0 or p_month !~ '^[0-9]{4}-[0-9]{2}$' then return false; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  if not exists (select 1 from auth.users where id = p_owner_id)
    or exists (select 1 from public.account_deletion_locks where owner_id = p_owner_id) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;
  select released_at into existing_release from public.service_budget_reservations where reservation_id = p_reservation_id;
  if found then return existing_release is null; end if;
  insert into public.service_budget(month, reserved_usd) values (p_month, 0) on conflict (month) do nothing;
  select reserved_usd into current_total from public.service_budget where month = p_month for update;
  select released_at into existing_release from public.service_budget_reservations where reservation_id = p_reservation_id;
  if found then return existing_release is null; end if;
  if current_total + p_amount > p_limit then return false; end if;
  update public.service_budget set reserved_usd = reserved_usd + p_amount where month = p_month;
  insert into public.service_budget_reservations(reservation_id, month, reserved_usd)
  values (p_reservation_id, p_month, p_amount);
  return true;
end;
$$;
revoke all on function public.reserve_account_service_budget(uuid, text, text, numeric, numeric) from public, anon, authenticated;
grant execute on function public.reserve_account_service_budget(uuid, text, text, numeric, numeric) to service_role;

create or replace function public.reserve_queued_service_budget(p_queued_id text, p_owner_id uuid, p_application_id text, p_month text, p_amount numeric, p_limit numeric)
returns jsonb
language plpgsql security definer set search_path = '' as $$
declare current_total numeric; existing public.service_budget_queue_reservations%rowtype;
begin
  if nullif(trim(p_queued_id), '') is null or p_owner_id is null or nullif(trim(p_application_id), '') is null or p_month !~ '^[0-9]{4}-[0-9]{2}$' or p_amount <= 0 or p_limit <= 0 then return null; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_owner_id::text, 0));
  if not exists (select 1 from auth.users where id = p_owner_id)
    or exists (select 1 from public.account_deletion_locks where owner_id = p_owner_id) then
    raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_IN_PROGRESS';
  end if;
  -- Keep concurrent retries for one queue item idempotent after owner admission.
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

-- Invoice imports and pilot capture can create shared rows while a user is
-- being erased. Lock all referenced owners in stable order and fail closed if
-- any allocation or attempt belongs to an account already being deleted.
create or replace function public.prevent_erased_owner_in_shared_record()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner_text text; owner_uuid uuid; expected_allocations jsonb;
begin
  -- The erasure RPC may update a shared invoice only to replace this owner's
  -- exact allocation share with the accounting sentinel. This narrow branch
  -- lets concurrent deletions of owners A and B serialize on the invoice row
  -- without making either transaction block on the other's deletion lock.
  if current_user = 'postgres'
    and nullif(current_setting('app.account_erasure_owner', true), '') is not null
    and tg_op = 'UPDATE' then
    owner_text := current_setting('app.account_erasure_owner', true);
    owner_uuid := owner_text::uuid;
    if exists (
      select 1 from jsonb_array_elements(coalesce(old.data->'allocations', '[]'::jsonb)) item
      where item->>'userId' = owner_text
    ) and not exists (
      select 1 from jsonb_array_elements(coalesce(new.data->'allocations', '[]'::jsonb)) item
      where item->>'userId' = owner_text
    ) then
      select coalesce(jsonb_agg(jsonb_build_object('userId', grouped.user_id, 'amountUsd', grouped.amount_usd) order by grouped.user_id), '[]'::jsonb)
      into expected_allocations
      from (
        select case when item->>'userId' = owner_text then '__deleted_account__' else item->>'userId' end as user_id,
          sum((item->>'amountUsd')::numeric) as amount_usd
        from jsonb_array_elements(coalesce(old.data->'allocations', '[]'::jsonb)) item
        group by case when item->>'userId' = owner_text then '__deleted_account__' else item->>'userId' end
      ) grouped;
      if expected_allocations = coalesce(new.data->'allocations', '[]'::jsonb)
        and (old.data - 'allocations' - 'reconciles') = (new.data - 'allocations' - 'reconciles')
        and not exists (
          select 1 from jsonb_array_elements_text(coalesce(new.data->'reconciles', '[]'::jsonb)) retained(value)
          where not coalesce(old.data->'reconciles', '[]'::jsonb) @> jsonb_build_array(retained.value)
        ) then
        return new;
      end if;
    end if;
  end if;

  -- The sentinel exists only as an accounting placeholder; callers cannot
  -- import it as if it were a real account allocation.
  if exists (
    select 1 from jsonb_array_elements(coalesce(new.data->'allocations', '[]'::jsonb)) item
    where item->>'userId' = '__deleted_account__'
  ) and not (
    current_user = 'postgres'
    and nullif(current_setting('app.account_erasure_owner', true), '') is not null
  ) then
    raise exception 'deleted-account allocation is reserved for erasure';
  end if;

  for owner_text in
    select distinct allocation_owner.value
    from (
      select new.data->'allocations' as allocation_array
    ) source
    cross join lateral jsonb_array_elements(coalesce(source.allocation_array, '[]'::jsonb)) item
    cross join lateral (select item->>'userId' as value) allocation_owner
    where allocation_owner.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    order by allocation_owner.value
  loop
    owner_uuid := owner_text::uuid;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_uuid::text, 0));
    if exists (select 1 from public.account_deletion_locks where owner_id = owner_uuid)
      or not exists (select 1 from auth.users where id = owner_uuid) then
      raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_IN_PROGRESS';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.prevent_erased_owner_in_shared_record() from public, anon, authenticated;
drop trigger if exists prevent_erased_owner_in_shared_record on public.service_cost_records;
create trigger prevent_erased_owner_in_shared_record
before insert or update of data on public.service_cost_records
for each row execute function public.prevent_erased_owner_in_shared_record();

create or replace function public.prevent_erased_owner_in_pilot_report()
returns trigger
language plpgsql security definer set search_path = '' as $$
declare owner_text text; owner_uuid uuid;
begin
  if current_user = 'postgres'
    and nullif(current_setting('app.account_erasure_owner', true), '') is not null then
    return new;
  end if;
  for owner_text in
    select distinct owners.value from (
      select new.owner_id as value
      union all
    select new.created_by as value
      union all
      select new.snapshot->'createdBy'->>'userId' as value
      union all
      select item->>'ownerId' as value
      from jsonb_array_elements(coalesce(new.snapshot->'attempts', '[]'::jsonb)) item
      union all
      select jsonb_array_elements_text(coalesce(new.snapshot->'sourceManifest'->'stateOwnerIds', '[]'::jsonb)) as value
      union all
      select state_row->>'ownerId' as value
      from jsonb_array_elements(coalesce(new.snapshot->'sourceManifest'->'stateRows', '[]'::jsonb)) state_row
    ) owners
    where owners.value ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    order by owners.value
  loop
    owner_uuid := owner_text::uuid;
    perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(owner_uuid::text, 0));
    if exists (select 1 from public.account_deletion_locks where owner_id = owner_uuid)
      or not exists (select 1 from auth.users where id = owner_uuid) then
      raise exception using errcode = 'P0001', message = 'ACCOUNT_DELETION_IN_PROGRESS';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.prevent_erased_owner_in_pilot_report() from public, anon, authenticated;
drop trigger if exists prevent_erased_owner_in_pilot_report on public.pilot_reports;
create trigger prevent_erased_owner_in_pilot_report
before insert on public.pilot_reports
for each row execute function public.prevent_erased_owner_in_pilot_report();
