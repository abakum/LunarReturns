// Pure phrase-to-chain compiler. Repeated token sets keep both neutral choices
// and arbitrarily deep pra-prefixes compact; no family graph is consulted.
const { genLabel } = require('./kinship.cjs');

const fold = s => s.toLowerCase().replace(/ё/g, 'е');
const PARENT = ['отец', 'мать', 'родитель'];
const CHILD = ['сын', 'дочь', 'ребёнок'];
const SIBLING = ['брат', 'сестра', 'сиблинг'];
const SPOUSE = ['муж', 'жена', 'супруг'];
const nouns = new Map();
const dictionary = new Set();
function noun(nom, kind, sex, depth = 1, aliases = []) {
    const gen = genLabel(nom);
    const entry = { nom, kind, sex, depth };
    for (const [word, grammaticalCase] of [[nom, 'nom'], [gen, 'gen'], ...aliases]) {
        nouns.set(fold(word), { ...entry, grammaticalCase });
        dictionary.add(fold(word));
    }
}
for (const [words, kind] of [[PARENT, 'parent'], [CHILD, 'child'], [SIBLING, 'sibling'], [SPOUSE, 'spouse']]) {
    words.forEach((w, i) => noun(w, kind, ['M', 'F', null][i], 1,
        w === 'дочь' ? [['дочка', 'nom'], ['дочери', 'gen']] : []));
}
noun('прародитель', 'parent', null, 2);
for (const [w, kind, sex] of [
    ['дед', 'parent', 'M'], ['дедушка', 'parent', 'M'], ['бабушка', 'parent', 'F'],
    ['внук', 'child', 'M'], ['внучка', 'child', 'F'],
    ['дядя', 'uncle', 'M'], ['тётя', 'uncle', 'F'],
    ['племянник', 'niece', 'M'], ['племянница', 'niece', 'F'],
]) noun(w, kind, sex, 2);

const degrees = ['двоюрод', 'троюрод', 'четвероюрод'];
function adjective(word) {
    const m = word.match(/^(двоюрод|троюрод|четвероюрод)(ный|ная|ного|ной)$/)
        || word.match(/^((?:пра\d*)?внучат)(ый|ая|ого|ой)$/);
    if (!m) return null;
    const end = m[2];
    const sex = /ая|ой|ная|ной/.test(end) ? 'F' : 'M';
    const grammaticalCase = /ого|ой|ного|ной/.test(end) ? 'gen' : 'nom';
    const degree = degrees.indexOf(m[1]) + 1;
    if (degree) return { degree, sex, grammaticalCase };
    const pra = m[1].match(/^пра(\d*)/);
    return { grand: pra ? 1 + count(pra[1]) : 1,
        pra: pra ? count(pra[1]) : 0, sex, grammaticalCase };
}
for (const stem of degrees) for (const end of ['ный', 'ная', 'ного', 'ной']) dictionary.add(stem + end);
for (const end of ['ый', 'ая', 'ого', 'ой']) dictionary.add('внучат' + end);

function count(digits) {
    return digits ? Math.min(Number(digits), Number.MAX_SAFE_INTEGER) : 1;
}
function wordNoun(word) {
    if (nouns.has(word)) return nouns.get(word);
    const m = word.match(/^пра(\d*)(.+)$/);
    if (!m) return null;
    const base = nouns.get(m[2]);
    if (!base || !['parent', 'child'].includes(base.kind) || base.depth !== 2
        || !/^(дед|деда|бабушка|бабушки|внук|внука|внучка|внучки)$/.test(m[2])) return null;
    return { ...base, depth: Math.min(2 + count(m[1]), Number.MAX_SAFE_INTEGER) };
}
function sexTokens(tokens, sex) {
    return sex ? [tokens[sex === 'M' ? 0 : 1]] : tokens;
}
function tokenSex(word) {
    const w = fold(word);
    for (const group of [PARENT, CHILD, SIBLING, SPOUSE]) {
        const i = group.findIndex(t => w === fold(t) || w === fold(genLabel(t)));
        if (i >= 0) return ['M', 'F', null][i];
    }
    return null;
}
function compatible(left, right) {
    const w = fold(left), sex = tokenSex(right);
    return !((w === 'жена' || w === 'жены') && sex === 'F')
        && !((w === 'муж' || w === 'мужа') && sex === 'M');
}

