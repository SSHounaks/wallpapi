import System from 'system';
import GLib from 'gi://GLib';

const ROOT = GLib.path_get_dirname(
    decodeURIComponent(import.meta.url.replace(/^file:\/\//, '').split('?')[0])).slice(0, -8);

const TARGETS = ['extension.js', 'lib.js', 'prefs.js', 'tests', 'scripts'];
const MAX_LINE = 130;

const BUILTINS = new Set([
    'global', 'globalThis', 'console', 'print', 'log', 'logError', 'System',
    'JSON', 'Math', 'Date', 'RegExp', 'Error', 'TypeError', 'RangeError',
    'ReferenceError', 'Object', 'Array', 'String', 'Number', 'Boolean',
    'Symbol', 'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Intl',
    'TextEncoder', 'TextDecoder', 'isNaN', 'decodeURIComponent',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'Uint8Array', 'Int8Array', 'Uint16Array', 'ArrayBuffer',
]);

function *walkFiles(base) {
    if (base.endsWith('.js') || base.endsWith('.mjs')) {
        yield base;
        return;
    }
    const dl = GLib.Dir.open(base, 0);
    let n;
    while ((n = dl.read_name()) !== null) {
        const p = `${base}/${n}`;
        const type = GLib.file_test(p, GLib.FileTest.IS_DIR) ? 'dir' : 'file';
        if (type === 'dir')
            yield * walkFiles(p);
        else if (n.endsWith('.js') || n.endsWith('.mjs'))
            yield p;
    }
    dl.close();
}

function strip(code) {
    return code
        .replace(/`[^`]*`/g, '')
        .replace(/'[^'\\]*(?:\\.[^'\\]*)*'/g, '')
        .replace(/"[^"\\]*(?:\\.[^"\\]*)*"/g, '')
        .replace(/\/\/[^\n]*/g, '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ');
}

function declared(code) {
    const names = new Set();
    const push = m => {
        for (const item of m.split(',')) {
            let t = item.trim().split(/\s+as\s+/)[0];
            if (t.includes(':'))
                t = t.split(':')[1];
            t = t.replace(/[=\[\]{}]|^\.+|\s.*$/, '').trim();
            if (/^[\w$]+$/.test(t))
                names.add(t);
        }
    };
    let m;
    const re = /import\s+(?:\* as\s+|(\w+)\s*(?:,\s*)?)?(?:\{([^}]*)\}|(\w+))(?:[^;]*?from\s+)?/g;
    while ((m = re.exec(code)))
        for (const g of [m[1], m[2], m[3]])
            if (g)
                push(g);
    const decl = /(?:const|let|var|function|class)\s+\*?\s*(?:([\w$]+)|[{[]([^}\]]+))/g;
    while ((m = decl.exec(code)))
        for (const g of [m[1], m[2]])
            if (g)
                push(g);
    const params = /\(([^()]*)\)\s*=>|\bcatch\s*\(([^()]*)\)|function\s+[\w$]*\s*\(([^()]*)\)/g;
    while ((m = params.exec(code)))
        for (const g of [m[1], m[2], m[3]])
            if (g)
                push(g);
    const methods = /(?:^|\n)\s*([\w$]+)\s*\(([^()]*)\)\s*\{/g;
    while ((m = methods.exec(code))) {
        if (m[1] !== 'for' && m[1] !== 'if' && m[1] !== 'while' && m[1] !== 'switch')
            push(m[1]);
        if (m[2].trim())
            push(m[2]);
    }
    return names;
}

let errors = 0;
let warnings = 0;
const files = [];
for (const t of TARGETS) {
    const path = `${ROOT}/${t}`;
    if (GLib.file_test(path, GLib.FileTest.EXISTS))
        files.push(...walkFiles(path));
}
files.sort();

for (const file of files) {
    const rel = file.slice(ROOT.length + 1);
    const code = new TextDecoder().decode(GLib.file_get_contents(file)[1]);
    const lines = code.split('\n');
    const names = declared(strip(code));
    let bad = [];

    lines.forEach((ln, i) => {
        if (/\t/.test(ln))
            errors++, bad.push(`L${i + 1}: tab character`);
        if (/[ \t]+$/.test(ln) && ln.trim())
            errors++, bad.push(`L${i + 1}: trailing whitespace`);
        if (ln.length > MAX_LINE)
            warnings++, bad.push(`L${i + 1}: ${ln.length} chars > ${MAX_LINE}`);
        if (rel !== 'scripts/lint.mjs') {
            if (/console\.log\(|debugger\b/.test(ln))
                errors++, bad.push(`L${i + 1}: console.log/debugger`);
            if (/(?:^|[/*])\s*(TODO|FIXME|XXX|HACK)[:\s]/i.test(ln))
                errors++, bad.push(`L${i + 1}: TODO/FIXME/XXX marker`);
        }
    });

    const KEYWORDS = new Set([
        'const', 'let', 'var', 'function', 'class', 'return', 'if', 'else',
        'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue',
        'try', 'catch', 'finally', 'throw', 'new', 'delete', 'typeof', 'instanceof',
        'void', 'in', 'of', 'yield', 'await', 'async', 'extends', 'super', 'this',
        'static', 'get', 'set', 'import', 'export', 'from', 'as', 'true', 'false',
        'null', 'undefined', 'debugger', 'satisfies', 'accessor', 'using',
    ]);
    const stripped = strip(code);
    const bare = new Set();
    if (['extension.js', 'lib.js', 'prefs.js'].includes(rel)) {
    const re = /[A-Za-z_$][\w$]*/g;
    let m;
    while ((m = re.exec(stripped)) !== null) {
        const tok = m[0];
        const before = m.index > 0 ? stripped[m.index - 1] : '';
        const after = m.index + tok.length < stripped.length ? stripped[m.index + tok.length] : '';
        if (before === '.' || before === '?')
            continue;
        if (/[0-9_]/.test(before) || /[0-9_]/.test(tok[0]))
            continue;
        if (after === ':')
            continue;
        if (KEYWORDS.has(tok) || BUILTINS.has(tok) || names.has(tok))
            continue;
        if (tok.length < 3 || !/^[A-Za-z]/.test(tok))
            continue;
        bare.add(tok);
    }

    }
    if (bad.length || bare.size) {
        print(`\n\x1b[1m${rel}\x1b[0m`);
        for (const b of bad)
            print(`  \x1b[31merror\x1b[0m   ${b}`);
        const suspicious = [...bare].slice(0, 12);
        for (const s of suspicious)
            warnings++, print(`  \x1b[33mwarn\x1b[0m    possible undefined identifier: '${s}'`);
    }

    if (['extension.js', 'lib.js', 'prefs.js'].includes(rel)) {
        const [res, , errs] = GLib.spawn_sync(
            ROOT, ['gjs', '-m', file], null,
            GLib.SpawnFlags.SEARCH_PATH, null);
        const errText = new TextDecoder().decode(errs ?? []);
        if (errText.includes('SyntaxError') || errText.includes('CompilationError')) {
            errors++;
            print(`\n\x1b[1m${rel}\x1b[0m`);
            const snippet = errText.split('\n').slice(0, 3)
                .map(l => '        ' + l).join('\n');
            print(`  \x1b[31merror\x1b[0m   does not compile:\n${snippet}`);
        }
    }
}

print(`\n\x1b[1mlint:\x1b[0m ${errors} errors, ${warnings} warnings`);
System.exit(errors ? 1 : 0);
