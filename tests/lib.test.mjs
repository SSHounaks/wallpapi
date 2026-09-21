import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import {describe, it, assert, eq} from './util.mjs';
import {lib} from './coverage.mjs';

const TMP = `${GLib.get_tmp_dir()}/wallpapi-test-${Date.now()}`;
const ENC = new TextEncoder();
const X = ENC.encode('x');

GLib.setenv('WALLPAPI_CACHE', `${TMP}/cache`, true);

function writeTmp(rel) {
    const f = Gio.File.new_for_path(`${TMP}/${rel}`);
    try {
        f.get_parent().make_directory_with_parents(null);
    } catch (unused) {
    }
    f.replace_contents(X, null, false,
        Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    return f;
}

function px(pixbuf, x, y) {
    const data = pixbuf.get_pixels();
    const row = pixbuf.get_rowstride();
    const off = y * row + x * 4;
    return [data[off], data[off + 1], data[off + 2], data[off + 3]];
}

const BORDER = [53, 132, 228, 255];
const SRC = [210, 30, 60, 255];

function solidPixbuf(w, h) {
    const p = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB, true, 8, w, h);
    p.fill(SRC[0] * 16777216 + SRC[1] * 65536 + SRC[2] * 256 + SRC[3]);
    return p;
}

writeTmp('a.txt');
writeTmp('alpha.JPG');
writeTmp('beta.png');
writeTmp('nested/gamma.jpeg');
writeTmp('.hidden.png');

describe('expandPath', () => {
    it('expands ~ and ~/', () => {
        eq(lib.expandPath('~'), GLib.get_home_dir());
        eq(lib.expandPath('~/x'), GLib.build_filenamev([GLib.get_home_dir(), 'x']));
        eq(lib.expandPath('$HOME/y'), GLib.build_filenamev([GLib.get_home_dir(), 'y']));
        eq(lib.expandPath('/abs/path'), '/abs/path');
        eq(lib.expandPath(''), '');
    });
});

describe('scanFolder', () => {
    it('finds images, skips dotfiles and non-images, sorts', () => {
        const flat = lib.scanFolder(TMP, false);
        eq(flat.length, 2, 'flat count');
        assert(flat[0].endsWith('alpha.JPG') && flat[0].includes('alpha'), flat[0]);
        assert(flat[1].endsWith('beta.png'), flat[1]);
    });
    it('recurses into subfolders', () => {
        const rec = lib.scanFolder(TMP, true);
        eq(rec.length, 3, 'recursive count');
        assert(rec.some(p => p.endsWith('gamma.jpeg')), 'nested found');
        assert(!rec.some(p => p.includes('.hidden')), 'dotfiles skipped');
    });
    it('survives missing folders', () => {
        eq(lib.scanFolder(`${TMP}/does-not-exist`, false).length, 0);
    });
});

describe('validateFolder', () => {
    it('flags empty', () => eq(lib.validateFolder('').valid, false));
    it('flags missing', () => eq(lib.validateFolder(`${TMP}/nope`).valid, false));
    it('accepts folder with images', () => {
        const r = lib.validateFolder(TMP);
        assert(r.valid, String(r.reason));
        eq(r.count, 2);
    });
    it('flags folder without images', () => {
        writeTmp('empty-dir/.keep');
        eq(lib.validateFolder(`${TMP}/empty-dir`).valid, false);
    });
});

describe('colorSchemeDark', () => {
    it('maps prefer-dark to true and prefer-light to false', () => {
        const ui = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        ui.set_enum('color-scheme', 1);
        Gio.Settings.sync();
        assert(lib.colorSchemeDark() === true, 'prefer-dark');
        ui.set_enum('color-scheme', 2);
        Gio.Settings.sync();
        assert(lib.colorSchemeDark() === false, 'prefer-light');
        ui.set_enum('color-scheme', 0);
        Gio.Settings.sync();
    });
});

describe('setWallpaper commit contract', () => {
    it('preview (commit:false) applies without sync; commit:true flushes', () => {
        const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        const ui = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        ui.set_enum('color-scheme', 0);
        const key = ui.get_enum('color-scheme') === 1 ? 'picture-uri-dark' : 'picture-uri';
        const base = `file://${TMP}/base.png`;
        writeTmp('base.png');

        bg.set_string(key, base);
        const origSync = Gio.Settings.sync;
        let syncCount = 0;
        Gio.Settings.sync = () => {
            syncCount++;
        };
        try {
            bg.set_string(key, base);
            eq(bg.get_string(key), base, 'baseline set');

            assert(lib.setWallpaper(`${TMP}/alpha.JPG`, {commit: false}), 'preview return');
            eq(syncCount, 0, 'preview must not call Gio.Settings.sync()');
            const fresh = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            eq(fresh.get_string(key).endsWith('alpha.JPG'), true,
                'preview value is visible to a fresh handle');

            assert(lib.setWallpaper(`${TMP}/beta.png`, {commit: true}), 'commit return');
            eq(syncCount, 1, 'commit must call Gio.Settings.sync() exactly once');
            eq(new Gio.Settings({schema_id: 'org.gnome.desktop.background'})
                .get_string(key).endsWith('beta.png'), true, 'value set');

            bg.set_string(key, base);
        } finally {
            Gio.Settings.sync = origSync;
        }
    });
});

