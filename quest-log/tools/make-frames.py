"""Rebuilds hooks/runner-frames.ts (PNG frames, for Svg and image terminals) and hooks/runner-pixels.ts
(colour pixel art for plain terminals) from the ranger sprite pack kept in assets/ranger-pack (cut from its
sheet by tools/cut-ranger.py).

Run from the mod folder:  python3 -I tools/make-frames.py
"""
import base64, io, os
from PIL import Image

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = os.path.join(root, 'assets', 'ranger-pack')
out = os.path.join(root, 'hooks', 'runner-frames.ts')
# pose: (animation folder, frames). The pack has no death: a hero out of hearts turns away to rest.
sets = {'run': ('walk', 4), 'idle': ('idle', 2), 'attack': ('attack', 5), 'thrust': ('thrust', 5), 'slash': ('slash', 6), 'guard': ('idle-sword', 2), 'rest': ('idle-back', 2)}
lines = ["// The hero's frames: the ranger sprite sheet the person supplied (160x128 frames, halved to 80x64",
         "// with nearest-neighbour so the pixels stay crisp).",
         "export type Pose = " + " | ".join(repr(p) for p in sets), "",
         "export const POSES: Record<Pose, string[]> = {"]
for pose, (folder, n) in sets.items():
    lines.append(f"  {pose}: [")
    for i in range(1, n + 1):
        im = Image.open(os.path.join(src, 'frames', folder, f"{i:02d}.png")).convert('RGBA').resize((80, 64), Image.NEAREST)
        buf = io.BytesIO(); im.save(buf, 'PNG', optimize=True)
        lines.append('    "data:image/png;base64,' + base64.b64encode(buf.getvalue()).decode() + '",')
    lines.append("  ],")
lines.append("}")
open(out, 'w').write("\n".join(lines) + "\n")
print('wrote', out)


# Pixel art for terminals that cannot draw images: every frame cropped to the shared bounds of the
# whole pack, scaled to SIZE x SIZE, alpha cut hard, colours reduced to one shared palette.
SIZE = 20
# The square that holds every frame (the lunges are wide), so all poses share one scale.
_boxes = [Image.open(os.path.join(src, 'frames', folder, f"{i:02d}.png")).getchannel('A').getbbox() for folder, n in sets.values() for i in range(1, n + 1)]
_l, _t, _r, _b = min(b[0] for b in _boxes), min(b[1] for b in _boxes), max(b[2] for b in _boxes), max(b[3] for b in _boxes)
_side = max(_r - _l, _b - _t)
_cx = (_l + _r) // 2
BOX = (_cx - _side // 2, _b - _side, _cx - _side // 2 + _side, _b)
frames = []
for pose, (folder, n) in sets.items():
    for i in range(1, n + 1):
        im = Image.open(os.path.join(src, 'frames', folder, f"{i:02d}.png")).convert('RGBA').crop(BOX).resize((SIZE, SIZE), Image.BOX)
        frames.append((pose, im))
# The sprite is dark and terminals are often black: lift it so the figure reads against the background.
lift = lambda c: min(255, int(c * 1.45) + 22)
frames = [(p, Image.merge('RGBA', [im.getchannel(0).point(lift), im.getchannel(1).point(lift), im.getchannel(2).point(lift), im.getchannel(3)])) for p, im in frames]
opaque = [px[:3] for _, im in frames for px in im.getdata() if px[3] >= 110]
strip = Image.new('RGB', (len(opaque), 1))
strip.putdata(opaque)
palette_im = strip.quantize(colors=32, method=Image.MEDIANCUT)
flat = palette_im.getpalette()[: 32 * 3]
palette = ['#%02x%02x%02x' % tuple(flat[k * 3: k * 3 + 3]) for k in range(len(flat) // 3)]
chars = '0123456789abcdefghijklmnopqrstuv'
lookup = {}
def nearest(rgb):
    if rgb not in lookup:
        lookup[rgb] = min(range(len(palette)), key=lambda k: sum((int(palette[k][1 + 2 * c: 3 + 2 * c], 16) - rgb[c]) ** 2 for c in range(3)))
    return lookup[rgb]
out_lines = ["// The runner as colour pixel art for terminals (see tools/make-frames.py): each row is one pixel row,",
             "// '.' is clear and every other character indexes PALETTE.", "",
             "export const PALETTE: string[] = " + repr(palette).replace("'", '"') + "", "",
             "export const PIXELS: Record<" + " | ".join(repr(p) for p in sets) + ", string[][]> = {"]
for pose in sets:
    out_lines.append(f"  {pose}: [")
    for p, im in frames:
        if p != pose:
            continue
        rows = []
        for y in range(SIZE):
            rows.append(''.join('.' if im.getpixel((x, y))[3] < 110 else chars[nearest(im.getpixel((x, y))[:3])] for x in range(SIZE)))
        out_lines.append("    [" + ", ".join('"' + r + '"' for r in rows) + "],")
    out_lines.append("  ],")
out_lines.append("}")
open(os.path.join(root, 'hooks', 'runner-pixels.ts'), 'w').write("\n".join(out_lines) + "\n")
print('wrote runner-pixels.ts', len(palette), 'colours')
