import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

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
    if (!file.query_exists(null) ||
        !file.query_file_info('standard::type', Gio.FileQueryInfoFlags.NONE, null) === null &&
        file.query_file_type === Gio.FileType.DIRECTORY) {
        return {valid: false, count: 0, reason: 'not-found'};
    }
    if (file.query_file_info('standard::type', Gio.FileQueryInfoFlags.NONE, null).get_file_type() !==
        Gio.FileType.DIRECTORY) {
        return {valid: false, count: 0, reason: 'not-found'};
    }

    const count = scanFolder(expanded, false).length;
    if (count === 0)
        return {valid: false, count: 0, reason: 'no-images'};
    return {valid: true, count, reason: 'ok'};
}

export function setWallpaper(path, notify) {
    if (!Gio.File.new_for_path(path).query_exists(null))
        return false;

    const uri = `file://${path}`;
    const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
    const key = colorSchemeDark() ? 'picture-uri-dark' : 'picture-uri';
    try {
        if (bg.is_writable(key))
            bg.set_string(key, uri);
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
