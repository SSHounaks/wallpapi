const tests = [];
let suite = '';

export function describe(name, fn) {
    const prev = suite;
    suite = name;
    fn();
    suite = prev;
}

export function it(name, fn) {
    tests.push({name: suite ? `${suite} › ${name}` : name, fn});
}

export function assert(cond, msg) {
    if (!cond)
        throw new Error(msg || 'assertion failed');
}

export function eq(actual, expected, msg) {
    if (actual !== expected)
        throw new Error(`${msg || 'eq failed'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

export {tests};
