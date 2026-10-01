# H2 gate record: Library and uploads

**Plan:** docs/superpowers/plans/2026-10-01-h2-library-and-uploads.md
**Status:** automated evidence recorded; deployed gates pending the owner actions in docs/deploy.md ("Library and uploads").

## Automated evidence

`npm run typecheck && npm test && npm run test:e2e` on the branch head. See the final line of this record for the counts.

| Area | Evidence |
|---|---|
| Presigned uploads | `tests/http/library.test.ts`: start/complete/status/delete, size and type refusals, foreign-Studio ids omitted. |
| Processing | `tests/domain/library.test.ts`: process_upload is idempotent, HEIC retry keeps the source, the sweep fails only stale rows whose job is dead. |
| Worker wake | `tests/jobs/wake.test.ts`: remote mode starts the worker when heavy jobs are pending; a timeout never blocks the request. |
| Culling excluded | Plugin culling previews never set `in_library`; the Library count ignores them. |
| Delivery | publishFinals validates then copies; Download all is capped at 3 GiB and streams the ZIP from disk. |

## Deployed gates (fill in after deploy)

**Gate 1: upload to visible, under 60 s.** Upload a 20 MB JPEG in `/admin/library`, then:

```sql
begin; set local role og_system;
select extract(epoch from (ready_at::timestamptz - created_at::timestamptz)) as seconds
from photos where in_library order by created_at desc limit 1;
rollback;
```

| Run | Worker | Seconds |
|---|---|---|
| 1 | cold | |
| 2 | warm | |
| 3 | warm | |

**Gate 2: culling excluded.** Send 5 previews from Lightroom to a test project. The Library header count does not change; the culling grid shows 5. Result:

**Gate 3: HEIC on the worker.** Upload an iPhone HEIC; it becomes ready with a JPEG preview. Result:

**Tenancy:** `npm run check:tenancy` against Neon → (pending)

Branch suite: typecheck clean; vitest 44 files, 287 passed, 3 skipped; e2e 7 passed.
