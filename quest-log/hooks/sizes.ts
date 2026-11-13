// How big a quest is, and what it pays. XP comes from goals, not from busywork: a goal's worth is set by its size,
// paid out as its parts are met (the goal check's own verdicts), as its milestones land, and the rest when it passes.
// Scaled on the chats this was measured on (a chat is a campaign; it starts again at Level 1): one trivial goal is
// worth about Lv 5, a typical sub-stage goal Lv 10–13, an epic one Lv 15, and a chat with several big goals reaches 20.

export type GoalSize = 'trivial' | 'small' | 'medium' | 'large' | 'epic'

export const SIZES: Record<GoalSize, { name: string; xp: number; tier: 1 | 2 | 3; level: number }> = {
  trivial: { name: 'Trivial', xp: 1300, tier: 1, level: 5 },
  small: { name: 'Small', xp: 4600, tier: 1, level: 7 },
  medium: { name: 'Medium', xp: 12800, tier: 2, level: 10 },
  large: { name: 'Large', xp: 24000, tier: 3, level: 13 },
  epic: { name: 'Epic', xp: 33000, tier: 3, level: 15 },
}

const ORDER: GoalSize[] = ['trivial', 'small', 'medium', 'large', 'epic']

/** The share of a goal's XP paid as its finish-line parts are met, and per milestone (up to MILESTONES of them). */
export const PARTS_SHARE = 0.6
export const MILESTONE_SHARE = 0.02
export const MILESTONES = 12
/** A plan's share paid step by step, as its planned steps are finished. */
export const STEPS_SHARE = 0.8

/**
 * A goal's size from what it asks: how many parts its finish line names, mostly; the stages it lays out and the length
 * of its brief add a little (capped: they are often context, not more work).
 */
export function sizeOfGoal(goal: string, finishLine: number, stages: number): GoalSize {
  if (goal.length < 120 && finishLine <= 1 && stages === 0) return 'trivial'
  // Stages named in order and a long brief often describe the whole campaign, not this goal: they count for a little.
  const score = Math.max(1, finishLine) + Math.min(1, stages * 0.25) + Math.min(1.5, goal.length / 1000)
  if (score < 2.5) return 'small'
  if (score < 4) return 'medium'
  if (score < 6) return 'large'

  return 'epic'
}

/** A plan's size from how many steps it lays out. */
export function sizeOfPlan(steps: number): GoalSize {
  if (steps <= 2) return 'trivial'
  if (steps <= 5) return 'small'
  if (steps <= 9) return 'medium'

  return 'large'
}

/** The bigger of two sizes: a quest only grows. */
export const bigger = (a: GoalSize, b: GoalSize) => (ORDER.indexOf(a) >= ORDER.indexOf(b) ? a : b)

/** What the work itself says: a quest that has run long or landed many milestones is bigger than its brief said. */
export function grownTo(size: GoalSize, milestones: number, hours: number): GoalSize {
  const steps = (milestones >= 30 || hours >= 12 ? 2 : 0) || (milestones >= 12 || hours >= 6 ? 1 : 0)

  return ORDER[Math.min(ORDER.length - 1, ORDER.indexOf(size) + steps)] as GoalSize
}

/** One finish-line part's worth, one milestone's, one planned step's. */
export const partXp = (size: GoalSize, parts: number) => (parts > 0 ? Math.round((SIZES[size].xp * PARTS_SHARE) / parts) : 0)
export const milestoneXp = (size: GoalSize) => Math.round(SIZES[size].xp * MILESTONE_SHARE)
export const stepXp = (size: GoalSize, steps: number) => (steps > 0 ? Math.round((SIZES[size].xp * STEPS_SHARE) / steps) : 0)

/** "24,000": XP the way the pane shows it. */
export const xpText = (xp: number) => Math.round(xp).toLocaleString('en-US')

/**
 * The d20 for a goal check that is not met yet: higher as more of the goal is met, never a 20 (that is the pass), a
 * little luck either way so two checks do not always read alike.
 */
export function rollFor(fraction: number, round: number): number {
  const luck = (((round * 7919) % 5) + 5) % 5 - 2
  const roll = 2 + Math.round(Math.max(0, Math.min(1, fraction)) * 15) + luck

  return Math.max(2, Math.min(19, roll))
}
