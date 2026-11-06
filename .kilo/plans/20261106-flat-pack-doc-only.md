feat(links): chat tree pack always as .ged.txt doc via ⏳/invisible edit (VK + TG)

Chat-tree flat pack (/links without reply, «-+=» button) is now always sent
as a «Древо чата.ged.txt» document; no more header text or the ✂️⏳ dance.

Plan (agreed in Plan mode with user):

1. `sendFlatPack(chatId, null, …)` (lib/bot.js): for the chat-tree pack
   (key=null) — always send one document answer: send "⏳" (new message
   replying to /links, or — via new `origin.edit` arg — edit the button
   message keeping its keyboard), attach the .ged.txt file as a reply to
   that message with the marker, then edit "⏳" → "\u2063" (invisible
   separator); keyboard stays in the button case. Failure → "💥 … file"
   message. NOT_FOR_GRAFT is prepended to the file when missing (as tailDoc
   did) — diamond pack must stay non-graftable. Hero branch packs
   (key≠null, reply to a trigger) keep the old short-text/overflow behavior.
2. callback_query.js «flat»: single startMarkup build + answer + one
   sendFlatPack(chatId, null, "", 0, {edit:{message_id, markup}}) call.
3. message.js untouched.
4. Tests: dev/repl.mjs — /links chat pack (document + invisible edit),
   «-+=» button (edit ⏳ → документ → invisible with keyboard), «-+=» on
   focus (focflat) restored; dev/sync-check.mjs passes. dev/tg-db.json
   restored after runs.

Report:

- Done as planned. Files changed: tgcloud/lib/bot.js (sendFlatPack):
  new INVISIBLE const ("\u2063"), key=null path always documents,
  `origin` param for the button edit; NOT_FOR_GRAFT prepended when
  missing. tgcloud/handlers/callback_query.js: «flat» branch simplified
  to a single sendFlatPack call; removed now-unused chatFlatText import.
- Latent fix: handlers/callback_query.js focflat (button «-+=» on a
  trigger reply) crashed with "branchFlatText is not defined" — missing
  import from lib/bot.js added (pre-existing, introduced by the previous
  keyboard-unification work; repl reproduced it before the fix).
- Files named «Древо чата» use NOT_FOR_GRAFT + BOM; drop-in-reply safety
  re-checked: diamond pack in reply to a trigger is refused by
  cutAndGraft (parseTree → noGraft).
- VK mirror: implemented on user's request («Синхронизуй правку и для ВК бота»)
  — both sites in lunarreturns.js rewritten to mirror TG:
  1) /links + «связи» without reply (~5119): «⏳» answer, then the doc is
     attached to that same message by messages.edit (attachment+message
     together — editing without attachment drops attachments), then
     «⏳» → «\u2063»; upload failure → «💥 Не удалось выложить файл».
     Hero branch (key≠null) keeps the old text/overflow handling.
  2) chat button payload "flat" (~5721): editOrigin «⏳» (kb0 stays),
     vkUploadDoc «Древо чата.ged.txt» (BOM + withGraftMark), then edit to
     «\u2063» with attachment+kb0; failure → «💥» editOrigin. NOT_FOR_GRAFT
     is put INSIDE the file (mirror of the TG file layout; the diamond
     pack stays non-graftable).
- VK tests (`node dev/vk-repl.mjs --fresh`; scripted runs race srv.close()
  with the deferred upload — paced TTY input via `script -qec` + «exit»
  line needed); verified: «связи» → ⏳ → attachment+invisible edit;
  chat «-+=» button → same with keyboard intact; foc:flat (hero branch)
  unchanged; sync-check passes; `node lunarreturns.js test "..."` ok.
- deploy: `npx tgcloud status` → `push` (schema unchanged); VК deploy is
  manual (systemd, VK_TOKEN).
