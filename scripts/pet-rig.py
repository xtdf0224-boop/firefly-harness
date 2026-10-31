"""Desktop-pet puppet rig: weight maps and rig.json for the "pseudo Live2D" renderer (src/pet/ui/puppet/).

    python scripts/pet-rig.py            # writes src/pet/ui/puppet/rigs.json and public/pet/<mode>/w-<pose>.png
    python scripts/pet-rig.py --preview  # also writes overlays to assets-src/pet/rig-preview/ to check by eye

The renderer bends one picture at a time (no cut-out layers, so no seams). Each pose gets a small weight map:
    R = hair: how far a pixel follows the hair sway (0 at the roots and on the body, 1 at the tips)
    G = accents: the ahoge, the leaf ornament and its ribbon (Firefly) / the helmet's side fins (SAM)
Breathing and the slight sway of the upper body need no map: they follow the height above the feet.
Blink and mouth need no mask either: blink.png / talk.png differ from their base only around the eyes / mouth,
so mixing the whole picture changes only those pixels. Coordinates below are in the 640x640 frames."""
import json, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZE = 640
OUT = 320  # weight maps are smooth: half size is plenty
POSES = ['idle', 'think', 'watch', 'happy', 'sleep']

# What each pose can blend in (file names without .png). Missing files are simply left out of rig.json.
EXTRAS = {
    'idle': {'blink': 'blink', 'talk': 'talk'},
    'watch': {'blink': 'watch_blink'},
    'think': {'blink': 'think_blink'},
}

RIG = {
    'firefly': {
        'foot': 612,            # the foot line
        'hip': 500,             # below this nothing breathes
        'chest': 330,           # from here up the body is lifted by the full breath
        'pivot': [293, 332],    # the neck: the head tilts around it
        'neck': [380, 290],     # the tilt fades in between these two heights (bottom, top)
        'breath': 6.0,          # px the chest rises (the figure is shown at about a third of this size)
        'tilt': 2.0,            # degrees the head sways
        'hair': 11.0,           # px the hair tips sway
        'accent': 6.0,          # px the ahoge / ribbon tips sway
        'mouth': {'kind': 'open'},
        # The body (torso, coat, skirt, legs) and the face: hair inside these does not sway.
        'body': [(212, 292), (378, 292), (412, 330), (424, 420), (448, 522), (404, 528), (372, 560), (372, 616),
                 (248, 616), (248, 560), (190, 522), (202, 420), (204, 330)],
        'face': [(232, 180), (356, 180), (372, 250), (352, 312), (236, 312), (216, 250)],
        'hair_from': 228,       # hair weight starts at this height...
        'hair_full': 430,       # ...and is full from here down
        # Accents: (centre x, centre y, radius x, radius y, anchor y): weight grows away from the anchor.
        'accents': [(292, 80, 34, 26, 108), (418, 158, 30, 44, 196), (446, 238, 40, 50, 196)],
    },
    'sam': {
        'foot': 612,
        'hip': 470,
        'chest': 300,
        'pivot': [320, 300],
        'neck': [330, 250],
        'breath': 5.0,
        'tilt': 1.0,
        'hair': 0.0,
        'accent': 3.5,
        'mouth': {'kind': 'glow'},
        'body': [],
        'face': [],
        'hair_from': 0,
        'hair_full': 1,
        # Only the thin fins beside the helmet flex a little; the armour itself stays rigid.
        'accents': [(196, 148, 50, 64, 212), (462, 142, 54, 68, 212)],
    },
}


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def poly_mask(points, size=SIZE):
    m = Image.new('L', (size, size), 0)
    if len(points) >= 3:
        ImageDraw.Draw(m).polygon(points, fill=255)
    return np.asarray(m).astype(np.float32) / 255.0


def hair_colour(rgb):
    """Firefly's hair: warm light grey (low saturation, bright) or the teal-blue tips."""
    r, g, b = [rgb[..., i] / 255.0 for i in range(3)]
    mx, mn = np.maximum(np.maximum(r, g), b), np.minimum(np.minimum(r, g), b)
    sat = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    grey = (sat < 0.2) & (mx > 0.5)
    # Hue of the tips: cyan to blue (roughly 175-215 degrees); the dark outline next to them counts too.
    hue = np.zeros_like(mx)
    d = np.maximum(mx - mn, 1e-6)
    hue = np.where(mx == r, ((g - b) / d) % 6, np.where(mx == g, (b - r) / d + 2, (r - g) / d + 4)) * 60
    teal = (hue > 172) & (hue < 220) & (sat > 0.2)
    outline = (mx < 0.45) & (hue > 170) & (hue < 260)
    return grey | teal | outline


def blur(a, radius):
    im = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32) / 255.0


def dilate(a, px):
    im = Image.fromarray(np.clip(a * 255, 0, 255).astype(np.uint8))
    return np.asarray(im.filter(ImageFilter.MaxFilter(px * 2 + 1))).astype(np.float32) / 255.0


