import System from 'system';
import GLib from 'gi://GLib';
import {tests} from './util.mjs';

const dir = GLib.path_get_dirname(
    decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').split('?')[0]));

const files = [];
const dl = GLib.Dir.open(dir, 0);
let name;
while ((name = dl.read_name()) !== null) {
    if (name.endsWith('.test.mjs'))
        files.push(`file://${dir}/${name}`);
}
dl.close();
files.sort();

for (const file of files)
    await import(file);

let failures = 0;
const started = Date.now();
for (const t of tests) {
    try {
        t.fn();
        print(`  \x1b[32m✓\x1b[0m ${t.name}`);
    } catch (e) {
        failures++;
        print(`  \x1b[31m✗\x1b[0m ${t.name}`);
        for (const line of String(e?.message ?? e).split('\n'))
            print(`      ${line}`);
    }
}

const ms = Date.now() - started;
print('');
print(`${tests.length - failures}/${tests.length} tests passed (${ms}ms)`);
if (failures)
    print(`\x1b[31m${failures} FAILED\x1b[0m`);
System.exit(failures ? 1 : 0);
