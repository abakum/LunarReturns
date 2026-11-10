'use strict';

const fs = require('node:fs');
const path = require('node:path');

module.exports = function (mode) {
    try {
        const args = process.argv.slice(2);
        const suffix = mode === 'ged2txt' ? /\.ged$/i : /\.ged\.txt$/i;
        if (args.length !== 1 || !suffix.test(args[0])) {
            throw new Error('Usage: ' + mode + (mode === 'ged2txt' ? ' <file.ged>' : ' <file.ged.txt>'));
        }
        const input = path.resolve(args[0]);
        const output = mode === 'ged2txt' ? input + '.txt' : input.replace(/\.ged\.txt$/i, '.txt.ged');
        if (input === output) throw new Error('Input and output must differ');
        if (!fs.statSync(input).isFile()) throw new Error('Input is not a regular file: ' + input);
        // Reject malformed UTF-8 rather than silently replacing genealogy text.
        const text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(input));
        process.env.LR_DB = ':memory:';
        const { convertGenealogy } = require('../lunarreturns.js');
        const converted = convertGenealogy(mode, text);
        // Exclusive creation also rejects symlinks and hardlinks to the input.
        fs.writeFileSync(output, '\uFEFF' + converted, { encoding: 'utf8', flag: 'wx' });
        console.log(output);
    } catch (error) {
        console.error(mode + ': ' + error.message);
        process.exitCode = 1;
    }
};
