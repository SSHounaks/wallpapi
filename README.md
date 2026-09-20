# Wallpapi

An Omarchy-style wallpaper picker for GNOME Shell 50 (Ubuntu 26.04 era).
Press the shortcut and browse your wallpapers as a cinematic, full-screen
carousel — every card is a uniform vertical parallelogram, the focused
wallpaper grows taller and wider, and neighbouring cards fan out so they
stay visible. Press Enter to set the selected wallpaper (scheme-aware:
it picks `picture-uri` or `picture-uri-dark` to match your light/dark mode).

## Features

- Full-screen picker with parallax-sheared parallelogram cards (no Clutter
  transforms — cards are pixel-sheared in GdkPixbuf).
- Focused card is enlarged horizontally and vertically; the two adjacent
  cards are pushed outward so they never overlap the selection.
- Scheme-aware wallpaper setter (light/dark) with `~`/`$HOME` expansion and a
  capped error log at `~/.local/var/log/Wallpapi.log`.
- Preferences panel (Override Settings): wallpaper folder, include subfolders,
  and the keyboard shortcut.
- Subfolder support: with "include subfolders" enabled, images from nested
  folders are listed too.

## Requirements

- GNOME Shell `50` (gjs 1.88+)
- `gir1.2-gexiv2` / standard GNOME desktop (shown indicator requires a running
  GNOME session)

## Install

### From a release zip

```sh
gnome-extensions install wallpapi@shalnark.shell-extension.zip
```

### From source

```sh
git clone https://github.com/SSHounaks/wallpapi.git
mkdir -p ~/.local/share/gnome-shell/extensions
cp -r wallpapi ~/.local/share/gnome-shell/extensions/wallpapi@shalnark
glib-compile-schemas ~/.local/share/gnome-shell/extensions/wallpapi@shalnark/schemas
```

Log out and back in, then enable it:

```sh
gnome-extensions enable wallpapi@shalnark
```

## Usage

- Press **Super+Shift+W** (configurable in the extension preferences) or click
  the panel indicator to open the picker.
- **←** / **→** — move focus through the carousel.
- **Enter** — set the focused wallpaper as the desktop background.
- **Esc** (or click outside) — close the picker.

The default wallpaper folder is empty; set one in
Preferences → Extensions → Wallpapi → "Wallpaper folder".

## Development

Clone, edit `extension.js` / `lib.js` / `prefs.js` / `stylesheet.css`, then:

```sh
# build a bundle
gnome-extensions pack --out-dir=. --extra-source=lib.js .
```

Reloading on Wayland requires logging out and back in (or a dev shell:
`dbus-run-session -- gnome-shell --devkit`).

## License

MIT License — see [LICENSE](LICENSE). Includes a non-binding courtesy request
(details in the LICENSE file).
