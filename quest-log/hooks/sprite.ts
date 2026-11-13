// The hero: the person's own ranger sprite sheet (see runner-frames.ts, cut by tools/cut-ranger.py), drawn as SVG
// images on the surfaces that have Svg, and as colour pixel art or emoji on the terminal.
import { POSES, type Pose } from './runner-frames'
import { PALETTE, PIXELS } from './runner-pixels'
import { FOE_FRAMES } from './foe-frames'
import { foeInfo, FRAME_MS, HURT_MS, WALK_IN_MS } from './foes'

export type { Pose }

/** A strike the hero plays through once: a step cleared (attack), a milestone landed (thrust). */
export type Strike = 'attack' | 'thrust'

/** Which animation the hero plays, from what is happening in the quest. */
export function poseOf(state: { busy: boolean; outOfHearts: boolean; won: boolean; celebrating: boolean; strike?: Strike; waiting?: boolean }): Pose {
  // A level up: the slash combo.
  if (state.celebrating) return 'slash'
  if (state.strike) return state.strike
  // A finished quest ends with the hero standing at ease, breathing, on repeat.
  if (state.won) return 'idle'
  // Out of session hearts: the pack has no fall, so the hero turns away to rest until the window resets.
  if (state.outOfHearts) return 'rest'
  // A decision waits on the person: sword lowered, on guard.
  if (state.waiting) return 'guard'

  return state.busy ? 'run' : 'idle'
}

/** Ticks each frame of a pose stays up (a tick is 160 ms): strikes are quick, standing poses slow. */
const HOLD: Record<Pose, number> = { run: 1, attack: 2, thrust: 2, slash: 2, idle: 4, guard: 4, rest: 5 }

/** Which of a pose's frames shows at a tick. Every pose loops; a strike lasts about one pass. */
const indexOf = (pose: Pose, frame: number, length: number) => ((Math.floor(frame / HOLD[pose]) % length) + length) % length

/** How long a strike shows: one pass of its frames. */
export const strikeMs = (pose: Strike) => POSES[pose].length * HOLD[pose] * 160

const pick = (pose: Pose, frame: number) => {
  const list = POSES[pose]

  return list[indexOf(pose, frame, list.length)] ?? ''
}

export type Run = { text: string; fg?: string; bg?: string }

/** Width, in terminal columns, of the hero drawn by heroRows. */
export const HERO_COLUMNS = 20

/**
 * The hero as coloured text for a terminal that cannot draw images: two pixel rows to a text row,
 * as half blocks (the top pixel the block's colour, the bottom one its background), with runs of
 * the same look merged so a frame is a few dozen elements, not hundreds.
 */
export function heroRows(frame: number, pose: Pose): Run[][] {
  const list = PIXELS[pose]
  const rows = list[indexOf(pose, frame, list.length)] ?? []
  const color = (char: string | undefined) => (!char || char === '.' ? undefined : PALETTE['0123456789abcdefghijklmnopqrstuv'.indexOf(char)])
  const out: Run[][] = []
  for (let y = 0; y < rows.length; y += 2) {
    const top = rows[y] ?? ''
    const bottom = rows[y + 1] ?? ''
    const runs: Run[] = []
    for (let x = 0; x < HERO_COLUMNS; x++) {
      const up = color(top[x])
      const down = color(bottom[x])
      const cell: Run = up && down ? { text: '▀', fg: up, bg: down } : up ? { text: '▀', fg: up } : down ? { text: '▄', fg: down } : { text: ' ' }
      const last = runs[runs.length - 1]
      if (last && last.fg === cell.fg && last.bg === cell.bg && last.text.slice(-1) === cell.text) last.text += cell.text
      else runs.push(cell)
    }
    out.push(runs)
  }

  return out
}

/** The frames are 5:4 (wide enough for a lunge): `size` is the height, the width follows. */
const ASPECT = 5 / 4
const IMG = (href: string, x: number, y: number, size: number) =>
  `<image href="${href}" x="${x}" y="${y}" width="${Math.round(size * ASPECT)}" height="${size}" style="image-rendering:pixelated"/>`

