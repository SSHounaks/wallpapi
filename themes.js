export const THEMES = [
    {
        id: 'omarchy', label: 'Omarchy carousel', kind: 'carousel', accent: [53, 132, 228, 255],
        caption: false,
        hint: 'scroll / \u2190 \u2192 choose  \u00b7  Enter set  \u00b7  Esc close',
    },
    {
        id: 'character-select', label: 'Level Select', kind: 'grid', accent: [232, 138, 255, 255],
        caption: true,
        hint: 'arrows move  \u00b7  Enter set  \u00b7  Esc close',
    },
    {
        id: 'polaroid', label: 'Polaroid board', kind: 'grid', flavor: 'polaroid', accent: [255, 255, 255, 255],
        caption: true,
        hint: '\u2190 \u2192 slide the board  \u00b7  \u2191 \u2193 between rows  \u00b7  Enter set  \u00b7  Esc close',
    },
    {
        id: 'comic-strip', label: 'Comic strip', kind: 'comic', accent: [255, 94, 94, 255],
        caption: true,
        hint: 'a masonry of wallpapers at their own size  \u00b7  arrows move  \u00b7  Enter set  \u00b7  Esc close',
    },
];

export const GRID_CELL_W = 300;
export const GRID_CELL_H = 220;
export const GRID_GAP = 26;
export const COMIC_PANEL_W = 480;
export const COMIC_PANEL_H = 340;
export const COMIC_GAP = 40;
export const COMIC_MARGIN = 40;
export const COMIC_MIN_SIDE = 160;

export function themeById(id) {
    return THEMES.find(t => t.id === id) ?? THEMES[0];
}

export function gridCols(width) {
    const usable = Math.max(1, width - 80);
    const cols = Math.floor(usable / (GRID_CELL_W + GRID_GAP));
    return Math.max(1, Math.min(cols, 8));
}

export function clampInt(value, lo, hi, fallback) {
    const n = Math.round(value);
    if (!Number.isFinite(n))
        return fallback;
    return Math.max(lo, Math.min(hi, n));
}

export function polaroidCellW(width, cols) {
    const usable = Math.max(1, width - 80);
    const per = Math.max(1, cols);
    return Math.max(100, Math.floor((usable - (per - 1) * GRID_GAP) / per));
}

export function polaroidCellH(areaH, rows) {
    const per = Math.max(1, rows);
    return Math.max(100, Math.floor((areaH - (per + 1) * GRID_GAP) / per));
}

export function comicSide(count, width, height) {
    const n = Math.max(1, count);
    const areaW = Math.max(1, width - 2 * COMIC_MARGIN);
    const areaH = Math.max(1, height - 2 * COMIC_MARGIN);
    let side = Math.round(Math.sqrt((areaW * areaH) / n));
    if (!Number.isFinite(side) || side < COMIC_MIN_SIDE)
        side = COMIC_MIN_SIDE;
    return side;
}

export function comicMasonry(count, aspects, width, unusedHeight) {
    const n = Math.max(0, count);
    if (n === 0)
        return [];
    const areaW = Math.max(1, width - 2 * COMIC_MARGIN);

    const targetColW = 380;
    let cols = Math.max(2, Math.floor((areaW + COMIC_GAP) / (targetColW + COMIC_GAP)));
    cols = Math.min(cols, 8);
    const colW = Math.max(COMIC_MIN_SIDE,
        Math.floor((areaW - (cols - 1) * COMIC_GAP) / cols));

    const maxH = Math.max(COMIC_MIN_SIDE, Math.round(colW * 2.2));
    const colHeights = new Array(cols).fill(COMIC_MARGIN);
    const panels = [];
    for (let i = 0; i < n; i++) {
        const dim = aspects && aspects[i];
        let ratio = 2 / 3;
        if (dim && dim[0] > 0 && dim[1] > 0)
            ratio = dim[1] / dim[0];
        const h = Math.max(COMIC_MIN_SIDE,
            Math.min(maxH, Math.round(colW * ratio)));

        let c = 0;
        for (let j = 1; j < cols; j++) {
            if (colHeights[j] < colHeights[c])
                c = j;
        }
        const x = COMIC_MARGIN + c * (colW + COMIC_GAP);
        const y = colHeights[c];
        colHeights[c] = y + h + COMIC_GAP;
        panels.push({x, y, w: colW, h});
    }
    return panels;
}