// null means ordinary/mixed literal text. A recognized but ungrammatical
// phrase deliberately returns a diagnostic object instead of becoming literal.
function compileKinship(text) {
    text = String(text);
    const leading = text.match(/^\s*/)[0], trailing = text.match(/\s*$/)[0];
    const words = fold(text.trim()).split(/\s+/);
    if (!text.trim() || words.some(w => !wordNoun(w) && !adjective(w))) return null;
    const parsed = [], sequence = [];
    let neutral = false, error = '', firstCase = null;
    const add = (tokens, repeat = 1) => {
        if (repeat <= 0) return;
        const grammaticalCase = sequence.length ? 'gen' : firstCase;
        const output = tokens.map(t => grammaticalCase === 'gen' ? genLabel(t) : t);
        sequence.push({ tokens: output, repeat });
    };
    for (let i = 0; i < words.length;) {
        const start = i, modifiers = [];
        while (i < words.length && adjective(words[i])) modifiers.push(adjective(words[i++]));
        const n = i < words.length ? wordNoun(words[i++]) : null;
        if (!n) { error = 'Ожидалось существительное после определения'; break; }
        neutral ||= n.sex === null;
        if (firstCase === null) firstCase = (modifiers[0] || n).grammaticalCase;
        if (modifiers.some(m => m.grammaticalCase !== n.grammaticalCase || m.sex !== (n.sex || 'M'))) {
            error = 'Несогласованные падеж или род: ' + words.slice(start, i).join(' '); break;
        }
        const degreeMods = modifiers.filter(m => m.degree);
        const grandMods = modifiers.filter(m => m.grand);
        const degree = degreeMods[0]?.degree || 0;
        // kinBlood uses pra(b-a-1) for cousin descendants, but pra(b-3)
        // for sibling descendants: their written pra counters differ by one.
        const grand = degree && grandMods[0]?.pra ? grandMods[0].pra : grandMods[0]?.grand || 0;
        if (degreeMods.length > 1 || grandMods.length > 1
            || (grand && n.kind !== 'niece')
            || (degree && !['sibling', 'uncle', 'niece', 'parent'].includes(n.kind))
            || (degree > 1 && n.kind === 'uncle')
            || (degree && n.kind === 'parent' && (degree !== 1 || n.depth < 2))
            || (degree && grand && modifiers[0].grand)) {
            error = 'Неподдерживаемое сочетание определений: ' + words.slice(start, i).join(' '); break;
        }
        parsed.push(words.slice(start, i).join(' '));
        if (n.kind === 'parent' && !degree) {
            add(sexTokens(PARENT, n.sex)); add(PARENT, n.depth - 1);
        } else if (n.kind === 'child') {
            add(sexTokens(CHILD, n.sex)); add(CHILD, n.depth - 1);
        } else if (n.kind === 'spouse') {
            add(sexTokens(SPOUSE, n.sex));
        } else {
            let a, b;
            if (n.kind === 'parent') { a = n.depth + 1; b = 1; }
            else if (n.kind === 'uncle') { a = degree ? degree + 2 : 2; b = degree ? degree + 1 : 1; }
            else if (n.kind === 'niece') { a = degree + 1; b = a + 1 + grand; }
            else { a = degree + 1; b = a; }
            if (b > 1) { add(sexTokens(CHILD, n.sex)); add(CHILD, b - 2); add(SIBLING); }
            else add(sexTokens(SIBLING, n.sex));
            add(PARENT, a - 1);
        }
    }
    // Prune choices at each boundary in both directions. Compatibility only
    // remembers the adjacent token, so this is an exact small-state automaton.
    for (let i = 1; i < sequence.length; i++) {
        sequence[i].tokens = sequence[i].tokens.filter(t => sequence[i - 1].tokens.some(p => compatible(p, t)));
    }
    for (let i = sequence.length - 2; i >= 0; i--) {
        sequence[i].tokens = sequence[i].tokens.filter(t => sequence[i + 1].tokens.some(p => compatible(t, p)));
    }
    if (sequence.some(s => !s.tokens.length)) error ||= 'Нет такой родственной связи';
    const valid = !error;
    const depth = sequence.reduce((n, s) => Math.min(Number.MAX_SAFE_INTEGER, n + s.repeat), 0);
    const preview = [];
    let previewTruncated = false;
    if (valid && depth <= 32) {
        const walk = (i, repeat, tokens) => {
            if (preview.length >= 8) { previewTruncated = true; return; }
            if (i === sequence.length) { preview.push(leading + tokens.join(' ') + trailing); return; }
            for (const t of sequence[i].tokens) {
                if (tokens.length && !compatible(tokens[tokens.length - 1], t)) continue;
                const next = repeat + 1;
                walk(next === sequence[i].repeat ? i + 1 : i, next === sequence[i].repeat ? 0 : next, [...tokens, t]);
                if (previewTruncated) return;
            }
        };
        walk(0, 0, []);
    } else if (valid) previewTruncated = true;

    const test = line => {
        if (!valid) return false;
        line = String(line).toLowerCase();
        if (depth > line.length) return false;
        // A token-aware NFA over character offsets, not a regex or a Cartesian
        // expansion. Keep previous tokens only for spouse compatibility.
        let states = new Map();
        for (let p = 0; p < line.length; p++) {
            if (leading && !line.startsWith(leading, p)) continue;
            const start = p + leading.length;
            states.set(start + '|', { pos: start, previous: '' });
        }
        let step = 0;
        for (const slot of sequence) for (let r = 0; r < slot.repeat; r++) {
            const next = new Map();
            for (const { pos, previous } of states.values()) for (const token of slot.tokens) {
                if (previous && !compatible(previous, token)) continue;
                const at = pos + (step ? 1 : 0);
                if (step && line[pos] !== ' ') continue;
                if (!line.startsWith(token, at)) continue;
                const end = at + token.length;
                next.set(end + '|' + token, { pos: end, previous: token });
            }
            states = next; step++;
            if (!states.size) return false;
        }
        return [...states.values()].some(({ pos }) => line.startsWith(trailing, pos));
    };
    const allVariants = () => {
        if (!valid) return [];
        if (depth > 100) throw new Error('Разложение слишком велико: уточните запрос');
        const result = [];
        let size = 0;
        const walk = (i, repeat, tokens) => {
            if (i === sequence.length) {
                const line = leading + tokens.join(' ') + trailing;
                size += line.length;
                if (result.length >= 100000 || size > 8000000)
                    throw new Error('Разложение слишком велико: уточните запрос');
                result.push(line);
                return;
            }
            for (const token of sequence[i].tokens) {
                if (tokens.length && !compatible(tokens.at(-1), token)) continue;
                const next = repeat + 1;
                walk(next === sequence[i].repeat ? i + 1 : i, next === sequence[i].repeat ? 0 : next, [...tokens, token]);
            }
        };
        walk(0, 0, []);
        return result;
    };
    return { known: true, neutral, valid, depth, alternatives: [sequence], allVariants,
        constraints: 'opposite-sex-spouse-heads', parsed,
        preview, previewTruncated, ...(error ? { error } : {}), test, matches: test };
}

function kinshipFragment(text) {
    const words = fold(String(text).trim()).split(/\s+/);
    let fragment = null;
    for (const w of words) {
        if (wordNoun(w) || adjective(w)) continue;
        const base = w.replace(/^пра\d*/, '');
        if (w.length < 3 || ![...dictionary].some(known => known.startsWith(w)
            || (base !== w && base && known.startsWith(base)))) return null;
        fragment ||= w;
    }
    return fragment;
}

const expandKinshipPhrase = compileKinship;
module.exports = { compileKinship, expandKinshipPhrase, kinshipFragment };
