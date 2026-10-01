-- Preserve the strongest provider evidence when a stable model invocation is
-- replayed. This replaces the initial RPC without changing its table.
create function public.model_usage_completeness(p_record jsonb) returns integer
language sql immutable security invoker set search_path = '' as $$
  select
    (select count(*)::integer from jsonb_each(coalesce(p_record->'tokens', '{}'::jsonb)) where value <> 'null')
    + case when p_record->>'rate' is not null then 1 else 0 end
    + case when p_record->>'estimatedUsd' is not null then 1 else 0 end
    + case when p_record->>'responseId' is not null then 1 else 0 end
    + case when p_record->>'providerStatus' is not null then 1 else 0 end;
$$;
revoke all on function public.model_usage_completeness(jsonb) from public, anon, authenticated;
grant execute on function public.model_usage_completeness(jsonb) to service_role;

create function public.merge_model_usage_data(p_existing jsonb, p_incoming jsonb) returns jsonb
language plpgsql immutable security invoker set search_path = '' as $$
declare
  existing_complete boolean := p_existing->>'completedAt' is not null;
  incoming_complete boolean := p_incoming->>'completedAt' is not null;
  existing_score integer := public.model_usage_completeness(p_existing);
  incoming_score integer := public.model_usage_completeness(p_incoming);
  existing_time timestamptz := coalesce((p_existing->>'completedAt')::timestamptz, (p_existing->>'startedAt')::timestamptz);
  incoming_time timestamptz := coalesce((p_incoming->>'completedAt')::timestamptz, (p_incoming->>'startedAt')::timestamptz);
  merged jsonb;
begin
  if existing_complete and not incoming_complete then return p_existing; end if;
  if incoming_score < existing_score or (incoming_score = existing_score and incoming_time < existing_time) then return p_existing; end if;
  -- Strip nulls before merging so an unknown replay field cannot erase a
  -- measured value. Nested token keys need the same treatment.
  merged := jsonb_strip_nulls(p_existing) || jsonb_strip_nulls(p_incoming);
  merged := jsonb_set(merged, '{tokens}', jsonb_strip_nulls(coalesce(p_existing->'tokens', '{}'::jsonb)) || jsonb_strip_nulls(coalesce(p_incoming->'tokens', '{}'::jsonb)), true);
  return merged;
end;
$$;
revoke all on function public.merge_model_usage_data(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.merge_model_usage_data(jsonb, jsonb) to service_role;

create or replace function public.record_model_usage(p_record jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_record->>'version' <> '1' or p_record->>'provider' <> 'openai'
     or nullif(p_record->>'id', '') is null or nullif(p_record->>'userId', '') is null
     or nullif(p_record->>'runId', '') is null then
    raise exception 'Invalid model usage report';
  end if;
  if exists (select 1 from public.model_usage_records
    where id = (p_record->>'id')::uuid and user_id <> (p_record->>'userId')::uuid) then
    raise exception 'Model usage belongs to another owner';
  end if;
  insert into public.model_usage_records(id, user_id, started_at, data)
  values ((p_record->>'id')::uuid, (p_record->>'userId')::uuid, (p_record->>'startedAt')::timestamptz, p_record)
  on conflict(id) do update set
    data = public.merge_model_usage_data(model_usage_records.data, excluded.data),
    started_at = least(model_usage_records.started_at, excluded.started_at)
  where model_usage_records.user_id = excluded.user_id;
end;
$$;
revoke all on function public.record_model_usage(jsonb) from public, anon, authenticated;
grant execute on function public.record_model_usage(jsonb) to service_role;
