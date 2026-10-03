-- One small version token invalidates catalog caches in every app instance.
create table public.catalog_revision (
  id boolean primary key default true check (id),
  revision bigint not null default 1
);
insert into public.catalog_revision (id) values (true);
alter table public.catalog_revision enable row level security;
revoke all on public.catalog_revision from public, anon, authenticated;
grant select, update on public.catalog_revision to service_role;

create function public.bump_catalog_revision()
returns trigger
language plpgsql security invoker set search_path = '' as $$
begin
  update public.catalog_revision set revision = revision + 1 where id = true;
  return null;
end;
$$;
revoke all on function public.bump_catalog_revision() from public, anon, authenticated;
grant execute on function public.bump_catalog_revision() to service_role;

create trigger jobs_catalog_revision
after insert or update or delete on public.jobs
for each statement execute function public.bump_catalog_revision();
