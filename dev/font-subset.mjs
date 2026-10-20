#!/usr/bin/env node
// dev/font-subset.mjs — офлайн-генератор шрифта для диаграммы tree.pdf.
// Берёт системный DejaVu Sans, сабсетирует его pyftsubset (venv с fonttools:
//   python3 -m venv /tmp/kilo/fontenv && /tmp/kilo/fontenv/bin/pip install fonttools
// ) и кладёт результат base64-строкой в tgcloud/lib/font-cyr.js — единственный
// источник шрифта для ОБЕИХ копий диаграммы: ТГ импортирует модуль, ВК читает
// файл и вырезает строку регуляркой. Запуск:
//   node dev/font-subset.mjs [/путь/к/pyftsubset] [/путь/к/DejaVuSans.ttf]
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PYFT = process.argv[2] || '/tmp/kilo/fontenv/bin/pyftsubset';
const SRC = process.argv[3] || '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

// кириллица+латиница+цифры+пунктуация/тире/кавычки+№+кейкап-комбининг
const UNICODES = 'U+0020-007E,U+00A0-00FF,U+0400-04FF,U+2010-2027,U+20E3,U+2116';
const TMP = '/tmp/kilo/font-cyr.ttf';

execFileSync(PYFT, [
    SRC,
    '--output-file=' + TMP,
    '--unicodes=' + UNICODES,
    '--no-hinting', '--no-glyph-names',
    '--name-IDs=1,2,3,4,6',
    '--layout-features=',
    '--drop-tables+=MATH,gasp',
], { stdio: 'inherit' });

const b64 = fs.readFileSync(TMP).toString('base64');
const out = path.join(ROOT, 'tgcloud', 'lib', 'font-cyr.js');
fs.writeFileSync(out,
    '// СГЕНЕРИРОВАНО dev/font-subset.mjs — не редактировать руками.\n'
    + '// Сабсет DejaVu Sans (base ' + path.basename(SRC) + ') для диаграммы tree.pdf\n'
    + '// (кириллица+латиница+цифры+пунктуация; без хинтинга). Читают обе копии\n'
    + '// диаграммы: ТГ — импортом, ВК — файлом и регуляркой (см. ГЕДКОМ → PDF).\n'
    + 'export const FONT_B64 = "' + b64 + '";\n');
console.log(out + ': ' + (b64.length / 1024).toFixed(1) + ' КБ base64');
