// Standalone EPUB experiment; not used by the bots. Requires Info-ZIP.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGedcom } from '../tgcloud/lib/parse.cjs';
import { viewerAnnotations, viewerHtml } from '../tgcloud/lib/viewer.cjs';

const title = 'Древо Романовых';
const gedcom = readFileSync(new URL('./fixtures/Romanov_family.ged', import.meta.url), 'utf8');
const { indis, fams } = parseGedcom(gedcom);
const event = e => e?.date ? { d: e.date, abt: e.abt, plac: e.plac } : null;
const persons = indis.map(({ __xref: key, name, sex, birt, deat, note }) => ({
    key, name, sex, note, nameOnly: !birt?.date, d: birt?.date, abt: birt?.abt, plac: birt?.plac,
    dd: deat?.date, dabt: deat?.abt, dp: deat?.plac,
}));
const families = fams.map(f => ({ xref: f.__xref, hKey: f.husb, wKey: f.wife, children: f.chil,
    marr: event(f.marr), div: event(f.div) }));
const hero = persons.find(p => p.name.startsWith('Пётр I Алексеевич'))?.key;
const html = viewerHtml(gedcom, title, hero, viewerAnnotations(gedcom, [persons, families]));
const scriptStart = html.indexOf('<script');
const xhtml = html.slice(0, scriptStart)
    .replace('<!doctype html><html lang="ru">', '<!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" lang="ru" xml:lang="ru">')
    .replace(/<(meta|input)\b[^>]+>/g, tag => tag.slice(0, -1) + ' />')
    .replace(/ hidden(?=[ >])/g, ' hidden="hidden"')
    .replace('<p id="status" role="status"></p><noscript>Для просмотра включите JavaScript и откройте файл в браузере.</noscript>',
        '<p id="status" role="status">Для просмотра дерева нужна поддержка JavaScript в читалке.</p>')
    + html.slice(scriptStart).replace(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g,
        (_, tag, content) => tag + '<![CDATA[' + content.replaceAll(']]>', ']]]]><![CDATA[>') + ']]></script>');

const dir = mkdtempSync('/tmp/kilo/lr-epub-');
const source = join(dir, 'source');
const epub = join(dir, 'Romanov-tree.epub');
try {
    mkdirSync(join(source, 'META-INF'), { recursive: true });
    mkdirSync(join(source, 'EPUB'));
    const put = (path, text) => writeFileSync(join(source, path), text);
    put('mimetype', 'application/epub+zip');
    put('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`);
    put('EPUB/package.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="ru">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">urn:uuid:${randomUUID()}</dc:identifier>
    <dc:title>${title}</dc:title><dc:language>ru</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
    <meta property="rendition:flow">scrolled-doc</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="tree" href="tree.xhtml" media-type="application/xhtml+xml" properties="scripted svg"/>
  </manifest>
  <spine><itemref idref="tree"/></spine>
</package>`);
    put('EPUB/nav.xhtml', `<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ru" lang="ru">
  <head><title>Оглавление</title></head>
  <body><nav epub:type="toc"><h1>Оглавление</h1><ol><li><a href="tree.xhtml">${title}</a></li></ol></nav></body>
</html>`);
    put('EPUB/tree.xhtml', xhtml);
    execFileSync('zip', ['-qX0', epub, 'mimetype'], { cwd: source });
    execFileSync('zip', ['-qXr9', epub, 'META-INF', 'EPUB'], { cwd: source });
    console.log(epub);
} finally {
    rmSync(source, { recursive: true, force: true });
}