def weights(mode, pose):
    cfg = RIG[mode]
    im = np.asarray(Image.open(os.path.join(ROOT, 'public', 'pet', mode, f'{pose}.png')).convert('RGBA')).astype(np.float32)
    alpha = im[..., 3] / 255.0
    ys, xs = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
    hair = np.zeros((SIZE, SIZE), np.float32)
    if cfg['hair'] > 0:
        keep_out = np.maximum(poly_mask(cfg['body']), poly_mask(cfg['face']))
        # Fade out near the body/face edge so the hair does not tear away from them.
        near = blur(dilate(keep_out, 6), 8)
        hair = (alpha > 0.5) & hair_colour(im[..., :3])
        hair = hair.astype(np.float32) * (1 - near)
        hair *= smoothstep(cfg['hair_from'], cfg['hair_full'], ys)
        # Spread past the silhouette (the sway pulls colour from inside outward), then smooth into a field.
        hair = blur(dilate(hair, 8), 7)
        hair = np.clip(hair * 1.6, 0, 1)
    acc = np.zeros((SIZE, SIZE), np.float32)
    for cx, cy, rx, ry, anchor in cfg['accents']:
        inside = np.clip(1 - ((xs - cx) / rx) ** 2 - ((ys - cy) / ry) ** 2, 0, 1)
        away = np.clip(np.abs(ys - anchor) / (ry * 1.4), 0, 1)
        acc = np.maximum(acc, np.sqrt(inside) * away)
    acc = blur(acc, 5)
    rgba = np.zeros((SIZE, SIZE, 4), np.uint8)
    rgba[..., 0] = np.clip(hair * 255, 0, 255)
    rgba[..., 1] = np.clip(acc * 255, 0, 255)
    rgba[..., 3] = 255
    return Image.fromarray(rgba, 'RGBA').resize((OUT, OUT), Image.LANCZOS), hair, acc, im


def preview(mode, pose, hair, acc, im, out_dir):
    base = Image.fromarray(im.astype(np.uint8), 'RGBA')
    bg = Image.new('RGBA', (SIZE, SIZE), (58, 62, 74, 255))
    bg.alpha_composite(base)
    tint = np.zeros((SIZE, SIZE, 4), np.uint8)
    tint[..., 0] = 255
    tint[..., 3] = np.clip(hair * 170, 0, 255)
    bg.alpha_composite(Image.fromarray(tint, 'RGBA'))
    tint = np.zeros((SIZE, SIZE, 4), np.uint8)
    tint[..., 1] = 255
    tint[..., 3] = np.clip(acc * 170, 0, 255)
    bg.alpha_composite(Image.fromarray(tint, 'RGBA'))
    d = ImageDraw.Draw(bg)
    cfg = RIG[mode]
    if cfg['body']:
        d.line(cfg['body'] + [cfg['body'][0]], fill=(255, 255, 0, 255), width=1)
        d.line(cfg['face'] + [cfg['face'][0]], fill=(0, 255, 255, 255), width=1)
    px, py = cfg['pivot']
    d.ellipse([px - 4, py - 4, px + 4, py + 4], outline=(255, 255, 255, 255))
    bg.save(os.path.join(out_dir, f'{mode}-{pose}.png'))


def main():
    show = '--preview' in sys.argv
    prev_dir = os.path.join(ROOT, 'assets-src', 'pet', 'rig-preview')
    if show:
        os.makedirs(prev_dir, exist_ok=True)
    rigs = {}
    for mode, cfg in RIG.items():
        folder = os.path.join(ROOT, 'public', 'pet', mode)
        poses = {}
        for pose in POSES:
            if not os.path.exists(os.path.join(folder, f'{pose}.png')):
                continue
            img, hair, acc, im = weights(mode, pose)
            img.save(os.path.join(folder, f'w-{pose}.png'), optimize=True)
            entry = {'weights': f'w-{pose}'}
            for kind, name in EXTRAS.get(pose, {}).items():
                if os.path.exists(os.path.join(folder, f'{name}.png')):
                    entry[kind] = name
            poses[pose] = entry
            if show:
                preview(mode, pose, hair, acc, im, prev_dir)
        # Where the mouth is: the bounding box of what talk.png changes (the renderer opens it from its centre).
        mouth = dict(cfg['mouth'])
        a = np.asarray(Image.open(os.path.join(folder, 'idle.png')).convert('RGBA')).astype(int)
        b = np.asarray(Image.open(os.path.join(folder, 'talk.png')).convert('RGBA')).astype(int)
        ys, xs = np.nonzero(np.abs(a - b).sum(axis=2) > 24)
        mouth['box'] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
        rig = {
            'version': 1, 'size': SIZE,
            'foot': cfg['foot'], 'hip': cfg['hip'], 'chest': cfg['chest'], 'pivot': cfg['pivot'], 'neck': cfg['neck'],
            'amp': {'breath': cfg['breath'], 'tilt': cfg['tilt'], 'hair': cfg['hair'], 'accent': cfg['accent']},
            'mouth': mouth, 'poses': poses,
        }
        rigs[mode] = rig
        size = sum(os.path.getsize(os.path.join(folder, f'w-{p}.png')) for p in poses)
        print(f'{mode}: {len(poses)} poses, mouth {mouth["box"]}, weight maps {size / 1024:.0f} KB, '
              f'blink for {[p for p, e in poses.items() if "blink" in e]}')
    # Bundled with the page (pet.html runs from file://, where fetch() cannot read a JSON file).
    with open(os.path.join(ROOT, 'src', 'pet', 'ui', 'puppet', 'rigs.json'), 'w', encoding='utf-8') as f:
        json.dump(rigs, f, ensure_ascii=False, indent=1)
        f.write('\n')


if __name__ == '__main__':
    main()
