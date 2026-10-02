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
  -- Unknown replay fields cannot erase measured values. Keep every nullable
  -- record/token key present so failed calls remain visibly unknown rather
  -- than changing shape to an incomplete object.
  merged := p_existing || p_incoming;
  merged := jsonb_set(merged, '{tokens}', jsonb_build_object(
    'input', coalesce(nullif(p_incoming->'tokens'->'input', 'null'::jsonb), nullif(p_existing->'tokens'->'input', 'null'::jsonb), 'null'::jsonb),
    'cachedInput', coalesce(nullif(p_incoming->'tokens'->'cachedInput', 'null'::jsonb), nullif(p_existing->'tokens'->'cachedInput', 'null'::jsonb), 'null'::jsonb),
    'cacheWrite', coalesce(nullif(p_incoming->'tokens'->'cacheWrite', 'null'::jsonb), nullif(p_existing->'tokens'->'cacheWrite', 'null'::jsonb), 'null'::jsonb),
    'output', coalesce(nullif(p_incoming->'tokens'->'output', 'null'::jsonb), nullif(p_existing->'tokens'->'output', 'null'::jsonb), 'null'::jsonb),
    'reasoningOutput', coalesce(nullif(p_incoming->'tokens'->'reasoningOutput', 'null'::jsonb), nullif(p_existing->'tokens'->'reasoningOutput', 'null'::jsonb), 'null'::jsonb)
  ), true);
  merged := jsonb_set(merged, '{completedAt}', coalesce(nullif(p_incoming->'completedAt', 'null'::jsonb), nullif(p_existing->'completedAt', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{responseId}', coalesce(nullif(p_incoming->'responseId', 'null'::jsonb), nullif(p_existing->'responseId', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{requestId}', coalesce(nullif(p_incoming->'requestId', 'null'::jsonb), nullif(p_existing->'requestId', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{providerStatus}', coalesce(nullif(p_incoming->'providerStatus', 'null'::jsonb), nullif(p_existing->'providerStatus', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{serviceTier}', coalesce(nullif(p_incoming->'serviceTier', 'null'::jsonb), nullif(p_existing->'serviceTier', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{rate}', coalesce(nullif(p_incoming->'rate', 'null'::jsonb), nullif(p_existing->'rate', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{estimatedUsd}', coalesce(nullif(p_incoming->'estimatedUsd', 'null'::jsonb), nullif(p_existing->'estimatedUsd', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{reconciledUsd}', coalesce(nullif(p_incoming->'reconciledUsd', 'null'::jsonb), nullif(p_existing->'reconciledUsd', 'null'::jsonb), 'null'::jsonb), true);
  merged := jsonb_set(merged, '{failure}', coalesce(nullif(p_incoming->'failure', 'null'::jsonb), nullif(p_existing->'failure', 'null'::jsonb), 'null'::jsonb), true);
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
