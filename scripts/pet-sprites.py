"""Desktop-pet sprites: GPT's 1024x1024 transparent frames -> public/pet/<firefly|sam>/<state>.png.

    python scripts/pet-sprites.py <source_dir>

source_dir holds firefly/ and sam/ with idle, blink, talk, think, watch, happy, sleep .png (the frames GPT
handed in). Originals are copied to assets-src/pet/ (git-ignored); the app gets 640x640 frames.
Every frame keeps the same canvas and foot line, so switching states never makes her jump."""
import os, shutil, sys
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if len(sys.argv) < 2:
    sys.exit('usage: python scripts/pet-sprites.py <source_dir>')
SRC = sys.argv[1]
STATES = ['idle', 'blink', 'talk', 'think', 'watch', 'happy', 'sleep']
# Closed-eye versions of other poses for the puppet (scripts/pet-rig.py); each matches its base pixel for pixel
# outside the eyes. Optional: a mode without them simply does not blink in those poses.
EXTRAS = ['watch_blink', 'think_blink']
SIZE = 640


def main():
    for mode in ('firefly', 'sam'):
        out_dir = os.path.join(ROOT, 'public', 'pet', mode)
        keep_dir = os.path.join(ROOT, 'assets-src', 'pet', mode)
        os.makedirs(out_dir, exist_ok=True)
        os.makedirs(keep_dir, exist_ok=True)
        feet = []
        for state in STATES:
            src = os.path.join(SRC, mode, f'{state}.png')
            im = Image.open(src).convert('RGBA')
            if im.size != (1024, 1024):
                raise SystemExit(f'{src}: expected 1024x1024, got {im.size}')
            box = im.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
            feet.append(box[3])
            shutil.copy2(src, os.path.join(keep_dir, f'{state}.png'))
            im.resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(out_dir, f'{state}.png'), optimize=True)
        for extra in EXTRAS:
            src = os.path.join(SRC, mode, f'{extra}.png')
            if not os.path.exists(src):
                continue
            im = Image.open(src).convert('RGBA')
            if im.size != (1024, 1024):
                raise SystemExit(f'{src}: expected 1024x1024, got {im.size}')
            shutil.copy2(src, os.path.join(keep_dir, f'{extra}.png'))
            im.resize((SIZE, SIZE), Image.LANCZOS).save(os.path.join(out_dir, f'{extra}.png'), optimize=True)
        spread = max(feet) - min(feet)
        size = sum(os.path.getsize(os.path.join(out_dir, f)) for f in os.listdir(out_dir) if f.endswith('.png') and not f.startswith('w-'))
        print(f'{mode}: foot line {min(feet)}-{max(feet)} (spread {spread}px), {size / 1e6:.1f} MB')
        if spread > 8:
            print(f'  warning: {mode} frames do not share a foot line')


if __name__ == '__main__':
    main()
