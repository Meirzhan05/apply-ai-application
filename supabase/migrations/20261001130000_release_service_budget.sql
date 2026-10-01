-- Imported preflight can fail after reserving a short-lived browser estimate.
-- Mark the reservation released transactionally so a stale retry cannot reuse it.
create or replace function public.release_service_budget(p_reservation_id text, p_month text)
returns boolean
language plpgsql security definer set search_path = '' as $$
declare held numeric;
begin
  if nullif(trim(p_reservation_id), '') is null or p_month !~ '^[0-9]{4}-[0-9]{2}$' then return false; end if;
  select reserved_usd into held
    from public.service_budget_reservations
    where reservation_id = p_reservation_id and month = p_month and released_at is null
    for update;
  if not found then
    return exists (select 1 from public.service_budget_reservations where reservation_id = p_reservation_id and month = p_month and released_at is not null);
  end if;
  update public.service_budget
    set reserved_usd = greatest(0, reserved_usd - held)
    where month = p_month;
  update public.service_budget_reservations
    set released_at = now()
    where reservation_id = p_reservation_id and month = p_month and released_at is null;
  return true;
end;
$$;

revoke all on function public.release_service_budget(text, text) from public, anon, authenticated;
grant execute on function public.release_service_budget(text, text) to service_role;
