---
name: wallpapi-dev
description: Use when working on the wallpapi GNOME Shell extension dev loop — editing extension.js/prefs.js/lib.js, rebuilding the test zip, running the headless nested-shell harness (gnome-shell-test-tool), reading wallpapi-report.txt, checking the preview screenshot, or fixing GNOME Shell 50 API issues. Covers the no-logout verify cycle for this repo.
---

# Wallpapi dev loop

Rapidly verify changes to this GNOME Shell 50 extension without touching a
live session. The environment is a snap sandbox (snap.opencode.opencode) with
no display, DRM/seat, Xvfb, weston, or mutter; shell 50 runs headless only.

## The loop (run after every code change)

1. Edit source in the repo (`extension.js`, `prefs.js`, `lib.js`,
   `stylesheet.css`, `schemas/...`).
2. Sync the installed copy (mirrors `~/.local/share/...`) and rebuild the zip:
   `cp extension.js ~/.local/share/gnome-shell/extensions/wallpapi@shalnark/extension.js`
   `rm -f /tmp/opencode/wallpapi@shalnark.zip && zip -q -r /tmp/opencode/wallpapi@shalnark.zip . -x '.git/*' -x 'schemas/gschemas.compiled'`
   (schema edits additionally need `glib-compile-schemas` in both `schemas/` and the installed copy).
3. Run the harness (bounded — the shell never exits on its own):
   `rm -f /tmp/opencode/wallpapi-report.txt`
   `timeout 120 dbus-run-session -- gnome-shell-test-tool --headless --disable-animations --extension /tmp/opencode/wallpapi@shalnark.zip /tmp/opencode/wallpapi-test.mjs > /tmp/opencode/out/runN.log 2>&1`
   Expect `exit=124` (timeout kill). **Success = report file ends with
   `=== TEST COMPLETE ===`.** Inspect the report, not the shell log.
4. Verify. The model cannot view images — read `/tmp/opencode/out/wallpapi-carousel.png`
   (captured each run with the overlay open) via Python/PIL: expect wallpaper
   colors inside card regions (e.g. center card avg ~(46,129,122) for forest),
   neighbor cards dimmer, scrim ~(7,29,61) in gaps, and the focus border color
   (53,132,228) traceable along the slanted edge (`blue where b>140, b-r>=40`).

## Harness contract (`/tmp/opencode/wallpapi-test.mjs`)

- An ESM automation script passed to `gnome-shell-test-tool` as the last
  argument. Shell 50 contract: export `init()` (called during startup),
  `METRICS = {}`, and `run()`.
- `gnome-shell-perf-helper` is ABSENT → `run()` must be a never-resolving
  `Promise` so the perf path idles instead of crashing with
  "Script failed: run is not a function".
- The extension installs/enables via keyfile into a fresh temp XDG dir.
  Find it with `Main.extensionManager.lookup('wallpapi@shalnark')`; wait until
  `stateObj` exists and `enabled === true`.
- Steps: open overlay (`ex._openOverlay()`), wait for `ex._pixbufs.size` to
  grow, assert focus/navigation math via `ex._setFocus`/`ex._moveFocus`,
  `ex._activate(1)` sets `org.gnome.desktop.background picture-uri`, screenshot
  while the overlay is open, toggle subfolders → 5 items, then print
  `=== TEST COMPLETE ===` to the report.
- Screenshot recipe: `new Shell.Screenshot().screenshot_stage_to_content()`
  → `content.get_texture()` → `captureScreenshot(texture, null, 1, null)`
  (exported from `resource:///org/gnome/shell/ui/screenshot.js`) returns a
  stored `Gio.File`; copy it to `/tmp/opencode/out/`.

## Test wallpapers

`/tmp/opencode/wallpapers/` holds `aurora.png, forest.png, sunset.png,
deepblue.png` + `sub/violet.png` (4 top-level, 5 with subfolders). Regenerate
with `magick -size 1920x1080 gradient:#HEX1-#HEX2 /tmp/opencode/wallpapers/X.png`.

## GNOME Shell 50 API gotchas (verified)

- **No `raise()`/`raise_top()`** on Clutter/St actors. Z-order:
  `Main.uiGroup.set_child_above_sibling(actor, null)` /
  `parent.set_child_above_sibling(child, null)`.
- **`actor.get_transform()` includes the actor's translation**, so
  `matrix.is_identity()` is usually false. Read shear from
  `matrix.get_value(0,1)` instead.
- **Skew/parallelogram — DO NOT use `set_transform`**: the Graphene shear matrix
  makes mutter refuse to paint the whole subtree (verified: nothing below
  y≈214 rendered; without transform everything painted). The working approach
  is **pixel-shear in GdkPixbuf** (`lib.shearPixbuf`): cover-crop the source,
  then per-row `copy_area(0,y,w,1, dest, x0(y), y)` where
  `x0(y) = outW/2 - w/2 + k*(y - h/2)` into a slightly wider `dest`, so every
  card is a uniform vertical parallelogram (equidistant, same size, selected
  card taller via a bigger slotH). Never attach any Clutter transform.
