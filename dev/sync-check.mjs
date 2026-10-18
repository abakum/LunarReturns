#!/usr/bin/env node
// dev/sync-check.mjs — проверка синхронности чистой логики ВК (lunarreturns.js)
// и ТГ (tgcloud/lib): обе стороны исполняются на одинаковых сценариях
// (parseTrigger, parseGedcom, гедком-импорт/экспорт, связи/семьи/каскад) и
// результаты сравниваются дословно. Расхождение → вывод diff и exit 1.
// Использование: node dev/sync-check.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';
import { createRequire } from 'node:module';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-sync-'));

let failed = 0;
function cmp(what, vk, tg) {
    const a = typeof vk === 'string' ? vk : JSON.stringify(vk);
    const b = typeof tg === 'string' ? tg : JSON.stringify(tg);
    if (a === b) return;
    failed++;
    console.log('✗ ' + what);
    console.log('  ВК: ' + a);
    console.log('  ТГ: ' + b);
}

// ---- ВК: копия lunarreturns.js с дописанными тестовыми экспортами ----
// argv "test" уводит main() в тихий путь (печать юбилея) без токена и poll.
process.env.LR_DB = path.join(TMP, 'vk-db.json');
const vkHook = '\nmodule.exports.__test = { parseTrigger, parseGedcom, gedStats, addLink, ensureFam, ensureFamSingle, '
    + 'pairRecords, confirmPair, linkText, gedcomText, importGedcom, upsertRecord, refreshFams, deleteEventCascade, '
    + 'getDb: () => db, setDb: d => { db = d; } };\n';
const vkFile = path.join(TMP, 'vk.cjs');
fs.writeFileSync(vkFile, fs.readFileSync(path.join(ROOT, 'lunarreturns.js'), 'utf8') + vkHook);
const require = createRequire(import.meta.url);
const prevArgv = process.argv.slice();
process.argv = [process.argv[0], vkFile, 'test', ''];
const prevLog = console.log;
console.log = () => {};
let VK;
try { VK = require(vkFile).__test; } finally { console.log = prevLog; process.argv = prevArgv; }

// ---- ТГ: tgcloud/lib через sdk-mock (как dev/repl.mjs) ----
process.env.LR_DEV_DB = path.join(TMP, 'tg-db.json');
fs.cpSync(path.join(ROOT, 'dev', 'sdk-mock'), path.join(ROOT, 'node_modules', 'sdk'), { recursive: true });
const TG = await import(path.join(ROOT, 'tgcloud', 'lib', 'bot.js'));
const TGP = await import(path.join(ROOT, 'tgcloud', 'lib', 'parse.js'));
const { db, eq, and, or } = await import(path.join(ROOT, 'node_modules', 'sdk', 'db.js'));
const { links } = await import(path.join(ROOT, 'tgcloud', 'schema.js'));

// ============================== 1. parseTrigger ==============================
const TRIGGERS = [
    'Иван 1960-05-10',
    'Иван 1960-05-10 06:30',
    'Иван 1960-05-10 06:30 (Пермь)',
    'Иван 1960-05-10 12:30 МСК+2',
    'Иван 1960-05-10 12:30 UTC-3',
    'Иван+Мария 1983-06-04 (Пермь) 1990-01-01 (Казань)',
    'Иван 1960-05-10 06:30 2020-02-03 04:00',
    'Иван 1960-13-10',
    'Иван 1960-05-10 (Тьмутаракань)',
];
for (const t of TRIGGERS) cmp('parseTrigger ' + JSON.stringify(t), VK.parseTrigger(t), TGP.parseTrigger(t));

// ============================== 2. parseGedcom ==============================
const GEDCOM = [
    '0 HEAD', '1 GEDC', '2 VERS 5.5.1',
    '0 @I1@ INDI', '1 NAME Иван /Иванов/', '1 SEX M', '1 BIRT', '2 DATE 10 MAY 1960', '2 TIME 06:30',
    '0 @I2@ INDI', '1 NAME Мария /Иванова/', '1 SEX F', '1 BIRT', '2 DATE 1 MAR 1962',
    '0 @I3@ INDI', '1 NAME Пётр /Иванов/', '1 BIRT', '2 DATE 7 JUL 1985', '2 TIME 23:45',
    '1 DEAT', '2 DATE 3 FEB 2020', '2 TIME 05:15', '1 ADOP', '2 FAMC @F1@',
    '0 @F1@ FAM', '1 HUSB @I1@', '1 WIFE @I2@', '1 CHIL @I3@', '2 PEDI adopted',
    '1 MARR', '2 DATE 4 JUN 1983', '2 PLAC Пермь', '1 DIV', '2 DATE 1 JAN 1990',
    '0 TRLR',
].join('\n');
cmp('parseGedcom', VK.parseGedcom(GEDCOM), TGP.parseGedcom(GEDCOM));
cmp('gedStats', VK.gedStats(VK.parseGedcom(GEDCOM)), TGP.gedStats(TGP.parseGedcom(GEDCOM)));

