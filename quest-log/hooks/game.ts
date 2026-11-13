// The game itself: pure functions over a QuestGame. Every change returns a new
// game plus the events it raised (for the feed, toasts and the status line).
import type {
  Quest,
  QuestAction,
  QuestAsk,
  QuestCheck,
  QuestGame,
  QuestRoad,
  QuestSource,
  QuestStep,
  QuestSummary,
  StepStatus,
} from '../types'

import { CHOICES, choicesFor, conclaveOf, featuresAt } from './ranger'
import { strikeMs } from './sprite'
import { bounty, foeInfo, pickFoe, } from './foes'
import { bigger, grownTo, milestoneXp, MILESTONES, partXp, rollFor, SIZES, sizeOfGoal, sizeOfPlan, stepXp, xpText, type GoalSize } from './sizes'

export { featuresAt } from './ranger'

export type Change = { game: QuestGame; events: string[] }
export type StepInput = { title: string; status: StepStatus }


/** Proficiency bonus: +2 at Lv 1, rising a point every four levels. */
export const profBonus = (level: number) => 2 + Math.floor((Math.min(level, 20) - 1) / 4)

/** Actions that only look around: they never make a step of their own. */
const LIGHT = /^(Read |Searched |Looked for|Read a web page|Used the browser: (read|find|tabs|get))/

/** Did the action only look around? The caller says so (`look`); older records fall back to their words. */
const isLook = (action: QuestAction) => action.look ?? LIGHT.test(action.text)

/** The folder a file action worked in, so edits in one folder join a single step. */
const dirOf = (family?: string) => (family?.startsWith('file:') ? family.slice(5).split('/').slice(0, -1).join('/') : undefined)

const COMBO_WINDOW_MS = 10 * 60 * 1000
const MAX_ACTIONS = 60
/** How many of the latest finished steps keep their whole action log. */
const KEEP_DETAILED = 25

const MAX_LEVEL = 20

/** The 5e XP table (0, 300, 900, 2700, ... 355000) at a fifth of its size: a quest is worth a few hundred XP, not a few thousand. */
const XP_TABLE = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000]

/** Total XP needed to reach a level. */
export const xpForLevel = (level: number) => Math.round((XP_TABLE[Math.max(1, Math.min(level, MAX_LEVEL)) - 1] ?? 0) / 5)

export function levelOf(xp: number) {
  let level = 1
  while (level < MAX_LEVEL && xpForLevel(level + 1) <= xp) level++
  const floor = xpForLevel(level)
  const capped = level >= MAX_LEVEL

  return {
    level,
    rank: 'Ranger',
    into: capped ? 1 : xp - floor,
    span: capped ? 1 : xpForLevel(level + 1) - floor,
  }
}

export const emptyGame = (): QuestGame => ({
  quest: null,
  history: [],
  stats: { xp: 0, questsWon: 0, stepsCleared: 0, bestCombo: 0, badges: [] },
  feed: [],
  lastPrompt: '',
  combo: { count: 0, lastAt: 0 },
  busy: false,
  lastAt: 0,
  lastText: '',
  limits: [],
})

/** A pasted message arrives wrapped in tags like <pasted_content id="...">: drop every line that carries one. */
export const unwrap = (text: string) =>
  text
    .split('\n')
    .filter(line => !/pasted_content/i.test(line))
    .join('\n')
    .trim()

const norm = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ')

const ALIAS: Record<string, string> = {
  create: 'write', created: 'write', wrote: 'write', writing: 'write', add: 'write', make: 'write', build: 'write', built: 'write',
  ran: 'run', running: 'run', execute: 'run', executed: 'run', pytest: 'test', testing: 'test', tested: 'test',
  fixed: 'fix', fixing: 'fix', patch: 'fix', edit: 'fix', edited: 'fix', confirmed: 'verify', confirm: 'verify', check: 'verify', verified: 'verify',
}
const STOP = new Set(['the', 'and', 'for', 'with', 'into', 'that', 'this', 'then', 'all', 'new', 'what', 'out', 'any', 'its'])

/** The meaningful words of a line: file names whole, verbs folded together (wrote ~ create ~ add). */
export function tokens(text: string): Set<string> {
  const out = new Set<string>()
  const word = (part: string) => {
    const stem = part.length > 4 && part.endsWith('s') ? part.slice(0, -1) : part
    if (stem.length >= 2 && !STOP.has(stem)) out.add(ALIAS[stem] ?? stem)
  }
  for (const raw of text.toLowerCase().split(/[^a-z0-9_.]+/)) {
    const w = raw.replace(/^[._]+|[._]+$/g, '')
    if (!w) continue
    const file = /\.[a-z0-9]{1,5}$/.test(w)
    if (file) out.add(w)
    for (const part of (file ? w.replace(/\.[a-z0-9]+$/, '') : w).split(/[._]+/)) word(part)
  }

  return out
}

/** How alike two lines are: shared words, a shared file name counting double. */
export function likeness(a: string, b: string) {
  const other = tokens(b)
  let score = 0
  for (const token of tokens(a)) if (other.has(token)) score += /\.[a-z0-9]{1,5}$/.test(token) ? 2 : 1

  return score
}

const isLive = (quest: Quest | null): quest is Quest => !!quest && !quest.finishedAt

/** Runs one change on a copy, collecting the events it raised. */
export function change(game: QuestGame, now: number, fn: (c: Ctx) => void): Change {
  const ctx = new Ctx(JSON.parse(JSON.stringify(game)) as QuestGame, now)
  fn(ctx)

  return { game: ctx.game, events: ctx.events }
}

export class Ctx {
  events: string[] = []
  /** Asks raised in this one change (one list being read): never one another's twin. */
  made = new Set<string>()
  constructor(
    public game: QuestGame,
    public now: number,
  ) {}

  say(text: string) {
    this.events.push(text)
    this.game.feed = [...this.game.feed, { at: this.now, text }].slice(-30)
  }

  addXp(xp: number) {
    const before = levelOf(this.game.stats.xp).level
    this.game.stats.xp += xp
    if (this.game.quest) this.game.quest.xpEarned += xp
    const after = levelOf(this.game.stats.xp)
    for (let level = before + 1; level <= after.level; level++) {
      const gained = featuresAt(level, this.game.stats.conclave).join(', ')
      const text = `Lv ${level} ${this.game.stats.conclave ?? ''} Ranger · +${profBonus(level)} proficiency${gained ? ` · New: ${gained}` : ''}`.replace('  ', ' ')
      // The class's choices at this level wait for the person, in the Adventure view: nothing is picked for them.
      const due = choicesFor(this.game.stats.picks?.conclave).filter(choice => choice.level === level)
      const ask = due.length ? ` · 🎓 Choose: ${due.map(choice => choice.title).join(', ')} (Adventure view)` : ''
      this.say(`⬆️ LEVEL UP! ${text}${ask}`)
      this.game.flash = { text: `LEVEL UP! ${text}${ask}`, until: this.now + 8000 }
    }
  }

  /** The person made a class choice in the Adventure view. A new conclave drops the old one's own choices. */
  pick(choiceId: string, optionId: string) {
    const choice = CHOICES.find(one => one.id === choiceId)
    const option = choice?.options.find(one => one.id === optionId)
    if (!choice || !option) return
    const stats = this.game.stats
    const picks = { ...(stats.picks ?? {}) }
    if (choiceId === 'conclave' && picks.conclave !== optionId) {
      for (const own of CHOICES.filter(one => one.conclave && one.conclave !== optionId)) delete picks[own.id]
      stats.conclave = conclaveOf(optionId)?.name
    }
    picks[choiceId] = optionId
    stats.picks = picks
    this.say(`🎓 ${choice.title}: ${option.name}`)
  }

  /** The person took a choice back, to choose again. Taking back the conclave takes back its own choices too. */
  unpick(choiceId: string) {
    const stats = this.game.stats
    const picks = { ...(stats.picks ?? {}) }
    delete picks[choiceId]
    if (choiceId === 'conclave') {
      for (const own of CHOICES.filter(one => one.conclave)) delete picks[own.id]
      stats.conclave = undefined
    }
    stats.picks = picks
  }

