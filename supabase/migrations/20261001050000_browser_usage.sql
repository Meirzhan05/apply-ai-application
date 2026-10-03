-- Browser provider evidence is independent from owner-state CAS. The text key
-- is deliberately stable across lifecycle replay deliveries (provider/session
-- event ids are not UUIDs).
create table public.browser_usage_records (
  id text primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  occurred_at timestamptz not null,
  data jsonb not null check (jsonb_typeof(data) = 'object')
);
create index browser_usage_owner_time_idx on public.browser_usage_records(user_id, occurred_at desc);
alter table public.browser_usage_records enable row level security;
revoke all on public.browser_usage_records from public, anon, authenticated;
grant select, insert, update on public.browser_usage_records to service_role;

-- A replay with a partial or active report must not erase a final report or
-- fields already measured on the same stable event id. JSON nulls represent an
-- omitted provider field and are stripped; explicit numeric zero survives.
create function public.merge_browser_usage_data(p_existing jsonb, p_incoming jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare
  existing_report jsonb;
  incoming_report jsonb;
  existing_has_report boolean := jsonb_typeof(p_existing->'report') = 'object';
  incoming_has_report boolean := jsonb_typeof(p_incoming->'report') = 'object';
  existing_final boolean := coalesce(existing_report->>'status' = 'stopped' or existing_report->>'finishedAt' is not null, false);
  incoming_final boolean := coalesce(incoming_report->>'status' = 'stopped' or incoming_report->>'finishedAt' is not null, false);
  incoming_newer boolean;
  primary_report jsonb;
  secondary_report jsonb;
  envelope jsonb;
  identity_key text;
begin
  -- Runs under the conflict row lock, including a racing first delivery.
  foreach identity_key in array array['id', 'userId', 'provider', 'sessionId', 'event', 'runId'] loop
    if p_existing->identity_key is distinct from p_incoming->identity_key then
      raise exception 'Browser usage identity cannot change';
    end if;
  end loop;
  existing_report := case when existing_has_report then jsonb_strip_nulls(p_existing->'report') else '{}'::jsonb end;
  incoming_report := case when incoming_has_report then jsonb_strip_nulls(p_incoming->'report') else '{}'::jsonb end;
  existing_final := coalesce(existing_report->>'status' = 'stopped' or existing_report->>'finishedAt' is not null, false);
  incoming_final := coalesce(incoming_report->>'status' = 'stopped' or incoming_report->>'finishedAt' is not null, false);
  incoming_newer := (p_incoming->>'occurredAt')::timestamptz >= (p_existing->>'occurredAt')::timestamptz;
  envelope := case when incoming_newer then p_existing || p_incoming else p_incoming || p_existing end;
  -- Optional associations may arrive late, but missing/null keys never erase them.
  foreach identity_key in array array['applicationId', 'jobId'] loop
    if nullif(envelope->>identity_key, '') is null then
      if nullif(p_existing->>identity_key, '') is not null then
        envelope := jsonb_set(envelope, array[identity_key], p_existing->identity_key, true);
      elsif nullif(p_incoming->>identity_key, '') is not null then
        envelope := jsonb_set(envelope, array[identity_key], p_incoming->identity_key, true);
      end if;
    end if;
  end loop;
  if not existing_has_report and not incoming_has_report then return envelope; end if;
  if existing_final and not incoming_final then
    primary_report := existing_report;
    secondary_report := incoming_report;
  elsif incoming_newer then
    primary_report := incoming_report;
    secondary_report := existing_report;
  else
    primary_report := existing_report;
    secondary_report := incoming_report;
  end if;
  return jsonb_set(envelope, '{report}', jsonb_strip_nulls(secondary_report) || jsonb_strip_nulls(primary_report), true);
end;
$$;
revoke all on function public.merge_browser_usage_data(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.merge_browser_usage_data(jsonb, jsonb) to service_role;

create function public.record_browser_usage(p_record jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_record->>'version' is distinct from '1' or p_record->>'id' is null
     or nullif(p_record->>'userId', '') is null or nullif(p_record->>'runId', '') is null
     or nullif(p_record->>'provider', '') is null or nullif(p_record->>'event', '') is null
     or nullif(p_record->>'occurredAt', '') is null or not (p_record ? 'sessionId') then
    raise exception 'Invalid browser usage report';
  end if;
  if exists (select 1 from public.browser_usage_records
    where id = p_record->>'id' and user_id <> (p_record->>'userId')::uuid) then
    raise exception 'Browser usage belongs to another owner';
  end if;
  insert into public.browser_usage_records(id, user_id, occurred_at, data)
  values (p_record->>'id', (p_record->>'userId')::uuid, (p_record->>'occurredAt')::timestamptz, p_record)
  on conflict(id) do update set
    data = public.merge_browser_usage_data(browser_usage_records.data, excluded.data),
    occurred_at = greatest(browser_usage_records.occurred_at, excluded.occurred_at);
end;
$$;
revoke all on function public.record_browser_usage(jsonb) from public, anon, authenticated;
grant execute on function public.record_browser_usage(jsonb) to service_role;
