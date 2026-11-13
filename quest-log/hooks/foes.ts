// The bad guys: each quest gets a guardian that waits at the end of the track. It walks in and roars when a goal or
// plan begins, waits (idling) through the long run, flinches when a milestone lands, strikes back when the goal check
// says "not met", and falls when the quest is won. Plain data and timing: sprite.ts draws it.
//
// Their game statistics are the 5e System Reference Document's (SRD 5.1, Wizards of the Coast, CC BY 4.0), each
// matched to the goal size whose payout brings the hero to about that challenge: a trivial goal (about Lv 5) meets
// a CR ½ creature, an epic one (about Lv 15) a CR 17 dragon. Where the art is a creature the SRD lacks (a purple
// dragon), the nearest SRD creature's numbers stand in, and the stat block names it.
import type { FoeId } from './foe-frames'
import type { GoalSize } from './sizes'

export type { FoeId }

export type StatBlock = {
  /** "Medium humanoid (lizardfolk), neutral". */
  type: string
  /** The SRD creature whose numbers these are, when it is not the name shown. */
  as?: string
  cr: string
  /** XP the SRD gives for it (not what the quest pays: that is the goal's). */
  xp: number
  ac: number
  hp: number
  speed: string
  /** STR, DEX, CON, INT, WIS, CHA. */
  abilities: [number, number, number, number, number, number]
  /** Its signature attack or power, in a line. */
  action: string
}

export type FoeInfo = {
  id: FoeId
  name: string
  emoji: string
  /** The 5e creature type, as the Adventure view's Favored Enemy choice names it: a favored foe pays more when it falls. */
  kind: string
  /** The goal sizes it guards. */
  sizes: GoalSize[]
  /** Drawn at this fraction of the sheet's pixels, so each sits beside the hero at a believable size. */
  scale: number
  stats: StatBlock
}

export const FOES: FoeInfo[] = [
  {
    id: 'lizard',
    name: 'Lizardfolk',
    emoji: '🦎',
    kind: 'humanoids',
    sizes: ['trivial'],
    scale: 0.8,
    stats: { type: 'Medium humanoid (lizardfolk), neutral', cr: '½', xp: 100, ac: 15, hp: 22, speed: '30 ft., swim 30 ft.', abilities: [15, 10, 13, 7, 12, 7], action: 'Multiattack: a bite and a spear thrust (+4 to hit)' },
  },
  {
    id: 'whelp',
    name: 'Dragon Wyrmling',
    emoji: '🐲',
    kind: 'dragons',
    sizes: ['small'],
    scale: 0.8,
    stats: { type: 'Medium dragon, chaotic evil', as: 'Red Dragon Wyrmling', cr: '4', xp: 1100, ac: 17, hp: 75, speed: '30 ft., climb 30 ft., fly 60 ft.', abilities: [19, 10, 17, 12, 11, 15], action: 'Fire Breath: 15-ft. cone, 24 (7d6) fire, DC 13 Dex for half' },
  },
  {
    id: 'medusa',
    name: 'Medusa',
    emoji: '🐍',
    kind: 'monstrosities',
    sizes: ['medium'],
    scale: 0.75,
    stats: { type: 'Medium monstrosity, lawful evil', cr: '6', xp: 2300, ac: 15, hp: 127, speed: '30 ft.', abilities: [10, 15, 16, 12, 13, 15], action: 'Petrifying Gaze: DC 14 Con or begin turning to stone' },
  },
  {
    id: 'jinn',
    name: 'Djinni',
    emoji: '🧞',
    kind: 'elementals',
    sizes: ['large'],
    scale: 0.65,
    stats: { type: 'Large elemental, chaotic good', cr: '11', xp: 7200, ac: 17, hp: 161, speed: '30 ft., fly 90 ft.', abilities: [21, 15, 22, 15, 16, 20], action: 'Create Whirlwind: a 5-ft. cyclone that restrains, DC 18 Str' },
  },
  {
    id: 'demon',
    name: 'Horned Devil',
    emoji: '👹',
    kind: 'fiends',
    sizes: ['large'],
    scale: 0.7,
    stats: { type: 'Large fiend (devil), lawful evil', cr: '11', xp: 7200, ac: 18, hp: 178, speed: '20 ft., fly 60 ft.', abilities: [22, 17, 21, 12, 16, 17], action: 'Fork: +10 to hit, 15 (2d8 + 6) piercing; Hurl Flame 14 (4d6) fire' },
  },
  {
    id: 'dragon',
    name: 'Adult Dragon',
    emoji: '🐉',
    kind: 'dragons',
    sizes: ['epic'],
    scale: 0.65,
    stats: { type: 'Huge dragon, chaotic evil', as: 'Adult Red Dragon', cr: '17', xp: 18000, ac: 19, hp: 256, speed: '40 ft., climb 40 ft., fly 80 ft.', abilities: [27, 10, 25, 16, 13, 21], action: 'Fire Breath: 60-ft. cone, 63 (18d6) fire, DC 21 Dex for half' },
  },
]

export const foeInfo = (id?: string) => FOES.find(one => one.id === id)

/** The guardian for a quest of this size: one of those that guard it, picked by the quest's id so a reload keeps it. */
export function pickFoe(seed: string, size: GoalSize): FoeId {
  const pool = FOES.filter(one => one.sizes.includes(size))
  let hash = 0
  for (const char of seed) hash = (hash * 31 + char.charCodeAt(0)) >>> 0

  return (pool[hash % pool.length] ?? (FOES[0] as FoeInfo)).id
}

/** How the fight reads against the hero the goal will make: a creature well below that level is easy, one above deadly. */
export function difficulty(cr: string, heroLevel: number): { word: string; tone: 'success' | 'claude' | 'warning' | 'error' } {
  const rating = cr === '½' ? 0.5 : Number(cr)
  const gap = rating - heroLevel
  if (gap <= -4.5) return { word: 'Easy', tone: 'success' }
  if (gap <= -3) return { word: 'Medium', tone: 'claude' }
  if (gap <= -1) return { word: 'Hard', tone: 'warning' }

  return { word: 'Deadly', tone: 'error' }
}

/** An ability score's modifier, as a sheet prints it: "+2", "−1". */
export const mod = (score: number) => {
  const m = Math.floor((score - 10) / 2)

  return m >= 0 ? `+${m}` : `−${-m}`
}

/** XP for felling it: a tenth of what the quest it guards is worth, a quarter more when it is one of the hero's favored enemies. */
export function bounty(questXp: number, favored: boolean) {
  const base = Math.round(questXp * 0.1)

  return favored ? Math.round(base * 1.25) : base
}

/** Timings, in ms. */
export const WALK_IN_MS = 2400
export const FRAME_MS = { walk: 120, attack: 120, hurt: 250, death: 220, idle: 260 } as const
export const HURT_MS = 1000
