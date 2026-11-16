#!/usr/bin/env node
// Actual-handler regressions; all DBs, generated modules and REPL logs stay in /tmp/kilo.
// Valid GED/PDF exports and forged cross-chat/bot replies are not covered by the REPL protocol.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { REPLY_TARGET_ERROR } from '../tgcloud/lib/text.cjs';

const root = new URL('../', import.meta.url);
const tmp = fs.mkdtempSync('/tmp/kilo/lr-reply-search-');
const marker = '#not for cut and graft';
let sequence = 0;
const family = [
    '-Father 1950-01-01', '+1979~', 'Mother 1952-02-02',
    '--Hero 1980-03-03', '--Brother 1982~ 2020~', '==Sister 1984-04-04',
    '-BrotherOutside 1986-05-05', '-bellamy 1990-01-01', '-startrek 1991-01-01',
].join('\\n');
const extendedFamily = [
    '-Grandfather 1920-01-01', '+1949~', 'Grandmother 1922-02-02',
    '--Father 1950-01-01', '++1979~', 'Mother 1952-02-02',
    '---Hero 1980-03-03', '---Brother 1982-04-04',
    '--Uncle 1954-05-05',
].join('\\n');

function run(platform, tag, commands) {
    const base = path.join(tmp, `${platform}-${++sequence}-${tag}`);
    const result = spawnSync(process.execPath,
        [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs', '--fresh',
            ...(platform === 'tg' ? ['--private'] : [])],
        { cwd: root, env: { ...process.env, TMPDIR: tmp, LR_DEV_DB: base + '.json', LR_DB: base + '.db',
            LR_VKOFF: String(12000 + process.pid % 20000 + sequence) },
        input: commands.join('\n') + '\n', encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    const log = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(base + '.log', log);
    assert.ifError(result.error);
    assert.equal(result.status, 0, base + '.log\n' + log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError|ECONNREFUSED|EADDRINUSE/, base + '.log');
    const entries = [...log.matchAll(/\[(\d+)\] (ты:|sendMessage:[^\n]*|текст →)\n((?:    [^\n]*\n)*)/g)]
        .map(m => ({ id: m[1], user: m[2] === 'ты:', body: m[3],
            text: m[3].split('\n').filter(l => l.startsWith('    ')).map(l => l.slice(4))
                .filter(l => !/^\[\d+\.\d+\] /.test(l) && l !== 'клавиатура →').join('\n').trimEnd() }));
    let data;
    const tables = ['indi', 'fam', 'chil', platform === 'tg' ? 'edges' : 'links', 'settings'];
    if (platform === 'tg') {
        const db = fs.existsSync(base + '.json') ? JSON.parse(fs.readFileSync(base + '.json', 'utf8')) : {};
        data = Object.fromEntries(tables.map(t => [t, db[t] || []]));
    } else {
        const db = new DatabaseSync(base + '.db');
        data = Object.fromEntries(tables.map(t => [t, db.prepare('SELECT * FROM ' + t).all().map(r => ({ ...r }))]));
        db.close();
    }
    return { log, entries, data, base };
}

function response(result, query, occurrence = 0) {
    const hits = result.entries.map((e, i) => e.user && e.text === query ? i : -1).filter(i => i >= 0);
    assert.ok(hits[occurrence] !== undefined, 'Missing input ' + query + '\n' + result.log);
    const out = [];
    for (let i = hits[occurrence] + 1; i < result.entries.length && !result.entries[i].user; i++) out.push(result.entries[i]);
    assert.ok(out.length, 'Missing response ' + query + '\n' + result.log);
    return out;
}

function button(log, label) {
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const hit = [...log.matchAll(new RegExp('\\[(\\d+)\\.(\\d+)\\] ' + escaped + '(?=  |\\n|$)', 'g'))].at(-1);
    assert.ok(hit, 'Missing button ' + label + '\n' + log);
    return '/' + hit[1] + ' ' + hit[2];
}

for (const platform of ['tg', 'vk']) {
    const setup = [family, 'Hero 1980-03-03', '/Hero'];
    const baseline = run(platform, 'baseline', setup);
    const hero = baseline.entries.find(e => e.user && e.text === 'Hero 1980-03-03');
    assert.ok(hero, baseline.log);
    const reply = '>' + hero.id + ' ';
    const cardReply = '>' + response(baseline, '/Hero')[0].id + ' ';
    const searches = ['/Brother', '/ брат', '/bRoThEr #ignored', '/Mother', '/Father+', '/Sister',
        '/BrotherOutside', '/missingzz', '/#comment', '/bellamy', '/startrek', '/ bell'];
    const searched = run(platform, 'searches', [...setup, '/missingzz', '/BrotherOutside',
        ...searches.map(q => reply + q), cardReply + '/Brother']);
    assert.deepEqual(searched.data, baseline.data, platform + ': searches preserve people, families, links and settings');
    const scoped = q => response(searched, q, ['/missingzz', '/BrotherOutside'].includes(q) ? 1 : 0)[0];
    for (const q of ['/Brother', '/ брат', '/bRoThEr #ignored']) {
        assert.equal(scoped(q).text, marker + '\nBrother 1982~ 2020~ брат', platform + ': ' + q);
        assert.doesNotMatch(scoped(q).body, /\[\d+\.\d+\]/, 'Search line must not become a jubilee card');
    }
    assert.equal(response(searched, '/Brother', 1)[0].text, scoped('/Brother').text,
        platform + ': bot-card and user-trigger replies resolve the same scope');
    assert.match(scoped('/Mother').text, /Mother 1952-02-02 мать/);
    assert.match(scoped('/Father+').text, /Father\+Mother 1979~/);
    assert.match(scoped('/Sister').text, /Sister 1984-04-04 сестра/);
    for (const q of ['/BrotherOutside', '/missingzz', '/#comment', '/bellamy', '/startrek', '/ bell'])
        assert.equal(scoped(q).text, 'Ничего не найдено в радиусе 1', platform + ': scoped ' + q);
    const empty = response(searched, '/missingzz')[0];
    assert.equal(empty.text, 'Ничего не найдено');
    assert.doesNotMatch(empty.body, /\[\d+\.\d+\]/);
    assert.match(response(searched, '/BrotherOutside')[0].text, /BrotherOutside 1986-05-05/);
    assert.match(response(searched, '/BrotherOutside')[0].body, /\[\d+\.\d+\]/, 'Global single match retains card buttons');

    for (const chain of [0, 1]) {
        const adaptiveSetup = [extendedFamily, '/fynny' + chain, 'Hero 1980-03-03'];
        const adaptiveBaseline = run(platform, 'adaptive-baseline-' + chain, adaptiveSetup);
        const target = adaptiveBaseline.entries.find(e => e.user && e.text === 'Hero 1980-03-03');
        assert.ok(target, adaptiveBaseline.log);
        const kinQuery = chain ? '/ брат отца' : '/ дядя';
        const queries = [kinQuery, kinQuery + ' #1', '/unknown#2', '/Uncle', '/Uncle #2', '/Uncle#2', '/Unc#2',
            '/unknown#0', '/unknown#9', '/#1', '/#2', '/#9', '/ #2'];
        const adaptive = run(platform, 'adaptive-search-' + chain,
            [...adaptiveSetup, ...queries.map(q => '>' + target.id + ' ' + q)]);
        const context = platform + ': fynny' + chain;
        const uncle = marker + '\nUncle 1954-05-05 ' + (chain ? 'брат отца' : 'дядя');
        assert.equal(response(adaptive, kinQuery)[0].text, uncle, context + ': inferred R2');
        assert.equal(response(adaptive, '/Uncle #2')[0].text, uncle, context + ': explicit R2');
        assert.equal(response(adaptive, '/Uncle#2')[0].text, uncle, context + ': compact explicit R2');
        assert.equal(response(adaptive, '/Unc#2')[0].text, uncle, context + ': compact prefix explicit R2');
        for (const q of [kinQuery + ' #1', '/Uncle', '/unknown#0'])
            assert.equal(response(adaptive, q)[0].text, 'Ничего не найдено в радиусе 1', context + ': ' + q);
        assert.equal(response(adaptive, '/unknown#2')[0].text, 'Ничего не найдено в радиусе 2', context);
        assert.equal(response(adaptive, '/unknown#9')[0].text, 'Ничего не найдено в радиусе 9', context);
        const allOne = response(adaptive, '/#1')[0].text;
        const allTwo = response(adaptive, '/#2')[0].text;
        assert.ok(allOne.startsWith(marker + '\n'), context);
        assert.match(allOne, /Hero 1980-03-03/);
        assert.doesNotMatch(allOne, /Uncle/);
        assert.ok(allTwo.includes(uncle.slice(marker.length + 1)), context);
        assert.match(allTwo, /Father\+Mother 1979~/);
        assert.match(response(adaptive, '/#9')[0].text, /Grandfather/);
        assert.equal(response(adaptive, '/ #2')[0].text, 'Ничего не найдено в радиусе 2', context);
        for (const q of queries)
            assert.doesNotMatch(response(adaptive, q)[0].body, /\[\d+\.\d+\]/, context + ': plain search result');
        assert.deepEqual(adaptive.data, adaptiveBaseline.data,
            context + ': adaptive searches preserve people, families, links and settings');
    }

    const ordinary = run(platform, 'ordinary', [...setup, '/bellamy', '/startrek', '/ bell',
        reply + 'HeroRenamed 1980-03-03', '/HeroRenamed']);
    for (const q of ['/bellamy', '/startrek', '/ bell'])
        assert.match(response(ordinary, q)[0].text, /(?:bellamy|startrek) 199[01]-01-01/);
    assert.match(response(ordinary, '/HeroRenamed')[0].text, /HeroRenamed 1980-03-03/);
    assert.notDeepEqual(ordinary.data.indi, baseline.data.indi, 'Ordinary reply edit still mutates the selected person');

    const commands = ['/', '/start', '/bell', '/bell5', '/links', '/trim0', '/trim1', '/fynny0', '/fynny1',
        '/StArT@Test_bot', '/BeLl@Test_bot', '/BeLl5@Test_bot', '/LiNkS@Test_bot', '/TrIm0@Test_bot', '/FyNnY1@Test_bot'];
    const routed = run(platform, 'commands', [...setup, ...commands, ...commands.map(q => reply + q)]);
    for (const q of commands) for (const occurrence of [0, 1]) {
        const output = response(routed, q, occurrence).map(e => e.text).join('\n');
        assert.doesNotMatch(output, /Ничего не найдено/, platform + ': command routed as search: ' + q);
        assert.ok(output.length, q);
    }
    const invalidSetup = [...setup, 'Unrecognized quote'];
    const invalidProbe = run(platform, 'invalid-probe', invalidSetup);
    const invalidId = invalidProbe.entries.find(e => e.user && e.text === 'Unrecognized quote').id;
    const invalidQueries = ['/Brother', '/ брат', '/gedcom', '/GEDCOM5@Test_bot'];
    const invalid = run(platform, 'invalid', [...invalidSetup, ...invalidQueries.map(q => '>' + invalidId + ' ' + q)]);
    for (const q of invalidQueries) assert.equal(response(invalid, q)[0].text, REPLY_TARGET_ERROR);
    assert.deepEqual(invalid.data, invalidProbe.data);
    const weddingSetup = [...setup, 'Father+Mother 1979~'];
    const weddingProbe = run(platform, 'wedding-probe', weddingSetup);
    const weddingId = weddingProbe.entries.find(e => e.user && e.text === 'Father+Mother 1979~').id;
    const wedding = run(platform, 'wedding', [...weddingSetup, '>' + weddingId + ' /Brother']);
    assert.equal(response(wedding, '/Brother')[0].text, REPLY_TARGET_ERROR);
    assert.deepEqual(wedding.data, weddingProbe.data);
    const stale = run(platform, 'stale', [...setup, reply + 'HeroRenamed 1980-03-03', reply + '/Brother']);
    assert.equal(response(stale, '/Brother')[0].text, REPLY_TARGET_ERROR);
    const blank = run(platform, 'empty-chat', ['/missingzz']);
    assert.equal(response(blank, '/missingzz')[0].text, 'Ничего не найдено');
    assert.doesNotMatch(response(blank, '/missingzz')[0].body, /\[\d+\.\d+\]/);

    const romanovCommands = ['!txt dev/fixtures/Romanov_family.ged.txt', '/2 2', '/Алексей', '/bell'];
    let romanov = run(platform, 'romanov', romanovCommands);
    assert.match(romanov.log, /древо: персон 57, семей 13, детей 43/);
    assert.match(response(romanov, '/bell')[0].text, /Романов/);
    romanovCommands.push('Алексей Алексеевич Романов 1654-02-05', '/Алексей Алексеевич');
    romanov = run(platform, 'romanov-focus', romanovCommands);
    romanovCommands.push(button(romanov.log, '🔔'));
    romanov = run(platform, 'romanov-open-bell', romanovCommands);
    romanovCommands.push(button(romanov.log, '2'));
    romanov = run(platform, 'romanov-radius', romanovCommands);
    romanovCommands.push(button(romanov.log, '🔔'));
    romanov = run(platform, 'romanov-bell', romanovCommands);
    assert.match(romanov.entries.at(-1).text, /Алексей/);
    const romanovHero = romanov.entries.find(e => e.user && e.text === 'Алексей Алексеевич Романов 1654-02-05');
    romanovCommands.push('>' + romanovHero.id + ' /Алексей #5', '>' + romanovHero.id + ' / брат');
    const romanovSearch = run(platform, 'romanov-search', romanovCommands);
    assert.match(response(romanovSearch, '/Алексей #5')[0].text, /Алексей Алексеевич Романов/);
    assert.match(response(romanovSearch, '/ брат')[0].text, /брат/);
    assert.deepEqual(romanovSearch.data, romanov.data, 'Romanov reply search preserves imported tree');
    console.log(platform + ': actual-handler adaptive radius (fynny0/1), errors, commands, no mutation, ordinary edit, Romanov radius/bell OK');
}
console.log('Reply search REPL logs and isolated DBs: ' + tmp);