- **Thumbnails**: `St.ImageContent.new_with_preferred_size(w,h)`, decode via
  `GdkPixbuf.Pixbuf.new_from_file_at_scale`, then
  `content.set_bytes(coglContext, bytes, fmt, w, h, rowstride)` with
  `coglContext` from `global.stage.context.get_backend().get_cogl_context()`.
  Center-crop fill: scale to cover (`max` ratio), `new_subpixbuf` the middle.
- **GdkPixbuf byte writes**: `pixbuf.get_pixels()` returns a **copy** — mutating
  it does NOT reach the pixbuf (saved PNG stays unchanged). To stamp pixels
  (borders), build a tiny pixbuf (`Pixbuf.new(...,true,8,1,1)`) and
  `copy_area` it in. Cross-pixbuf `copy_area` works; **self `copy_area`
  (source==dest) is a silent no-op**. `fill(uint32)` takes RGBU big-endian
  order — build the value with arithmetic (`r*16777216+g*65536+b*256+a`), never
  JS `<<` bit-shifts (32-bit signed → negative → gjs `uint32 out of range`
  error).
- **`Gio.Task`/worker threads segfault** standalone gjs → keep chunked loading
  (`GLib.timeout_add` completing a couple of items per tick, `LOAD_RANGE`-aware).
- **`Main.pushModal` returns `Clutter.Grab`** (not a number).
- **Wallpaper setter is scheme-aware** (WallpaperSwitcher pattern): only
  `picture-uri` (light) or `picture-uri-dark` (dark) from
  `org.gnome.desktop.interface color-scheme`; guard `is_writable`; expand `~`/
  `$HOME`; errors → `~/.local/var/log/Wallpapi.log` with a 64KB cap.
- **Prefs caching**: the prefs worker caches the imported `prefs.js`; after
  editing prefs, `pkill -f gnome-extensions` before reopening, else you
  retest stale code.
- **`--nested` was removed in GNOME 49** (it was tied to the X11 backend);
  any `gnome-shell --wayland` now tries to own the seat and dies with
  `Failed to take control of the session ... EBUSY`. The replacement is the
  **development kit**: `dbus-run-session -- gnome-shell --devkit` (windowed
  shell, no seat takeover). It requires `/usr/libexec/mutter-devkit` from the
  `mutter-dev-bin` package (`sudo apt install mutter-dev-bin`). In the sandbox
  there is no seat anyway, so the headless harness remains the only local
  validation path. If a run fails with `Failed to create_socket`, kill the
  leaked stale instance (find it via `pgrep -af 'gnome-shell --automation-script'`,
  kill by PID — never `pkill gnome-shell`, that kills the real session) and
  delete `/run/user/1000/gnome-shell-test-display*`.

## Live-session notes

- No logout/in-place reload works in the sandbox: `ExtensionManager.lookup`
  won't adopt the install dir, `EnableExtension` returns `(false,)`, `Eval` is
  unavailable. Real reload on Wayland = log out/in. On a real host you can:
  `dbus-run-session -- gnome-shell --devkit` after `sudo apt install
  mutter-dev-bin` (windowed dev shell sharing the extension install dirs), or
  `Alt+F2` → `lg` (Looking Glass, logs) — `r` restart is X11-only. There is no
  Wayland reload mechanism; code changes need a fresh shell process.
- Geometry knobs live near the top of `extension.js`: `SLICE_SKEW` (lean,
  ~0.12), `SELECTED_EXTRA_HEIGHT` (selected card extra length, 150),
  `SELECTED_EXTRA_WIDTH` (selected card extra width, 40),
  `SLICE_WIDTH`/`SLICE_SPACING`/`VISIBLE_RANGE`/`LOAD_RANGE`.
- String-replace patches silently no-op when the search text doesn't match
  exactly (spaces/newlines). After patching a file, grep it to confirm the edit
  actually landed before running the harness.
- Commit after each verified milestone (repo has no git identity configured at
  global level — `git config user.name`/`user.email` locally if needed).

## Repo tooling (no Node — plain gjs)

- `make check` — lint + unit tests + coverage in one shot, exits non-zero on
  failure. Individual: `make test`, `make coverage`, `make lint`.
- Unit tests/coverage must run under `dbus-run-session` (Gio.Settings needs a
  session bus); the Makefile already wraps them.
- gjs built-in `--coverage` is unreliable in gjs 1.88 — don't use it; coverage
  is a Proxy recorder over `lib.js` exports (see scripts/coverage.mjs).
- `scripts/lint.mjs` = code-smell scan: gjs syntax check on extension.js /
  lib.js / prefs.js, tabs, trailing whitespace, lines >130, console.log /
  debugger, TODO/FIXME markers, and undefined-identifier heuristics on the
  three shipped files. Keep it at 0 errors, 0 warnings.