/** The hero alone, for the header. */
export function runnerSvg(frame: number, pose: Pose, size = 56) {
  const w = Math.round(size * ASPECT)

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${size}" viewBox="0 0 ${w} ${size}">${IMG(pick(pose, frame), 0, 0, size)}</svg>`
}

/** A guardian as the track draws it: this moment's frame, its size on the track, how far it has walked in, its health. */
export type FoeView = { href: string; w: number; h: number; enter: number; hp?: number }

type FoeState = { id: string; at: number; act?: { anim: 'attack' | 'hurt'; at: number }; defeatedAt?: number }

const frameAt = (list: string[] | undefined, since: number, ms: number, hold = false) => {
  if (!list || list.length === 0) return undefined
  const i = Math.max(0, Math.floor(since / ms))

  return list[hold ? Math.min(i, list.length - 1) : i % list.length]
}

/** What the guardian is doing now: walking in, roaring, struck, striking back, idling, or fallen (it stays down). */
export function foeView(foe: FoeState | undefined, now: number, hp: number): FoeView | undefined {
  const info = foeInfo(foe?.id)
  if (!foe || !info) return undefined
  const art = FOE_FRAMES[info.id]
  const size = { w: Math.round(art.w * info.scale), h: Math.round(art.h * info.scale) }
  const anims = art.anims
  const roarMs = (anims.attack?.length ?? 0) * FRAME_MS.attack
  const idle = frameAt(anims.idle, now, FRAME_MS.idle) ?? ''
  if (foe.defeatedAt !== undefined) return { ...size, enter: 1, href: frameAt(anims.death, now - foe.defeatedAt, FRAME_MS.death, true) ?? idle }
  const since = now - foe.at
  const health = Math.max(0, Math.min(1, hp))
  if (since < WALK_IN_MS) return { ...size, enter: since / WALK_IN_MS, hp: health, href: frameAt(anims.walk, since, FRAME_MS.walk) ?? idle }
  if (since < WALK_IN_MS + roarMs) return { ...size, enter: 1, hp: health, href: frameAt(anims.attack, since - WALK_IN_MS, FRAME_MS.attack, true) ?? idle }
  const act = foe.act
  if (act?.anim === 'attack' && now - act.at < roarMs) return { ...size, enter: 1, hp: health, href: frameAt(anims.attack, now - act.at, FRAME_MS.attack, true) ?? idle }
  if (act?.anim === 'hurt' && now - act.at < HURT_MS) return { ...size, enter: 1, hp: health, href: frameAt(anims.hurt ?? anims.idle, now - act.at, FRAME_MS.hurt) ?? idle }

  return { ...size, enter: 1, hp: health, href: idle }
}

/** Is the guardian in the middle of something (walking in, roaring, struck, striking, falling)? The pane keeps drawing while it is. */
export function foeMoving(foe: FoeState | undefined, now: number) {
  const info = foeInfo(foe?.id)
  if (!foe || !info) return false
  const anims = FOE_FRAMES[info.id].anims
  const roarMs = (anims.attack?.length ?? 0) * FRAME_MS.attack
  if (foe.defeatedAt !== undefined) return now - foe.defeatedAt < (anims.death?.length ?? 0) * FRAME_MS.death
  if (now - foe.at < WALK_IN_MS + roarMs) return true

  return !!foe.act && now - foe.act.at < (foe.act.anim === 'attack' ? roarMs : HURT_MS)
}

