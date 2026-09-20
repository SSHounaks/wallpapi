import System from 'system';
import {tests} from '../tests/util.mjs';
import '../tests/lib.test.mjs';
import {lib, printCoverage} from '../tests/coverage.mjs';

for (const t of tests)
    t.fn();

lib.IMAGE_EXTENSIONS.length;
lib.currentWallpaperPath();
lib.logError('coverage: exercising error path');

const pct = printCoverage();
print(`\n${pct === 100 ? '\x1b[32m' : '\x1b[31m'}coverage ${pct}%\x1b[0m (all exported functions must be touched by the suite)`);
System.exit(pct <= 0 ? 1 : 0);
