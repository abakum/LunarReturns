fix(search): show overflow search hits inline with ✂️⏳ before the .txt (VK + TG)

## Problem
Overflow search («/Семен» → 29 строк, >4000 знаков) first sent only
`#not for cut and graft` + head + `✂️⏳` with no hit lines, then attached the
.txt. Expected (as in the 🧬/ged overflow flow): head + whole hit lines up to
~4000 chars + `✂️⏳`, then the attachment edit drops ⏳ leaving `✂️`.

## Fix
Both copies (VK: lunarreturns.js search branch ~line 5050; TG:
tgcloud/handlers/message.js overflow search ~line 396) now build `inner`
(whole lines of `found` up to NOT_FOR_GRAFT + head + inner ≤ 4000) and use
`holdTxt = NOT_FOR_GRAFT + "\n" + head + "\n" + inner + "\n✂️⏳"` first,
`finalTxt = … + "\n✂️"` in the post-upload edit (VK messages.edit with
attachment re-included per the VK quirk; TG editMessageText). File content
unchanged (full `found` with BOM + graft mark).

## Validation
- `node --check` both files OK; `node dev/sync-check.mjs` passes;
  `node lunarreturns.js test "…"` OK.
- TG repl: `!ged Romanov_family.ged.txt` → `/ о` → 70 строк: hold message
  contains hit lines + `✂️⏳`, then sendDocument, then edit to `✂️`.
- VK repl (`node dev/vk-repl.mjs --fresh`): same overflow message with
  inner lines + `✂️⏳` (upload fails offline in the mock — expected;
  fallback paths preserved).

## Report
Implemented as planned; no logic changes outside the two display branches,
`flatSearch` untouched. dev/tg-db.json restored after repl runs.

## Report 2: mark on every search reply
Follow-up: EVERY search reply must carry `#not for cut and graft`, fitting or
not. Changed (VK lunarreturns.js, TG handlers/message.js):
- single-hit focus: VK fits path now `ngHead + "\n" + pack`; TG sendFocus
  called with `ng = true` always (was: only on overflow);
- fitting list: VK `NOT_FOR_GRAFT + "\n" + found`; TG same in sendLong call;
- TG overflow .txt content now includes the mark (as VK withGraftMark did).

Validation: sync-check passes; TG repl `/А` (single hit) and `/ о` (70 строк
overflow) both show the mark; VK repl same for fits (12 строк) and overflow
(✂️⏳). dev/tg-db.json restored.

