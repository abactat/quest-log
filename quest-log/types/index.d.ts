export type StepStatus = 'pending' | 'in_progress' | 'completed'

/** One thing Claude did, already put in plain English. */
/** `look`: it only looked around (a read, a search, a read-only command). `family`: what it worked on, so repeats join one step. */
/** `commit`: the subject of the git commit it made; a commit closes a milestone. */
export type QuestAction = { at: number; text: string; ok: boolean; byHelper?: boolean; look?: boolean; family?: string; commit?: string }

export type QuestStep = {
  key: string
  title: string
  status: StepStatus
  startedAt?: number
  doneAt?: number
  xp?: number
  /** Made by the log itself (no plan existed): one per stretch of work. */
  auto?: boolean
  /** What an unplanned step is about (a file, a command family): more work on the same thing joins it. */
  family?: string
  /** How many actions the step has had in all (its `actions` keeps only the latest once the step is old). */
  n?: number
  /** Which list the step came from ('work' for steps the log made before a plan arrived). */
  src?: string
  /** Unplanned work up to a git commit, folded into one step named by the commit's message. */
  milestone?: boolean
  actions: QuestAction[]
}

/** What the goal check last said: Claude Code's own judgement of the goal, read from the feedback it sends the agent. */
export type QuestCheck = {
  at: number
  /** Which check this is, counting from the first. */
  round: number
  /** The checker's own words. */
  reason: string
  /** Parts of the goal it says are done. */
  met: string[]
  /** Parts it says are still to do. */
  todo: string[]
}

/** One condition of the goal's finish line: `open` until a goal check counts it as met. */
export type RoadItem = { text: string; status: 'open' | 'done' }

export type QuestRoad = {
  /** The goal's "complete when ..." terms (or its bullet list), each ticked as the goal check counts it met. */
  finish: RoadItem[]
  /** Stages the goal names in order ("C1 -> C2 -> C3"), and how far the work has reached (an index into `stages`). */
  stages: string[]
  stageAt?: number
  /** What Claude last said comes next, and when. */
  next?: { at: number; items: string[] }
}

/** A decision the agent handed to the person instead of making the call. */
export type QuestAsk = {
  id: string
  at: number
  text: string
  options?: string[]
  /** `dialog`: the question dialog; `message`: the agent's own words ended a turn on it. */
  source: 'dialog' | 'message'
  /** `blocking`: the agent stopped on it; `floating`: it kept working with the question parked. */
  kind?: 'blocking' | 'floating'
  /** `unanswered`: the quest ended with it still open. */
  status: 'waiting' | 'answered' | 'unanswered'
  answer?: string
  answeredAt?: number
  /** The step in progress when it was raised. */
  stepKey?: string
  /** The person has been notified that Claude is waiting on it: raised again, it is not notified again. */
  told?: boolean
  /** Its number in Claude's latest numbered list of decisions: a numbered reply answers it by that number. */
  n?: number
}

export type QuestSource = 'goal' | 'plan' | 'checklist' | 'todos' | 'tasks'

export type Quest = {
  id: string
  title: string
  goal?: string
  /** False when the goal was only pasted as text: Claude Code is not checking it, so nothing sends the agent back to work. */
  checked?: boolean
  sources: QuestSource[]
  startedAt: number
  finishedAt?: number
  outcome?: 'won' | 'cleared'
  /** Why the goal check said it was met, in the checker's own words. */
  verdict?: string
  steps: QuestStep[]
  /** Decisions parked with the person, oldest first. */
  asks?: QuestAsk[]
  /** The goal check's latest verdict, while the goal is not met. */
  check?: QuestCheck
  /**
   * The quest's guardian, waiting at the end of the track: which monster, when it arrived, what it is doing now
   * (`attack` when the goal check sends Claude back, `hurt` when a milestone lands), and when it fell.
   */
  foe?: { id: string; at: number; act?: { anim: 'attack' | 'hurt'; at: number }; defeatedAt?: number; favored?: boolean }
  /** What is still ahead, known before the work reaches it: the goal's own finish line and stages, and what Claude said comes next. */
  road?: QuestRoad
  /** Times Claude stopped since the goal check last ran: two or more means nothing is checking the goal or sending Claude back. */
  unchecked?: number
  /** How big the quest is (it only grows), which sets what it pays. */
  size?: 'trivial' | 'small' | 'medium' | 'large' | 'epic'
  /** What it has paid so far: in all, for which finish-line parts, how many milestones, which planned steps. */
  paid?: { xp: number; parts: string[]; milestones: number; steps: string[] }
  /** What winning changed (conditions it ticked, the stage and roll before it, the XP it paid): a reopen undoes it. */
  won?: { open: string[]; stageAt?: number; roll?: { n: number; at: number; round: number }; xp: number; paid?: number }
  /** The d20: rolled at each goal check (2–19 by how much is met), 1 when the goal loop stalls, 20 when the goal passes. */
  roll?: { n: number; at: number; round: number }
  /** Goal checks in a row with no work between them: Claude has stopped, and the check keeps sending it back. */
  spins?: number
  /** Claude Code ended the goal loop itself (the check sent Claude back too many times in a row): nothing runs until the person replies. */
  stalled?: { at: number; times: number }
  /** Work done before any step was in progress. */
  scouting: QuestAction[]
  /** Reading and checking since the last doing: it goes into the step it leads to. */
  lookbuf?: QuestAction[]
  actionCount: number
  /** Kinds of action, counted as they happen (the logs themselves are trimmed on a long run). */
  counts?: { edits: number; reads: number; searches: number; failed: number; helpers: number }
  xpEarned: number
}