describe('thumbnail cache', () => {
    const w = 480;
    const h = 320;
    const src = `${TMP}/thumb-src.png`;

    function writeSrc() {
        const [ok, bytes] = solidPixbuf(w, h).save_to_bufferv('png', [], []);
        assert(ok, 'png encode');
        Gio.File.new_for_path(src).replace_contents(
            bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
    }

    it('decodes at most the requested bounds with aspect kept', () => {
        writeSrc();
        const t = lib.loadThumbnail(src, 300, 200);
        assert(t, 'thumb decoded');
        assert(t.get_width() <= 300 && t.get_height() <= 200,
            `bounds ${t.get_width()}x${t.get_height()}`);
        eq([t.get_width(), t.get_height()].includes(300) ||
            [t.get_width(), t.get_height()].includes(200), true, 'touches a bound');
    });

    it('writes a cache entry and reuses it', () => {
        const path = lib.thumbnailCachePath(src, 300, 200);
        assert(path, 'cache path computed');
        const cacheFile = Gio.File.new_for_path(path);
        assert(cacheFile.query_exists(null), 'cache file written');
        const again = lib.loadThumbnail(src, 300, 200);
        assert(again, 'cache read hit');
    });

    it('re-keys when the source file is modified', () => {
        const before = lib.thumbnailCachePath(src, 300, 200);
        const [ok, bytes] = solidPixbuf(96, 96).save_to_bufferv('png', [], []);
        assert(ok, 'png encode');
        Gio.File.new_for_path(src).replace_contents(
            bytes, null, false,
            Gio.FileCreateFlags.REPLACE_DESTINATION, null);
        const after = lib.thumbnailCachePath(src, 300, 200);
        assert(before, 'has before path');
        assert(after, 'has after path');
        eq(before === after, false, 'mtime/size key changed');
        assert(Gio.File.new_for_path(before).query_exists(null), 'old entry intact');
    });

    it('returns null for a missing source', () => {
        eq(lib.loadThumbnail(`${TMP}/nope.png`, 300, 200), null);
    });
});

describe('a missing wallpaper is rejected', () => {
    it('returns false for a nonexistent file', () => {
        eq(lib.setWallpaper(`${TMP}/missing.png`, {commit: false}), false);
        eq(lib.setWallpaper(`${TMP}/missing.png`, {commit: true}), false);
    });
});

describe('framePixbuf', () => {
    const w = 30;
    const h = 20;
    const pad = 6;
    const paper = [240, 240, 236, 255];
    const framed = lib.framePixbuf(solidPixbuf(w, h), pad, paper);

    it('grows by 2*pad each side', () => {
        eq(framed.get_width(), w + 2 * pad, 'width');
        eq(framed.get_height(), h + 2 * pad, 'height');
    });

    it('keeps source pixels centered', () => {
        assert(px(framed, pad + w / 2, pad + h / 2).every((v, i) => v === SRC[i]),
            'center kept');
    });

    it('supports an asymmetric bottom pad', () => {
        const padFramed = lib.framePixbuf(solidPixbuf(10, 10), 3,
            paper, 8);
        eq(padFramed.get_width(), 16, 'width with pad bottom');
        eq(padFramed.get_height(), 10 + 3 + 8, 'height with padded bottom');
        assert(px(padFramed, 1, 12)[3] === 255 &&
            px(padFramed, 1, 12) !== undefined, 'bottom strip present');
    });


    it('paints the paper color on the margin', () => {
        assert(px(framed, 0, 0).every((v, i) => v === paper[i]), 'corner paper');
        assert(px(framed, w + 2 * pad - 1, h + 2 * pad - 1)
            .every((v, i) => v === paper[i]), 'opposite corner paper');
        assert(px(framed, pad + w + 5, pad / 2).every((v, i) => v === paper[i]),
            'left/right margin paper');
    });
});

describe('shearPixbuf geometry', () => {
    const w = 40;
    const h = 30;
    const shiftMax = Math.max(1, Math.round(0.12 * h));
    const out = lib.shearPixbuf(solidPixbuf(w, h), 0.12, BORDER);
    const outW = out.get_width();

    it('width grows by 2*shiftMax, height unchanged', () => {
        eq(outW, w + 2 * shiftMax, 'width');
        eq(out.get_height(), h, 'height');
    });

    it('keeps source pixels along the shifted rows', () => {
        for (const y of [3, 10, 18, h - 5]) {
            const x0 = Math.round(outW / 2 - w / 2 + 0.12 * (y - h / 2));
            assert(px(out, x0 + 2, y).every((v, i) => v === SRC[i]), `row ${y} inner pixel`);
        }
    });

    it('draws the border along both slanted edges', () => {
        for (const y of [3, 15, h - 4]) {
            const x0 = Math.round(outW / 2 - w / 2 + 0.12 * (y - h / 2));
            assert(px(out, x0 - 1, y).every((v, i) => v === BORDER[i]), `left edge y=${y}`);
            assert(px(out, x0 + w, y).every((v, i) => v === BORDER[i]), `right edge y=${y}`);
        }
    });

    it('leaves the surrounding area transparent without a border', () => {
        const plain = lib.shearPixbuf(solidPixbuf(w, h), 0.12);
        const x0 = Math.round(plain.get_width() / 2 - w / 2);
        eq(px(plain, 0, h / 2)[3], 0, 'left margin alpha');
        eq(px(plain, plain.get_width() - 1, h / 2)[3], 0, 'right margin alpha');
        assert(px(plain, x0 + w / 2, h / 2).every((v, i) => v === SRC[i]), 'center kept');
    });
});
