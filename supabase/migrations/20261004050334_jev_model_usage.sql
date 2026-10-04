-- Allow owner-scoped JEV usage in the existing model ledger. Permissions remain service-role-only.
create or replace function public.record_model_usage(p_record jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_record->>'version' <> '1' or coalesce(p_record->>'provider', '') not in ('openai', 'typesafe')
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
