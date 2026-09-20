import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as lib from './lib.js';

const EXPECTED_HEIGHT = 340;
const SELECTED_EXTRA_HEIGHT = 150;
const SELECTED_EXTRA_WIDTH = 200;
const NEAR_STEP_PULL = 20;
const SLICE_WIDTH = 110;
const SLICE_SPACING = 12;
const VISIBLE_RANGE = 4;
const SLICE_SKEW = 0.12;
const LOAD_RANGE = 6;
const HEADER_HEIGHT = 120;
const BOTTOM_HEIGHT = 96;

export default class WallpapiExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._overlay = null;
        this._grab = null;
        this._focusIndex = 0;
        this._items = [];
        this._sliceActors = [];
        this._sliceImgs = new Map();
        this._sliceDims = new Map();
        this._pixbufs = new Map();
        this._loadQueue = [];
        this._loadQueueSet = new Set();
        this._loadTimerId = 0;
        this._coglContext = null;
        this._originalWallpaper = null;
        this._previewDebounceId = 0;
        this._committed = false;

        try {
            this._coglContext = global.stage.context.get_backend().get_cogl_context();
        } catch (e) {
            lib.logError(e);
        }

        this._buildIndicator();

        Main.wm.addKeybinding(
            'show-picker',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            this._toggleOverlay.bind(this));

        this._settingsChangedId = this._settings.connect(
            'changed::folder', this._onFolderChanged.bind(this));
        this._subfoldersChangedId = this._settings.connect(
            'changed::include-subfolders', this._onFolderChanged.bind(this));
    }

    disable() {
        if (this._overlay)
            this._closeOverlay();

        this._stopLoading();
        this._cancelPreview();

        Main.wm.removeKeybinding('show-picker');

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._subfoldersChangedId) {
            this._settings.disconnect(this._subfoldersChangedId);
            this._subfoldersChangedId = null;
        }

        if (this._button) {
            this._button.destroy();
            this._button = null;
        }

        this._settings = null;
    }

    _buildIndicator() {
        this._button = new PanelMenu.Button(0.0, 'Wallpapi', true);
        this._button.add_child(new St.Icon({
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            fallback_icon_name: 'image-x-generic-symbolic',
            style_class: 'system-status-icon',
        }));
        this._button.connect('button-press-event', () => {
            this._toggleOverlay();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea('wallpapi', this._button, 0, 'right');
    }

    _onFolderChanged() {
        if (this._overlay)
            this._rescan();
    }

    _folderEmpty() {
        return !this._settings.get_string('folder').trim();
    }

    _toggleOverlay() {
        if (this._overlay)
            this._closeOverlay();
        else
            this._openOverlay();
    }

    _openOverlay() {
        if (this._overlay)
            return;

        this._stopLoading();
        this._items = [];
        this._sliceActors = [];
        this._sliceImgs.clear();
        this._sliceDims.clear();
        this._pixbufs.clear();
        this._focusIndex = 0;

        const monitor = Main.layoutManager.primaryMonitor;
        const overlay = new St.Widget({
            style_class: 'wallpapi-overlay',
            reactive: true,
            can_focus: true,
            x: monitor.x,
            y: monitor.y,
            width: monitor.width,
            height: monitor.height,
        });

        this._overlay = overlay;
        Main.uiGroup.add_child(overlay);
        Main.uiGroup.set_child_above_sibling(overlay, null);

        overlay.connect('button-press-event', () => {
            this._closeOverlay();
            return Clutter.EVENT_STOP;
        });
        overlay.connect('key-press-event', (actor, event) =>
            this._onKeyPress(event));

        const header = new St.BoxLayout({
            vertical: true,
            style_class: 'wallpapi-header',
            x_expand: true,
        });
        header.add_child(new St.Label({
            text: 'Wallpapers',
            style_class: 'wallpapi-title',
        }));
        this._folderLabel = new St.Label({
            text: '',
            style_class: 'wallpapi-folder',
        });
        header.add_child(this._folderLabel);
        overlay.add_child(header);

        this._carouselArea = new Clutter.Actor();
        overlay.add_child(this._carouselArea);

        this._bottomBar = new St.BoxLayout({
            vertical: true,
            style_class: 'wallpapi-bottom',
            x_expand: true,
        });
        this._currentLabel = new St.Label({
            text: '',
            style_class: 'wallpapi-current',
        });
        this._bottomBar.add_child(this._currentLabel);
        this._bottomBar.add_child(new St.Label({
            text: '← → choose  ·  Enter set  ·  Esc close',
            style_class: 'wallpapi-hint',
        }));
        overlay.add_child(this._bottomBar);

        this._grab = Main.pushModal(overlay, {actionMode: Shell.ActionMode.POPUP});
        global.stage.set_key_focus(overlay);

        try {
            const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
            this._originalWallpaper = {
                light: bg.get_string('picture-uri'),
                dark: bg.get_string('picture-uri-dark'),
            };
        } catch (e) {
            lib.logError(e);
            this._originalWallpaper = null;
        }
        this._committed = false;

        this._rescan();
    }

    _closeOverlay() {
        if (!this._overlay)
            return;

        this._stopLoading();
        this._cancelPreview();

        if (!this._committed && this._originalWallpaper) {
            try {
                const bg = new Gio.Settings({schema_id: 'org.gnome.desktop.background'});
                if (bg.is_writable('picture-uri'))
                    bg.set_string('picture-uri', this._originalWallpaper.light);
                if (bg.is_writable('picture-uri-dark'))
                    bg.set_string('picture-uri-dark', this._originalWallpaper.dark);
                Gio.Settings.sync();
            } catch (e) {
                lib.logError(e);
            }
        }
        this._originalWallpaper = null;
        this._committed = false;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        this._overlay.destroy();
        this._overlay = null;
        this._carouselArea = null;
        this._bottomBar = null;
        this._folderLabel = null;
        this._currentLabel = null;
        this._items = [];
        this._sliceActors = [];
        this._sliceImgs.clear();
        this._sliceDims.clear();
        this._pixbufs.clear();
    }

    _rescan() {
        if (!this._overlay)
            return;

        this._stopLoading();
        this._pixbufs.clear();

        this._carouselArea.destroy_all_children();
        this._sliceActors = [];
        this._sliceImgs.clear();
        this._sliceDims.clear();
        this._items = [];

        if (this._folderEmpty()) {
            this._folderLabel.text = 'No folder set';
            this._showMessage('Pick a folder in the extension settings to browse wallpapers here.');
            return;
        }

        const folder = this._settings.get_string('folder').trim();
        const recursive = this._settings.get_boolean('include-subfolders');
        let paths;
        try {
            paths = lib.scanFolder(folder, recursive);
        } catch (e) {
            lib.logError(e);
            this._folderLabel.text = 'Folder could not be read';
            this._showMessage(`Could not read ${lib.expandPath(folder)}`);
            return;
        }

        if (paths.length === 0) {
            this._folderLabel.text = 'No wallpapers found';
            this._showMessage(`No wallpapers found in ${lib.expandPath(folder)}`);
            return;
        }

        this._items = paths;
        this._folderLabel.text = `${lib.expandPath(folder)} — ${paths.length} wallpaper${paths.length > 1 ? 's' : ''}`;

        paths.forEach((path, index) => {
            const slice = this._buildSlice(path, index);
            this._carouselArea.add_child(slice);
            this._sliceActors.push(slice);
        });

        const current = lib.currentWallpaperPath();
        const currentIndex = current ? paths.indexOf(current) : -1;
        const startIndex = currentIndex >= 0 ? currentIndex : 0;

        this._setFocus(startIndex);
    }

    _showMessage(text) {
        const label = new St.Label({
            text,
            style_class: 'wallpapi-empty',
            x_expand: true,
            y_expand: true,
        });
        label.set_position((this._overlay.width - label.width) / 2,
            (this._overlay.height - label.height) / 2);
        this._carouselArea.add_child(label);
    }

    _buildSlice(path, index) {
        const slice = new St.Widget({
            style_class: 'wallpapi-slice',
            reactive: true,
            can_focus: false,
        });
        slice.connect('button-press-event', () => {
            this._activate(index);
            return Clutter.EVENT_STOP;
        });

        const imgActor = new Clutter.Actor();
        const content = St.ImageContent.new_with_preferred_size(
            (SLICE_WIDTH + SELECTED_EXTRA_WIDTH) * 3,
            EXPECTED_HEIGHT + SELECTED_EXTRA_HEIGHT);
        imgActor.content = content;
        slice.add_child(imgActor);

        this._sliceImgs.set(index, imgActor);
        return slice;
    }

    _relayout() {
        if (!this._overlay || this._items.length === 0)
            return;

        const width = this._overlay.width;
        const height = this._overlay.height;
        const areaY = HEADER_HEIGHT;
        const areaH = height - HEADER_HEIGHT - BOTTOM_HEIGHT;
        const cx = width / 2;
        const cy = areaY + areaH / 2;

        for (let i = 0; i < this._items.length; i++) {
            const slice = this._sliceActors[i];
            if (!slice)
                continue;

            const rel = i - this._focusIndex;
            if (Math.abs(rel) > VISIBLE_RANGE) {
                slice.visible = false;
                continue;
            }
            slice.visible = true;

            const selected = rel === 0;
            const w = selected
                ? SLICE_WIDTH + SELECTED_EXTRA_WIDTH
                : SLICE_WIDTH;
            const h = selected
                ? EXPECTED_HEIGHT + SELECTED_EXTRA_HEIGHT
                : EXPECTED_HEIGHT;
            const x = cx + this._slotOffset(rel) - w / 2;
            const y = cy - h / 2;

            slice.set_position(x, y);
            slice.set_size(w, h);
            this._applySliceVisual(i, w, h);

            if (selected)
                this._carouselArea.set_child_above_sibling(slice, null);
        }
    }

    _slotOffset(rel) {
        if (rel === 0)
            return 0;

        const sign = rel > 0 ? 1 : -1;
        const dist = Math.abs(rel);

        const pad = 6;
        const focalH = EXPECTED_HEIGHT + SELECTED_EXTRA_HEIGHT - 2 * pad;
        const nbhH = EXPECTED_HEIGHT - 2 * pad;
        const bound = (Math.min(focalH, nbhH) / 2) - 1;

        const focalHalf = (SLICE_WIDTH + SELECTED_EXTRA_WIDTH) / 2
            + SLICE_SKEW * bound;
        const nbhHalf = SLICE_WIDTH / 2 + SLICE_SKEW * bound;
        const nearStep = Math.round(
            focalHalf + nbhHalf + SLICE_SPACING - NEAR_STEP_PULL);

        if (dist === 1)
            return sign * nearStep;
        return sign * (nearStep + (dist - 1) * (SLICE_WIDTH + SLICE_SPACING));
    }

    _applySliceVisual(index, slotW, slotH) {
        const slice = this._sliceActors[index];
        const imgActor = this._sliceImgs.get(index);
        if (!slice || !imgActor)
            return;

        const selected = index === this._focusIndex;
        slice.style_class = selected
            ? 'wallpapi-slice wallpapi-slice-selected'
            : 'wallpapi-slice';

        const pixbuf = this._pixbufs.get(index);
        if (!pixbuf || !this._coglContext)
            return;

        const pad = 6;
        const availW = Math.max(1, slotW);
        const availH = Math.max(1, slotH - 2 * pad);
        const scale = Math.max(availW / pixbuf.get_width(),
            availH / pixbuf.get_height());
        const iw = Math.max(1, Math.round(pixbuf.get_width() * scale));
        const ih = Math.max(1, Math.round(pixbuf.get_height() * scale));

        let source = pixbuf;
        if (iw !== pixbuf.get_width() || ih !== pixbuf.get_height()) {
            source = pixbuf.scale_simple(iw, ih, GdkPixbuf.InterpType.BILINEAR);
            if (!source)
                return;
        }

        let cropped = source;
        let cw = iw;
        let ch = ih;
        if (iw > availW || ih > availH) {
            const ox = Math.max(0, Math.floor((iw - availW) / 2));
            const oy = Math.max(0, Math.floor((ih - availH) / 2));
            cw = Math.min(availW, iw - ox);
            ch = Math.min(availH, ih - oy);
            cropped = source.new_subpixbuf(ox, oy, cw, ch);
        }

        const border = selected
            ? [53, 132, 228, 255]
            : [255, 255, 255, 90];
        const sheared = lib.shearPixbuf(cropped, SLICE_SKEW, border);
        const sw = sheared.get_width();

        const bytes = new GLib.Bytes(sheared.get_pixels());
        imgActor.content.set_bytes(
            this._coglContext, bytes,
            Cogl.PixelFormat.RGBA_8888,
            sw, sheared.get_height(), sheared.get_rowstride());

        imgActor.set_size(sw, sheared.get_height());
        imgActor.set_position(
            Math.round((slotW - sw) / 2), pad);
        imgActor.opacity = selected ? 255 : 170;
    }

    _setFocus(index) {
        if (index < 0 || index >= this._items.length)
            return;

        this._focusIndex = index;
        this._relayout();

        const name = this._items[index].split('/').pop();
        if (this._currentLabel)
            this._currentLabel.text = this._settings.get_boolean('instant-preview')
                ? `${name} · preview`
                : name;

        if (this._settings.get_boolean('instant-preview') && this._originalWallpaper)
            this._schedulePreview(this._items[index]);

        this._requestLoadNearFocus();
    }

    _schedulePreview(path) {
        if (this._previewDebounceId) {
            GLib.source_remove(this._previewDebounceId);
            this._previewDebounceId = 0;
        }
        this._previewDebounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 60, () => {
                this._previewDebounceId = 0;
                try {
                    lib.setWallpaper(path, {commit: false});
                } catch (e) {
                    lib.logError(e);
                }
                return GLib.SOURCE_REMOVE;
            });
    }

    _cancelPreview() {
        if (this._previewDebounceId) {
            GLib.source_remove(this._previewDebounceId);
            this._previewDebounceId = 0;
        }
    }

    _moveFocus(dx) {
        if (this._items.length === 0)
            return;
        const index = (this._focusIndex + dx + this._items.length) % this._items.length;
        this._setFocus(index);
    }

    _onKeyPress(event) {
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            this._closeOverlay();
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Return || symbol === Clutter.KEY_KP_Enter) {
            this._activate(this._focusIndex);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_BackTab) {
            this._moveFocus(-1);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Tab) {
            this._moveFocus(1);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _requestLoadNearFocus() {
        const low = Math.max(0, this._focusIndex - LOAD_RANGE);
        const high = Math.min(this._items.length - 1, this._focusIndex + LOAD_RANGE);
        for (let i = low; i <= high; i++) {
            if (this._pixbufs.has(i) || this._loadQueueSet.has(i))
                continue;
            this._loadQueueSet.add(i);
            this._loadQueue.push({path: this._items[i], index: i});
        }
        this._startLoading();
    }

    _startLoading() {
        if (this._loadTimerId || this._loadQueue.length === 0)
            return;
        this._loadTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 8, () => {
            const tasks = this._loadQueue.splice(0, 2);
            for (const {path, index} of tasks) {
                this._loadQueueSet.delete(index);
                this._loadThumbnail(path, index);
            }

            if (this._loadQueue.length === 0) {
                this._loadTimerId = 0;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopLoading() {
        if (this._loadTimerId) {
            GLib.source_remove(this._loadTimerId);
            this._loadTimerId = 0;
        }
        this._loadQueue = [];
        this._loadQueueSet.clear();
    }

    _loadThumbnail(srcPath, index) {
        try {
            const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_scale(
                srcPath, (SLICE_WIDTH + SELECTED_EXTRA_WIDTH) * 4,
                (EXPECTED_HEIGHT + SELECTED_EXTRA_HEIGHT) * 2, true);
            if (!pixbuf)
                return;
            this._pixbufs.set(index, pixbuf);
            const slice = this._sliceActors[index];
            if (slice)
                this._applySliceVisual(index,
                    slice.width ? slice.width : SLICE_WIDTH,
                    slice.height ? slice.height : EXPECTED_HEIGHT);
        } catch (e) {
            lib.logError(e);
        }
    }

    _activate(index) {
        const path = this._items[index];
        if (!path)
            return;
        this._cancelPreview();
        this._setWallpaper(path);
        this._committed = true;
        this._closeOverlay();
    }

    _setWallpaper(path) {
        try {
            lib.setWallpaper(path);
            Main.notify('Wallpapi', `${path.split('/').pop()}`);
        } catch (e) {
            lib.logError(e);
        }
    }
}
