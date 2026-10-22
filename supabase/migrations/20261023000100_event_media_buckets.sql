-- Event media buckets (D-075, amending D-038).
--
-- D-038 kept every stored file private behind 15-minute signed URLs. A
-- published event page is public by design, and signed URLs differ on every
-- request, which defeats the CDN and makes every guest's phone fetch hero
-- images the slow way. So events get two buckets of their own:
--
--   event-media      PUBLIC. Processed derivatives of published-page media
--                    only: AVIF/WebP/JPEG re-encoded by sharp (EXIF and GPS
--                    stripped), mp4/webm loops and their posters, and the OG
--                    share card. Content-hashed paths, never overwritten:
--                      <org>/<event>/<sha>.<width>.<avif|webp|jpg>
--                      og/<event>/v<published_version>.png
--                    No SVG, ever. 30 MB per object.
--   event-originals  PRIVATE. The originals as uploaded (browser straight to
--                    Supabase via createSignedUploadUrl), and every GATED
--                    item (AGM pre-reads, the reception address card): served
--                    only as 15-minute signed URLs to viewers who qualify.
--                    50 MB per object (the Supabase free-plan ceiling).
--
-- Anything in event-media is world-readable and may linger in CDN caches
-- after deletion; that is why only derivatives of published, ungated media
-- go there. The deal-attachments bucket is untouched.
--
-- No storage.objects policies: browser roles never read or write these
-- buckets directly. Uploads use server-minted signed upload URLs, reads of
-- event-media use its public URL, reads of event-originals use server-minted
-- signed URLs, all under the service role.
--
-- lib/storage/allowed-types.ts mirrors both type lists, and
-- tests/unit/storage-allowed-types.test.ts holds it to this file.
-- Idempotent: re-running resets both buckets to exactly this.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-media',
  'event-media',
  true,
  31457280, -- 30 MB
  array[
    'image/webp',
    'image/avif',
    'image/jpeg',
    'image/png',
    'video/mp4',
    'video/webm'
  ]
)
on conflict (id) do update
  set public = true,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'event-originals',
  'event-originals',
  false,
  52428800, -- 50 MB
  array[
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
    'image/gif',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;
