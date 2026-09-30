-- Immutable generated PDFs and LaTeX sources; only trusted workers write.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('application-files', 'application-files', false, 5242880, array['application/pdf', 'text/plain'])
on conflict (id) do nothing;

create policy "Owners can read their generated application files" on storage.objects
for select to authenticated
using (bucket_id = 'application-files' and (storage.foldername(name))[1] = (select auth.uid())::text);
-- No authenticated INSERT/UPDATE/DELETE policy: published artifacts cannot be
-- replaced by the browser. Service-role writes require explicit owner checks.
