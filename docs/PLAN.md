# Wallpapi v1.1 roadmap

## Goals
Instant preview, history/undo, file watching, slideshow timer, per-monitor model.

## Schema additions (org.gnome.shell.extensions.wallpapi)
- `instant-preview` (b, default true)
- `slideshow-enabled` (b, false), `slideshow-interval` (i, 10 min)
- `history` (as, [], capped 20)
- `monitor-wallpapers` (a{sv}, per-monitor map — scope P1, see below)

## Shared groundwork
- `lib.setWallpaper(path, {commit: true, monitor})` — commit false skips
  Gio.Settings.sync() (preview); monitor param for per-monitor model.
- extension.js: new state in enable()/_openOverlay/_closeOverlay; porters in
  disable(). prefs.js: toggles + interval spin + Clear history row
  (pkill -f gnome-extensions quirk). Recompile schemas both locations.

## Feature order
1. Instant preview  — focus = live apply (throttled, no sync), Enter commit,
   Esc/close revert to _originalWallpaper captured at open.
2. History + undo   — push on commit + slideshow, pop via Ctrl+z / H key.
3. File watching    — Gio.FileMonitor (recursive incl. subfolders), debounce
   300ms → _rescan.
4. Slideshow        — timeout_add_seconds, random pick per tick, skip while
   overlay open.
5. Per-monitor      — P1 (safe): data model + picker selector; actual
   background stays global. P2 global-set w/ per-monitor memory. P3 true
   compositing = NOT EGO-safe, avoided.

## Per-feature details & risks
- Preview: rapid GSettings writes throttled via 60ms debounce; one sync() at
  commit/close. Toggleable.
- History: written only on commit/slideshow, never preview.
- File monitor: re-created on folder/include-subfolders change; errors logError.
- Slideshow: folder empty → skip; interval change restarts timer.
- Per-monitor: GNOME has no public per-monitor wallpaper API on Wayland;
  P1 is EGO-review-safe and forward-compatible.

## Release
Bump metadata version → v1.1.0 tag + release asset + live reload
(disable/enable over D-Bus).
