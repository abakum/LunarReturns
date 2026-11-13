#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { parseGedcom, trimImport } = require('../tgcloud/lib/parse.cjs');

try {
    const args = process.argv.slice(2);
    if (args.length !== 1 || !/\.ged$/i.test(args[0])) throw new Error('Usage: trim <file.ged>');
    const input = path.resolve(args[0]);
    const output = input.replace(/\.ged$/i, '.trim.ged');
    if (!fs.statSync(input).isFile()) throw new Error('Input is not a regular file: ' + input);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(input));
    const parsed = parseGedcom(text);
    if (!parsed) throw new Error('Input is not GEDCOM');
    const names = new Map(trimImport(parsed).indis.map(p => [p.__xref, p.name]));
    const newline = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = [];
    const kept = [];
    let person = null;
    for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^(\s*)(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?:\s+(.*))?$/);
        if (!m) { if (!line.trim()) lines.push(line); continue; }
        const level = Number(m[2]), tag = m[4].toUpperCase();
        kept.length = level;
        if (level === 0) person = tag === 'INDI' && m[3] ? m[3].slice(1, -1) : null;
        const root = kept[0], parent = kept[level - 1];
        const allowed = level === 0 ? ['HEAD', 'INDI', 'FAM', 'TRLR'].includes(tag)
            : level === 1 && root === 'HEAD' ? ['GEDC', 'CHAR'].includes(tag)
            : level === 2 && root === 'HEAD' && parent === 'GEDC' ? ['VERS', 'FORM'].includes(tag)
            : level === 1 && root === 'INDI' ? ['NAME', 'SEX', 'BIRT', 'DEAT', 'BURI', 'ADOP'].includes(tag)
            : level === 1 && root === 'FAM' ? ['HUSB', 'WIFE', 'CHIL', 'MARR', 'DIV'].includes(tag)
            : level === 2 && root === 'INDI' && ['BIRT', 'DEAT', 'BURI'].includes(parent)
                ? tag === 'DATE' || (tag === 'TIME' && parent !== 'BURI')
            : level === 2 && root === 'FAM' && ['MARR', 'DIV'].includes(parent) ? tag === 'DATE'
            : level === 2 && root === 'FAM' && parent === 'CHIL' ? tag === 'PEDI'
            : level === 2 && root === 'INDI' && parent === 'ADOP' ? tag === 'FAMC'
            : false;
        if (!allowed) continue;
        kept[level] = tag;
        if (tag === 'NAME' && person !== null) {
            lines.push(m[1] + level + ' NAME ' + (names.get(person) || ''));
        } else lines.push(line);
    }
    // Keep original date records rather than round-tripping through the bot DB.
    fs.writeFileSync(output, '\uFEFF' + lines.join(newline), { encoding: 'utf8', flag: 'wx' });
    console.log(output);
} catch (error) {
    console.error('trim: ' + error.message);
    process.exitCode = 1;
}