  /** Archives the quest in play (if any) and starts a fresh one. */
  startQuest(title: string, source: QuestSource, goal?: string, checked?: boolean) {
    this.endQuest('cleared')
    this.game.quest = {
      id: `q${this.now}`,
      title: unwrap(title) || 'A mysterious quest',
      goal: goal === undefined ? undefined : unwrap(goal),
      ...(checked === undefined ? {} : { checked }),
      sources: [source],
      startedAt: this.now,
      steps: [],
      asks: [],
      scouting: [],
      actionCount: 0,
      xpEarned: 0,
    }
    // What the goal itself says is ahead: shown from the start, not only as the work reaches it.
    const road = goal ? goalRoad(unwrap(goal)) : undefined
    if (road && (road.finish.length || road.stages.length)) this.game.quest.road = road
    this.game.combo = { count: 0, lastAt: 0 }
    this.say(`📜 New quest: ${this.game.quest.title}`)
    // Its size sets what it pays; a guardian bars the way, bigger for a bigger quest, walking in now.
    this.resize(goal ? sizeOfGoal(unwrap(goal), road?.finish.length ?? 0, road?.stages.length ?? 0) : 'trivial', true)
  }

  /** The quest is (at least) this big now: it never shrinks, and a bigger quest brings a bigger guardian. */
  resize(size: GoalSize, quiet = false) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    const was = (quest.size ?? 'trivial') as GoalSize
    const now = quest.size ? bigger(was, size) : size
    quest.size = now
    quest.paid = quest.paid ?? { xp: 0, parts: [], milestones: 0, steps: [] }
    if (!quiet && now !== was) this.say(`📈 The quest grows: now ${SIZES[now].name}, worth ${xpText(SIZES[now].xp)} XP`)
    this.guard(now)
  }

  /** Pays out part of the quest's worth. */
  pay(xp: number) {
    const quest = this.game.quest
    if (!quest || xp <= 0) return 0
    quest.paid = quest.paid ?? { xp: 0, parts: [], milestones: 0, steps: [] }
    quest.paid.xp += xp
    this.addXp(xp)

    return xp
  }

  /** A guardian for the quest in play, or a bigger one when the quest has grown past the one it has. */
  guard(size: GoalSize) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    const now = foeInfo(quest.foe?.id)
    // The guardian it has still fits: no change. A quest that grew past it gets one of its new size.
    if (now && quest.foe && !quest.foe.defeatedAt && now.sizes.includes(size)) return
    const foe = pickFoe(`${quest.id}:${size}`, size)
    const info = foeInfo(foe)
    quest.foe = { id: foe, at: this.now }
    if (info) this.say(now ? `${info.emoji} A ${info.name} takes over from the ${now.name}` : `${info.emoji} A ${info.name} guards this quest`)
  }


  /**
   * A goal arrives (a /goal, or one Claude proposed). With a plan or task list already running, the goal takes that
   * quest over and keeps its steps; the same goal reworded updates the quest in place; any other goal is a new quest.
   */
  setGoal(title: string, goal: string, checked: boolean) {
    const quest = this.game.quest
    const text = unwrap(goal)
    const live = isLive(quest) ? quest : undefined
    const reworded = !!live?.goal && live.goal !== text && (similar(live.goal, text) || likeness(live.goal, text) >= Math.min(12, Math.ceil(tokens(live.goal).size * 0.5)))
    if (!live || (live.sources.includes('goal') && !reworded)) {
      this.startQuest(title, 'goal', text, checked)

      return
    }
    const joined = !live.sources.includes('goal')
    live.goal = text
    live.title = unwrap(title) || live.title
    live.checked = checked
    if (joined) live.sources = ['goal', ...live.sources]
    // The goal's own finish line and stages; a condition the old wording had already met stays met.
    const road = goalRoad(text)
    const before = live.road?.finish ?? []
    for (const item of road.finish) if (before.some(old => old.status === 'done' && alike(old.text, item.text))) item.status = 'done'
    if (road.finish.length || road.stages.length) live.road = { ...road, ...(live.road?.next ? { next: live.road.next } : {}), ...(live.road?.stageAt !== undefined ? { stageAt: live.road.stageAt } : {}) }
    this.say(joined ? `📜 Goal set on this quest: ${live.title}` : `📜 Goal updated: ${live.title}`)
    this.resize(sizeOfGoal(text, road.finish.length, road.stages.length))
  }

  /** The quest in play, starting one named after the last prompt if none is. */
  liveQuest(source: QuestSource): Quest {
    if (!isLive(this.game.quest)) this.startQuest(this.game.lastPrompt || 'Untitled quest', source)
    const quest = this.game.quest as Quest
    if (!quest.sources.includes(source)) quest.sources = [...quest.sources, source]

    return quest
  }

  endQuest(outcome: 'won' | 'cleared') {
    const quest = this.game.quest
    if (!quest) return
    if (quest.lookbuf?.length) {
      quest.scouting = [...quest.scouting, ...quest.lookbuf].slice(-MAX_ACTIONS)
      quest.lookbuf = []
    }
    for (const ask of quest.asks ?? []) if (ask.status === 'waiting') Object.assign(ask, { status: 'unanswered', answeredAt: this.now })
    if (!quest.finishedAt) {
      quest.finishedAt = this.now
      quest.outcome = outcome
      if (outcome === 'cleared') this.say(`🏳️ Quest set aside: ${quest.title}`)
    }
    const summary: QuestSummary = {
      id: quest.id,
      title: quest.title,
      outcome: quest.outcome ?? outcome,
      steps: quest.steps.length,
      cleared: quest.steps.filter(step => step.status === 'completed').length,
      actions: quest.actionCount,
      startedAt: quest.startedAt,
      finishedAt: quest.finishedAt,
      xpEarned: quest.xpEarned,
      ...(quest.outcome !== 'won' && quest.check?.todo.length ? { left: quest.check.todo.slice(0, 4).join(' · ') } : {}),
      ...(quest.foe ? { foe: { id: quest.foe.id, defeated: !!quest.foe.defeatedAt } } : {}),
      ...(quest.size ? { size: quest.size } : {}),
    }
    this.game.history = [summary, ...this.game.history.filter(one => one.id !== quest.id)].slice(0, 20)
    if (outcome === 'cleared' || quest.outcome === 'cleared') this.game.quest = null
  }

  /** Claude stopped with a checked goal in play: one more stop the goal check has yet to answer. */
  stopped() {
    const quest = this.game.quest
    if (!isLive(quest) || !quest.sources.includes('goal') || quest.checked === false) return
    quest.unchecked = (quest.unchecked ?? 0) + 1
  }

  /** A turn ended: close the stretch of unplanned work it was. */
  endTurn() {
    const quest = this.game.quest
    if (!isLive(quest)) return
    const step = quest.steps.find(one => one.auto && one.status === 'in_progress')
    if (step) {
      this.setStatus(step, 'completed')
    }
  }

  /**
   * An agent's list arrives (a plan, todos, a checklist): fold it into the quest. Steps the quest
   * already has are matched by title, place, then likeness and keep their log, whichever list they
   * came from; finished work the new list leaves out stays where it was; steps another list owns
   * stay put above or below; work done before any plan becomes finished steps above it.
   */
  setSteps(source: QuestSource, list: StepInput[]) {
    const quest = this.liveQuest(source)
    // Work done before the plan: what only looked around joins Prep work, what did something stays as a finished step.
    for (const step of quest.steps.filter(one => one.auto)) {
      if (step.actions.every(isLook)) {
        quest.scouting = [...step.actions, ...quest.scouting].slice(-MAX_ACTIONS)
        quest.steps = quest.steps.filter(one => one !== step)
        continue
      }
      if (step.status === 'in_progress') this.setStatus(step, 'completed')
      step.auto = false
      step.src = 'work'
    }
    const mine = (step: QuestStep) => (step.src ?? source) === source
    const pool = quest.steps
    const used = new Set<string>()
    const chosen: (QuestStep | undefined)[] = list.map(input => {
      const hit = pool.find(step => !used.has(step.key) && norm(step.title) === norm(input.title))
      if (hit) used.add(hit.key)

      return hit
    })
    const same = pool.filter(mine)
    list.forEach((input, index) => {
      if (chosen[index]) return
      const here = same[index]
      let pick = here && !used.has(here.key) && same.length === list.length ? here : undefined
      if (!pick) {
        let best = 1
        for (const step of pool) {
          const score = used.has(step.key) || step.status === 'completed' || (!mine(step) && step.src === 'work') ? 0 : likeness(input.title, step.title)
          if (score > best) {
            best = score
            pick = step
          }
        }
      }
      if (pick) used.add(pick.key)
      chosen[index] = pick
    })
    // Finished steps stay; a step the agent dropped keeps its log under Prep work.
    const unmatched = same.filter(step => !used.has(step.key))
    const kept = unmatched.filter(step => step.status === 'completed')
    const dropped = unmatched.filter(step => step.status !== 'completed')
    if (dropped.length) quest.scouting = [...dropped.flatMap(step => step.actions), ...quest.scouting].slice(-MAX_ACTIONS)
    const built: QuestStep[] = list.map((input, index) => {
      const match = chosen[index]

      return match
        ? { ...match, title: input.title, src: source }
        : { key: `s${this.now}-${index}`, title: input.title, status: 'pending', actions: [], src: source }
    })
    const ours = new Set([...same.map(step => step.key), ...used])
    const anchorAt = quest.steps.findIndex(step => ours.has(step.key))
    const rest = quest.steps.filter(step => !ours.has(step.key))
    const at = anchorAt < 0 ? rest.length : quest.steps.slice(0, anchorAt).filter(step => !ours.has(step.key)).length
    quest.steps = [...rest.slice(0, at), ...kept, ...built, ...rest.slice(at)]
    built.forEach((input, index) => {
      const step = quest.steps.find(one => one.key === input.key)
      const want = list[index]?.status
      if (step && want) this.setStatus(step, want)
    })
    this.planSize()
    this.checkWin()
  }

  /** The task tool's own list (TaskList): add what is new, retitle and restate the rest, drop what is gone. */
  syncTasks(tasks: { id: string; subject: string; status: StepStatus }[]) {
    if (tasks.length === 0) return
    const quest = this.liveQuest('tasks')
    const keys = new Set(tasks.map(task => `t${task.id}`))
    quest.steps = quest.steps.filter(step => !step.key.startsWith('t') || keys.has(step.key))
    for (const task of tasks) {
      const key = `t${task.id}`
      let step = quest.steps.find(one => one.key === key)
      if (!step) {
        step = { key, title: task.subject, status: 'pending', actions: [] }
        quest.steps = [...quest.steps, step]
      }
      step.title = task.subject
      this.setStatus(step, task.status)
    }
    this.planSize()
    this.checkWin()
  }

  /** Task order from the task tool's own links: a task goes before what it blocks and after what blocks it. */
  placeTask(key: string, blocks: string[] = [], blockedBy: string[] = []) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    const at = quest.steps.findIndex(step => step.key === key)
    if (at < 0) return
    const [step] = quest.steps.splice(at, 1)
    if (!step) return
    const where = (ids: string[]) => ids.map(id => quest.steps.findIndex(one => one.key === `t${id}`)).filter(i => i >= 0)
    let to = at
    const blocked = where(blocks)
    const blockers = where(blockedBy)
    if (blocked.length) to = Math.min(to, ...blocked)
    if (blockers.length) to = Math.max(to, Math.max(...blockers) + 1)
    quest.steps.splice(to, 0, step)
  }

  /** The agent handed a decision to the person: show it, tied to the step it was on. */
  askUser(text: string, source: QuestAsk['source'], options?: string[], kind: NonNullable<QuestAsk['kind']> = 'blocking', n?: number) {
    const quest = this.game.quest
    // A quest won just before the agent's closing words (its last step ticked off first) still takes them: what they
    // hand over is left open for the person.
    const closed = !!quest && !!quest.finishedAt
    if (!quest || (closed && quest.outcome !== 'won')) return
    const one = text
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^(?:still )?(?:waiting on you|needs? your call|decisions? (?:for|waiting on) you|for you)\s*[:—–-]\s*/i, '')
      .slice(0, 240)
    if (!one) return
    const asks = quest.asks ?? (quest.asks = [])
    // The same question raised again (mid-turn, then at the turn's end) is one ask; ending the turn on it makes it blocking.
    // Restated in other words ("Cache ownership on the new servers" → "Who owns the caches"), it is the open ask it clearly
    // matches best. Items of the list being read now are never one another's twin.
    const earlier = asks.filter(ask => (ask.status === 'waiting' || ask.status === 'unanswered') && !this.made.has(ask.id))
    const ranked = earlier.map(ask => ({ ask, score: likeness(one, ask.text) })).sort((a, b) => b.score - a.score)
    const best = ranked[0]
    const twin =
      earlier.find(ask => norm(ask.text) === norm(one) || similar(ask.text, one)) ??
      (best && best.score >= 4 && best.score >= (ranked[1]?.score ?? 0) + 2 ? best.ask : undefined)
    if (twin) {
      if (n !== undefined) twin.n = n
      if (!closed && twin.status === 'waiting' && kind === 'blocking' && twin.kind === 'floating') {
        // Raised again it keeps its first wording: a later line may fold several decisions into one sentence.
        twin.kind = 'blocking'
        // A decision raised again on every turn of a goal loop tells the person once, not each time.
        if (!twin.told) this.say(`❗ Now waiting on you: ${one.length > 90 ? `${one.slice(0, 89)}…` : one}`)
        twin.told = true
      }
      return
    }
    if (asks.filter(ask => ask.status === 'waiting' || ask.status === 'unanswered').length >= 8) return
    // The step it came up on: the one in progress, else the one worked on last.
    const live = quest.steps.find(step => step.status === 'in_progress') ?? quest.steps[quest.steps.length - 1]
    this.made.add(`k${this.now}-${asks.length}`)
    asks.push({ id: `k${this.now}-${asks.length}`, at: this.now, text: one, source, ...(options?.length ? { options } : {}), kind, status: closed ? 'unanswered' : 'waiting', ...(closed ? { answeredAt: this.now } : {}), ...(live ? { stepKey: live.key } : {}), ...(kind === 'blocking' ? { told: true } : {}), ...(n !== undefined ? { n } : {}) })
    this.say(`${kind === 'blocking' ? '❗ Needs your call' : '📌 Parked for you'}: ${one.length > 90 ? `${one.slice(0, 89)}…` : one}`)
  }

  /** A new numbered list of decisions: the numbers of the last one no longer apply. */
  renumber() {
    for (const ask of this.game.quest?.asks ?? []) delete ask.n
  }

  /**
   * The agent carried on after handing something over (a goal's check sent it back to work, or a new turn began):
   * a question it only said in words no longer holds it up, so it floats. A question dialog still blocks.
   */
  softenAsks() {
    const quest = this.game.quest
    if (!quest) return
    const held = (quest.asks ?? []).filter(ask => ask.status === 'waiting' && ask.source === 'message' && ask.kind !== 'floating')
    if (held.length === 0) return
    for (const ask of held) ask.kind = 'floating'
    this.say(`📌 Claude kept going: ${held.length} question${held.length === 1 ? '' : 's'} parked for you`)
  }

  /**
   * The person answered. In the dialog: its questions are settled. In the chat: a question of their own ("explain
   * why...") settles nothing; otherwise what Claude stopped on is settled, and a decision it parked while it kept going
   * only when the reply is about it (its words, its label like "D-9") or is a plain yes, no or go-ahead.
   */
  resolveAsks(answer: string, from: 'chat' | 'dialog' = 'chat') {
    const quest = this.game.quest
    if (!quest) return
    const said = answer.replace(/\s+/g, ' ').trim().slice(0, 160) || 'answered'
    const asking = from === 'chat' && (/\?\s*$/.test(said) || /^(?:why|what|how|when|where|which|who|explain|status|can you|could you|is it|are (?:we|you)|did you|does|do you)\b/i.test(said))
    const plain = /^(?:y(?:es|ep|eah)?|no(?:pe)?|ok(?:ay)?|sure|approved?|agreed?|go(?: ahead)?|do it|proceed|fine|default|use the defaults?|sounds good|lgtm)\b/i.test(said)
    // A numbered reply to a numbered list ("1. ... 2. fix it everywhere"): answer n goes to decision n, and an answer
    // that asks back leaves its decision open.
    const open = (quest.asks ?? []).filter(ask => ask.status === 'waiting' && ask.source !== 'dialog')
    const parts = from === 'chat' ? [...answer.matchAll(/^\s*(\d+)[.)]\s+(.+)$/gm)].map(match => ({ n: Number(match[1]), text: (match[2] ?? '').trim() })) : []
    // By the number Claude gave each decision; else, when the counts match, by order.
    const numberedAsks = open.filter(ask => ask.n !== undefined)
    const byNumber = (part: { n: number }, index: number) => (numberedAsks.length ? numberedAsks.find(ask => ask.n === part.n) : parts.length === open.length ? open[index] : undefined)
    if (parts.length >= 2 && parts.some((part, index) => byNumber(part, index))) {
      let settled = 0
      parts.forEach((part, index) => {
        const ask = byNumber(part, index)
        if (!ask || /\?/.test(part.text)) return
        Object.assign(ask, { status: 'answered', answer: part.text.slice(0, 160), answeredAt: this.now })
        settled++
      })
      if (settled) this.say(`🧙 ${settled} ruling${settled === 1 ? '' : 's'} given`)

      return
    }
    const labels = (text: string) => new Set(text.match(/\b[A-Z]{1,6}-?\d+(?:\.\d+)?[a-z]?\b/g) ?? [])
    const mine = labels(said)
    const about = (ask: QuestAsk) => [...labels(ask.text)].some(label => mine.has(label)) || likeness(said, ask.text) >= 3
    const waiting = (quest.asks ?? []).filter(ask => {
      if (ask.status !== 'waiting') return false
      if (from === 'dialog') return ask.source === 'dialog'
      if (asking) return false
      return ask.kind !== 'floating' || plain || about(ask)
    })
    if (waiting.length === 0) return
    for (const ask of waiting) Object.assign(ask, { status: 'answered', answer: said, answeredAt: this.now })
    this.say(`🧙 Ruling given: ${said.length > 70 ? `${said.slice(0, 69)}…` : said}`)
  }

  renameByKey(key: string, title: string) {
    const step = this.game.quest?.steps.find(one => one.key === key)
    if (step && title.trim()) step.title = title.trim()
  }

  addStep(title: string, key?: string) {
    const quest = this.liveQuest('tasks')
    quest.steps = [
      ...quest.steps,
      { key: key ?? `s${this.now}-${quest.steps.length}`, title, status: 'pending', actions: [], src: 'tasks' },
    ]
    this.planSize()
  }

  /** A plan with no goal is as big as the steps it lays out. */
  planSize() {
    const quest = this.game.quest
    if (!isLive(quest) || quest.sources.includes('goal')) return
    this.resize(sizeOfPlan(quest.steps.filter(one => !one.auto).length))
  }

  setStatusAt(index: number, status: StepStatus) {
    const quest = this.game.quest
    if (!isLive(quest) || !quest.steps[index]) return
    this.setStatus(quest.steps[index], status)
    this.checkWin()
  }

  setStatusByKey(key: string, status: StepStatus | 'deleted') {
    const quest = this.game.quest
    if (!isLive(quest)) return
    if (status === 'deleted') {
      quest.steps = quest.steps.filter(step => step.key !== key)
    } else {
      const step = quest.steps.find(one => one.key === key)
      if (step) this.setStatus(step, status)
    }
    this.checkWin()
  }

  /** The goal check judged the goal not met: keep what it said, with the parts it counts as done and as still to do. */
  setCheck(reason: string, parsed: { met: string[]; todo: string[] }) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    const round = (quest.check?.round ?? 0) + 1
    quest.check = { at: this.now, round, reason: reason.slice(0, 1500), met: parsed.met, todo: parsed.todo }
    quest.unchecked = 0
    // Not met yet: the guardian strikes back.
    if (quest.foe && !quest.foe.defeatedAt) quest.foe.act = { anim: 'attack', at: this.now }
    // Tick the finish line: a condition the check names as still to do is open, one it names as met is done.
    const finish = quest.road?.finish ?? []
    for (const item of finish) {
      if (parsed.todo.some(one => alike(one, item.text))) item.status = 'open'
      else if (parsed.met.some(one => alike(one, item.text))) item.status = 'done'
    }
    // A part of the finish line met for the first time pays its share (once: met again later, it does not pay again).
    const size = (quest.size ?? 'trivial') as GoalSize
    for (const item of finish.filter(one => one.status === 'done' && !quest.paid?.parts.includes(one.text))) {
      const xp = this.pay(partXp(size, finish.length))
      quest.paid?.parts.push(item.text)
      if (xp) this.say(`✅ Part met: ${item.text.length > 70 ? `${item.text.slice(0, 69)}…` : item.text} (+${xpText(xp)} XP)`)
    }
    // The d20: higher the more is met, never the 20 that passes it.
    const named = parsed.met.length + parsed.todo.length
    const fraction = finish.length ? finish.filter(one => one.status === 'done').length / finish.length : named ? parsed.met.length / named : 0
    quest.roll = { n: rollFor(fraction, round), at: this.now, round }
    quest.spins = (quest.spins ?? 0) + 1
    // Checks with no work between them repeat each other: one feed line says so instead of one per check.
    if (quest.spins === 3) this.say('🔁 Standoff: Claude has stopped working, but the goal check keeps sending it back')
    else if (quest.spins < 3) this.say(`🎯 Goal check ${round}: ${parsed.todo.length} part${parsed.todo.length === 1 ? '' : 's'} still to do`)
  }

  /** Claude Code ended the goal loop after the check sent Claude back too many times in a row. */
  stall(times: number) {
    const quest = this.game.quest
    if (!isLive(quest) || quest.stalled) return
    quest.stalled = { at: this.now, times }
    quest.roll = { n: 1, at: this.now, round: quest.check?.round ?? 0 }
    this.say(`⛔ Goal loop stopped: sent back ${times} times with no new work. Reply to carry on, or /goal clear`)
  }

  /** Work or a new turn: the goal loop is running again. */
  unstall() {
    const quest = this.game.quest
    if (!quest) return
    quest.spins = 0
    quest.stalled = undefined
  }

  /** The goal check says the goal is still not met after the log called it done: the quest goes on. */
  reopenQuest() {
    const quest = this.game.quest
    if (!quest || quest.outcome !== 'won' || !quest.sources.includes('goal')) return
    quest.finishedAt = undefined
    quest.outcome = undefined
    quest.verdict = undefined
    for (const ask of quest.asks ?? []) if (ask.status === 'unanswered') ask.status = 'waiting'
    this.game.history = this.game.history.filter(one => one.id !== quest.id)
    this.game.stats.questsWon = Math.max(0, this.game.stats.questsWon - 1)
    // Undo what the early win did: the conditions only it ticked, the stage it marked, its natural 20, the XP it paid
    // and the guardian's fall. (Steps it closed stay closed: the work in them was done.)
    const won = quest.won
    let back = 0
    if (won) {
      for (const item of quest.road?.finish ?? []) if (won.open.includes(item.text)) item.status = 'open'
      if (quest.road) quest.road.stageAt = won.stageAt
      quest.roll = won.roll
      back = Math.min(won.xp, this.game.stats.xp)
      this.game.stats.xp -= back
      quest.xpEarned = Math.max(0, quest.xpEarned - back)
      // Only the goal's own share counts toward what it has paid (the bounty is the guardian's).
      if (quest.paid) quest.paid.xp = Math.max(0, quest.paid.xp - (won.paid ?? back))
      quest.won = undefined
    }
    if (quest.foe) {
      quest.foe.defeatedAt = undefined
      quest.foe.favored = undefined
      quest.foe.at = this.now
    }
    this.say(`🔁 The goal is still active — the quest goes on${back ? ` (the early win's ${xpText(back)} XP is taken back)` : ''}`)
  }

  /** The agent wrapped up its turn: whatever planned step it was on is done. */
  finishCurrent() {
    const quest = this.game.quest
    if (!isLive(quest)) return
    for (const step of quest.steps) if (step.status === 'in_progress' && !step.auto) this.setStatus(step, 'completed')
    this.checkWin()
  }

  /** "Advance": finish the step in progress and start the next pending one. */
  advance() {
    const quest = this.game.quest
    if (!isLive(quest)) return
    const at = quest.steps.findIndex(step => step.status === 'in_progress')
    const current = quest.steps[at]
    if (current) this.setStatus(current, 'completed')
    const next = quest.steps.findIndex((step, index) => index > at && step.status === 'pending')
    const upNext = quest.steps[next]
    if (upNext) this.setStatus(upNext, 'in_progress')
    this.checkWin()
  }

  setStatus(step: QuestStep, status: StepStatus) {
    if (step.status === status) return
    const was = step.status
    step.status = status
    if (status === 'in_progress') {
      step.startedAt = step.startedAt ?? this.now
      this.say(`⚔️ Now battling: ${step.title}`)
    }
    if (status === 'completed' && was !== 'completed') this.clearStep(step)
    if (status === 'pending') step.doneAt = undefined
  }

  clearStep(step: QuestStep) {
    step.doneAt = this.now
    step.startedAt = step.startedAt ?? this.now
    const stats = this.game.stats
    const combo = this.game.combo
    combo.count = this.now - combo.lastAt <= COMBO_WINDOW_MS ? combo.count + 1 : 1
    combo.lastAt = this.now
    stats.bestCombo = Math.max(stats.bestCombo, combo.count)
    stats.stepsCleared += 1
    // The hero strikes: one pass of the sword attack.
    this.game.strike = { pose: 'attack', until: this.now + strikeMs('attack') }
    // A plan's own step pays its share of the plan's worth (a goal pays for its parts and milestones instead).
    const quest = this.game.quest
    let xp = 0
    if (quest && !step.auto && !quest.sources.includes('goal') && !quest.paid?.steps.includes(step.key)) {
      const planned = quest.steps.filter(one => !one.auto).length
      xp = this.pay(stepXp((quest.size ?? 'trivial') as GoalSize, planned))
      quest.paid?.steps.push(step.key)
    }
    step.xp = xp
    this.say(`✅ Step cleared: ${step.title}${xp ? ` (+${xpText(xp)} XP)` : ''}`)
  }

  checkWin() {
    const quest = this.game.quest
    if (!isLive(quest) || quest.steps.length === 0) return
    if (quest.steps.some(step => step.auto)) return
    if (!quest.steps.every(step => step.status === 'completed')) return
    this.winQuest()
  }

  winQuest(verdict?: string) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    if (verdict) quest.verdict = verdict.slice(0, 600)
    // What the win changes, kept so a win the goal check later takes back (it says "not met" again) can be undone.
    const won: NonNullable<Quest['won']> = {
      open: (quest.road?.finish ?? []).filter(item => item.status !== 'done').map(item => item.text),
      ...(quest.road?.stageAt !== undefined ? { stageAt: quest.road.stageAt } : {}),
      ...(quest.roll ? { roll: quest.roll } : {}),
      xp: 0,
    }
    const xpBefore = this.game.stats.xp
    const paidBefore = quest.paid?.xp ?? 0
    // The goal check judged the work done: any step the agent never ticked off is cleared with it.
    for (const step of quest.steps) if (step.status !== 'completed') this.setStatus(step, 'completed')
    for (const item of quest.road?.finish ?? []) item.status = 'done'
    if (quest.road?.stages.length) quest.road.stageAt = quest.road.stages.length - 1
    quest.check = undefined
    quest.roll = { n: 20, at: this.now, round: (quest.roll?.round ?? 0) + 1 }
    // The rest of the goal's worth: what its parts, milestones and steps have not paid yet.
    const size = (quest.size ?? 'trivial') as GoalSize
    const bonus = this.pay(Math.max(0, SIZES[size].xp - (quest.paid?.xp ?? 0)))
    // The guardian falls: a bounty for it, more when the hero chose it as a Favored Enemy (Adventure view).
    if (quest.foe && !quest.foe.defeatedAt) {
      const info = foeInfo(quest.foe.id)
      const picks = this.game.stats.picks ?? {}
      const favored = !!info && ['enemy-1', 'enemy-6', 'enemy-14'].some(id => picks[id] === info.kind)
      const prize = bounty(SIZES[size].xp, favored)
      quest.foe.defeatedAt = this.now
      quest.foe.favored = favored
      quest.foe.act = undefined
      this.addXp(prize)
      if (info) this.say(`💀 The ${info.name} is defeated! +${xpText(prize)} XP${favored ? ' (favored enemy)' : ''}`)
    }
    won.xp = this.game.stats.xp - xpBefore
    won.paid = (quest.paid?.xp ?? 0) - paidBefore
    quest.won = won
    this.game.stats.questsWon += 1
    this.say(`🏆 QUEST COMPLETE — natural 20! ${quest.title} (+${xpText(bonus)} XP)`)
    this.endQuest('won')
  }

  /**
   * A commit with no plan in play: the small steps since the last milestone fold into one finished step, named by the
   * commit's message. A long run then reads as what got landed ("TK-62: the request rate limiter"), not as a
   * list of every command, and the actions stay under it.
   */
  milestone(subject: string) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    let from = quest.steps.length
    while (from > 0 && quest.steps[from - 1]?.auto && !quest.steps[from - 1]?.milestone) from--
    const run = quest.steps.slice(from)
    const first = run[0]
    if (!first) return
    // A message of a word or two ("docs", "wip") says little: name it for the biggest piece of work, and keep the message.
    const biggest = [...run].filter(one => !one.actions.every(action => action.commit)).sort((a, b) => (b.n ?? b.actions.length) - (a.n ?? a.actions.length))[0]?.title
    const terse = subject === 'Saved a commit' || subject.trim().split(/\s+/).length < 3
    const named = terse && biggest ? `${biggest}${subject === 'Saved a commit' ? '' : ` (committed: “${subject}”)`}` : subject
    const title = named.length > 100 ? `${named.slice(0, 99)}…` : named
    const actions = run.flatMap(step => step.actions)
    const step: QuestStep = {
      key: first.key,
      title,
      status: 'completed',
      startedAt: first.startedAt ?? this.now,
      doneAt: this.now,
      xp: run.reduce((sum, one) => sum + (one.xp ?? 0), 0),
      auto: true,
      milestone: true,
      n: run.reduce((sum, one) => sum + (one.n ?? one.actions.length), 0),
      actions: actions.slice(-MAX_ACTIONS),
    }
    // The steps folded in were counted as cleared one by one: the milestone counts once.
    const cleared = run.filter(one => one.status === 'completed').length
    this.game.stats.stepsCleared = Math.max(0, this.game.stats.stepsCleared - cleared) + 1
    // The work since the last finished step is done, and landing it pays a milestone's share (up to MILESTONES).
    const live = run.find(one => one.status !== 'completed')
    if (live) {
      this.clearStep(live)
      this.game.stats.stepsCleared -= 1
    }
    quest.paid = quest.paid ?? { xp: 0, parts: [], milestones: 0, steps: [] }
    if (quest.paid.milestones < MILESTONES) {
      quest.paid.milestones += 1
      step.xp = (step.xp ?? 0) + this.pay(milestoneXp((quest.size ?? 'trivial') as GoalSize))
    }
    // The work itself can show a quest is bigger than its brief: many milestones, or a long run.
    const milestones = quest.steps.filter(one => one.milestone).length + 1
    this.resize(grownTo((quest.size ?? 'trivial') as GoalSize, milestones, (this.now - quest.startedAt) / 3_600_000))
    const keys = new Set(run.map(one => one.key))
    for (const ask of quest.asks ?? []) if (ask.stepKey && keys.has(ask.stepKey)) ask.stepKey = step.key
    quest.steps = [...quest.steps.slice(0, from), step]
    this.reach(subject)
    this.game.strike = { pose: 'thrust', until: this.now + strikeMs('thrust') }
    if (quest.foe && !quest.foe.defeatedAt) quest.foe.act = { anim: 'hurt', at: this.now }
    this.say(`🏁 Milestone: ${title.length > 90 ? `${title.slice(0, 89)}…` : title}`)
  }

  /** Work named a stage of the goal (a commit, what Claude says it is on next): the road has reached it. Never goes back. */
  reach(text: string) {
    const road = this.game.quest?.road
    if (!road?.stages.length) return
    const at = stageIn(road.stages, text)
    if (at > (road.stageAt ?? -1)) road.stageAt = at
  }

  /** Claude said what comes next: the latest word on it replaces the last. */
  noteNext(text: string) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    const items = nextSteps(text)
    if (items.length === 0) return
    quest.road = quest.road ?? { finish: [], stages: [] }
    quest.road.next = { at: this.now, items }
    this.reach(items[0] ?? '')
  }

  /** Files one action under the step in progress, or under scouting. */
  logAction(action: QuestAction) {
    const quest = this.game.quest
    if (!isLive(quest)) return
    quest.actionCount += 1
    quest.spins = 0
    quest.stalled = undefined
    // Counted as it happens: old steps keep only their last few actions, so a count taken later would come up short.
    const counts = quest.counts ?? (quest.counts = { edits: 0, reads: 0, searches: 0, failed: 0, helpers: 0 })
    if (/^(Edited|Wrote|Added to)/.test(action.text)) counts.edits += 1
    else if (/^Read\b/.test(action.text)) counts.reads += 1
    else if (/^(Searched|Looked|Found which)/.test(action.text)) counts.searches += 1
    if (!action.ok) counts.failed += 1
    if (action.byHelper) counts.helpers += 1
    this.game.lastAt = this.now
    this.game.lastText = action.text
    let step = quest.steps.find(one => one.status === 'in_progress')
    let buffered = false
    const planned = quest.steps.some(one => !one.auto)
    if (!planned) {
      // No plan: the work itself is the to-do list. Each doing (a command, a write, an edit)
      // is a step; looking around (reads, searches) folds into the step it leads to.
      const heavy = !isLook(action)
      if (!heavy) {
        // Looking around never makes a step: it waits, and goes into the step it leads to.
        quest.lookbuf = [...(quest.lookbuf ?? []), action].slice(-30)
        buffered = true
        step = undefined
      } else {
        // The same thing done again (a rerun, a retry), or more work on the same file, folder or command, belongs
        // to the step it continues, not a new one: a step is a piece of the job, and the actions are what was done for it.
        const sameFamily = !!step && !!action.family && (action.family === step.family || (!!dirOf(action.family) && dirOf(action.family) === dirOf(step.family)))
        const repeat = !!step && (norm(action.text) === norm(step.title) || sameFamily || likeness(action.text, step.title) >= 3)
        if (step && !repeat) {
          this.setStatus(step, 'completed')
          step = undefined
        }
        if (!step) {
          step = {
            key: `a${this.now}-${quest.steps.length}`,
            // A step is named for the main thing done; the "(+2 more)" of a compound command belongs to its action line.
            title: action.text.replace(/ \(\+\d+ more\)$/, ''),
            status: 'in_progress',
            startedAt: this.now,
            auto: true,
            actions: [],
            ...(action.family ? { family: action.family } : {}),
          }
          quest.steps = [...quest.steps, step]
          this.say(`⚔️ Now battling: ${step.title}`)
        }
        // What was read or checked on the way here belongs to this step.
        if (quest.lookbuf?.length) {
          step.actions = [...step.actions, ...quest.lookbuf].slice(-MAX_ACTIONS)
          step.n = (step.n ?? 0) + quest.lookbuf.length
          quest.lookbuf = []
        }
      }
    }
    if (planned) {
      // A plan the agent did not keep up to date: follow the work. The step whose words best match
      // this action takes it; moving on to a later step finishes the one before.
      const open = quest.steps.filter(one => one.status !== 'completed')
      const scored = open.map(one => ({ one, score: likeness(action.text, one.title) }))
      const top = scored.reduce<(typeof scored)[number] | undefined>((best, cur) => (!best || cur.score > best.score ? cur : best), undefined)
      const heavy = !isLook(action)
      const currentScore = step ? likeness(action.text, step.title) : 0
      if (top && top.score >= 2 && top.one !== step && top.score > currentScore) {
        if (step && quest.steps.indexOf(top.one) > quest.steps.indexOf(step)) this.setStatus(step, 'completed')
        if (!step || quest.steps.indexOf(top.one) > quest.steps.indexOf(step)) this.setStatus(top.one, 'in_progress')
        step = top.one
      } else if (!step && heavy) {
        step = open.find(one => one.status === 'pending')
        if (step) this.setStatus(step, 'in_progress')
      }
    }
    if (step && !buffered) {
      step.n = (step.n ?? step.actions.length) + 1
      step.actions = [...step.actions, action].slice(-MAX_ACTIONS)
    } else if (!buffered) {
      quest.scouting = [...quest.scouting, action].slice(-MAX_ACTIONS)
    }
    // Several files in one folder make one step, named for what it was.
    if (step?.auto) {
      const files = new Set(step.actions.map(one => one.family).filter((family): family is string => !!family?.startsWith('file:')))
      const dir = dirOf(step.family)
      if (files.size > 1 && dir !== undefined) step.title = `Edited ${files.size} files in ${dir.split('/').pop() || '.'}/`
    }
    // No plan, and the work was committed: everything since the last commit was one piece of the job.
    if (!planned && action.commit) this.milestone(action.commit)
    // A long chat must not grow without end: steps long finished keep only their last few actions.
    for (const old of quest.steps.filter(one => one.status === 'completed').slice(0, -KEEP_DETAILED)) {
      if (old.actions.length > 6) old.actions = old.actions.slice(-6)
    }

  }
}

