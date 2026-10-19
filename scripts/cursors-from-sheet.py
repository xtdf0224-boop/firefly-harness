"""Turn a painted cursor sheet (1536x1024, 3x2 cells of 512: default, pointer, text, not-allowed, ns-resize,
progress / busy) into cursor PNGs: build/cursors/<mode>/<name>.png (32 px), <name>@2x.png (64 px) and hotspots.json.
scripts/gen-cursors.mjs then uses these instead of its own SVG shapes.

    python scripts/cursors-from-sheet.py <sheet.png> <firefly|sam> [--preview out.png]

The background may be transparent, flat magenta, or any flat colour (keyed from the corners). Arrow
cells are aligned by their tip (the opaque pixel nearest the cell's top-left corner); centred cells by
the middle of their bounding box. Downscaling is done on premultiplied colour so edges do not darken."""
import json, os, sys
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NAMES = ['default', 'pointer', 'text', 'not-allowed', 'ns-resize', 'progress']
ARROWS = {'default', 'pointer', 'not-allowed', 'progress'}
TIP = (4, 3)  # where the tip sits in the 32 px cursor


def key_background(im: Image.Image) -> Image.Image:
    """Make the background transparent unless it already is."""
    a = np.asarray(im.convert('RGBA')).astype(np.float32)
    if (a[..., 3] < 250).mean() > 0.2:
        return im.convert('RGBA')
    rgb = a[..., :3]
    corners = np.concatenate([rgb[:8, :8].reshape(-1, 3), rgb[:8, -8:].reshape(-1, 3), rgb[-8:, :8].reshape(-1, 3), rgb[-8:, -8:].reshape(-1, 3)])
    bg = np.median(corners, axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(-1))
    # soft key: fully transparent near the background colour, opaque beyond a margin
    alpha = np.clip((dist - 28) / 40, 0, 1)
    out = a.copy()
    out[..., 3] = alpha * 255
    # pull the background tint out of semi-transparent edge pixels (un-premultiply against bg)
    m = (alpha > 0) & (alpha < 1)
    out[..., :3][m] = np.clip((rgb[m] - bg * (1 - alpha[m, None])) / alpha[m, None], 0, 255)
    return Image.fromarray(out.astype(np.uint8), 'RGBA')


def fit(cell: Image.Image, name: str, size: int):
    """Scale one cell into a size x size cursor; return the image and its hotspot."""
    a = np.asarray(cell)[..., 3]
    ys, xs = np.nonzero(a > 40)
    if len(xs) == 0:
        return None, None
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    unit = size / 32
    if name in ARROWS:
        # tip: opaque pixel with the smallest x + y (the arrow points to the top-left)
        solid = np.nonzero(a > 160)
        k = np.argmin(solid[0] + solid[1])
        ty, tx = solid[0][k], solid[1][k]
        hx, hy = TIP[0] * unit, TIP[1] * unit
        scale = min((size - hx - 0.5 * unit) / max(1, x1 - tx), (size - hy - 0.5 * unit) / max(1, y1 - ty), size / 32 / 16 * 1.25)
        ox, oy = hx - tx * scale, hy - ty * scale
    else:
        cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
        scale = min((size - 2 * unit) / (x1 - x0), (size - 2 * unit) / (y1 - y0))
        hx = hy = size / 2
        ox, oy = hx - cx * scale, hy - cy * scale
    # premultiplied resample of the whole cell, then place
    big = cell.convert('RGBa')
    w, h = round(cell.width * scale), round(cell.height * scale)
    small = big.resize((w, h), Image.LANCZOS).convert('RGBA')
    canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    ox, oy = round(ox), round(oy)
    part = small.crop((max(0, -ox), max(0, -oy), min(small.width, size - ox), min(small.height, size - oy)))
    canvas.alpha_composite(part, (max(0, ox), max(0, oy)))
    canvas = canvas.filter(ImageFilter.UnsharpMask(radius=0.6 * unit, percent=60, threshold=1))
    return canvas, (round(hx / unit), round(hy / unit))


def main():
    sheet, mode = sys.argv[1], sys.argv[2]
    preview = sys.argv[sys.argv.index('--preview') + 1] if '--preview' in sys.argv else None
    im = key_background(Image.open(sheet))
    if im.size != (1536, 1024):
        im = im.resize((1536, 1024), Image.LANCZOS)
    out_dir = os.path.join(ROOT, 'build', 'cursors', mode)
    os.makedirs(out_dir, exist_ok=True)
    hotspots = {}
    tiles = []
    for i, name in enumerate(NAMES):
        cell = im.crop(((i % 3) * 512, (i // 3) * 512, (i % 3 + 1) * 512, (i // 3 + 1) * 512))
        one, hs = fit(cell, name, 32)
        if one is None:
            continue
        two, _ = fit(cell, name, 64)
        one.save(os.path.join(out_dir, f'{name}.png'))
        two.save(os.path.join(out_dir, f'{name}@2x.png'))
        hotspots[name] = hs
        tiles.append((name, cell, one, two))
    with open(os.path.join(out_dir, 'hotspots.json'), 'w', encoding='utf8') as f:
        json.dump(hotspots, f, indent=2)
    if preview:
        W = 150 * len(tiles)
        sheet_im = Image.new('RGBA', (W, 330), (90, 100, 112, 255))
        for i, (name, cell, one, two) in enumerate(tiles):
            for j, bg in enumerate([(11, 18, 33, 255), (243, 244, 246, 255)]):
                box = Image.new('RGBA', (140, 150), bg)
                box.alpha_composite(two.resize((128, 128), Image.NEAREST), (6, 4))
                box.alpha_composite(one, (100, 112))
                sheet_im.alpha_composite(box, (i * 150 + 5, 10 + j * 160))
        sheet_im.save(preview)
    print('wrote', out_dir, hotspots)


if __name__ == '__main__':
    main()
