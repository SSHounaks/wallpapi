import System from 'system';
import GLib from 'gi://GLib';

const ROOT = GLib.path_get_dirname(
    decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').split('?')[0])).slice(0, -8);

const STEPS = [
    ['lint', ['gjs', '-m', `${ROOT}/scripts/lint.mjs`], false],
    ['unit', ['dbus-run-session', '--', 'gjs', '-m', `${ROOT}/tests/run.mjs`], true],
    ['coverage', ['dbus-run-session', '--', 'gjs', '-m', `${ROOT}/scripts/coverage.mjs`], true],
];

function run(argv) {
    const [ok, pid] = GLib.spawn_async(
        ROOT, argv, null,
        GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
        null);
    if (!ok)
        return false;
    const loop = GLib.MainLoop.new(null, false);
    let good = true;
    GLib.child_watch_add(GLib.PRIORITY_DEFAULT, pid, (p, st) => {
        try {
            GLib.spawn_check_exit_status(st);
        } catch (e) {
            good = false;
        }
        loop.quit();
    });
    loop.run();
    return good;
}

let failed = 0;
print('\x1b[1mwallpapi repo check\x1b[0m');
for (const [name, argv] of STEPS) {
    print(`\n\x1b[1m-- ${name} --\x1b[0m`);
    const ok = run(argv);
    print(`\x1b[1m-- ${name}: ${ok ? '\x1b[32mPASS' : '\x1b[31mFAIL'}\x1b[0m --`);
    if (!ok)
        failed++;
}
print(`\n${failed === 0 ? '\x1b[32mALL CHECKS PASSED' : `\x1b[31m${failed} STEP(S) FAILED`}\x1b[0m`);
System.exit(failed ? 1 : 0);