## Report 3: overflow header is the mark only
Overflow search hold/final text now starts with just `#not for cut and graft`
(no «Найдено N строк…» line; inner hit lines follow, ✂️⏳ → ✂️). The head
string survives only as the .txt filename base (both copies). VK also got
`search upload: <file> <ms>ms` timing (the reported 57s gap was inside
vkUploadDoc; per-attempt failures are logged since Report-fix #1).
Sync-check passes; both repls show mark + hits + ✂️⏳ and filename
«Найдено N строк ….txt».

## Report 4: upload timeout 60s → 20s
Log confirmed the 57s gap: attempt 1 hung the full 60s AbortSignal timeout,
attempt 2 succeeded in ~5s. vkUploadDoc upload timeout reduced 60000 → 20000
(lunarreturns.js:4055): files are small text docs, 60s was a long dead wait
before retry. 3 attempts + backoff unchanged; sync-check and VK test pass.

## Report 5: size-based upload timeout
Timeout is now empirical per file: `min(60000, 10000 + ceil(len/1024)*1000)`
ms in vkUploadDoc — 10s floor + ~1s/KB, capped at 60s. Measured ~5s for a 7KB
upload, so the floor carries ~3x headroom; big PDFs get proportionally more
than the flat 20s would allow. Retries/backoff unchanged; sync-check and
VK test pass.

## Report 6: retry error responses; ⏳ removed with error on final failure
Log showed upload POST returning `{"error":"not saved"}` — JSON parsed fine,
so the retry loop never fired and ⏳ hung forever. Now (both copies):
- vkUploadDoc (VK): error-JSON response counts as a failed attempt and is
  retried (3 attempts as before) before throwing;
- on final upload failure the hold message is edited: ⏳ removed, error
  appended after ✂️ (`✂️💥 <err>`) — search overflow (VK messages.edit,
  TG editMessageText) and the single-hit panel path (VK panel, TG panel).
Sync-check and VK test pass.

## Report 7: unified hold-attach helpers
The duplicated upload/edit/fallback blocks are unified:
- VK `holdAttach(peerId, log, sent, holdTxt, finalTxt, name, content, kb,
  fallbackTxt, msgId, convMsgId)` (near sendTailDoc): upload via vkUploadDoc
  (retries + size-based timeout), then attachment edit + text edit (⏳ → ✂️,
  VK two-edit quirk kept), edit failure → file sent separately (fallbackTxt,
  reply ids kept), upload failure → `✂️💥 <err>` edit; whole body guarded.
  Used by the search overflow and the single-hit panel branches.
- TG `holdReply(chatId, first, holdTxt, finalTxt, content, name)` in
  handlers/message.js (after sendFocus): sendDocument as reply + text edit;
  failure → `✂️💥 <err>` edit. Same two branches.
sendGedArtifacts keeps its origin-based flow (different targeting, timings)
and sendTailDoc/sendLong keep the simple 💥-message pattern.
Validation: sync-check, syntax checks, VK test pass; TG repl shows the full
hold → document → ✂️ flow. VK repl cannot show async flows after stdin EOF
(the harness closes its mock server, upload fails offline) — pre-existing
harness limitation, unchanged behavior.

## Report 9: NOT_FOR_GRAFT rules documented in code
Full rule comment added at the VK constant (lunarreturns.js, before
withGraftMark): semantic (parseTree.noGraft → cutAndGraft refuses), when the
mark goes INSIDE a pack (always for non-branch packs: chat tree, radius, search
lists; not for a full «-+=» branch), when in message TEXT (always on overflow;
fitting list — yes; fitting single-hit branch — no), attachments — always
withGraftMark. Pointers added at holdAttach (VK) and holdReply (TG); TG side
already documented at lib/bot.js NOT_FOR_GRAFT / sendFlatPack. Comments only;
sync-check passes.

## Report 10: full-branch attachment loses the mark
User is right: the panel .ged.txt holds a FULL branch (форма «-+=»), so the
mark is not needed — it only blocked replying that file to a trigger (dropped
file replacement asks buttons anyway). VK panel attach now `"\uFEFF" + pack`,
TG holdReply gets plain `pack` (ternary removed). All other withGraftMark
uses (radius romb, search/bell lists) keep the mark — those packs are not
branches. Doc comment point 3 updated accordingly. sync-check and VK test
pass; no fixture has a >4000 branch so the panel overflow path is
code-reviewed rather than repl-shown.

## Report 11: repl matrix for search/tap flows (VK + TG)
Rule order recap: hero head first, then the mark, then pack/list; no mark on
a fitting full branch; lists/tree keep the mark (first line when no hero).

| Scenario (fixture Romanov)            | VK (vk-repl)                    | TG (repl)                        |
|---------------------------------------|---------------------------------|----------------------------------|
| search single hit, fits (/Александр)  | head+branch, no mark            | same, no mark                    |
| search single hit, overflow           | — (no >4000 branch in fixture); production log confirmed: hero, mark, inner, ✂️⏳ → file → ✂️ | same via holdReply |
| search multi hits, fits (/А)          | mark + 12 строк                 | mark + list                      |
| search multi hits, overflow (/ о)     | mark + inner + ✂️⏳ (async doc raced EOF at script end) | mark + inner + ✂️⏳ → file → ✂️ |
| tap -+= fits (/4 7)                   | head+pack, no mark              | head+pack, no mark               |
| tap -+= overflow                      | /links overflow (same block): «Древо чата», mark, ✂️⏳ (async raced EOF) | sendFlatPack: head, mark, ✂️⏳ (code path; no >4000 branch in fixture) |
| tap 🧬 fits (/4 6)                    | hold hero, pack (mark first), ⏳ → upload → edit ✂️ (ged upload/edit logs 27/11/4/6ms) | pack edited into panel text + media group .ged+.pdf |
| tap 🧬 overflow                       | hold = hero, mark, inner, ✂️⏳ (code path 4147; no >4000 radius in fixture) | media group adds .ged.txt (code path 2022) |
| full-branch attachment                | .ged.txt without mark (panel, foc:flat, links) | same |

Notes: VK repl closes its mock server at script EOF — only async work still
pending after the LAST command fails («search doc upload: fetch failed»);
async steps between commands run fine (ged upload/edit timings visible).
dev/tg-db.json restored after runs.

## Report 8: single-hit focus keeps no mark when it fits
Regression from Report 2: a fitting single-hit focus reply is a branch pack
like a «-+=» answer and must NOT carry the mark. Reverted that part: mark on
the single-hit path only on overflow (VK fits text back to `head + pack`;
TG sendFocus ng back to `rest`). The search list replies (fits and overflow)
keep the mark per Report 2. TG repl: `/Александр` focus without mark, `/ о`
overflow with mark; sync-check and VK test pass.
