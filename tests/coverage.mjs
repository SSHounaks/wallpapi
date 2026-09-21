import GLib from 'gi://GLib';
import * as real from '../lib.js';

const called = new Set();

export const lib = new Proxy(real, {
    get(target, prop) {
        if (typeof prop === 'symbol' || prop === 'then')
            return target[prop];
        called.add(prop);
        return target[prop];
    },
});

function attributeLines() {
    const here = GLib.path_get_dirname(
        decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').split('?')[0]));
    const src = GLib.file_get_contents(GLib.build_filenamev([here, '..', 'lib.js']))[1];
    const source = new TextDecoder().decode(src).split('\n');

    const depthAt = [];
    let depth = 0;
    let inStr = null;
    let esc = false;
    for (const line of source) {
        for (const ch of line) {
            if (esc) {
                esc = false;
                continue;
            }
            if (inStr) {
                if (ch === '\\')
                    esc = true;
                else if (ch === inStr)
                    inStr = null;
                continue;
            }
            if (ch === '"' || ch === "'" || ch === '`') {
                inStr = ch;
                continue;
            }
            if (ch === '{')
                depth++;
            else if (ch === '}')
                depth--;
        }
        depthAt.push(depth);
    }

    const exports = [];
    for (let i = 0; i < source.length; i++) {
        const m = source[i].match(/^export (?:const|function)\s+([\w$]+)/);
        if (!m)
            continue;
        const baseline = i === 0 ? 0 : depthAt[i - 1];
        let end = i;
        for (let j = i; j < source.length; j++) {
            if (j > i && depthAt[j] <= baseline) {
                end = j;
                break;
            }
        }
        exports.push({name: m[1], start: i, end});
    }
    return {source, exports};
}

const {source, exports} = attributeLines();

function countLines(name) {
    const ex = exports.find(e => e.name === name);
    if (!ex)
        return 0;
    let n = 0;
    for (let i = ex.start; i <= ex.end; i++) {
        const t = source[i].trim();
        if (t && !t.startsWith('//'))
            n++;
    }
    return n;
}

export function printCoverage() {
    let hit = 0;
    let total = 0;
    print('\nlib.js export coverage (Proxy recorder over the real module)');
    print('export'.padEnd(26) + 'lines'.padStart(6) + 'touched'.padStart(10));
    print('-'.repeat(44));
    const all = new Map();
    for (const ex of exports)
        all.set(ex.name, countLines(ex.name));
    // ensure any export never walked off the list still shows as 0
    for (const [name, lines] of all) {
        const t = called.has(name);
        print(`${name.padEnd(26)}${String(lines).padStart(6)}${(t ? 'yes' : 'NO').padStart(10)}`);
        hit += t ? lines : 0;
        total += lines;
    }
    const pct = total ? Math.round(100 * hit / total) : 0;
    print('-'.repeat(44));
    print(`${'TOTAL'.padEnd(26)}${String(total).padStart(6)}${String(`${pct}%`).padStart(10)}`);
    return pct;
}
