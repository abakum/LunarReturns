// Standalone EPUB sample using the same generator as both bots.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGedcom } from '../tgcloud/lib/parse.cjs';
import { viewerAnnotations } from '../tgcloud/lib/viewer.cjs';
import { viewerEpub, epubBase } from '../tgcloud/lib/epub.cjs';

const gedcom = readFileSync(new URL('./fixtures/Romanov_family.ged', import.meta.url), 'utf8');
const { indis, fams } = parseGedcom(gedcom);
const event = e => e?.date ? { d: e.date, abt: e.abt, plac: e.plac } : null;
const persons = indis.map(({ __xref: key, name, sex, birt, deat, note }) => ({
    key, name, sex, note, nameOnly: !birt?.date, d: birt?.date, abt: birt?.abt, plac: birt?.plac,
    dd: deat?.date, dabt: deat?.abt, dp: deat?.plac,
}));
const families = fams.map(f => ({ xref: f.__xref, hKey: f.husb, wKey: f.wife, children: f.chil,
    marr: event(f.marr), div: event(f.div) }));
const hero = persons.find(p => p.name.startsWith('Пётр I Алексеевич'));
const title = epubBase(hero && (hero.name + ' ' + hero.d));
const dir = mkdtempSync('/tmp/kilo/lr-epub-');
const epub = join(dir, title + '.epub');
writeFileSync(epub, viewerEpub(gedcom, title, hero?.key, viewerAnnotations(gedcom, [persons, families])));
console.log(epub);