/** A track with the hero somewhere along it, the flag at the end, and the quest's guardian waiting before the flag. */
export function trackSvg(width: number, fraction: number, frame: number, pose: Pose, isDone: boolean, size = 64, foe?: FoeView) {
  const bar = foe?.hp !== undefined ? 8 : 0
  const h = Math.max(size + 2, (foe?.h ?? 0) + bar) + 8
  const ground = h - 6
  const flagW = 14
  const room = foe ? foe.w + 4 : 0
  const span = Math.max(1, width - Math.round(size * ASPECT) - flagW - 4 - room)
  const x = Math.round(2 + Math.max(0, Math.min(1, fraction)) * span)
  const dashes = Array.from({ length: Math.floor(width / 14) }, (_, i) => `<rect x="${i * 14 + 3}" y="${ground + 3}" width="6" height="2" fill="#8a8f98" opacity="0.5"/>`).join('')
  const flag = `<rect x="${width - 10}" y="${ground - 30}" width="2" height="30" fill="#8a8f98"/><path d="M${width - 8} ${ground - 30} l14 6 l-14 6 z" fill="${isDone ? '#2fb86a' : '#c0392b'}"/>`
  let guardian = ''
  if (foe) {
    // It walks in from beyond the right edge to its post before the flag.
    const fx = width - flagW - 2 - foe.w + Math.round((1 - Math.max(0, Math.min(1, foe.enter))) * (foe.w + flagW + 12))
    const fy = ground - foe.h + 1
    const health =
      foe.hp === undefined
        ? ''
        : `<rect x="${fx + Math.round(foe.w * 0.2)}" y="${fy - 7}" width="${Math.round(foe.w * 0.6)}" height="4" rx="1" fill="#3a3d45"/><rect x="${fx + Math.round(foe.w * 0.2)}" y="${fy - 7}" width="${Math.max(0, Math.round(foe.w * 0.6 * foe.hp))}" height="4" rx="1" fill="#d64545"/>`
    guardian = `${health}<image href="${foe.href}" x="${fx}" y="${fy}" width="${foe.w}" height="${foe.h}" style="image-rendering:pixelated"/>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width + 8}" height="${h}" viewBox="0 0 ${width + 8} ${h}"><rect x="0" y="${ground}" width="${width}" height="2" fill="#8a8f98"/>${dashes}${flag}${guardian}${IMG(pick(pose, frame), x, ground - size - 2, size)}</svg>`
}

/** Plain-text runner for the terminal: the guardian's emoji (a skull once it falls) stands at the end in place of the flag. */
export function textTrack(cells: number, fraction: number, pose: Pose, frame: number, foe?: { emoji: string; dead: boolean }) {
  const span = Math.max(4, cells - 4)
  const at = Math.round(Math.max(0, Math.min(1, fraction)) * span)
  const pip =
    pose === 'run' ? (Math.floor(frame / 3) % 2 ? '🧝' : '🧝💨') : pose === 'slash' ? '🧝✨' : pose === 'attack' || pose === 'thrust' ? '🧝⚔️' : pose === 'rest' ? '🧝💤' : pose === 'guard' ? '🧝🛡️' : '🧝'
  const end = foe ? (foe.dead ? '💀' : foe.emoji) : pose === 'slash' ? '🏁' : '🚩'

  return `${'·'.repeat(at)}${pip}${'·'.repeat(Math.max(0, span - at))}${end}`
}

/** How long a roll takes to land: the ring spins down onto the number. */
export const ROLL_MS = 1600

/** The numbers round the d20's ring, in the order the die's faces sit (each opposite pair adds to 21). */
const D20_ORDER = [20, 5, 10, 13, 18, 3, 8, 11, 16, 1, 6, 19, 14, 9, 4, 17, 12, 7, 2, 15]
const D20_SIZE = 144

/** The die's face: an icosahedron seen point-on, drawn as shaded facets (original art, plain geometry). */
const D20_FACE = (() => {
  const c = D20_SIZE / 2
  const at = (r: number, deg: number) => [c + r * Math.cos((deg * Math.PI) / 180), c + r * Math.sin((deg * Math.PI) / 180)] as const
  const hex = [-90, -30, 30, 90, 150, 210].map(deg => at(40, deg))
  const [top, right, left] = [at(22, -90), at(22, 30), at(22, 150)]
  const poly = (fill: string, ...pts: (readonly [number, number])[]) => `<polygon points="${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="${fill}"/>`
  const [h0, h1, h2, h3, h4, h5] = hex as [readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number], readonly [number, number]]

  return [
    poly('#7d1d18', h0, h1, h2, h3, h4, h5),
    poly('#c8463b', top, right, left),
    poly('#a83228', h0, h1, top), poly('#b93a30', h0, top, h5),
    poly('#8f2620', h1, h2, right), poly('#9e2c24', h1, right, top),
    poly('#6e1914', h2, h3, right), poly('#7a1c17', h3, left, right),
    poly('#86221c', h3, h4, left), poly('#a02e25', h4, h5, left), poly('#b13529', h5, top, left),
    `<polygon points="${hex.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')}" fill="none" stroke="#2a0b09" stroke-width="2" stroke-linejoin="round"/>`,
    `<path d="M${top[0]},${top[1]} L${right[0]},${right[1]} L${left[0]},${left[1]} Z M${h0[0]},${h0[1]} L${top[0]},${top[1]} M${h1[0]},${h1[1]} L${top[0]},${top[1]} M${h1[0]},${h1[1]} L${right[0]},${right[1]} M${h2[0]},${h2[1]} L${right[0]},${right[1]} M${h3[0]},${h3[1]} L${right[0]},${right[1]} M${h3[0]},${h3[1]} L${left[0]},${left[1]} M${h4[0]},${h4[1]} L${left[0]},${left[1]} M${h5[0]},${h5[1]} L${left[0]},${left[1]} M${h5[0]},${h5[1]} L${top[0]},${top[1]}" stroke="#2a0b09" stroke-width="1.2" fill="none" stroke-opacity="0.7"/>`,
    // The arrow: it points down at the ring, and the number under it is the roll.
    `<polygon points="${c - 7},${c + 38} ${c + 7},${c + 38} ${c},${c + 48}" fill="#f2c14e" stroke="#3b2410" stroke-width="1.5" stroke-linejoin="round"/>`,
  ].join('')
})()

