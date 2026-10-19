"""Build the NSIS installer bitmaps (design B「在梦与火之间」) from build/installer/art-b.jpg.

    python scripts/gen-installer-art.py [--preview out.png]

Writes 24-bit BMP masters at 3x the classic MUI sizes:
  build/installer/sidebar.bmp  welcome / finish page strip (164x314 -> 492x942)
  build/installer/header.bmp   inner-page header image (150x57 -> 450x171)
build/installer.nsh scales them at runtime to the real control size (HALFTONE), so they stay sharp
at any display scale. The right edge of both fades to the page colour #0A0F14 so there is no seam."""
import os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'build', 'installer', 'art-b.jpg')
OUT = os.path.join(ROOT, 'build', 'installer')
BG = np.array([10, 15, 20], dtype=np.float32)  # #0A0F14, MUI_BGCOLOR
SCALE = 3
FONT = 'C:/Windows/Fonts/msyhbd.ttc'


def fade_right(im: Image.Image, frac: float) -> Image.Image:
    """Blend the rightmost `frac` of the width into BG with a smoothstep ramp."""
    a = np.asarray(im.convert('RGB'), dtype=np.float32)
    w = a.shape[1]
    t = np.clip((np.arange(w) - w * (1 - frac)) / (w * frac), 0, 1)
    t = t * t * (3 - 2 * t)
    a = a * (1 - t)[None, :, None] + BG[None, None, :] * t[None, :, None]
    return Image.fromarray(np.round(a).astype(np.uint8))


def vertical_label(base: Image.Image, text: str, x: int, y: int, size: int, color, anchor_bottom=False):
    """Stack the characters top to bottom with a soft dark shadow, like writing-mode: vertical-rl."""
    font = ImageFont.truetype(FONT, size)
    step = round(size * 1.3)
    h = step * len(text)
    top = y - h if anchor_bottom else y
    shadow = Image.new('L', base.size, 0)
    sd = ImageDraw.Draw(shadow)
    for i, ch in enumerate(text):
        sd.text((x, top + i * step + size // 10), ch, font=font, fill=210)
    shadow = shadow.filter(ImageFilter.GaussianBlur(size * 0.28))
    out = Image.composite(Image.new('RGB', base.size, (0, 0, 0)), base, shadow)
    d = ImageDraw.Draw(out)
    for i, ch in enumerate(text):
        d.text((x, top + i * step), ch, font=font, fill=color)
    return out


def sidebar(art: Image.Image) -> Image.Image:
    W, H = art.size
    sw = round(H * 164 / 314)
    strip = art.crop((0, 0, sw, H)).resize((164 * SCALE, 314 * SCALE), Image.LANCZOS)
    strip = fade_right(strip, 0.15)
    s = 11 * SCALE
    strip = vertical_label(strip, '梦', 12 * SCALE, 12 * SCALE, s, (234, 251, 246))
    strip = vertical_label(strip, '燃烧', strip.width - 26 * SCALE, strip.height - 12 * SCALE, s, (200, 249, 142), anchor_bottom=True)
    return strip


def header(art: Image.Image) -> Image.Image:
    W, H = art.size
    hw = round(W * 0.62 / 1.7)
    hh = round(hw * 57 / 150)
    cx, cy = 0.39 * W, 0.21 * H
    x0 = int(min(max(0, cx - hw / 2), W - hw))
    y0 = int(min(max(0, cy - hh / 2), H - hh))
    img = art.crop((x0, y0, x0 + hw, y0 + hh)).resize((150 * SCALE, 57 * SCALE), Image.LANCZOS)
    img = fade_right(img, 0.40)
    # a thin lime slash near the right edge, the "fire rift" that splits dream and burning
    over = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(over)
    w, h = img.size
    x = w - 30 * SCALE
    skew = round(h * np.tan(np.radians(24)))
    for width, alpha in ((7 * SCALE, 40), (2 * SCALE, 150), (1 * SCALE, 230)):
        d.line([(x + skew // 2, -2), (x - skew // 2, h + 2)], fill=(216, 255, 176, alpha), width=width)
    mask = Image.linear_gradient('L').resize(img.size)  # fade the slash out at both ends
    mask = Image.fromarray((np.sin(np.asarray(mask, dtype=np.float32) / 255 * np.pi) * 255).astype(np.uint8))
    over.putalpha(Image.fromarray((np.asarray(over.getchannel('A'), dtype=np.float32) * np.asarray(mask, dtype=np.float32) / 255).astype(np.uint8)))
    return Image.alpha_composite(img.convert('RGBA'), over.filter(ImageFilter.GaussianBlur(0.6))).convert('RGB')


def main():
    art = Image.open(SRC).convert('RGB')
    side, head = sidebar(art), header(art)
    side.save(os.path.join(OUT, 'sidebar.bmp'))
    head.save(os.path.join(OUT, 'header.bmp'))
    print('sidebar', side.size, 'header', head.size)
    if '--preview' in sys.argv:
        p = sys.argv[sys.argv.index('--preview') + 1]
        sheet = Image.new('RGB', (side.width + head.width + 30, side.height), tuple(int(v) for v in BG))
        sheet.paste(side, (0, 0))
        sheet.paste(head, (side.width + 30, 0))
        sheet.save(p)


if __name__ == '__main__':
    main()
