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
const expansionGed = path.join(tmp, 'expansion.ged');
const expansionPeople = [
    ['GreatGrandmother', 'F', '1900', null, 'F0'],
    ['Grandfather', 'M', '1920', null, 'F1'],
    ['Grandmother', 'F', '1922', 'F0', 'F1'],
    ['Father', 'M', '1950', 'F1', 'F2'], ['Mother', 'F', '1952', null, 'F2'],
    ['Hero', 'M', '1980', 'F2', 'F3'], ['Brother', 'M', '1982', 'F2'],
    ['Sister', 'F', '1984', 'F2'], ['UnknownSibling', null, '1986', 'F2'],
    ['HeroWife', 'F', '1981', null, 'F3'],
    ['Son', 'M', '2000', 'F3', 'F4'], ['Daughter', 'F', '2002', 'F3', 'F5'],
    ['UnknownChild', null, '2004', 'F3', 'F6'],
    ['SonWife', 'F', '2001', null, 'F4'], ['DaughterHusband', 'M', '2001', null, 'F5'],
    ['UnknownPartner', null, '2005', null, 'F6'],
    ['Uncle', 'M', '1954', 'F1'],
];
fs.writeFileSync(expansionGed, ['0 HEAD', '1 SOUR ReplySearchExpansion', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8',
    ...expansionPeople.flatMap(([name, sex, year, child, spouse], i) => [`0 @I${i + 1}@ INDI`, '1 NAME ' + name,
        ...(sex ? ['1 SEX ' + sex] : []), '1 BIRT', '2 DATE 1 JAN ' + year,
        ...(child ? ['1 FAMC @' + child + '@'] : []), ...(spouse ? ['1 FAMS @' + spouse + '@'] : [])]),
    ...[
        ['F0', null, 1, [3]], ['F1', 2, 3, [4, 17]], ['F2', 4, 5, [6, 7, 8, 9]],
        ['F3', 6, 10, [11, 12, 13]], ['F4', 11, 14, []], ['F5', 15, 12, []], ['F6', 13, 16, []],
    ].flatMap(([id, husband, wife, children]) => ['0 @' + id + '@ FAM',
        ...(husband ? ['1 HUSB @I' + husband + '@'] : []), ...(wife ? ['1 WIFE @I' + wife + '@'] : []),
        ...children.map(i => '1 CHIL @I' + i + '@')]), '0 TRLR', ''].join('\n'));

