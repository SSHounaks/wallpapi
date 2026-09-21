import {describe, it, assert, eq} from './util.mjs';
import * as themes from '../themes.js';

describe('gridCols', () => {
    it('caps at 8 and floors at 1', () => {
        eq(themes.gridCols(99999), 8);
        eq(themes.gridCols(0), 1);
        eq(themes.gridCols(1920), 5);
        eq(themes.gridCols(800), 2);
    });
});

describe('clampInt', () => {
    it('clamps and falls back on NaN', () => {
        eq(themes.clampInt(99, 2, 10, 6), 10);
        eq(themes.clampInt(1, 2, 10, 6), 2);
        eq(themes.clampInt(7, 2, 10, 6), 7);
        eq(themes.clampInt(NaN, 2, 10, 6), 6);
        eq(themes.clampInt('x', 2, 10, 6), 6);
    });
});

describe('polaroidCellW', () => {
    it('sizes a board row inside the width', () => {
        const w = themes.polaroidCellW(1920, 6);
        const total = 6 * w + 5 * 26;
        assert(total <= 1920 - 80, `board ${total} too wide`);
        eq(themes.polaroidCellW(1920, 1) >= 100, true);
    });
});

describe('polaroidCellH', () => {
    it('fits the view height', () => {
        const h = themes.polaroidCellH(504, 2);
        assert(2 * h + 3 * 26 <= 504, 'two rows overflow');
    });
});

describe('comicSide', () => {
    it('grows square enough to fill the area', () => {
        for (const n of [4, 5, 12, 30]) {
            const side = themes.comicSide(n, 1920, 520);
            assert(side >= themes.COMIC_MIN_SIDE, `n=${n} side ${side} too small`);
        }
    });
});

describe('comicMasonry', () => {
    const sides = (n, w, h) => {
        const panels = themes.comicMasonry(n, Array(n).fill([1920, 1080]), w, h);
        return panels;
    };

    it('produces exactly count panels', () => {
        for (const n of [1, 4, 5, 12, 30]) {
            const panels = sides(n, 1920, 520);
            eq(panels.length, n, `n=${n} count`);
            for (const pan of panels) {
                assert(pan.w >= themes.COMIC_MIN_SIDE, 'panel narrow');
                assert(pan.h >= themes.COMIC_MIN_SIDE, 'panel short');
                assert(pan.x >= 0 && pan.y >= 0, 'negative origin');
            }
        }
    });

    it('keeps every panel inside the stage width', () => {
        const panels = sides(12, 1920, 520);
        for (const pan of panels)
            assert(pan.x + pan.w <= 1920, `overflow right ${pan.x + pan.w}`);
    });

    it('heights follow wallpaper aspect ratio (portrait vs landscape)', () => {
        const landscape = themes.comicMasonry(1, [[1920, 1080]], 1920, 520)[0];
        const portrait = themes.comicMasonry(1, [[1080, 1920]], 1920, 520)[0];
        assert(portrait.h > landscape.h,
            `landscape ${landscape.h} vs portrait ${portrait.h}`);
        const ratio = landscape.h / landscape.w;
        assert(Math.abs(ratio - 1080 / 1920) < 0.12,
            `landscape ratio ${ratio.toFixed(3)}`);
    });

    it('falls back to a default ratio without dims', () => {
        const panels = themes.comicMasonry(2, [null, null], 1920, 520);
        for (const pan of panels) {
            assert(pan.h >= themes.COMIC_MIN_SIDE, 'tiny fallback');
            assert(Number.isFinite(pan.w) && pan.w > 0, 'finite width');
        }
    });

    it('is deterministic', () => {
        const a = sides(12, 1920, 520);
        const b = sides(12, 1920, 520);
        eq(JSON.stringify(a), JSON.stringify(b));
    });

    it('returns [] for zero items', () => {
        eq(themes.comicMasonry(0, [], 1920, 520).length, 0);
    });
});
