# Wallpapi roadmap

## Delivered (v1.1.0, master)
- Instant preview (throttled, commit on Enter) + original-wallpaper revert.
- File watching (recursive incl. subfolders, debounced 300ms rescans).
- Scroll navigation + keyboard (Left/Right, PgUp/PgDn), smooth wheel.
- Disk thumbnail cache in lib.js (~/.cache/wallpapi/thumbnails).
- Tooling: Makefile, lint (0/0), unit tests 19/19, coverage 100%, zip build.
- org.gnome.shell.extensions.wallpapi schema live on EGO; local install synced.

## Abandoned
- History + undo — skipped by request; Ctrl+Z/H reserved by themes, do not build.

# v1.2 — Picker themes

## Goal
Give the picker distinct presentations ("themes") sharing one pipeline
(scan, thumbnails, preview, apply, commit). OLD behavior = the Omarchy
carousel, kept as the default and untouched. New themes are layered UI
stages over the existing overlay state machine.

## Schema additions
- `picker-theme` (i, default 0): 0 = omarchy, 1 = character-select,
  2 = polaroid, 3 = comic-strip.
- prefs.js: "Picker style" dropdown.

## Theme engine
- Registry: `{id, name, buildOverlay, nav(dx,dy,scroll), flavorClass}`
  in lib.js; extension.js dispatches `_openOverlay`/`_setFocus`/
  `_moveFocus`/`_onScrollEvent` through it. Additive — omarchy math untouched.
- All themes share `lib.setWallpaper`, `_originalWallpaper`, preview
  debounce, file-monitor rescan, and slice visuals per theme.

## Theme specs
### Omarchy (default) — unchanged carousel
Oblique sheared cards, parallax, focus enlargement.

### Character Select (flagship, medium)
- Full-screen arcade roster grid of the folder's wallpapers; cell = poster
  (loadThumbnail disk cache) + filename as the character name.
- 2D arrow nav with wrap, Enter/click applies, Esc closes.
- Optional "?" cell = random pick.
- Anime accent (blush/violet focus ring, glow) via flavor class.
- Scroll keeps carousel convention (down=next, up=prev within row).

### Polaroid / Vintage (tiny, CSS-garnish)
- Taped tilted polaroid cards on a dim corkboard backdrop; subtle rotate
  jitter on siblings, focus card straightens + lifts.
- Reuses the carousel layout geometry; only visuals/flavor change.

### Comic Strip (medium)
- Current folder rendered as a zigzag sequence of manga panels; prev/next
  turns panels, Enter commits the selected panel as wallpaper.
- Panel captions = filename + resolution; panels use shared posters.

## Feature order
1. Theme engine + registry refactor (no visual change, tests keep passing).
2. Polaroid (proves garnish path, cheap).
3. Character Select (flagship).
4. Comic Strip.
5. Docs: README theme section + SKILL.md refresh; rebuild zips; v1.2.0 tag.

## Open decisions (defaults assumed until user says otherwise)
- Theme switch = prefs dropdown only (no in-picker key yet).
- No per-theme settings (grid size, block count) in v1.2.
- include-subfolders keeps current behavior; roster themes browse the same
  folder's images (see Deferred: channels).

# Carried (not started, from v1.1 plan)
- Slideshow: `slideshow-enabled`/`slideshow-interval` schema keys,
  timeout_add_seconds random pick, skip while overlay open.
- Per-monitor P1: `monitor-wallpapers` a{sv} data model + picker selector;
  background stays global (P1 is EGO-review-safe).

# Deferred / backlog
- Channels: subfolders ("waifu folders") as selectable profiles — later
  layers onto the Character Select theme (folder = character).
- Live wallpapers: Phase A animated GIF/WebP via PixbufAnimation (no deps),
  Phase B video (clutter-gst / GStreamer appsink). Needs private
  Main.layoutManager._backgroundGroup hook + guard.
- Garnish: sakura-petal layer, mood palettes, resolution in label,
  random hotkey (R), lock-screen mirror, fit vs cover, sort order,
  copy path / open folder, rebindable shortcut.

## Release
Bump metadata version → v1.2.0 tag + release asset; EGO upload when done.
