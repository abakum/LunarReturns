#!/usr/bin/env node
// dev/est-diag.mjs — диагностика: состав чарта PDF при chartKeys
// levels=false (до коммита 555d64d) и levels=true (после) на древе
// с бездатными персонами (импорт выдаёт им фиктивные даты, birtAbt 15 = EST).
// Использование: node dev/est-diag.mjs
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import os from 'node:os';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'lr-est-'));

process.env.LR_DEV_DB = path.join(TMP, 'tg-db.json');
fs.cpSync(path.join(ROOT, 'dev', 'sdk-mock'), path.join(ROOT, 'node_modules', 'sdk'), { recursive: true });
const TG = await import(path.join(ROOT, 'tgcloud', 'lib', 'bot.js'));
const TGP = await import(path.join(ROOT, 'tgcloud', 'lib', 'parse.js'));

const CHAT = 1;

// Гедком: у отца две жены; вторая жена и её сын (полубрат героя) бездатные —
// импорт изобретёт им EST-даты (birtAbt 15). Тётя (сестра отца) тоже бездатная.
const GED = fs.readFileSync(path.join(ROOT, 'dev', 'est-test.ged'), 'utf8');
const g = TGP.parseGedcom(GED);
const rep = await TG.importGedcom(CHAT, g);
console.log('импорт:', JSON.stringify(rep));

// кого импорт наделил выдуманной (EST) датой
const all = await TG.personRows(CHAT);
const estKeys = all.filter(r => r.abt >= 15).map(r => r.n + ' ' + r.d);
console.log('\nEST-персоны (birtAbt>=15):', estKeys);

const pairs = await TG.linkPairs(CHAT);
const spPairs = await TG.focusSpousePairs(CHAT);
const sexMap = new Map(all.map(r => [r.n + ' ' + r.d, r.sex ?? null]));
const hero = 'Герой Героевич 1980-06-06';

for (const r of [1, 2]) {
    const blood = TG.focusListKeys(pairs, spPairs, hero, r, k => sexMap.get(k) ?? null, false);
    const levels = TG.focusListKeys(pairs, spPairs, hero, r, k => sexMap.get(k) ?? null, true);
    // chartKeys ПОСЛЕ ФИКСА: levels + примернодатированные из keys-ромба
    const approx = new Set(all.filter(x => x.abt).map(x => x.n + ' ' + x.d));
    const fixed = [...new Set([...levels, ...blood.filter(k => approx.has(k))])];
    const estIn = ks => ks.filter(k => estKeys.includes(k));
    console.log(`\n=== радиус ${r} ===`);
    console.log('кровный ромб (levels=false, ДО коммита):', blood);
    console.log('  → EST в ключах:', estIn(blood));
    console.log('уровневый (levels=true, ПОСЛЕ коммита):', levels);
    console.log('  → EST в ключах:', estIn(levels));
    console.log('ФИКС (levels + abt из ромба):', fixed);
    console.log('  → EST в ключах:', estIn(fixed));

    // что реально попадает в строки чарта (как в chartFor)
    for (const [name, keys] of [['ДО (blood)', blood], ['ПОСЛЕ (levels)', levels], ['ФИКС', fixed]]) {
        const res = await TG.chartFor(CHAT, keys, 'Тест', hero, r);
        console.log(`  чарт ${name}: ${res.persons} персон`);
    }
}
// состав строк чарта после коммита: имена строк (как бы выглядел PDF)
const lv = TG.focusListKeys(pairs, spPairs, hero, 1, k => sexMap.get(k) ?? null, true);
const after = await TG.chartFor(CHAT, lv, 'Тест', hero, 1);
console.log('\nPDF-строки после коммита (r1, levels):', JSON.stringify(after, null, 1).slice(0, 400));
// у фантомов не видно имён из ответа chartFor — выведем гедком-фрагмент для сравнения
console.log('\nгедком-фрагмент r1 (keys 🧬):');
console.log(await TG.gedcomText(CHAT, TG.focusListKeys(pairs, spPairs, hero, 1, k => sexMap.get(k) ?? null, false)));
