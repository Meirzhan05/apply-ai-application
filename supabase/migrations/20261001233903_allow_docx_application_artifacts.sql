update storage.buckets
set allowed_mime_types = case
  when allowed_mime_types is null then null
  else (
    select array_agg(distinct mime_type order by mime_type)
    from unnest(allowed_mime_types || array[
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]) as mime_type
  )
end
where id = 'application-files';