/** The numbered ring, unturned: number i sits i × 18° clockwise from the top, its foot toward the centre. */
const D20_RING = (() => {
  const c = D20_SIZE / 2
  const nums = D20_ORDER.map((n, i) => {
    const deg = i * 18
    const rad = (deg * Math.PI) / 180
    const [x, y] = [c + 56 * Math.sin(rad), c - 56 * Math.cos(rad)]

    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" transform="rotate(${deg + 180} ${x.toFixed(1)} ${y.toFixed(1)})" text-anchor="middle" dominant-baseline="central" font-family="Georgia, serif" font-weight="bold" font-size="13" fill="${n === 20 ? '#b8860b' : n === 1 ? '#9b1c1c' : '#2b1d10'}">${n}</text>`
  })
  const ticks = D20_ORDER.map((_, i) => `<line x1="${c}" y1="${c - 47}" x2="${c}" y2="${c - 65}" transform="rotate(${i * 18 + 9} ${c} ${c})" stroke="#8a6a3c" stroke-width="1"/>`)

  return `<circle cx="${c}" cy="${c}" r="56" fill="none" stroke="#efe2c4" stroke-width="18"/>${ticks.join('')}${nums.join('')}`
})()

/**
 * The d20 roller: its numbered ring turned so the roll sits at the bottom, under the die's arrow. With no roll to show,
 * it spins (`frame` turns it); a fresh roll decelerates onto its number over ROLL_MS.
 */
export function d20Svg(size: number, roll: number | undefined, frame: number, sinceRoll = Infinity) {
  const at = roll === undefined ? -1 : D20_ORDER.indexOf(roll)
  let turn = at < 0 ? (frame * 23) % 360 : 180 - at * 18
  if (at >= 0 && sinceRoll < ROLL_MS) {
    const left = 1 - sinceRoll / ROLL_MS
    turn += left * left * 1080
  }
  const c = D20_SIZE / 2
  const band = `<circle cx="${c}" cy="${c}" r="70" fill="#3b2410"/><circle cx="${c}" cy="${c}" r="66" fill="none" stroke="#c9a14a" stroke-width="2"/><circle cx="${c}" cy="${c}" r="46" fill="#2a180b" stroke="#c9a14a" stroke-width="1.5"/>`

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${D20_SIZE} ${D20_SIZE}">${band}<g transform="rotate(${turn.toFixed(1)} ${c} ${c})">${D20_RING}</g>${D20_FACE}</svg>`
}
