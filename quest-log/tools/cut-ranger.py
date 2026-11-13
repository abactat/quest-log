"""Cuts the ranger sheet (assets/ranger-pack/source/ranger-sheet.webp, 1024x1024) into transparent 160x128 frames (wide enough for the lunges, no wasted headroom),
one folder per animation, every frame lined up by the feet so animations do not jitter.

The sheet's grid: rows are 128 px; rows 0-3 have seven cells (cells 1 and 2 are ~192 px wide, for the lunges),
rows 4-7 have eight 128 px cells. Some cells are empty or a dark filler block.

Run from the mod folder:  python3 -I tools/cut-ranger.py
"""
import os
from PIL import Image
import numpy as np

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pack = os.path.join(root, 'assets', 'ranger-pack')
sheet = np.asarray(Image.open(os.path.join(pack, 'source', 'ranger-sheet.webp')).convert('RGB')).astype(int)
WIDE = [0, 128, 321, 512, 640, 768, 896, 1024]
STD = [0, 128, 256, 384, 512, 640, 768, 896, 1024]
WIDTH, HEIGHT, BASELINE = 160, 128, 124

# (animation, row, cells) in play order
ANIMS = [
    ('attack', 0, [0, 1, 2, 3, 4]),        # sword strike, facing front-right
    ('walk', 1, [0, 1, 2, 3]),              # walk, side on
    ('idle', 1, [5, 6]),                    # standing, breathing
    ('thrust', 2, [0, 1, 2, 3, 4]),         # draw and thrust
    ('attack-back', 3, [0, 1, 2, 3, 4]),    # strike, seen from behind
    ('walk-away', 4, [0, 1, 2, 3, 4]),      # walking away
    ('idle-back', 5, [0, 1]),
    ('idle-front', 5, [2, 3, 4]),
    ('slash', 6, [0, 1, 2, 3, 4, 5]),       # slash combo with a swoosh
    ('walk-sword', 7, [0, 1, 2, 3, 4]),     # walking with the sword drawn
    ('idle-sword', 7, [6, 7]),
]

def cut(row, col):
    edges = WIDE if row < 4 else STD
    x0, x1, y0, y1 = edges[col] + 4, edges[col + 1] - 3, row * 128 + 4, row * 128 + 125
    cell = sheet[y0:y1, x0:x1]
    ring = np.concatenate([cell[0], cell[-1], cell[:, 0], cell[:, -1]])
    bg = np.median(ring, 0)
    art = np.abs(cell - bg).sum(2) > 48
    # drop specks of compression noise: pixels with fewer than 2 art neighbours
    pad = np.pad(art, 1)
    near = sum(np.roll(np.roll(pad, dy, 0), dx, 1) for dy in (-1, 0, 1) for dx in (-1, 0, 1))[1:-1, 1:-1] - art
    art &= near >= 2
    ys, xs = np.nonzero(art)
    feet = xs[ys >= ys.max() - 10]
    cx, foot = int(round((feet.min() + feet.max()) / 2)), int(ys.max())
    rgba = np.zeros(cell.shape[:2] + (4,), dtype=np.uint8)
    rgba[..., :3] = cell.clip(0, 255)
    rgba[..., 3] = art * 255
    out = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
    out.paste(Image.fromarray(rgba), (WIDTH // 2 - cx, BASELINE - foot))
    return out

for name, row, cols in ANIMS:
    folder = os.path.join(pack, 'frames', name)
    os.makedirs(folder, exist_ok=True)
    for i, col in enumerate(cols, 1):
        cut(row, col).save(os.path.join(folder, f'{i:02d}.png'))
    print(f'{name}: {len(cols)} frames')
