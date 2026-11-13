"""Cuts the bad guys out of their animated previews (assets/foes-pack/source/<name>.gif, CraftPix monsters, 600x370,
one frame every 100 ms, a flat grey background above a banner). Each GIF plays idle, walk, attack, hurt and death in
turn; the frame numbers below pick each animation out (the fade at the end and other characters are left out).

Every frame of a monster is cropped to that monster's one box (so it stands still between animations), keyed to
transparent, and mirrored where the monster faces right: on the track they all face left, at the hero.

Run from the mod folder:  python3 -I tools/cut-foes.py
"""
import os
from PIL import Image, ImageSequence
import numpy as np

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
pack = os.path.join(root, 'assets', 'foes-pack')
BG = np.array([223, 223, 223])

# name: faces right?, x window around the body for the attack (None: keep effects), animations as GIF frame numbers
FOES = {
    'whelp':  dict(right=False, window=None, anims={'idle': [0, 1, 2], 'walk': [12, 13, 14, 15], 'attack': [25, 26, 27, 28, 29, 30], 'death': [43, 44, 45]}),
    'lizard': dict(right=True, window=None, anims={'idle': [0, 1, 2], 'walk': [12, 13, 14, 15, 16, 17], 'attack': [25, 26, 27, 28], 'hurt': [30, 31], 'death': [36, 37, 38, 39]}),
    'medusa': dict(right=True, window=(-6, 18), anims={'idle': [0, 1, 2], 'walk': [12, 13, 14, 15], 'attack': [24, 25, 26, 27, 28, 29], 'hurt': [37, 38], 'death': [39, 40, 41, 42, 43, 44]}),
    'jinn':   dict(right=True, window=(-6, 40), anims={'idle': [0, 1, 2], 'walk': [12, 13, 14, 15], 'attack': [25, 26, 27, 28], 'death': [39, 40, 41]}),
    'demon':  dict(right=True, window=None, anims={'idle': [0, 1, 2], 'walk': [12, 13, 14, 15, 16, 17], 'attack': [25, 26, 27, 28], 'hurt': [30, 31], 'death': [37, 38, 39]}),
    'dragon': dict(right=False, window=None, anims={'idle': [0, 1, 2], 'walk': [12, 13, 14, 15, 16], 'attack': [23, 24, 25, 26, 27, 28, 29, 30], 'hurt': [31, 32], 'death': [36, 37, 38]}),
}

def art_of(frame):
    a = np.asarray(frame.convert('RGB')).astype(int)[:300]
    return a, np.abs(a - BG).sum(2) > 18

for name, spec in FOES.items():
    gif = [f.copy() for f in ImageSequence.Iterator(Image.open(os.path.join(pack, 'source', f'{name}.gif')))]
    # The body's own columns, from the idle frames: an attack's effects outside the window (a victim, a far
    # projectile) are left out.
    idle_x = [np.nonzero(art_of(gif[i])[1].any(0))[0] for i in spec['anims']['idle']]
    body = (min(x.min() for x in idle_x), max(x.max() for x in idle_x))
    def mask_of(i):
        a, m = art_of(gif[i])
        if spec['window']:
            lo, hi = body[0] + spec['window'][0], body[1] + spec['window'][1]
            m[:, :max(0, lo)] = False
            m[:, hi + 1:] = False
        return a, m
    picked = [i for frames in spec['anims'].values() for i in frames]
    boxes = []
    for i in picked:
        ys, xs = np.nonzero(mask_of(i)[1])
        boxes.append((xs.min(), ys.min(), xs.max(), ys.max()))
    x0, y0, x1, y1 = min(b[0] for b in boxes), min(b[1] for b in boxes), max(b[2] for b in boxes), max(b[3] for b in boxes)
    for anim, frames in spec['anims'].items():
        folder = os.path.join(pack, 'frames', name, anim)
        os.makedirs(folder, exist_ok=True)
        for n, i in enumerate(frames, 1):
            a, m = mask_of(i)
            rgba = np.zeros((y1 - y0 + 1, x1 - x0 + 1, 4), dtype=np.uint8)
            rgba[..., :3] = a[y0:y1 + 1, x0:x1 + 1]
            rgba[..., 3] = m[y0:y1 + 1, x0:x1 + 1] * 255
            out = Image.fromarray(rgba)
            if spec['right']:
                out = out.transpose(Image.FLIP_LEFT_RIGHT)
            out.save(os.path.join(folder, f'{n:02d}.png'))
    print(f'{name}: {x1 - x0 + 1}x{y1 - y0 + 1}', {k: len(v) for k, v in spec['anims'].items()})

# The frames as data URIs for the mod (hooks/foe-frames.ts), at their own pixel size: the track scales them.
import base64, io
lines = ["// The bad guys' frames (see tools/cut-foes.py): CraftPix monsters, each frame its own PNG, all facing left.",
         "// Generated: do not edit.", "",
         "export type FoeId = " + " | ".join(repr(n) for n in FOES), "",
         "export type FoeAnim = 'idle' | 'walk' | 'attack' | 'hurt' | 'death'", "",
         "export const FOE_FRAMES: Record<FoeId, { w: number; h: number; anims: Partial<Record<FoeAnim, string[]>> }> = {"]
for name, spec in FOES.items():
    first = Image.open(os.path.join(pack, 'frames', name, 'idle', '01.png'))
    lines.append(f"  {name}: {{ w: {first.width}, h: {first.height}, anims: {{")
    for anim in spec['anims']:
        folder = os.path.join(pack, 'frames', name, anim)
        uris = []
        for f in sorted(os.listdir(folder)):
            buf = io.BytesIO(); Image.open(os.path.join(folder, f)).save(buf, 'PNG', optimize=True)
            uris.append('"data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode() + '"')
        lines.append(f"    {anim}: [{', '.join(uris)}],")
    lines.append("  } },")
lines.append("}")
open(os.path.join(root, 'hooks', 'foe-frames.ts'), 'w').write("\n".join(lines) + "\n")
print('wrote hooks/foe-frames.ts')
