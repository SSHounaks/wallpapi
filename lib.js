import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';

export const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'avif'];

const LOG_FILE = `${GLib.get_home_dir()}/.local/var/log/Wallpapi.log`;
const LOG_LIMIT = 65536;

export function expandPath(path) {
    if (!path)
        return '';
    if (path === '~')
        return GLib.get_home_dir();
    if (path.startsWith('~/'))
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]);
    const homeVar = '$HOME';
    if (path === homeVar)
        return GLib.get_home_dir();
    if (path.startsWith(`${homeVar}/`))
        return GLib.build_filenamev([GLib.get_home_dir(), path.slice(homeVar.length + 1)]);
    return path;
}

export function colorSchemeDark() {
    try {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        return settings.get_enum('color-scheme') === 1;
    } catch (e) {
        return false;
    }
}

export function currentWallpaperPath() {
    try {
        const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
        const key = colorSchemeDark() ? 'picture-uri-dark' : 'picture-uri';
        const uri = settings.get_string(key);
        let path = uri;
        if (path.startsWith('file://'))
            path = decodeURIComponent(path.slice('file://'.length));
        const file = Gio.File.new_for_path(path);
        return file.query_exists(null) ? path : null;
    } catch (e) {
        return null;
    }
}

export function scanFolder(folder, recursive) {
    const paths = [];
    const stack = [expandPath(folder)];
    const visited = new Set();

    while (stack.length > 0) {
        const dir = stack.pop();
        const file = Gio.File.new_for_path(dir);
        let enumerator;
        try {
            enumerator = file.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            continue;
        }

        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            const name = info.get_name();
            if (name.startsWith('.'))
                continue;

            if (info.get_file_type() === Gio.FileType.DIRECTORY) {
                if (recursive) {
                    const sub = GLib.build_filenamev([dir, name]);
                    if (!visited.has(sub))
                        stack.push(sub);
                }
                continue;
            }

            if (info.get_file_type() !== Gio.FileType.REGULAR &&
                info.get_file_type() !== Gio.FileType.SYMBOLIC_LINK)
                continue;

            const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
            if (IMAGE_EXTENSIONS.includes(ext))
                paths.push(GLib.build_filenamev([dir, name]));
        }
        visited.add(dir);
    }

    paths.sort((a, b) => a.localeCompare(b));
    return paths;
}

export function validateFolder(folder) {
    if (!folder || !folder.trim())
        return {valid: false, count: 0, reason: 'empty'};

    const expanded = expandPath(folder.trim());
    const file = Gio.File.new_for_path(expanded);
    if (!file.query_exists(null))
        return {valid: false, count: 0, reason: 'not-found'};
    const info = file.query_info(
        'standard::type', Gio.FileQueryInfoFlags.NONE, null);
    if (!info || info.get_file_type() !== Gio.FileType.DIRECTORY)
        return {valid: false, count: 0, reason: 'not-found'};

    const count = scanFolder(expanded, false).length;
    if (count === 0)
        return {valid: false, count: 0, reason: 'no-images'};
    return {valid: true, count, reason: 'ok'};
}

export function setWallpaper(path, opts = {}) {
    if (!Gio.File.new_for_path(path).query_exists(null))
        return false;

    const {commit = true} = opts;
    const uri = `file://${path}`;
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const key = colorSchemeDark() ? 'picture-uri-dark' : 'picture-uri';
    try {
        if (bg.is_writable(key))
            bg.set_string(key, uri);
        if (commit)
            Gio.Settings.sync();
        return true;
    } catch (e) {
        logError(e);
        return false;
    }
}

export function logError(e) {
    const message = e?.stack ?? String(e);
    try {
        const file = Gio.File.new_for_path(LOG_FILE);
        try {
            const size = file.query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null).get_size();
            if (size > LOG_LIMIT)
                file.replace(null, false, Gio.FileCreateFlags.NONE, null).close(null);
        } catch (err) {
        }

        let stream;
        if (file.query_exists(null))
            stream = file.append_to(Gio.FileCreateFlags.NONE, null);
        else
            stream = file.replace(null, false, Gio.FileCreateFlags.REPLACE_DESTINATION, null);

        const timestamp = new Date().toISOString();
        const bytes = new TextEncoder().encode(`[${timestamp}] Wallpapi: ${message}\n`);
        stream.write_all(bytes, null);
        stream.close(null);
    } catch (err) {
    }
    console.warn(`Wallpapi: ${message}`);
}

export function shearPixbuf(source, skew, border = null) {
    const w = source.get_width();
    const h = source.get_height();
    const shiftMax = Math.max(1, Math.round(Math.abs(skew) * h));
    const outW = w + shiftMax * 2;
    const dest = GdkPixbuf.Pixbuf.new(
        GdkPixbuf.Colorspace.RGB, true, 8, outW, h);

    const cx = outW / 2;
    const x0 = (y) => Math.round(cx - w / 2 + skew * (y - h / 2));

    for (let y = 0; y < h; y++) {
        source.copy_area(0, y, w, 1, dest, x0(y), y);
    }

    if (border !== null) {
        const [br, bg, bb, ba] = border;
        const rgb = br * 16777216 + bg * 65536 + bb * 256 + (ba & 0xff);
        const dot = GdkPixbuf.Pixbuf.new(
            GdkPixbuf.Colorspace.RGB, true, 8, 1, 1);
        dot.fill(rgb);
        for (let y = 0; y < h; y++) {
            const xl = x0(y) - 1;
            const xr = x0(y) + w;
            if (xl >= 0)
                dot.copy_area(0, 0, 1, 1, dest, xl, y);
            if (xr < outW)
                dot.copy_area(0, 0, 1, 1, dest, xr, y);
        }
        const horiz = GdkPixbuf.Pixbuf.new(
            GdkPixbuf.Colorspace.RGB, true, 8, w + 2, 2);
        horiz.fill(rgb);
        horiz.copy_area(0, 0, w + 2, 2, dest, x0(0) - 1, 0);
        horiz.copy_area(0, 0, w + 2, 2, dest, x0(h - 1) - 1, h - 2);
    }
    return dest;
}
