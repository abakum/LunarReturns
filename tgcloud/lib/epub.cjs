const { viewerHtml } = require('./viewer.cjs');
const { deflateSync } = require('./epub-deflate.cjs');
const { fileBaseOf } = require('./chart.cjs');

const EPUB_TYPE = 'application/epub+zip';
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
    for (let bit = 0; bit < 8; bit++) n = (n >>> 1) ^ (n & 1 ? 0xedb88320 : 0);
    return n;
});

// EPUB requires a ZIP container with mimetype first and stored without extra fields.
function zipFiles(files) {
    const entries = files.map(([path, text]) => {
        const name = encoder.encode(path), data = encoder.encode(text);
        let crc = 0xffffffff;
        for (const byte of data) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
        const method = path === 'mimetype' ? 0 : 8;
        return { name, data: method ? deflateSync(data) : data, size: data.length, method, crc: crc ^ 0xffffffff };
    });
    const start = entries.reduce((n, { name, data }) => n + 30 + name.length + data.length, 0);
    const end = start + entries.reduce((n, { name }) => n + 46 + name.length, 0);
    const bytes = new Uint8Array(end + 22), view = new DataView(bytes.buffer);
    const u16 = (at, value) => view.setUint16(at, value, true);
    const u32 = (at, value) => view.setUint32(at, value, true);
    let local = 0, central = start;
    for (const { name, data, size, method, crc } of entries) {
        const version = method ? 20 : 10;
        const flags = name.some(byte => byte > 127) ? 0x0800 : 0;
        u32(local, 0x04034b50); u16(local + 4, version); u16(local + 8, method); u16(local + 12, 33); u32(local + 14, crc);
        u16(local + 6, flags);
        u32(local + 18, data.length); u32(local + 22, size); u16(local + 26, name.length);
        bytes.set(name, local + 30); bytes.set(data, local + 30 + name.length);
        u32(central, 0x02014b50); u16(central + 4, version); u16(central + 6, version); u16(central + 10, method); u16(central + 14, 33);
        u16(central + 8, flags);
        u32(central + 16, crc); u32(central + 20, data.length); u32(central + 24, size);
        u16(central + 28, name.length); u32(central + 42, local); bytes.set(name, central + 46);
        local += 30 + name.length + data.length;
        central += 46 + name.length;
    }
    u32(end, 0x06054b50); u16(end + 8, entries.length); u16(end + 10, entries.length);
    u32(end + 12, end - start); u32(end + 16, start);
    return bytes;
}

function epubBase(heroKey, radius = 1) {
    if (!heroKey) return 'Древо чата';
    const prefix = radius + ' ';
    const space = heroKey.lastIndexOf(' ');
    const date = heroKey.slice(space);
    const name = fileBaseOf(heroKey.slice(0, space).replace(/[\x00-\x1f\x7f]/g, ' '));
    return prefix + [...name].slice(0, 64 - prefix.length - date.length).join('').trimEnd() + date;
}

function viewerEpub(gedcom, title, heroXref, annotations) {
    const html = viewerHtml(gedcom, title, heroXref, annotations);
    const escapedTitle = html.match(/<title>(.*?)<\/title>/s)[1];
    const filename = title + '.xhtml';
    const href = encodeURIComponent(filename);
    const htmlRoot = '<html xmlns="http://www.w3.org/1999/xhtml" lang="ru" xml:lang="ru"';
    const scriptStart = html.indexOf('<script');
    const xhtml = html.slice(0, scriptStart)
        .replace('<!doctype html><html lang="ru">', '<!DOCTYPE html>' + htmlRoot + '>')
        .replace(/<(meta|input)\b[^>]+>/g, tag => tag.slice(0, -1) + ' />')
        .replace(/ hidden(?=[ >])/g, ' hidden="hidden"')
        .replace('<p id="status" role="status"></p><noscript>Для просмотра включите JavaScript и откройте файл в браузере.</noscript>',
            () => `<p id="status" role="status">Без ридера с JavaScript книгу можно распаковать как ZIP и открыть <code>EPUB/${escapedTitle}.xhtml</code> в браузере.</p>`)
        + html.slice(scriptStart).replace(/(<script\b[^>]*>)([\s\S]*?)<\/script>/g,
            (_, tag, content) => tag + '<![CDATA[' + content.replaceAll(']]>', ']]]]><![CDATA[>') + ']]></script>');
    const now = new Date();
    return zipFiles([
        ['mimetype', EPUB_TYPE],
        ['META-INF/container.xml', '<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>'],
        ['EPUB/package.opf', `<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id" xml:lang="ru">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="pub-id">urn:lunarreturns:${now.getTime()}-${Math.random().toString(36).slice(2)}</dc:identifier>
<dc:title>${escapedTitle}</dc:title><dc:language>ru</dc:language>
<meta property="dcterms:modified">${now.toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
<meta property="rendition:flow">scrolled-doc</meta></metadata>
<manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="tree" href="${href}" media-type="application/xhtml+xml" properties="scripted svg"/></manifest>
<spine><itemref idref="tree"/></spine></package>`],
        ['EPUB/nav.xhtml', `<!DOCTYPE html>${htmlRoot} xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Оглавление</title></head>
<body><nav epub:type="toc"><h1>Оглавление</h1><ol><li><a href="${href}">${escapedTitle}</a></li></ol></nav></body></html>`],
        ['EPUB/' + filename, xhtml],
    ]);
}

module.exports = { viewerEpub, EPUB_TYPE, epubBase };
