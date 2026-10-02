-- Provider measurements are independent from application-state revisions and
-- projected budget reservations. Only trusted server workers write/read them.
create table public.model_usage_records (
  id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  started_at timestamptz not null,
  data jsonb not null check (jsonb_typeof(data) = 'object')
);
create index model_usage_owner_time_idx on public.model_usage_records(user_id, started_at desc);
alter table public.model_usage_records enable row level security;
revoke all on public.model_usage_records from public, anon, authenticated;
grant select, insert, update on public.model_usage_records to service_role;

-- Replayed delivery updates the original invocation, and an older pending
-- report cannot erase measured usage. Ownership cannot change on conflict.
create function public.record_model_usage(p_record jsonb) returns void
language plpgsql security invoker set search_path = '' as $$
begin
  if p_record->>'version' <> '1' or p_record->>'provider' <> 'openai'
     or nullif(p_record->>'runId', '') is null then
    raise exception 'Invalid model usage report';
  end if;
  if exists (select 1 from public.model_usage_records
    where id = (p_record->>'id')::uuid and user_id <> (p_record->>'userId')::uuid) then
    raise exception 'Model usage belongs to another owner';
  end if;
  insert into public.model_usage_records(id, user_id, started_at, data)
  values ((p_record->>'id')::uuid, (p_record->>'userId')::uuid, (p_record->>'startedAt')::timestamptz, p_record)
  on conflict(id) do update set data = excluded.data
    where model_usage_records.user_id = excluded.user_id
      and (model_usage_records.data->>'completedAt' is null or excluded.data->>'completedAt' is not null);
end;
$$;
revoke all on function public.record_model_usage(jsonb) from public, anon, authenticated;
grant execute on function public.record_model_usage(jsonb) to service_role;
