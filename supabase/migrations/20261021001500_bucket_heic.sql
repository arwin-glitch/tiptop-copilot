-- Campaign photos: let the private bucket take HEIC photos.
--
-- Campaign photos are stored in the private `deal-attachments` bucket with
-- their real image type. The bucket (20260101000700_storage_and_bootstrap.sql)
-- allows PNG, JPEG, GIF and WebP but not HEIC, the format iPhones save photos
-- in. Until this is applied, a HEIC photo is refused with "HEIC photos are not
-- enabled yet ... use JPG or PNG", and every other photo and file works as
-- before.
--
-- Adds image/heic and image/heif to the bucket's allowed types, each only when
-- it is missing. Nothing else about the bucket changes: it stays private, with
-- the same size limit and every other allowed type. A bucket with no type
-- list at all (null, which allows every type) is left as it is. Safe to
-- re-run. Re-running 20260101000700 on its own resets the list to that file's,
-- so run this one again after it.
--
-- lib/storage/allowed-types.ts mirrors this list (the demo and test storage
-- enforce it).

update storage.buckets
set allowed_mime_types = allowed_mime_types || array['image/heic']::text[]
where id = 'deal-attachments'
  and allowed_mime_types is not null
  and not ('image/heic' = any (allowed_mime_types));

update storage.buckets
set allowed_mime_types = allowed_mime_types || array['image/heif']::text[]
where id = 'deal-attachments'
  and allowed_mime_types is not null
  and not ('image/heif' = any (allowed_mime_types));
