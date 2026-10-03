-- Report snapshots are append-only service records.  Revoke the default table
-- privileges before granting the two operations used by the capture route.
revoke all on table public.pilot_reports from service_role;
grant select, insert on table public.pilot_reports to service_role;

revoke all on function public.prevent_pilot_report_mutation() from service_role;
grant execute on function public.prevent_pilot_report_mutation() to service_role;
