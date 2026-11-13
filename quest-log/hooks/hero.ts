// The hero's character sheet: a 5e Ranger built on the standard array (Dex and Wis first, as a ranger is built),
// raised by the Ability Score Improvements chosen in the Adventure view, with the class's own hit points, armor,
// attack, saving throws and spell slots by level (5e SRD 5.1, CC BY 4.0). Derived, never stored: the level and
// the choices are the state.
import { profBonus } from './game'

export const ABILITIES = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'] as const
const BASE = [12, 15, 13, 10, 14, 8]
const ASI = { str: 0, dex: 1, con: 2, int: 3, wis: 4, cha: 5 } as Record<string, number>
const ASI_CHOICES = ['asi-4', 'asi-8', 'asi-12', 'asi-16', 'asi-19']

/** Ranger spell slots by level, 1st to 5th. */
const SLOTS: Record<number, number[]> = {
  2: [2], 3: [3], 4: [3], 5: [4, 2], 6: [4, 2], 7: [4, 3], 8: [4, 3], 9: [4, 3, 2], 10: [4, 3, 2], 11: [4, 3, 3], 12: [4, 3, 3],
  13: [4, 3, 3, 1], 14: [4, 3, 3, 1], 15: [4, 3, 3, 2], 16: [4, 3, 3, 2], 17: [4, 3, 3, 3, 1], 18: [4, 3, 3, 3, 1], 19: [4, 3, 3, 3, 2], 20: [4, 3, 3, 3, 2],
}

const modOf = (score: number) => Math.floor((score - 10) / 2)
const signed = (n: number) => (n >= 0 ? `+${n}` : `−${-n}`)

export type Sheet = {
  scores: number[]
  mods: string[]
  hp: number
  ac: number
  speed: string
  prof: number
  attack: string
  saves: string
  slots: string
}

export function heroSheet(level: number, picks: Record<string, string>): Sheet {
  const scores = [...BASE]
  for (const id of ASI_CHOICES) {
    const at = ASI[picks[id] ?? '']
    if (at !== undefined) scores[at] = Math.min(20, (scores[at] ?? 10) + 2)
  }
  const [str, dex, con] = scores.map(modOf) as [number, number, number]
  const prof = profBonus(level)
  const archery = picks.style === 'archery' ? 2 : 0
  const slots = SLOTS[level] ?? []

  return {
    scores,
    mods: scores.map(score => signed(modOf(score))),
    hp: 10 + con + (level - 1) * (6 + con),
    // Studded leather (12 + Dex); the Defense style adds 1.
    ac: 12 + dex + (picks.style === 'defense' ? 1 : 0),
    speed: '30 ft.',
    prof,
    attack: `Longbow ${signed(prof + dex + archery)} to hit, 1d8 ${signed(dex)}${level >= 5 ? ', twice a turn' : ''}`,
    saves: `Str ${signed(str + prof)}, Dex ${signed(dex + prof)}`,
    slots: slots.length ? slots.map((n, i) => `${['1st', '2nd', '3rd', '4th', '5th'][i]} ${n}`).join(' · ') : 'none yet (from Lv 2)',
  }
}