function run(platform, tag, commands) {
    const base = path.join(tmp, `${platform}-${++sequence}-${tag}`);
    const result = spawnSync(process.execPath,
        [platform === 'tg' ? 'dev/repl.mjs' : 'dev/vk-repl.mjs', '--fresh',
            ...(platform === 'tg' ? ['--private'] : [])],
        { cwd: root, env: { ...process.env, TMPDIR: tmp, LR_DEV_DB: base + '.json', LR_DB: base + '.db',
            LR_VK_TRACE: base + '.trace.jsonl',
            LR_VKOFF: String(12000 + process.pid % 20000 + sequence) },
        input: commands.join('\n') + '\n', encoding: 'utf8', timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
    const log = (result.stdout || '') + (result.stderr || '');
    fs.writeFileSync(base + '.log', log);
    assert.ifError(result.error);
    assert.equal(result.status, 0, base + '.log\n' + log);
    assert.doesNotMatch(log, /ERROR:|TypeError|ReferenceError|ECONNREFUSED|EADDRINUSE/, base + '.log');
    const entries = [...log.matchAll(/\[(\d+)\] (ты:|sendMessage:[^\n]*|текст →)\n((?:    [^\n]*\n)*)/g)]
        .map(m => ({ id: m[1], user: m[2] === 'ты:', edited: m[2] === 'текст →', body: m[3],
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
    query = query.replace(/\\n/g, '\n').trim();
    const hits = result.entries.map((e, i) => e.user && e.text === query ? i : -1).filter(i => i >= 0);
    assert.ok(hits[occurrence] !== undefined, 'Missing input ' + query + '\n' + result.log);
    const out = [];
    for (let i = hits[occurrence] + 1; i < result.entries.length && !result.entries[i].user; i++) out.push(result.entries[i]);
    assert.ok(out.length, 'Missing response ' + query + '\n' + result.log);
    // Keep raw output for UI assertions; content assertions ignore only the progress metadata.
    return [...new Set(out.map(e => e.id))].map(id => {
        const versions = out.filter(e => e.id === id);
        const first = versions[0], final = versions.at(-1);
        const hasProgress = /#[1-9] \/fynny[01](?:\n[\s\S]*)?\n⏳$/.test(first.text);
        if (hasProgress) {
            assert.equal(first.edited, false, query + ': progress is a new message');
            assert.ok(versions.length >= 2, query + ': missing final edit');
            assert.ok(versions.slice(1).every(e => e.edited), query + ': update the same message');
            assert.equal(final.id, first.id, query + ': final ID');
            assert.doesNotMatch(final.text, /⏳/, query + ': final clock removed');
            assert.ok(final.text.startsWith(first.text.slice(0, -1)), query + ': retain header');
        }
        return { ...final, rawText: final.text, initial: first, versions,
            text: hasProgress ? final.text.slice(first.text.length - 1) : final.text };
    });
}

function progress(result, query, radius, chain, occurrence = 0) {
    const final = response(result, query, occurrence)[0];
    const lines = query.replace(/\\n/g, '\n').trim().split(/\r?\n/);
    const last = lines.findLastIndex(line => /^[\/|!]/.test(line));
    assert.ok(last >= 0, query + ': condition in header');
    const hash = lines[last].indexOf('#');
    lines[last] = (hash < 0 ? lines[last] : lines[last].slice(0, hash)) + '#' + radius + ' /fynny' + chain;
    const head = lines.slice(0, last + 1).join('\n');
    assert.ok(final.initial.text === head + '\n⏳' || final.initial.text.startsWith(head + '\n\n')
        || final.initial.text.startsWith(head + '\nПолное разложение'), query + ': initial range and effective mode');
    assert.ok(final.initial.text.endsWith('\n⏳'), query + ': initial clock');
    assert.equal(final.rawText, final.initial.text.slice(0, -1) + final.text, query + ': actual final full text');
    return final;
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
        assert.equal(scoped(q).text, 'Ничего не найдено', platform + ': scoped ' + q);
    for (const q of searches)
        progress(searched, q, 1, q === '/ брат' ? 1 : 0, ['/missingzz', '/BrotherOutside'].includes(q) ? 1 : 0);
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
        const kinQueries = ['/ брат отца', '/ дядя'];
        const queries = [...kinQueries.flatMap(q => [q, q + '#1', q + '#2', q + '#ignored']), '/ брат',
            '/unknown#2', '/Uncle', '/Uncle #2', '/Uncle#2', '/Unc#2',
            '/unknown#0', '/unknown#9', '/#1', '/#2', '/#9', '/ #2',
            '/ бабушка матери', '/ жена тёти', '/ племянница матери'];
        const adaptive = run(platform, 'adaptive-search-' + chain,
            [...adaptiveSetup, ...queries.map(q => '>' + target.id + ' ' + q)]);
        const context = platform + ': fynny' + chain;
        for (const q of ['/ жена тёти']) {
            const rejected = response(adaptive, q)[0];
            assert.match(rejected.text, /^Нет такой родственной связи/, context);
            assert.doesNotMatch(rejected.initial.text, /⏳|fynny=/, context + ': rejected before list');
            assert.ok(rejected.text.length <= 4000, context + ': bounded diagnostic');
        }
        for (const q of ['/ бабушка матери', '/ племянница матери']) {
            assert.equal(progress(adaptive, q, 3, 1).text, 'Ничего не найдено', context + ': repaired ' + q);
        }
        const uncle = marker + '\nUncle 1954-05-05 ' + (chain ? 'брат отца' : 'дядя');
        for (const q of kinQueries) {
            const expected = marker + '\nUncle 1954-05-05 ' + (q === '/ дядя' ? 'дядя' : 'брат отца');
            for (const suffix of ['', '#2', '#ignored'])
                assert.equal(response(adaptive, q + suffix)[0].text, expected, context + ': automatic labels ' + q + suffix);
            assert.equal(response(adaptive, q + '#1')[0].text, 'Ничего не найдено',
                context + ': explicit R1 excludes uncle ' + q);
        }
        assert.equal(response(adaptive, '/ брат')[0].text, marker + '\nBrother 1982-04-04 брат',
            context + ': sibling chain search');
        assert.equal(response(adaptive, '/Uncle #2')[0].text, uncle, context + ': explicit R2');
        assert.equal(response(adaptive, '/Uncle#2')[0].text, uncle, context + ': compact explicit R2');
        assert.equal(response(adaptive, '/Unc#2')[0].text, uncle, context + ': compact prefix explicit R2');
        for (const q of ['/Uncle', '/unknown#0'])
            assert.equal(response(adaptive, q)[0].text, 'Ничего не найдено', context + ': ' + q);
        assert.equal(response(adaptive, '/unknown#2')[0].text, 'Ничего не найдено', context);
        assert.equal(response(adaptive, '/unknown#9')[0].text, 'Ничего не найдено', context);
        const allOne = response(adaptive, '/#1')[0].text;
        const allTwo = response(adaptive, '/#2')[0].text;
        assert.ok(allOne.startsWith(marker + '\n'), context);
        assert.match(allOne, /Hero 1980-03-03/);
        assert.doesNotMatch(allOne, /Uncle/);
        assert.ok(allTwo.includes(uncle.slice(marker.length + 1)), context);
        assert.match(allTwo, /Father\+Mother 1979~/);
        assert.match(response(adaptive, '/#9')[0].text, /Grandfather/);
        assert.equal(response(adaptive, '/ #2')[0].text, allTwo, context + ': spaced full list');
        for (const q of queries) {
            if (['/ бабушка матери', '/ жена тёти', '/ племянница матери'].includes(q)) continue;
            const explicit = q.match(/#([0-9]+)$/);
            const radius = explicit ? Math.max(1, Number(explicit[1])) : kinQueries.some(k => q.startsWith(k)) ? 2 : 1;
            const mode = q.startsWith('/ брат') ? 1 : q.startsWith('/ дядя') ? 0 : chain;
            progress(adaptive, q, radius, mode);
        }
        for (const q of queries)
            assert.doesNotMatch(response(adaptive, q)[0].body, /\[\d+\.\d+\]/, context + ': plain search result');
        assert.deepEqual(adaptive.data, adaptiveBaseline.data,
            context + ': adaptive searches preserve people, families, links and settings');
    }

    for (const chain of [0, 1]) {
        const expansionSetup = ['!ged ' + expansionGed, '/2 2', '/fynny' + chain,
            'Father 1950-01-01', 'Hero 1980-01-01'];
        const expansionBaseline = run(platform, 'expansion-baseline-' + chain, expansionSetup);
        const target = expansionBaseline.entries.find(e => e.user && e.text === 'Hero 1980-01-01');
        const father = expansionBaseline.entries.find(e => e.user && e.text === 'Father 1950-01-01');
        assert.ok(target && father, expansionBaseline.log);
        const cases = [
            { q: '/ ребёнок ребёнка ребёнка ребёнка', r: 4, empty: true },
            { q: '/ двоюродный дед\\n| двоюродная бабушка', r: 3, mode: 0, empty: true },
            { q: '/ двоюродный дед\\n| двоюродная бабушка#4', r: 4, mode: 0, empty: true },
            { q: '/ сиблинг родителя родителя', r: 3, empty: true },
            { q: '/ родитель', r: 1, yes: [/Father 1950-01-01 отец/, /Mother 1952-01-01 мать/], no: /Grandfather/ },
            { q: '/ ребёнок', r: 1, yes: [/Son 2000-01-01 сын/, /Daughter 2002-01-01 дочь/, /UnknownChild 2004-01-01 ребёнок/] },
            { q: '/ сиблинг', r: 1, yes: [/Brother 1982-01-01 брат/, /Sister 1984-01-01 сестра/, /UnknownSibling 1986-01-01 сиблинг/] },
            { q: '/ супруг ребёнка', r: 2, yes: [/SonWife 2001-01-01 жена сына/, /DaughterHusband 2001-01-01 муж дочки/, /UnknownPartner 2005-01-01 супруг ребёнка/] },
            { q: '/ бабушка отца', r: 3, yes: [/GreatGrandmother \S+ мать матери отца/] },
            { q: '/ прародитель', r: 2, yes: [/Grandfather/, /Grandmother/], no: /GreatGrandmother/ },
            { q: '/ прародитель#1', r: 1, empty: true },
            { q: '/ родитель\\n| дядя', r: 2,
                yes: [/Father 1950-01-01 отец/, /Mother 1952-01-01 мать/, /Uncle 1954-01-01 брат отца/], no: /Hero 1980/ },
            { q: '/#2\\n/ родитель', r: 2, yes: [/Father/, /Mother/], no: /Hero 1980/ },
            { q: '/#2\\n! родитель', r: 2, yes: [/Hero 1980/], no: /Father 1950|Mother 1952/ },
            { q: '/ребёнок', r: 1, mode: 1, empty: true },
            { q: '/Иван ребёнок', r: 1, mode: chain, empty: true },
            { q: '/ ребёнок Иван', r: 1, mode: chain, empty: true },
        ];
        const diagnostic = '/ родитель\\n| двоюрод';
        const longDiagnostic = '/ родитель\\n| жена тёти' + ' матери'.repeat(180);
        const childQuery = '/ ребёнок#1';
        const expansion = run(platform, 'expansion-' + chain, [...expansionSetup,
            ...cases.map(c => '>' + target.id + ' ' + c.q),
            '>' + father.id + ' ' + childQuery,
            '>' + target.id + ' ' + diagnostic, '>' + target.id + ' ' + longDiagnostic,
            '/ родитель', '/ сиблинг', '/ супруг ребёнка']);
        for (const c of cases) {
            const out = progress(expansion, c.q, c.r, c.mode ?? 1);
            if (c.empty) assert.equal(out.text, 'Ничего не найдено', platform + ': ' + c.q);
            for (const pattern of c.yes || []) assert.match(out.text, pattern, platform + ': ' + c.q);
            if (c.no) assert.doesNotMatch(out.text, c.no, platform + ': ' + c.q);
            assert.doesNotMatch(out.body, /\[\d+\.\d+\]/, platform + ': expansion is a plain list');
        }
        const children = progress(expansion, childQuery, 1, 1);
        for (const name of ['Hero', 'Brother', 'Sister', 'UnknownSibling']) assert.match(children.text, new RegExp(name));
        for (const q of [diagnostic, longDiagnostic]) {
            const out = response(expansion, q)[0];
            assert.match(out.text, /^(?:Нет такой родственной связи|Не удалось разобрать родственную связь)/,
                platform + ': mixed/invalid chain');
            assert.doesNotMatch(out.initial.text, /⏳|\/fynny[01]/, platform + ': diagnostic before progress');
            assert.ok(out.versions.every(e => e.text.length <= 4000), platform + ': bounded expansion diagnostic');
        }
        for (const q of ['/ родитель', '/ сиблинг', '/ супруг ребёнка']) {
            const out = response(expansion, q, 1)[0];
            assert.equal(out.text, 'Ничего не найдено', platform + ': global remains literal ' + q);
            assert.doesNotMatch(out.initial.text, /⏳|\/fynny[01]/);
        }
        assert.deepEqual(expansion.data, expansionBaseline.data,
            platform + ': expansions, diagnostics and literals never mutate domain/settings');
    }

    const multilineCases = [
        { q: '/Brother\\n/ ther', yes: ['Brother'], no: ['Sister'] },
        { q: '/Brother\\n/ther', empty: true },
        { q: '/missingzz\\n|/Sister', empty: true },
        { q: '/Brother\\n/ missingzz\\n|Sister', yes: ['Sister'], no: ['Brother'] },
        { q: '/Brother\\n|Sister\\n!Brother', yes: ['Sister'], no: ['Brother'] },
        { q: '/Brother\\n|Sister\\n! Sister', yes: ['Brother'], no: ['Sister'] },
        { q: '/missingzz\\n| ther', yes: ['Brother', 'Father', 'Mother'], no: ['Sister'] },
        { q: '/Brother#first line\\n|Sister#second line\\n!Outside#ignored', yes: ['Brother', 'Sister'] },
        { q: '# leading comment\\n\\n/Brother\\n|Sister\\n# trailing comment', yes: ['Brother', 'Sister'] },
    ];
    const syntaxCases = [
        ['/Brother\\nSister', 2],
        ['/Brother\\n!', 2], ['/Brother\\n/ #2', 2],
        ['/Brother\\n|#ignored', 2], ['# comment\\n/Brother\\nplain text', 3],
    ];
    const multilineQueries = [...multilineCases.map(c => c.q), ...syntaxCases.map(c => c[0])];
    const multiline = run(platform, 'multiline', [...setup,
        ...multilineQueries, ...multilineQueries.map(q => reply + q)]);
    for (const occurrence of [0, 1]) {
        for (const c of multilineCases) {
            const out = response(multiline, c.q, occurrence)[0];
            if (c.empty) assert.equal(out.text, 'Ничего не найдено', platform + ': ' + c.q);
            for (const name of c.yes || []) assert.match(out.text, new RegExp(name), platform + ': ' + c.q);
            for (const name of c.no || []) assert.doesNotMatch(out.text, new RegExp(name), platform + ': ' + c.q);
            if (occurrence) progress(multiline, c.q, 1, 0, occurrence);
        }
        for (const [q, line] of syntaxCases) {
            const rejected = response(multiline, q, occurrence)[0];
            assert.match(rejected.text, new RegExp('^Ошибка поискового запроса: строка ' + line + ': .+'));
            assert.doesNotMatch(rejected.initial.text, /⏳|\/fynny[01]/, q + ': syntax error before progress');
        }
    }
    assert.deepEqual(multiline.data, baseline.data, platform + ': global/reply multiline errors and filters do not mutate');

    for (const chain of [0, 1]) {
        const multiSetup = [extendedFamily, '/fynny' + chain, 'Hero 1980-03-03'];
        const multiBaseline = run(platform, 'multiline-mode-baseline-' + chain, multiSetup);
        const target = multiBaseline.entries.find(e => e.user && e.text === 'Hero 1980-03-03');
        const cases = [
            { q: '/ брат\\n| сестра#2', r: 2, mode: 1, yes: /Brother/ },
            { q: '/ дядя\\n| брат отца', r: 2, mode: 0, yes: /Uncle 1954-05-05 дядя/, no: /брат отца/ },
            { q: '/ двоюродный', r: 3, mode: 0, empty: true },
            { q: '/ двоюродный брат', r: 3, mode: 0, empty: true },
            { q: '/ двоюродный#2', r: 2, mode: 0, empty: true },
            { q: '/Uncle\\n! троюродный', r: 5, mode: 0, yes: /Uncle/ },
            { q: '/Uncle\\n! троюродный брат', r: 5, mode: 0, yes: /Uncle/ },
            { q: '/ брат\\n| брат отца', r: 2, mode: 1, yes: /Uncle 1954-05-05 брат отца/ },
            { q: '/Uncle#1\\n|Brother#2\\n!missingzz#ignored', r: 2, mode: chain, yes: /Uncle/, no: /Grandfather/ },
            { q: '/Uncle#1\\n! троюродный брат', r: 1, mode: 0, empty: true },
            { q: '/#2\\n!Brother', r: 2, mode: chain, yes: /Uncle/, no: /Brother/ },
            { q: '/#2 /fynny' + (1 - chain) + '\\n!Brother', r: 2, mode: chain, yes: /Uncle/, no: /Brother/ },
            { q: '/Uncle#2 /fynny' + (1 - chain), r: 2, mode: chain, yes: /Uncle/ },
            { q: '/#2 /fynny' + (1 - chain), r: 2, mode: chain, yes: /Grandfather/ },
            { q: '/Brother\\n| бабушка матери', r: 3, mode: 1, yes: /Brother/ },
            { q: '/ бабушка матери\\n|Brother', r: 3, mode: 1, yes: /Brother/ },
        ];
        const impossible = ['/Brother\\n! жена тёти'];
        const checked = run(platform, 'multiline-modes-' + chain, [...multiSetup,
            ...cases.map(c => '>' + target.id + ' ' + c.q),
            ...impossible.map(q => '>' + target.id + ' ' + q)]);
        for (const c of cases) {
            const out = progress(checked, c.q, c.r, c.mode);
            if (c.empty) assert.equal(out.text, 'Ничего не найдено');
            if (c.yes) assert.match(out.text, c.yes, platform + ': ' + c.q);
            if (c.no) assert.doesNotMatch(out.text, c.no, platform + ': ' + c.q);
            assert.doesNotMatch(out.body, /\[\d+\.\d+\]/, c.q + ': plain reply results');
        }
        for (const q of impossible) {
            const out = response(checked, q)[0];
            assert.match(out.text, /^Нет такой родственной связи/, platform + ': impossible branch ' + q);
            assert.doesNotMatch(out.initial.text, /⏳|\/fynny[01]/, q + ': reject before progress');
        }
        assert.deepEqual(checked.data, multiBaseline.data, platform + ': common mode/compact metadata never changes settings');
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

    const children = Array.from({ length: 100 }, (_, i) => 'Child' + String(i).padStart(3, '0') + ' Long Name For Complete Reply Search Overflow');
    const ged = path.join(tmp, platform + '-children.ged');
    fs.writeFileSync(ged, ['0 HEAD', '1 SOUR ReplySearchCheck', '1 GEDC', '2 VERS 5.5.1', '1 CHAR UTF-8',
        '0 @I1@ INDI', '1 NAME OverflowHero', '1 SEX M', '1 BIRT', '2 DATE 1 JAN 1950', '1 FAMS @F1@',
        ...children.flatMap((name, i) => [`0 @I${i + 2}@ INDI`, '1 NAME ' + name, '1 SEX M',
            '1 BIRT', '2 DATE 1 JAN 1980', '1 FAMC @F1@']),
        '0 @F1@ FAM', '1 HUSB @I1@', ...children.map((_, i) => `1 CHIL @I${i + 2}@`), '0 TRLR', ''].join('\n'));
    const overflowSetup = ['!ged ' + ged, '/2 2', '/fynny0', 'OverflowHero 1950-01-01'];
    const overflowBaseline = run(platform, 'overflow-baseline', overflowSetup);
    const overflowHero = overflowBaseline.entries.find(e => e.user && e.text === 'OverflowHero 1950-01-01');
    assert.ok(overflowHero, overflowBaseline.log);
    const fullQuery = '/#1\\n!missingzz#replace this';
    const oversizedQuery = '/Child' + 'x'.repeat(4000) + '\\n|Child';
    const overflow = run(platform, 'overflow', [...overflowSetup,
        '>' + overflowHero.id + ' ' + fullQuery,
        '>' + overflowHero.id + ' /Child099',
        '>' + overflowHero.id + ' ' + oversizedQuery]);
    const full = progress(overflow, fullQuery, 1, 0);
    assert.match(response(overflow, '/Child099')[0].text, /Child099 Long Name For Complete Reply Search Overflow/,
        platform + ': filtering sees rows beyond preview');
    {
        const rejected = response(overflow, oversizedQuery)[0];
        assert.match(rejected.text, /Ошибка поискового запроса:/, platform + ': oversized header rejected');
        assert.doesNotMatch(rejected.initial.text, /⏳/, platform + ': oversized query has no progress');
        assert.ok(rejected.versions.every(e => e.text.length <= 4000), platform + ': bounded rejection');
    }
    assert.ok(full.rawText.length <= 4000, platform + ': bounded final text');
    assert.match(full.rawText, /✂️/);
    assert.ok(full.versions.some(e => e.edited && /✂️⏳/.test(e.text)), platform + ': upload progress');
    assert.ok(full.versions.every(e => e.text.length <= 4000), platform + ': bounded intermediate text');
    let artifact;
    if (platform === 'tg') {
        const docs = [...overflow.log.matchAll(/\[\d+\] sendDocument: [^\n]+\.txt \([^\n]+\)\n    → ([^\n]+)/g)];
        assert.equal(docs.length, 1, overflow.log);
        artifact = fs.readFileSync(docs[0][1], 'utf8');
    } else {
        const trace = fs.readFileSync(overflow.base + '.trace.jsonl', 'utf8').trim().split('\n').map(l => JSON.parse(l));
        const uploads = trace.filter(e => e.method === 'upload' && /filename="[^"\r\n]+\.txt"/.test(e.body));
        assert.equal(uploads.length, 1, overflow.log);
        const multipart = Buffer.from(uploads[0].base64, 'base64').toString('utf8');
        artifact = multipart.slice(multipart.indexOf('\r\n\r\n') + 4, multipart.lastIndexOf('\r\n--'));
        assert.match(full.rawText, /📎 вложение/, platform + ': attachment on the same message');
    }
    artifact = artifact.replace(/^\uFEFF/, '');
    assert.ok(artifact.startsWith('/#1\n!missingzz#1 /fynny0\n'), platform + ': full file header');
    assert.ok(artifact.includes('\n' + marker + '\n'), platform + ': file protection marker');
    assert.doesNotMatch(artifact, /⏳|✂️/);
    const rows = artifact.split('\n' + marker + '\n')[1].split('\n');
    assert.equal(rows.length, children.length + 1, platform + ': complete list including hero');
    for (const name of children) assert.equal(rows.filter(row => row === name + ' 1980-01-01 сын').length, 1, name);
    assert.ok(rows.some(row => row.startsWith('OverflowHero 1950-01-01')), platform + ': hero in full list');
    const shown = full.rawText.split('\n' + marker + '\n')[1].split('\n').filter(row => !/✂️|📎/.test(row));
    assert.ok(shown.length > 0 && shown.length < rows.length, platform + ': truncated preview');
    assert.deepEqual(shown, rows.slice(0, shown.length), platform + ': only complete rows in preview');
    assert.deepEqual(overflow.data, overflowBaseline.data, platform + ': overflow search preserves tree');
    console.log(platform + ': multiline AND/OR/NOT, compact progress/final IDs, automatic labels and radii (fynny0/1), early errors, commands, no mutation, ordinary edit, Romanov radius/bell, full overflow artifact OK');
}
console.log('Reply search REPL logs and isolated DBs: ' + tmp);