// ==================== 3. импорт → полный экспорт гедкома ====================
const g = VK.parseGedcom(GEDCOM);
VK.setDb({ records: [] });
const vkImp = VK.importGedcom(1, g);
const tgImp = await TG.importGedcom(1, g);
cmp('importGedcom отчёт', vkImp, tgImp);
cmp('gedcomText после импорта', VK.gedcomText(1), await TG.gedcomText(1));

// ==================== 4. связи: reply-флоу, свадьба, каскад ====================
const CH = 2; // VK peerId = TG chatId
const persons = [
    { n: 'Отец', d: '1955-02-02' },
    { n: 'Мать', d: '1957-04-04', srcH: 3, srcM: 15 },
    { n: 'Дочь', d: '1982-09-09' },
];
const pair = { n: 'Отец+Мать', d: '1980-01-20', plac: 'Пермь' };
VK.setDb({ records: [] });
for (const p of persons) { VK.upsertRecord(p, CH); await TG.upsertEvent(CH, p); }
VK.upsertRecord(pair, CH); await TG.upsertEvent(CH, pair);

// связь родитель→ребёнок (как reply-триггер)
const pk = 'Отец ' + persons[0].d, mk = 'Мать ' + persons[1].d, ck = 'Дочь ' + persons[2].d;
const vkL1 = VK.addLink(CH, pk, ck, 'c').link;
const tgL1 = (await TG.addLink(CH, pk, ck, 'c')).link;
cmp('pairRecords (один родитель)', VK.pairRecords(CH, vkL1), await TG.pairRecords(CH, tgL1));

// второй родитель → семья; кандидаты свадьбы с обоими
const vkL2 = VK.addLink(CH, mk, ck, 'c').link;
const tgL2 = (await TG.addLink(CH, mk, ck, 'c')).link;
VK.ensureFam(CH, ck); await TG.ensureFam(CH, ck);
cmp('pairRecords (двое родителей)', VK.pairRecords(CH, vkL2), await TG.pairRecords(CH, tgL2));

// подтвердить свадьбу — сравнить текст связи и фрагмент гедкома
const vkCand = VK.pairRecords(CH, vkL2);
const tgCand = await TG.pairRecords(CH, tgL2);
VK.confirmPair(CH, vkL2, vkCand[0]);
await TG.confirmPair(CH, tgL2, tgCand[0]);
const tgFresh = await db.select().from(links).where(eq(links.id, tgL2.id)).get();
cmp('linkText после confirmPair', VK.linkText(CH, vkL2), await TG.linkText(CH, tgFresh));
cmp('gedcomText фрагмент', VK.gedcomText(CH, [pk, mk, ck]), await TG.gedcomText(CH, [pk, mk, ck]));
cmp('gedcomText весь чат', VK.gedcomText(CH), await TG.gedcomText(CH));

// каскад: удалить свадьбу-пару «Отец+Мать» — MARR уходит из семьи,
// кандидаты у оставшихся связей чистятся (как del1/👎 на записи пары)
const pairKey = pair.n + ' ' + pair.d;
const vkCand0 = VK.pairRecords(CH, vkL1);
await TG.setLinkCand(tgL1, vkCand0);
vkL1.pairCand = vkCand0;
const vdbPair = VK.getDb();
const vkPairRec = vdbPair.records.find(r => r.peerId === CH && r.n + ' ' + r.d === pairKey);
VK.deleteEventCascade(CH, vkPairRec);
await TG.deleteEventCascade(CH, pairKey);
const tgL1f = await db.select().from(links).where(eq(links.id, tgL1.id)).get();
cmp('linkText: pairCand после удаления пары', VK.linkText(CH, vkL1), await TG.linkText(CH, tgL1f));
cmp('gedcomText: MARR после удаления пары', VK.gedcomText(CH), await TG.gedcomText(CH));

// каскад: удалить персону «Мать» — связи падают, семья остаётся с «Отцом»
const vdbP = VK.getDb();
const vkMRec = vdbP.records.find(r => r.peerId === CH && r.n === 'Мать');
VK.deleteEventCascade(CH, vkMRec);
await TG.deleteEventCascade(CH, mk);
cmp('gedcomText после удаления персоны', VK.gedcomText(CH), await TG.gedcomText(CH));

if (failed) { console.log('\n✗ расхождений: ' + failed); process.exit(1); }
console.log('✓ ВК и ТГ синхронны (' + TRIGGERS.length + ' триггеров, гедком-импорт/экспорт, связи/семьи/каскад)');