const PARKED =
  /(bring(?:ing)?|brought|hand(?:ing)?|defer(?:ring)?|leav(?:e|ing)|kick(?:ing)?|pass(?:ing)?)\b[^.\n]{0,40}\b(?:to|back to|for|with) (?:you|(?:the )?user|your call)|instead of making (?:a|the) (?:call|decision)|\byour call\b|needs? (?:your|a) (?:decision|call|input|answer|ruling|go-?ahead|confirmation)|waiting (?:on|for) (?:you|your)|(?:decision|question|choice) for you|before I (?:proceed|continue|go on|go ahead)/i

const FLOATING =
  /(?:flag(?:ging|ged)?|not(?:e|ing)|surfac(?:e|ing)|rais(?:e|ing))\b[^.\n]{0,40}\bfor (?:you|your (?:review|attention|input|decision))|open question|(?:let me know|tell me|say so) if you(?:'d)? (?:prefer|want|would rather|disagree|object)|worth (?:confirming|checking) with you|you (?:may|might) want to (?:weigh in|decide|confirm|review)|(?:assum(?:ing|ed)|default(?:ing|ed)?|proceed(?:ing)?|going) (?:to|with|on)\b[^.\n]{0,70}\b(?:unless|until) you|(?:pending|awaiting) your (?:call|decision|input|confirmation|review)/i

/** Two questions that are the same ask in other words: most of the shorter one's words are in the other. */
export function similar(a: string, b: string) {
  const [small, large] = [tokens(a), tokens(b)].sort((x, y) => x.size - y.size)
  if (!small || !large || small.size < 3) return false
  let shared = 0
  for (const token of small) if (large.has(token)) shared++

  return shared / small.size >= 0.6
}

/** Text from partway through a turn that parks a decision with the person while the agent carries on: the paragraph that says so. */
export function floatingAsk(text: string): string | null {
  const paragraph = text
    .replace(/[*_`#>]/g, '')
    .split(/\n\s*\n/)
    .map(one => one.trim())
    .find(one => PARKED.test(one) || FLOATING.test(one))

  return paragraph ? paragraph.replace(/\s+/g, ' ').slice(0, 240) : null
}

const LIST_HEADING =
  /(?:decisions?|questions?|asks?|approvals?|items?|things?|blockers?)\b[^\n]{0,40}\b(?:waiting|for you|on you|needed|pending|open|your call|to decide|need you)|(?:waiting on you|needs? (?:your|you)\b|for your (?:decision|input|call|review|approval)|your (?:call|decision) needed)/i
const BULLET = /^\s*(?:[-*•]|\d+[.)])\s+(.*\S)\s*$/

/**
 * A list of decisions under a heading like "Decisions waiting on you": one ask per bullet, with the heading's words
 * left out. An item that says it has a default, or only matters later, is marked `floating`; the rest are `blocking`.
 */
export function parkedList(text: string): { text: string; kind: 'blocking' | 'floating'; n: number }[] {
  // "**1. Who owns the caches.**": a bold number still starts an item.
  const lines = text
    .replace(/[`#>]/g, '')
    .split('\n')
    .map(line => line.replace(/^(\s*)\*\*(\d+[.)]\s)/, '$1$2'))
  const out: { text: string; kind: 'blocking' | 'floating'; n: number }[] = []
  // Each item keeps its number in Claude's list, so a numbered reply ("2. fix it everywhere") finds its decision.
  const item = (one: string) => ({ ...itemOf(one), n: out.length + 1 })
  for (let i = 0; i < lines.length; i++) {
    const heading = (lines[i] ?? '').replace(/^\s*[-*•]\s+/, '').trim()
    if (!heading || heading.length > 90 || BULLET.test(lines[i] ?? '') || !LIST_HEADING.test(heading)) continue
    let j = i + 1
    while (j < lines.length && !(lines[j] ?? '').trim()) j++
    // A numbered list: only numbers start an item, and the dashes under one are its details.
    const numbered = /^\s*\d+[.)]\s/.test(lines[j] ?? '')
    let current = ''
    for (; j < lines.length; j++) {
      const line = lines[j] ?? ''
      const bullet = line.match(BULLET)
      const starts = bullet && (!numbered || /^\s*\d+[.)]\s/.test(line))
      if (starts && bullet) {
        if (current) out.push(item(current))
        current = (bullet[1] ?? '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim()
      } else if (numbered && bullet && current) {
        // Of an item's details, the one that says what to choose is the decision.
        const detail = (bullet[1] ?? '').replace(/\*+/g, '').replace(/\s+/g, ' ').trim()
        if (/^(?:your (?:choice|call|decision)|choose|options?|decide)\b/i.test(detail)) current += ` ${detail}`
      } else if (line.trim() && current && /^\s{2,}\S/.test(line)) {
        current += ` ${line.replace(/\*+/g, '').trim()}`
      } else if (!line.trim() && current) {
        // A blank line inside a list: the next bullet, if any, still belongs to it.
        const next = lines.slice(j + 1).find(one => one.trim())
        if (!next || !BULLET.test(next)) break
      } else {
        break
      }
    }
    if (current) out.push(item(current))
    if (out.length) break
  }

  // "Two process points (not strictly your decisions, but you should know)": told, not asked.
  return out.filter(one => !/\bnot (?:strictly |really |actually )?(?:your )?decisions?\b|\bfor your information\b|\bfyi\b|\bno action needed\b/i.test(one.text)).slice(0, 8)
}

const itemOf = (text: string) => ({
  text: text.slice(0, 240),
  kind: /\b(?:have|has|with|use|using) (?:a )?defaults?\b|\bdefaults? (?:to|is|are)\b|only matters?\b|optional|nice to have|can wait|later|when you (?:get|have) (?:a chance|time)/i.test(text) ? ('floating' as const) : ('blocking' as const),
})

/** The agent's closing words, if they park a decision with the person: the paragraph that says so, else (in a goal) a closing question. */
export function parkedAsk(answer: string, inGoal: boolean): string | null {
  const paragraphs = answer
    .replace(/[*_`#>]/g, '')
    .split(/\n\s*\n/)
    .map(one => one.trim())
    .filter(Boolean)
  const said = paragraphs.find(one => PARKED.test(one))
  const last = paragraphs[paragraphs.length - 1]
  const pick = said ?? (inGoal && last && /\?\s*$/.test(last) ? last : undefined)

  return pick ? pick.replace(/\s+/g, ' ').slice(0, 240) : null
}

/** What the goal check's feedback row says, or null when the row is some other stop hook's (the checker's starts with the goal in brackets). */
export function goalFeedback(text: string, goal?: string): string | null {
  const body = text.replace(/^\s*Stop hook feedback:\s*/, '')
  if (!body.startsWith('[')) return null
  const at = goal && body.includes(`[${goal}]`) ? body.indexOf(`[${goal}]`) + goal.length + 2 : body.indexOf(']: ') + 1

  return at > 0 ? body.slice(at).replace(/^\s*:\s*/, '').trim() : ''
}

const NEG = /^no\b|\bno (?:[\w-]+ ){0,3}(?:was|were|is|are|has|have|had|exists?)\b|\b(?:not|isn't|aren't|wasn't|weren't|hasn't|haven't|never|still|remains?|remained|missing|unmet|uncomputed|unverified|unfinished|incomplete|partly|partially|yet to|no longer|deferred|rather than|left (?:un|out)|only partly)\b/i
const STRONG = /^no\b|\bno (?:[\w-]+ ){0,3}(?:was|were|is|are|has|have|had|exists?)\b|\b(?:not|isn't|aren't|wasn't|weren't|hasn't|haven't|never|still|remains?|missing|unmet|uncomputed|unverified|unfinished|incomplete|yet to)\b/i
const POS = /\b(?:satisfied|met|done|written|committed|implemented|completed|specified|settled|present|filed|deleted|created|passed|verified|reported|handed off|0 problems)\b/i
const clauses = (text: string) => text.split(/,\s+(?![^()]*\))(?:and\s+)?/).map(one => one.replace(/\s+/g, ' ').trim()).filter(Boolean)
const tidy = (text: string, max = 150) => {
  let one = text.replace(/^(?:but|and|also|however|so)\s+/i, '').replace(/[.;:]+$/, '').trim()
  // A quote left open by the sentence split ('...still ahead."') goes; a quote that closes one in the text stays.
  for (const mark of `"'”’`) if (one.endsWith(mark) && one.split(mark).length % 2 === 0) one = one.slice(0, -1).replace(/[.;:]+$/, '').trim()

  return one.charAt(0).toUpperCase() + one.slice(1, max)
}

/** Splits prose into sentences: a stop followed by a space and a capital, quote or bracket (not the dot in "E.9"). */
function sentencesOf(text: string): string[] {
  const out: string[] = []
  let from = 0
  for (let i = 0; i < text.length; i++) {
    if (!'.!?'.includes(text[i] ?? '')) continue
    // A quote or bracket closing right after the stop ends with the sentence ('...still ahead." No tag was made').
    let end = i + 1
    while (end < text.length && `"'”’)`.includes(text[end] ?? '')) end++
    const rest = text.slice(end)
    if (rest === '' || /^\s+[A-Z("'\[]/.test(rest)) {
      out.push(text.slice(from, end))
      from = end
      i = end - 1
    }
  }
  if (from < text.length) out.push(text.slice(from))

  return out.map(one => one.trim()).filter(Boolean)
}

/** The goal check's reasoning as a checklist: what it says is met, and what is still to do. */
export function parseCheck(reason: string): { met: string[]; todo: string[] } {
  const met: string[] = []
  const todo: string[] = []
  for (const sentence of sentencesOf(reason)) {
    // Words about the condition itself ("The condition requires...", "...is therefore not met") are not parts of the work.
    const aboutCondition = /^(?:but |and |so )?(?:the )?(?:stopping )?condition\b/i.test(sentence) && !sentence.includes(':')
    if (sentence.length < 12 || aboutCondition || /^(?:not satisfied|partially met|the user (?:then )?(?:told|instructed|asked|interrupted))/i.test(sentence) || /\btherefore not met\b/i.test(sentence)) continue
    const colon = sentence.indexOf(':')
    const lead = colon > 0 ? sentence.slice(0, colon) : sentence
    const tail = colon > 0 ? sentence.slice(colon + 1) : ''
    const parts = tail ? clauses(tail) : []
    if (NEG.test(lead)) {
      // "...is unmet: A is still running, B is not tagged": each clause that says so is a to-do.
      const open = (tail ? parts : clauses(lead)).filter(part => STRONG.test(part))
      todo.push(...(open.length ? open : [lead]).map(one => tidy(one)))
    } else if (POS.test(lead) && tail) {
      // "Most are satisfied by evidence: the plan was updated, the skill was written": each clause is a part done.
      met.push(...parts.filter(part => !NEG.test(part)).map(one => tidy(one)))
      todo.push(...parts.filter(part => NEG.test(part)).map(one => tidy(one)))
    } else if (POS.test(sentence) && !NEG.test(sentence)) {
      met.push(...clauses(sentence).map(one => tidy(one)))
    } else if (NEG.test(sentence)) {
      todo.push(...clauses(sentence).filter(part => NEG.test(part)).map(one => tidy(one)))
    }
  }
  // Not parts of the work: what the checker read ("the last assistant message states..."), or the goal as a whole
  // restated as unfinished ("Stage C is not complete").
  const filler = (one: string) =>
    /\b(?:last|final|latest) (?:assistant )?message\b|\bthe (?:transcript|hook|assistant)\b/i.test(one) ||
    /^[\w .:/-]{0,40}?\b(?:is|was|remains|are)\s+(?:still\s+)?(?:not\s+(?:yet\s+)?(?:complete|finished|done|met)|incomplete|unfinished)\b[\w ,]{0,24}$/i.test(one)
  const unique = (list: string[]) => list.filter((one, i) => one.length >= 12 && !filler(one) && list.findIndex(other => other === one || similar(other, one)) === i).slice(0, 8)

  return { met: unique(met), todo: unique(todo) }
}

const ARROW = /\s*(?:->|→|=>|⟶)\s*/

/**
 * What a goal says is ahead, before any work: its finish line (the terms after "complete when", or its bullet list)
 * and the stages it names in order ("C1 -> C2 -> C3").
 */
export function goalRoad(goal: string): QuestRoad {
  const text = goal.replace(/␤/g, '\n').replace(/\*\*|__|`/g, '')
  let finish: string[] = []
  const when = text.match(/\b(?:complete|completed|done|finished|met|success(?:ful)?)\s+(?:only\s+)?(?:when|once)\s+([\s\S]+?)(?:\n\s*\n|$)/i)
  if (when?.[1]) {
    const first = sentencesOf(when[1].replace(/\s+/g, ' ').trim())[0] ?? ''
    // "tag X exists: A, B, and C": the lead is a condition too, and so is each clause after the colon. Only a colon
    // after such a verb counts: "the item named next: in the log" is not one.
    let colon = -1
    for (let at = first.indexOf(': '); at >= 0; at = first.indexOf(': ', at + 1)) {
      if (/\b(?:finished|complete|completed|done|met|exists?|holds?|true|landed)\s*$/i.test(first.slice(0, at))) {
        colon = at
        break
      }
    }
    const parts = colon > 0 ? [first.slice(0, colon), ...clauses(first.slice(colon + 2))] : clauses(first)
    // "a HANDOFF is committed with a clean tree, its scope: line naming that rule": a clause that only describes the
    // one before it (its, their, whose, with, which...) belongs to that condition, not a new one.
    finish = parts.reduce<string[]>((out, part) => {
      if (out.length && /^(?:its|their|his|her|whose|with|which|where|that|including|each with)\b/i.test(part.trim())) out[out.length - 1] += `, ${part.trim()}`
      else out.push(part)

      return out
    }, [])
  } else {
    finish = text
      .split('\n')
      .map(line => line.match(BULLET)?.[1] ?? '')
      .filter(Boolean)
  }
  const chain = text.match(/[A-Za-z][\w.]*(?:\s*(?:->|→|=>|⟶)\s*[A-Za-z][\w.]*)+/)?.[0]

  return {
    finish: finish
      .map(one => tidy(one, 300))
      .filter(one => one.length >= 4)
      .slice(0, 12)
      .map(one => ({ text: one, status: 'open' as const })),
    stages: chain ? chain.split(ARROW).filter(Boolean).slice(0, 12) : [],
  }
}

/**
 * What Claude says comes next, in its own words: "Next: A, then B, then C." or a list under a heading like
 * "Next steps" / "Remaining". Empty when it says nothing of the kind.
 */
export function nextSteps(text: string): string[] {
  const lines = text.replace(/[`#>]/g, '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/\*\*|__/g, '').replace(/^\s*[-*•]\s+/, '').trim()
    const head = line.match(/^(?:next(?: steps?| up)?|up next|remaining(?: work| steps)?|still to do|what'?s (?:left|next)|the road ahead)(?:\s*:\s*|\s+(?:is|are)\s+|\s*$)(.*)$/i)
    if (!head) continue
    const rest = (head[1] ?? '').trim()
    if (rest) {
      const sentence = sentencesOf(rest)[0] ?? rest
      const items = sentence
        .split(/,?\s+(?:and )?then\s+|;\s+/i)
        .map(one => tidy(one))
        .filter(one => one.length >= 3)

      return items.slice(0, 8)
    }
    const items: string[] = []
    for (let j = i + 1; j < lines.length; j++) {
      const bullet = (lines[j] ?? '').match(BULLET)
      if (bullet) items.push(tidy((bullet[1] ?? '').replace(/\*\*|__/g, '')))
      else if ((lines[j] ?? '').trim() || items.length) break
    }
    if (items.length) return items.slice(0, 8)
  }

  return []
}

/**
 * The stage a piece of work is in: the stage its words lead with ("C1.3 build step 0" is in stage "C1"). Later stages
 * mentioned in passing further on ("...the co-requisite of C2.1") do not count.
 */
export function stageIn(stages: string[], text: string): number {
  const lead = text.slice(0, 48)
  let at = -1
  let where = Infinity
  stages.forEach((stage, index) => {
    const name = stage.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hit = new RegExp(`(?<![\\w.])${name}(?![0-9A-Za-z])`, 'i').exec(lead)
    if (hit && hit.index < where) {
      where = hit.index
      at = index
    }
  })

  return at
}

/** The same condition in other words: most words shared, or a shared label ("API3", "D-2") and a word more. */
function alike(a: string, b: string) {
  const labels = (text: string) => new Set((text.toLowerCase().match(/[a-z-]*\d[\w.-]*/g) ?? []).map(one => one.replace(/[.-]+$/, '')))
  const mine = labels(a)
  const shared = [...labels(b)].some(label => mine.has(label))

  return similar(a, b) || likeness(a, b) >= 3 || (shared && likeness(a, b) >= 2)
}

/** Pulls the steps out of a plan's markdown: its top-level list, else its headings. */
export function stepsFromPlan(plan: string): { title: string; steps: string[] } {
  const lines = plan.split('\n')
  const heading = lines.find(line => /^#\s+/.test(line))
  const title = heading ? clean(heading.replace(/^#\s+/, '')) : 'The Plan'
  const listed = lines
    .map(line => line.match(/^(?: {0,1})(?:\d+[.)]|[-*])\s+(?:\[[ x]\]\s+)?(.+)$/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map(match => clean(match[1] ?? ''))
  const headed = lines
    .map(line => line.match(/^#{2,3}\s+(.+)$/))
    .filter((match): match is RegExpMatchArray => !!match)
    .map(match => clean(match[1] ?? ''))
    .filter(text => !/^(context|summary|overview|verification|testing|notes?|files?)\b/i.test(text))
  const steps = (listed.length >= 2 ? listed : headed).filter(Boolean).slice(0, 20)

  return { title, steps }
}

const clean = (text: string) =>
  text
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