export type QuestSummary = {
  id: string
  title: string
  outcome: 'won' | 'cleared'
  steps: number
  cleared: number
  actions: number
  startedAt: number
  finishedAt: number
  xpEarned: number
  /** A goal set aside unmet: what its last check said was still to do. */
  left?: string
  /** Its size, and the XP it paid. */
  size?: string
  /** The guardian it faced, and whether it fell. */
  foe?: { id: string; defeated: boolean }
}

export type QuestFeed = { at: number; text: string }

export type QuestStats = {
  xp: number
  questsWon: number
  stepsCleared: number
  bestCombo: number
  badges: string[]
  /** The Ranger conclave chosen at Lv 3, by name. */
  conclave?: string
  /** The class choices made in the Class tab: choice id → option id (`conclave` → `gloom-stalker`, `style` → `archery`). */
  picks?: Record<string, string>
}

export type QuestGame = {
  quest: Quest | null
  history: QuestSummary[]
  stats: QuestStats
  feed: QuestFeed[]
  lastPrompt: string
  combo: { count: number; lastAt: number }
  /** True from a turn's start to its end: the runner runs while it is. */
  busy: boolean
  /** When, and what, the last tool call was. */
  lastAt: number
  lastText: string
  /** When this chat began (the engine's own figure): a different one on start means a new chat, so the game starts over. */
  chatStartedAt?: number
  /** The last chat row the log saw that was the agent's words (`assistant`), the person's (`user`) or a goal check's "keep going" feedback (`feedback`). */
  lastRow?: 'assistant' | 'user' | 'feedback'
  /** When and how the agent's last turn ended (`answer`, `aborted`, ...): tells a goal being checked from one left waiting. */
  lastTurnEnd?: { at: number; reason: string }
  /** When the person last sent the agent a message: after a quest is won, the agent only works again once this moves. */
  lastPromptAt?: number
  /** When a goal was last set (a /goal, or one Claude proposed): the check that announces it is not a verdict. */
  goalSetAt?: number
  /** When the conversation was last compacted: the goal re-posts its marker then, which is not a verdict. */
  compactedAt?: number
  /** Runs going now (and just ended), oldest first. */
  runs?: QuestRun[]
  /** How long each kind of run took, its last few times: what the next one like it is timed against. */
  runTimes?: Record<string, number[]>
  /** How long Claude just said a run it is starting will take: the next run to start takes it. */
  pendingHint?: { ms: number; at: number }
  /** The run that ended last: shown for a moment after it ends. */
  lastRun?: { label: string; took: number; status: string; at: number }
  /** The account's usage-limit windows as the engine last reported them (read for free; empty off a subscription). */
  limits: QuestLimit[]
  /** A banner shown until `until` (level ups). */
  flash?: { text: string; until: number }
  /** A strike the hero plays until `until`: `attack` when a step is cleared, `thrust` when a milestone lands. */
  strike?: { pose: 'attack' | 'thrust'; until: number }
  /** The last time the log failed to read a call, shown so a gap is never silent. */
  problem?: string
}

/**
 * A run Claude started and is waiting on: a foreground command still going, a background command, a helper agent.
 * `sig` names the kind of run (its plain-English description), so the next run like it can be timed against this one.
 */
export type QuestRun = {
  id: string
  kind: 'foreground' | 'background' | 'helper'
  label: string
  sig: string
  startedAt: number
  endedAt?: number
  status?: 'completed' | 'failed' | 'killed'
  /** Files its output goes to, read now and then for progress. */
  files?: string[]
  /** Its progress as its output last showed it. */
  progress?: { pct: number; line: string; at: number }
  /** How long Claude said it would take, in ms. */
  hint?: number
}

/** One usage-limit window: `five_hour` (the session limit) or `seven_day` (the weekly one). */
export type QuestLimit = { kind: string; percentUsed: number; resetsAt?: string }

/** The two views; `class` and `history` are older tabs (now inside Adventure and Quest), kept so a saved view still reads. */
export type QuestTab = 'quest' | 'adventure' | 'class' | 'history'

export type QuestView = { tab: QuestTab; open: string[]; frame: number }

declare module 'claude-code' {
  interface PluginState {
    'quest-log': { game: QuestGame; view: QuestView }
  }
}
