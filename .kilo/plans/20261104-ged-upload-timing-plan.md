fix(vk): time each ged artifact upload step to find the slow one

## Context
Logs show ~2m13s between `ged hold` and `ged artifacts edited into origin`
with no intermediate lines. The gap is the async block in sendGedArtifacts
(lunarreturns.js:4126): chartFor (sync, fast) + 3 sequential vkUploadDoc
(.ged, .pdf, .ged.txt) + 2 messages.edit. vkUploadDoc (lunarreturns.js:4046)
silently retries up to 3x with 60s upload timeout, so slow/retried steps are
invisible. Which attachment delays is currently unanswerable from logs.

## Task: add timing instrumentation (VK only; tg mirror not needed —
vkUploadDoc/messages.edit are VK transport, not shared logic)

In lunarreturns.js only:

1. In the async block of sendGedArtifacts (~line 4126):
   - log duration of chartFor (if non-trivial, >1s);
   - log duration of each vkUploadDoc call with the file name:
     `ged upload: <base>.ged 12345ms` etc.
2. In vkUploadDoc:
   - log each attempt start/fail (attempt number, error) so silent retries
     become visible: `ged upload attempt 2 <title>: <err>`;
   - log docs.save duration optionally (same line).
3. Log messages.edit durations (tlex is the one that can be slow/rate-limited).

Keep logs one-line, same style as existing (`console.log`/`console.error`).
No behavior changes: same retries, same order, same fallbacks.

## Validation
- `node lunarreturns.js test "..."` — bot logic unaffected (pure logging).
- Optionally run a real 🧬 on a test peer and confirm per-step timings
  identify the slow attachment (expect .pdf or upload-POST to dominate;
  retries will now show as extra attempt lines).
- `node dev/sync-check.mjs` still passes (VK file only, but cheap to run).

## Out of scope
- Parallelizing uploads (VK rate limits; sequential is deliberate).
- TG copy: platform has no doc upload path like this.

## Report

Implemented in `lunarreturns.js` only (VK transport, TG untouched):

- `vkUploadDoc` (lunarreturns.js:4046): each failed upload attempt now logs
  `ged upload attempt <N> <title>: <err>` — silent retries (HTTP-garbage
  response or network/timeout) are visible.
- `sendGedArtifacts` async block (lunarreturns.js:4128):
  - `ged chart: <ms>ms` when chartFor takes >1s;
  - `ged upload: <base>.ged|.pdf|.ged.txt <ms>ms` after each vkUploadDoc
    (total includes getMessagesUploadServer + POST + docs.save);
  - `ged edit: attachment <ms>ms` and `ged edit: text <ms>ms` for the two
    messages.edit calls.

No behavior changes: same retry count, order, timeouts, fallbacks.

Validation: `node --check lunarreturns.js` OK; `node dev/sync-check.mjs`
passes (VK/ТГ синхронны); `node lunarreturns.js test "Имя 1963-09-27 12:30
(Пермь)"` OK. Timings themselves appear only in production logs — next slow
🧬 run will name the culprit step/file.
