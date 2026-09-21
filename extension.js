import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Cogl from 'gi://Cogl';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import * as lib from './lib.js';
import * as themes from './themes.js';

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
const CAPTION_HEIGHT = 30;
const POLAROID_PAD = 10;

export default class WallpapiExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._overlay = null;
        this._grab = null;
        this._focusIndex = 0;
        this._items = [];
        this._sliceActors = [];
        this._sliceImgs = new Map();
        this._sliceLabels = new Map();
        this._sliceDims = new Map();
        this._pixbufs = new Map();
        this._loadQueue = [];
        this._loadQueueSet = new Set();
        this._loadTimerId = 0;
        this._coglContext = null;
        this._originalWallpaper = null;
        this._previewDebounceId = 0;
        this._committed = false;
        this._fileSubMonitors = [];
        this._fsDebounceId = 0;
        this._buttonPressId = null;
        this._gridCols = 0;
        this._gridRows = 2;
        this._polStart = 0;
        this._comicPanels = [];
        this._comicDirty = false;

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
        this._themeChangedId = this._settings.connect(
            'changed::picker-theme', this._onThemeChanged.bind(this));
        this._polColsChangedId = this._settings.connect(
            'changed::picker-polaroid-cols', this._onPolaroidSettingsChanged.bind(this));
        this._polRowsChangedId = this._settings.connect(
            'changed::picker-polaroid-rows', this._onPolaroidSettingsChanged.bind(this));
        this._trayChangedId = this._settings.connect(
            'changed::show-tray-icon', this._onTrayIconChanged.bind(this));

        this._setupFileMonitor();
    }

    _onTrayIconChanged() {
        const want = this._settings.get_boolean('show-tray-icon');
        const have = !!this._button;
        if (want === have)
            return;
        if (!want && this._button) {
            if (this._buttonPressId) {
                this._button.disconnect(this._buttonPressId);
                this._buttonPressId = null;
            }
            this._button.destroy();
            this._button = null;
        } else if (want) {
            this._buildIndicator();
        }
    }


    disable() {
        if (this._overlay)
            this._closeOverlay();

        this._stopLoading();
        this._cancelPreview();
        this._teardownFileMonitor();

        Main.wm.removeKeybinding('show-picker');

        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        if (this._subfoldersChangedId) {
            this._settings.disconnect(this._subfoldersChangedId);
            this._subfoldersChangedId = null;
        }
        if (this._themeChangedId) {
            this._settings.disconnect(this._themeChangedId);
            this._themeChangedId = null;
        }
        if (this._polColsChangedId) {
            this._settings.disconnect(this._polColsChangedId);
            this._polColsChangedId = null;
        }
        if (this._polRowsChangedId) {
            this._settings.disconnect(this._polRowsChangedId);
            this._polRowsChangedId = null;
        }
        if (this._trayChangedId) {
            this._settings.disconnect(this._trayChangedId);
            this._trayChangedId = null;
        }

        if (this._button) {
            if (this._buttonPressId)
                this._button.disconnect(this._buttonPressId);
            this._buttonPressId = null;
            this._button.destroy();
            this._button = null;
        }

        this._settings = null;
    }

    _buildIndicator() {
        if (!this._settings.get_boolean('show-tray-icon'))
            return 0;
        this._button = new PanelMenu.Button(0.0, 'Wallpapi', true);
        this._button.add_child(new St.Icon({
            icon_name: 'preferences-desktop-wallpaper-symbolic',
            fallback_icon_name: 'image-x-generic-symbolic',
            style_class: 'system-status-icon',
        }));
        this._buttonPressId = this._button.connect('button-press-event', () => {
            this._toggleOverlay();
            return Clutter.EVENT_STOP;
        });
        Main.panel.addToStatusArea('wallpapi', this._button, 0, 'right');
    }

    _onFolderChanged() {
        this._setupFileMonitor();
        if (this._overlay)
            this._rescan();
    }

    _onThemeChanged() {
        if (!this._overlay)
            return;
        this._closeOverlay();
        this._openOverlay();
    }

    _onPolaroidSettingsChanged() {
        if (!this._overlay || !this._theme)
            return;
        if (this._theme.flavor === 'polaroid')
            this._relayout();
    }

    _setupFileMonitor() {
        this._teardownFileMonitor();

        const folder = this._settings.get_string('folder').trim();
        if (!folder)
            return;

        const dirs = [lib.expandPath(folder)];
        if (this._settings.get_boolean('include-subfolders')) {
            try {
                const seen = new Set(dirs);
                for (const path of lib.scanFolder(folder, true)) {
                    const parent = GLib.path_get_dirname(path);
                    if (!seen.has(parent)) {
                        seen.add(parent);
                        dirs.push(parent);
                    }
                }
            } catch (e) {
                lib.logError(e);
            }
        }

        for (const dir of dirs) {
            try {
                const mon = Gio.File.new_for_path(dir).monitor_directory(
                    Gio.FileMonitorFlags.NONE, null);
                if (!mon)
                    continue;
                const id = mon.connect('changed', (m, file, other, ev) => {
                    if (ev === Gio.FileMonitorEvent.CHANGED ||
                        ev === Gio.FileMonitorEvent.ATTRIBUTE_CHANGED ||
                        ev === Gio.FileMonitorEvent.PRE_UNMOUNT ||
                        ev === Gio.FileMonitorEvent.UNMOUNTED)
                        return;
                    this._scheduleFolderRefresh();
                });
                this._fileSubMonitors.push({mon, id});
            } catch (e) {
                lib.logError(e);
            }
        }
    }

    _scheduleFolderRefresh() {
        if (this._fsDebounceId) {
            GLib.source_remove(this._fsDebounceId);
            this._fsDebounceId = 0;
        }
        this._fsDebounceId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT, 300, () => {
                this._fsDebounceId = 0;
                if (this._overlay)
                    this._rescan();
                return GLib.SOURCE_REMOVE;
            });
    }

    _teardownFileMonitor() {
        for (const {mon, id} of this._fileSubMonitors) {
            try {
                if (id)
                    mon.disconnect(id);
                mon.cancel();
            } catch (unused) {
            }
        }
        this._fileSubMonitors = [];
        if (this._fsDebounceId) {
            GLib.source_remove(this._fsDebounceId);
            this._fsDebounceId = 0;
        }
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
        this._sliceLabels.clear();
        this._sliceDims.clear();
        this._pixbufs.clear();
        this._focusIndex = 0;
        this._polStart = 0;
        this._comicPanels = [];
        this._comicDirty = false;
        this._scrollAccum = {x: 0, y: 0};
        this._theme = this._currentTheme();

        const monitor = Main.layoutManager.primaryMonitor;
        const overlay = new St.Widget({
            style_class: `wallpapi-overlay wallpapi-theme-${this._theme.id}`,
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
        overlay.connect('scroll-event', (actor, event) =>
            this._onScrollEvent(event));

        const header = new St.BoxLayout({
            vertical: true,
            style_class: 'wallpapi-header',
            x_expand: true,
        });
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
        this._hintLabel = new St.Label({
            text: '',
            style_class: 'wallpapi-hint',
        });
        // instructions intentionally withheld: people can figure the picker out
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

    _currentTheme() {
        const idx = this._settings.get_int('picker-theme');
        return themes.THEMES[idx] ?? themes.THEMES[0];
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
        this._scrollAccum = null;

        if (this._grab) {
            Main.popModal(this._grab);
            this._grab = null;
        }

        if (this._carouselArea) {
            this._carouselArea.destroy();
            this._carouselArea = null;
        }
        if (this._currentLabel) {
            this._currentLabel.destroy();
            this._currentLabel = null;
        }
        if (this._hintLabel) {
            this._hintLabel.destroy();
            this._hintLabel = null;
        }
        if (this._bottomBar) {
            this._bottomBar.destroy();
            this._bottomBar = null;
        }
        if (this._folderLabel) {
            this._folderLabel.destroy();
            this._folderLabel = null;
        }
        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }
        this._items = [];
        this._sliceActors = [];
        this._sliceImgs.clear();
        this._sliceLabels.clear();
        this._sliceDims.clear();
        this._pixbufs.clear();
        this._theme = null;
        this._comicPanels = [];
        this._comicDirty = false;
    }

    _rescan() {
        if (!this._overlay)
            return;

        this._stopLoading();
        this._pixbufs.clear();
        this._theme = this._currentTheme();

        this._carouselArea.destroy_all_children();
        this._sliceActors = [];
        this._sliceImgs.clear();
        this._sliceLabels.clear();
        this._sliceDims.clear();
        this._items = [];
        this._polStart = 0;
        this._comicPanels = [];
        this._comicDirty = false;

        if (this._folderEmpty()) {
            this._folderLabel.text = '';
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
            this._folderLabel.text = '';
            this._showMessage('Could not read the selected folder');
            return;
        }

        if (paths.length === 0) {
            this._folderLabel.text = '';
            this._showMessage('No wallpapers found in the selected folder');
            return;
        }

        this._items = paths;
        this._folderLabel.text = '';

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

        if (this._theme.caption &&
                this._settings.get_boolean('show-file-name')) {
            const label = new St.Label({
                text: path.split('/').pop(),
                style_class: 'wallpapi-caption',
            });
            slice.add_child(label);
            this._sliceLabels.set(index, label);
        }

        return slice;
    }

    _relayout() {
        if (!this._overlay || this._items.length === 0)
            return;

        const kind = this._theme.kind;
        if (kind === 'grid') {
            return this._theme.flavor === 'polaroid'
                ? this._relayoutPolaroid()
                : this._relayoutGrid();
        }
        if (kind === 'comic')
            return this._relayoutComic();
        return this._relayoutCarousel();
    }

    _relayoutCarousel() {
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
            this._applyCarouselVisual(i, w, h);

            if (selected)
                this._carouselArea.set_child_above_sibling(slice, null);
        }
    }

    _relayoutGrid() {
        const width = this._overlay.width;
        const height = this._overlay.height;
        const areaY = HEADER_HEIGHT;
        const areaH = height - HEADER_HEIGHT - BOTTOM_HEIGHT;
        const cols = themes.gridCols(width);
        this._gridCols = cols;
        const n = this._items.length;
        const rows = Math.ceil(n / cols);
        const cellW = themes.GRID_CELL_W;
        const cellH = themes.GRID_CELL_H;
        const gap = themes.GRID_GAP;
        const totalW = cols * cellW + (cols - 1) * gap;
        const totalH = rows * cellH + (rows - 1) * gap;
        const left = Math.max(0, Math.round((width - totalW) / 2));

        let top;
        if (totalH <= areaH - 16) {
            top = Math.max(areaY + 8, areaY + Math.round((areaH - totalH) / 2));
        } else {
            const cy = Math.round(areaY + areaH / 2);
            const focusRow = Math.floor(this._focusIndex / cols);
            const rowCenter = focusRow * (cellH + gap) + cellH / 2;
            top = Math.round(cy - rowCenter);
            top = Math.max(areaY + areaH - 8 - totalH,
                Math.min(areaY + 8, top));
        }

        for (let i = 0; i < this._items.length; i++) {
            const slice = this._sliceActors[i];
            if (!slice)
                continue;
            slice.visible = true;
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = left + col * (cellW + gap);
            const y = top + row * (cellH + gap);
            slice.set_position(x, y);
            slice.set_size(cellW, cellH);
            this._applyFlatVisual(i, cellW, cellH);

            if (i === this._focusIndex)
                this._carouselArea.set_child_above_sibling(slice, null);
        }
    }

    _relayoutPolaroid() {
        const width = this._overlay.width;
        const height = this._overlay.height;
        const areaY = HEADER_HEIGHT;
        const areaH = height - HEADER_HEIGHT - BOTTOM_HEIGHT;
        const cols = themes.clampInt(
            this._settings.get_int('picker-polaroid-cols'), 2, 10, 6);
        const rows = themes.clampInt(
            this._settings.get_int('picker-polaroid-rows'), 1, 4, 2);
        this._gridCols = cols;
        this._gridRows = rows;
        const n = this._items.length;
        if (n === 0)
            return;

        const cellW = themes.polaroidCellW(width, cols);
        const cellH = themes.polaroidCellH(areaH, rows);
        const totalCols = Math.max(1, Math.ceil(n / rows));

        let start = this._polStart ?? 0;
        const startCol = Math.floor(start / rows);
        const focusCol = Math.floor(this._focusIndex / rows);
        if (focusCol < startCol)
            start = focusCol * rows;
        else if (focusCol >= startCol + cols)
            start = (focusCol - cols + 1) * rows;
        const maxStart = Math.max(0, (totalCols - cols) * rows);
        this._polStart = Math.max(0, Math.min(start, maxStart));
        const viewCol = Math.floor(this._polStart / rows);

        const gap = themes.GRID_GAP;
        const viewW = cols * cellW + (cols - 1) * gap;
        const viewH = rows * cellH + (rows - 1) * gap;
        const x0 = Math.max(0, Math.round((width - viewW) / 2));
        const y0 = Math.max(areaY + 8, areaY + Math.round((areaH - viewH) / 2));

        for (let i = 0; i < n; i++) {
            const slice = this._sliceActors[i];
            if (!slice)
                continue;
            const c = Math.floor(i / rows) - viewCol;
            if (c < 0 || c >= cols) {
                slice.visible = false;
                continue;
            }
            slice.visible = true;
            const r = i % rows;
            slice.set_position(x0 + c * (cellW + gap),
                y0 + r * (cellH + gap));
            slice.set_size(cellW, cellH);
            this._applyPolaroidVisual(i, cellW, cellH);

            if (i === this._focusIndex)
                this._carouselArea.set_child_above_sibling(slice, null);
        }
    }

    _relayoutComic() {
        const width = this._overlay.width;
        const height = this._overlay.height;
        const areaY = HEADER_HEIGHT;
        const areaH = height - HEADER_HEIGHT - BOTTOM_HEIGHT;

        if (this._comicPanels.length !== this._items.length || this._comicDirty) {
            const aspects = this._items.map((src, i) => {
                const d = this._sliceDims.get(i);
                return d ?? null;
            });
            this._comicPanels = themes.comicMasonry(
                this._items.length, aspects, width, areaH);
            this._comicDirty = false;
        }
        const panels = this._comicPanels;
        const n = Math.min(this._items.length, panels.length);
        if (n === 0)
            return;

        let bottom = 0;
        for (const pan of panels)
            bottom = Math.max(bottom, pan.y + pan.h);
        const totalH = bottom + themes.COMIC_MARGIN;

        let top;
        if (totalH <= areaH) {
            top = areaY + Math.round((areaH - totalH) / 2);
        } else {
            const focus = panels[this._focusIndex] ?? panels[0];
            const fc = focus.y + focus.h / 2;
            top = Math.round(areaY + areaH / 2 - fc);
            top = Math.max(areaY + areaH - 8 - bottom,
                Math.min(areaY + 8, top));
        }

        for (let i = 0; i < n; i++) {
            const slice = this._sliceActors[i];
            if (!slice)
                continue;
            const pan = panels[i];
            slice.visible = true;
            slice.set_position(pan.x, top + pan.y);
            slice.set_size(pan.w, pan.h);
            this._applyFlatVisual(i, pan.w, pan.h);

            if (i === this._focusIndex)
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

        const focalHalf = (SLICE_WIDTH + SELECTED_EXTRA_WIDTH) / 2 +
            SLICE_SKEW * bound;
        const nbhHalf = SLICE_WIDTH / 2 + SLICE_SKEW * bound;
        const nearStep = Math.round(
            focalHalf + nbhHalf + SLICE_SPACING - NEAR_STEP_PULL);

        if (dist === 1)
            return sign * nearStep;
        return sign * (nearStep + (dist - 1) * (SLICE_WIDTH + SLICE_SPACING));
    }

    _cropTo(pixbuf, availW, availH) {
        const scale = Math.max(availW / pixbuf.get_width(),
            availH / pixbuf.get_height());
        const iw = Math.max(1, Math.round(pixbuf.get_width() * scale));
        const ih = Math.max(1, Math.round(pixbuf.get_height() * scale));

        let source = pixbuf;
        if (iw !== pixbuf.get_width() || ih !== pixbuf.get_height()) {
            source = pixbuf.scale_simple(iw, ih, GdkPixbuf.InterpType.BILINEAR);
            if (!source)
                return null;
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
        return cropped;
    }

    _borderFor(selected) {
        if (!selected)
            return [255, 255, 255, 90];
        if (this._theme && themes.THEMES[this._settings.get_int('picker-theme')]) {
            const accent = this._theme.accent;
            return accent ?? [53, 132, 228, 255];
        }
        return [53, 132, 228, 255];
    }

    _applyCarouselVisual(index, slotW, slotH) {
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
        const cropped = this._cropTo(pixbuf, availW, availH);
        if (!cropped)
            return;

        const border = this._borderFor(selected);
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

    _applyPolaroidVisual(index, slotW, slotH) {
        const slice = this._sliceActors[index];
        const imgActor = this._sliceImgs.get(index);
        if (!slice || !imgActor)
            return;

        const selected = index === this._focusIndex;
        slice.style_class = selected
            ? 'wallpapi-slice wallpapi-theme-polaroid wallpapi-polaroid-selected'
            : 'wallpapi-slice wallpapi-theme-polaroid';

        const pixbuf = this._pixbufs.get(index);
        if (!pixbuf || !this._coglContext)
            return;

        const availW = Math.max(1, slotW - 2 * POLAROID_PAD);
        const availH = Math.max(1, slotH - 2 * POLAROID_PAD - CAPTION_HEIGHT);
        const cropped = this._cropTo(pixbuf, availW, availH);
        if (!cropped)
            return;

        const framed = lib.framePixbuf(
            cropped, POLAROID_PAD, [245, 245, 240, 255],
            POLAROID_PAD + CAPTION_HEIGHT);
        const fw = framed.get_width();
        const fh = framed.get_height();
        const capY = Math.max(0, fh - CAPTION_HEIGHT);

        const bytes = new GLib.Bytes(framed.get_pixels());
        imgActor.content.set_bytes(
            this._coglContext, bytes,
            Cogl.PixelFormat.RGBA_8888,
            fw, fh, framed.get_rowstride());

        imgActor.set_size(fw, fh);
        imgActor.set_position(Math.round((slotW - fw) / 2), 0);
        imgActor.opacity = selected ? 255 : 170;

        const label = this._sliceLabels.get(index);
        if (label) {
            label.set_position(POLAROID_PAD, capY);
            label.set_size(fw - 2 * POLAROID_PAD, fh - capY);
            label.style_class = 'wallpapi-caption';
        }
    }

    _applyFlatVisual(index, slotW, slotH) {
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

        const captionH = this._theme.caption ? CAPTION_HEIGHT : 0;
        const pad = 8;
        const availW = Math.max(1, slotW - 2 * pad);
        const availH = Math.max(1, slotH - captionH - 2 * pad);
        const cropped = this._cropTo(pixbuf, availW, availH);
        if (!cropped)
            return;

        const border = this._borderFor(selected);
        const rect = lib.shearPixbuf(cropped, 0, border);
        const rw = rect.get_width();

        const bytes = new GLib.Bytes(rect.get_pixels());
        imgActor.content.set_bytes(
            this._coglContext, bytes,
            Cogl.PixelFormat.RGBA_8888,
            rw, rect.get_height(), rect.get_rowstride());

        imgActor.set_size(rw, rect.get_height());
        imgActor.set_position(Math.round((slotW - rw) / 2), pad);
        imgActor.opacity = selected ? 255 : 170;

        const label = this._sliceLabels.get(index);
        if (label) {
            label.set_position(0, slotH - captionH);
            label.set_size(slotW, captionH);
            label.visible = captionH > 0;
        }
    }

    _setFocus(index) {
        if (index < 0 || index >= this._items.length)
            return;

        this._focusIndex = index;
        this._relayout();

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

    _moveFocus(dx, dy) {
        if (this._items.length === 0)
            return;
        const n = this._items.length;
        if (this._theme && this._theme.kind === 'grid') {
            if (this._theme.flavor === 'polaroid') {
                const stepX = this._gridRows || 2;
                this._setFocus(((this._focusIndex + dx * stepX + dy) % n + n) % n);
            } else {
                const cols = this._gridCols || themes.gridCols(this._overlay.width);
                this._setFocus(((this._focusIndex + dx + dy * cols) % n + n) % n);
            }
            return;
        }
        if (this._theme && this._theme.kind === 'comic') {
            this._setFocus(((this._focusIndex + dx) % n + n) % n);
            return;
        }
        this._setFocus(((this._focusIndex + dx) % n + n) % n);
    }

    _onScrollEvent(event) {
        const dir = event.get_scroll_direction();
        const board = this._theme?.flavor === 'polaroid';
        const step = board ? this._gridRows || 2 : 1;
        if (dir === Clutter.ScrollDirection.UP) {
            this._moveFocus(board ? -step : -1, 0);
            return Clutter.EVENT_STOP;
        }
        if (dir === Clutter.ScrollDirection.DOWN) {
            this._moveFocus(board ? step : 1, 0);
            return Clutter.EVENT_STOP;
        }
        if (dir === Clutter.ScrollDirection.LEFT) {
            this._moveFocus(-step, 0);
            return Clutter.EVENT_STOP;
        }
        if (dir === Clutter.ScrollDirection.RIGHT) {
            this._moveFocus(step, 0);
            return Clutter.EVENT_STOP;
        }
        if (dir === Clutter.ScrollDirection.SMOOTH) {
            const delta = event.get_scroll_delta();
            this._scrollAccum.y += delta.y ?? delta[1] ?? 0;
            this._scrollAccum.x += delta.x ?? delta[0] ?? 0;
            while (this._scrollAccum.y >= 1) {
                this._scrollAccum.y -= 1;
                this._moveFocus(step, 0);
            }
            while (this._scrollAccum.y <= -1) {
                this._scrollAccum.y += 1;
                this._moveFocus(-step, 0);
            }
            while (this._scrollAccum.x >= 1) {
                this._scrollAccum.x -= 1;
                this._moveFocus(step, 0);
            }
            while (this._scrollAccum.x <= -1) {
                this._scrollAccum.x += 1;
                this._moveFocus(-step, 0);
            }
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
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
        if (this._theme && this._theme.kind === 'grid') {
            if (symbol === Clutter.KEY_Up) {
                this._moveFocus(0, -1);
                return Clutter.EVENT_STOP;
            }
            if (symbol === Clutter.KEY_Down) {
                this._moveFocus(0, 1);
                return Clutter.EVENT_STOP;
            }
        }
        if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_BackTab) {
            this._moveFocus(-1, 0);
            return Clutter.EVENT_STOP;
        }
        if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Tab) {
            this._moveFocus(1, 0);
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
            const pixbuf = lib.loadThumbnail(
                srcPath, (SLICE_WIDTH + SELECTED_EXTRA_WIDTH) * 4,
                (EXPECTED_HEIGHT + SELECTED_EXTRA_HEIGHT) * 2);
            if (!pixbuf)
                return;
            this._pixbufs.set(index, pixbuf);
            this._sliceDims.set(index, [pixbuf.get_width(), pixbuf.get_height()]);
            if (this._theme && this._theme.id === 'comic-strip')
                this._comicDirty = true;
            if (this._theme && this._theme.id === 'comic-strip') {
                const label = this._sliceLabels.get(index);
                if (label) {
                    label.text = `${srcPath.split('/').pop()} · ` +
                        `${pixbuf.get_width()}×${pixbuf.get_height()}`;
                }
            }
            const slice = this._sliceActors[index];
            if (slice) {
                this._resliceVisual(index,
                    slice.width ? slice.width : SLICE_WIDTH,
                    slice.height ? slice.height : EXPECTED_HEIGHT);
            }
        } catch (e) {
            lib.logError(e);
        }
    }

    _resliceVisual(index, slotW, slotH) {
        if (!this._theme)
            return;
        const kind = this._theme.kind;
        if (kind === 'grid') {
            if (this._theme.flavor === 'polaroid') {
                const cols = themes.clampInt(
                    this._settings.get_int('picker-polaroid-cols'), 2, 10, 6);
                const rows = themes.clampInt(
                    this._settings.get_int('picker-polaroid-rows'), 1, 4, 2);
                const cellW = themes.polaroidCellW(this._overlay.width, cols);
                const areaH = this._overlay.height - HEADER_HEIGHT - BOTTOM_HEIGHT;
                const cellH = themes.polaroidCellH(areaH, rows);
                this._applyPolaroidVisual(index, cellW, cellH);
            } else {
                this._applyFlatVisual(index, themes.GRID_CELL_W, themes.GRID_CELL_H);
            }
        } else if (kind === 'comic') {
            const pan = this._comicPanels?.[index];
            const w = pan?.w ?? themes.COMIC_PANEL_W;
            const h = pan?.h ?? themes.COMIC_PANEL_H;
            this._applyFlatVisual(index, w, h);
        } else if (this._theme.flavor === 'polaroid') {
            this._applyPolaroidVisual(index, slotW, slotH);
        } else {
            this._applyCarouselVisual(index, slotW, slotH);
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
