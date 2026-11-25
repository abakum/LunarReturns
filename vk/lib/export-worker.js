'use strict';
const { parentPort } = require('node:worker_threads');
const { createExportData } = require('./export-data.js');
const { focusListKeys, focusKeys, focusListText, focusListMessage, focusSearch, prepareReplySearch } = require('../../tgcloud/lib/tree.cjs');
const { checkEpubLimit, epubChart } = require('../../tgcloud/lib/epub.cjs');
const { createFlatAnnotationScope, datelessFocusList, datelessSearchLine, flatSearch, personSearchLines } = require('../../tgcloud/lib/flat.cjs');
const { findPersonSearch } = require('../../tgcloud/lib/text.cjs');

let job;
parentPort.on('message', async ({ op, input }) => {
    if (op === 'clear') { job = undefined; return; }
    if (op === 'open') {
        const { snapshot, head, heroKey, radius, heroXref, fullPack, manualCancel } = input;
        job = { data: snapshot && createExportData(snapshot), settings: snapshot?.settings, head, heroKey, radius, heroXref,
            keys: input.keys, fullPack, progress: manualCancel ? (phase, done, total) => parentPort.postMessage({ progress: { phase, done, total } }) : undefined };
        return parentPort.postMessage({ result: null });
    }
    const started = performance.now();
    parentPort.postMessage({ start: true });
    try {
        const { data, head, heroKey, radius, heroXref, settings, progress } = job;
        const getGed = () => job.ged ??= data.gedcomText(job.keys);
        const getChart = () => job.chart ??= epubChart(() => data.prepareChart(
            heroKey && !job.keys?.xrefs ? focusKeys(data.pairsOf(), heroKey, radius, data.spousesOf()) : job.keys,
            head.replace(/^\d\s+/, ''), heroKey, radius, false, settings.fynny, heroXref));
        let result;
        switch (op) {
        case 'focus': {
            const sex = new Map(data.personsOf().map(r => [r.n + ' ' + r.d, r.sex ?? null]));
            job.keys = focusListKeys(data.pairsOf(), data.spousesOf(), heroKey, radius, k => sex.get(k) ?? null);
            progress?.('selection', job.keys.length, job.keys.length);
            result = data.chatFlatText(job.keys);
            break;
        }
        case 'flat': result = data.chatFlatText(job.fullPack ? null : job.keys); break;
        case 'branch': result = data.branchFlatText(input); break;
        case 'focus_keys': {
            const sex = new Map(data.personsOf().map(r => [r.n + ' ' + r.d, r.sex ?? null]));
            result = job.keys = focusListKeys(data.pairsOf(), data.spousesOf(), heroKey, radius, k => sex.get(k) ?? null);
            break;
        }
        case 'gedcom': result = getGed(); break;
        case 'pdf': {
            const chart = await getChart();
            if (chart.error) throw chart.error;
            const pdf = chart.renderPdf();
            result = Uint8Array.from(pdf, c => c.charCodeAt(0));
            break;
        }
        case 'html': case 'epub': {
            const ged = getGed();
            progress?.('gedcom', ged.length, ged.length);
            checkEpubLimit(ged, op.toUpperCase());
            if (!job.viewer) {
                const hero = heroKey && data.personsOf().find(r => r.n + ' ' + r.d === heroKey);
                const xref = heroXref ?? (hero && ged.split('\n').includes('0 @' + hero.xref + '@ INDI') ? hero.xref : null);
                job.viewer = data.exportViewer(ged, heroKey, xref, radius, settings, await getChart(), progress);
            }
            result = job.viewer(op);
            break;
        }
        case 'parse_gedcom': result = require('../../tgcloud/lib/parse.cjs').parseGedcom(input); break;
        case 'parse_flat': result = require('../../tgcloud/lib/parse.cjs').parseTree(input); break;
        case 'flat_search': {
            if (!input.exact) { result = flatSearch(data.chatFlatText(), input); break; }
            const snapshot = data.flatRows();
            const ambiguous = [];
            const hit = findPersonSearch(snapshot[0], input.query, ambiguous);
            if (hit) {
                const line = hit.d == null ? datelessSearchLine(snapshot, hit.key) : '';
                result = { hit, hits: line ? [line] : [], line };
            } else result = { hit, hits: hit === false ? personSearchLines(snapshot, ambiguous.map(p => p.key))
                : flatSearch(data.chatFlatText(), input.query) };
            break;
        }
        case 'dateless_bell': {
            const snapshot = data.flatRows();
            const scope = createFlatAnnotationScope(snapshot, data.pairsOf(), data.spousesOf());
            const body = datelessFocusList(snapshot, scope, heroXref, radius, input.mmdd, settings.fynny);
            result = focusListMessage(head, body || '(в радиусе нет событий)');
            break;
        }
        case 'bell': {
            const persons = data.personsOf(), pairs = data.pairsOf(), spouses = data.spousesOf();
            const sex = new Map(persons.map(r => [r.n + ' ' + r.d, r.sex ?? null]));
            const sexOf = key => sex.get(key) ?? null;
            const keys = focusListKeys(pairs, spouses, heroKey, radius, sexOf, true);
            const list = focusListText([...persons, ...input.weddings], keys, heroKey, pairs, spouses, sexOf,
                input.byFull, input.mmdd, radius, settings.fynny);
            result = focusListMessage(head, list || '(в радиусе нет событий)');
            break;
        }
        case 'focus_search': {
            const plan = prepareReplySearch(input.query, settings.fynny);
            result = focusSearch(data.personsOf(), input.weddings, data.pairsOf(), data.spousesOf(),
                heroKey, plan.query, plan.chain, radius);
            break;
        }
        default: throw new Error('Unknown VK computation');
        }
        progress?.('complete', 1, 1);
        const binary = Array.isArray(result) ? result[1] : result;
        parentPort.postMessage({ result, ms: Math.round(performance.now() - started) }, binary instanceof Uint8Array ? [binary.buffer] : []);
    } catch (e) {
        parentPort.postMessage({ error: e.message, ms: Math.round(performance.now() - started) });
    }
});
