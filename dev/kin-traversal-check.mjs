import assert from 'node:assert/strict';
import { focusKeys, focusGraphDist, focusListKeys } from '../tgcloud/lib/tree.cjs';

// Independent common-ancestor oracle, not a walk through the undirected graph.
function oracle(pairs, hero, radius) {
    const parents = new Map(), kids = new Map();
    for (const [p, c] of pairs) {
        parents.set(c, [...(parents.get(c) || []), p]);
        kids.set(p, [...(kids.get(p) || []), c]);
    }
    const out = new Set();
    const ancestors = [[hero, 0]];
    for (let i = 0; i < ancestors.length; i++) {
        const [ancestor, up] = ancestors[i];
        if (up < radius) for (const p of parents.get(ancestor) || []) ancestors.push([p, up + 1]);
        const descendants = [[ancestor, 0]];
        for (let j = 0; j < descendants.length; j++) {
            const [person, down] = descendants[j];
            if (up && down && up + down - 1 > radius) continue;
            out.add(person);
            if (down < radius) for (const c of kids.get(person) || []) descendants.push([c, down + 1]);
        }
    }
    return [...out].sort();
}
let seed = 112026;
const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
for (let fixture = 0; fixture < 20; fixture++) {
    const pairs = [];
    for (let child = 1; child < 24; child++) {
        const parents = new Set(Array.from({ length: random(3) }, () => random(child)));
        for (const p of parents) pairs.push(['P' + p, 'P' + child]);
    }
    for (const hero of ['P0', 'P7', 'P23']) for (let radius = 1; radius <= 5; radius++) {
        const expected = oracle(pairs, hero, radius);
        assert.deepEqual(focusKeys(pairs, hero, radius).sort(), expected);
        assert.deepEqual(focusKeys(pairs.slice().reverse(), hero, radius).sort(), expected);
    }
}
const pairs = [['Mother', 'Hero'], ['Father', 'Hero'], ['Mother', 'Full'], ['Father', 'Full'],
    ['Mother', 'Half'], ['Other', 'Half'], ['Hero', 'Child'], ['Spouse', 'Child'],
    ['SpouseMother', 'Spouse'], ['Full', 'Nephew']];
for (let r = 1; r <= 5; r++) {
    for (const edges of [pairs, pairs.slice().reverse()]) {
        const dist = focusGraphDist(edges, [], 'Hero', r);
        assert.equal(dist.get('Full'), 1);
        assert.equal(dist.has('Half'), r >= 2);
        assert.equal(dist.has('Nephew'), r >= 2);
        assert.ok(!dist.has('Other'));
        assert.ok(!dist.has('Spouse'));
        assert.ok(!dist.has('SpouseMother'));
        const keys = focusListKeys(edges, [['Hero', 'Spouse']], 'Hero', r, () => null, true);
        assert.ok(keys.includes('Spouse'));
        assert.ok(!keys.includes('SpouseMother'));
    }
}
// A spouse resets the phase only when an explicit marriage is enabled.
assert.equal(focusGraphDist(pairs, [['Hero', 'Spouse']], 'Hero', 2).get('SpouseMother'), 2);
assert.ok(focusKeys(pairs, 'Hero', 2, [['Hero', 'Spouse']]).includes('SpouseMother'));

// Foreign ancestors of co-parents never become candidates, however wide the tree.
const wide = [];
for (let i = 0; i < 200; i++) {
    wide.push(['Hero', 'Child' + i], ['Spouse' + i, 'Child' + i]);
    for (let j = 0; j < 5; j++) wide.push([`Foreign${i}-${j}`, j ? `Foreign${i}-${j - 1}` : 'Spouse' + i]);
}
assert.equal(focusKeys(wide, 'Hero', 5).length, 201);
assert.equal(focusGraphDist(wide, [], 'Hero', 5).size, 201);
// Malformed cyclic ancestry and pedigree overlap must terminate and be order-independent.
const cyclic = [...pairs, ['Child', 'Mother'], ['Full', 'Father']];
for (let r = 1; r <= 5; r++) {
    assert.deepEqual(focusKeys(cyclic, 'Hero', r).sort(), oracle(cyclic, 'Hero', r));
    assert.deepEqual([...focusGraphDist(cyclic, [], 'Hero', r)].sort(),
        [...focusGraphDist(cyclic.slice().reverse(), [], 'Hero', r)].sort());
}
console.log('Phased traversal: oracle, R1–5, half/full siblings, shared children, explicit marriages, cycles and bounded candidates OK');
