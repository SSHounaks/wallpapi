import Gtk from 'gi://Gtk';
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import * as lib from './lib.js';

export default class WallpapiExtensionPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        window.add(page);

        const folderGroup = new Adw.PreferencesGroup({
            title: 'Wallpaper folder',
        });
        page.add(folderGroup);

        const entry = new Adw.EntryRow({
            title: 'Folder path',
        });
        entry.text = settings.get_string('folder') ?? '';
        folderGroup.add(entry);

        const browse = new Gtk.Button({
            label: 'Browse…',
            valign: Gtk.Align.CENTER,
        });
        browse.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({
                title: 'Choose wallpaper folder',
            });
            dialog.select_folder(window, null, (dlg, res) => {
                try {
                    const file = dialog.select_folder_finish(res);
                    entry.text = file.get_path();
                    settings.set_string('folder', file.get_path());
                } catch (e) {
                }
            });
        });
        entry.add_suffix(browse);

        const statusGroup = new Adw.PreferencesGroup();
        page.add(statusGroup);

        const statusRow = new Adw.ActionRow({
            title: 'Checking folder…',
        });
        statusGroup.add(statusRow);

        const refreshStatus = () => {
            const validation = lib.validateFolder(entry.text);
            switch (validation.reason) {
            case 'empty':
                statusRow.title = 'No folder set yet';
                statusRow.subtitle = 'Pick the folder with the Browse button or type a path.';
                statusRow.icon_name = 'dialog-information-symbolic';
                break;
            case 'not-found':
                statusRow.title = 'Folder does not exist';
                statusRow.subtitle = `${lib.expandPath(entry.text)}`;
                statusRow.icon_name = 'dialog-error-symbolic';
                break;
            case 'no-images':
                statusRow.title = 'No images found';
                statusRow.subtitle = `No supported images in ${lib.expandPath(entry.text)}`;
                statusRow.icon_name = 'dialog-warning-symbolic';
                break;
            default:
                statusRow.title = `${validation.count} wallpaper${validation.count === 1 ? '' : 's'} collected`;
                statusRow.subtitle = lib.expandPath(entry.text);
                statusRow.icon_name = 'emblem-default-symbolic';
                break;
            }
        };

        let debounceId = 0;
        entry.connect('changed', (row) => {
            settings.set_string('folder', row.text.trim());
            if (debounceId)
                GLib.source_remove(debounceId);
            statusRow.title = 'Checking folder…';
            debounceId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
                debounceId = 0;
                refreshStatus();
                return GLib.SOURCE_REMOVE;
            });
        });
        refreshStatus();

        const optionsGroup = new Adw.PreferencesGroup();
        page.add(optionsGroup);

        const subfoldersRow = new Adw.SwitchRow({
            title: 'Include subfolders',
            subtitle: 'Also list image files inside nested folders.',
        });
        subfoldersRow.active = settings.get_boolean('include-subfolders');
        subfoldersRow.connect('notify::active', () =>
            settings.set_boolean('include-subfolders', subfoldersRow.active));
        optionsGroup.add(subfoldersRow);

        const shortcutGroup = new Adw.PreferencesGroup({
            title: 'Keyboard shortcut',
        });
        page.add(shortcutGroup);

        const shortcutRow = new Adw.EntryRow({
            title: 'Show picker',
        });
        const [binding] = settings.get_strv('show-picker');
        shortcutRow.text = binding ?? '';
        shortcutRow.connect('changed', (row) => {
            const value = row.text.trim();
            settings.set_strv('show-picker', value ? [value] : []);
        });
        shortcutGroup.add(shortcutRow);
    }
}
