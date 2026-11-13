// Quest Log: watches /goal prompts and Claude's plans (TodoWrite, Tasks, plan
// mode, the desktop checklist) and turns them into a live quest in a pane.
// It only reads what passes by: it adds nothing to what the model reads and
// asks no model anything, so it costs no tokens and adds nothing to the context. The
// hearts read the usage limits the engine already reports (session.measure, and the plain
// $.session.usage() with no breakdown, which the API documents as free). Never add a
// $.model call, a prompt, a context row or a "full" usage breakdown. Everything is per
// chat: a new chat starts again at Level 1.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Quest, QuestAction, QuestAsk, QuestGame, QuestLimit, QuestStep, QuestTab, QuestView, StepStatus } from '../types'
import { commitOf, describe, explainBash, familyOf, lookOnly, PLAN_TOOLS } from './describe'
import { dur, endRun, estimate, hintOf, liveRuns, noticeOf, outputsOf, progressOf, RUN_MIN_MS, startRun } from './runs'
import { change, Ctx, emptyGame, featuresAt, floatingAsk, goalFeedback, levelOf, parkedAsk, parkedList, parseCheck, profBonus, stepsFromPlan, unwrap, xpForLevel } from './game'
import { CHOICES, choicesFor, CONCLAVE_LEVELS, CONCLAVES, conclaveOf, pendingChoices } from './ranger'
import { bounty, difficulty, foeInfo, mod } from './foes'
import { ABILITIES, heroSheet } from './hero'
import { milestoneXp, MILESTONES, partXp, PARTS_SHARE, SIZES, stepXp, xpText, type GoalSize } from './sizes'
import { d20Svg, foeMoving, foeView, HERO_COLUMNS, heroRows, poseOf, ROLL_MS, runnerSvg, textTrack, trackSvg } from './sprite'

const PANE = 'quest-log'
const TITLE = 'Quest Log'
const TICK_MS = 160
const PROGRESS_MS = 5000
/** After a compaction, a goal marker this soon is the goal re-announced, not judged. */
const COMPACT_MS = 30_000
const QUIET_MS = 60_000

const gameAtom = atom({ plugin: 'quest-log', key: 'game' } as const, emptyGame())
const viewAtom = atom({ plugin: 'quest-log', key: 'view' } as const, { tab: 'quest', open: [], frame: 0 } as QuestView)

/** Can the agent's words still hand something to the person under this quest? Yes while it runs, and just after a win (no message from the person since). */
const askable = (quest: Quest, game: QuestGame) => !quest.finishedAt || (quest.outcome === 'won' && (game.lastPromptAt ?? 0) < quest.finishedAt)

let warned = false
let lastSecond = 0

/** Opens the pane; where the surface has nowhere to seat one, says so once instead of failing silently. */
async function openPane($: EngineInterface) {
  const opened = await $.ui.open({ id: PANE, title: TITLE }).catch(() => undefined)
  if (opened && opened.isPlaced === false && !warned) {
    warned = true
    $.ui.toast('Quest Log: this view has no side pane to draw in, so progress shows in the status line.')
  }
}

type Loose = { tool: string; agentId?: string; [argument: string]: unknown }

/** Runs a game change, then tells the person about it (toast, status line, notification). */
async function apply($: EngineInterface, fn: (ctx: Ctx) => void) {
  const now = await $.clock.now()
  let events: string[] = []
  const game = await update($, gameAtom, current => {
    const done = change(current, now, fn)
    events = done.events

    return done.game
  })
  for (const text of events.filter(one => !one.startsWith('⚔️')).slice(-3)) $.ui.toast(text)
  $.ui.status(statusLine(game))
  if (events.some(one => one.startsWith('📜'))) void openPane($)
  const won = events.find(one => one.startsWith('🏆 QUEST COMPLETE'))
  if (won) void $.ui.notify(won.replace('🏆 ', ''), { title: 'Quest Log' }).catch(() => undefined)
  const asked = events.find(one => one.startsWith('❗'))
  if (asked) void $.ui.notify(asked.replace('❗ ', ''), { title: 'Quest paused: your call' }).catch(() => undefined)
  const stalled = events.find(one => one.startsWith('⛔'))
  if (stalled) void $.ui.notify(stalled.replace('⛔ ', ''), { title: 'Quest stalled' }).catch(() => undefined)

  return game
}

function statusLine(game: QuestGame): string | undefined {
  const { level } = levelOf(game.stats.xp)
  const quest = game.quest
  if (!quest) return game.stats.xp ? `🛡️ Lv ${level} · ${game.stats.xp} XP` : undefined
  if (quest.finishedAt) return `🏆 Quest complete! · Lv ${level}`
  const open = (quest.asks ?? []).filter(ask => ask.status === 'waiting')
  const blocked = open.filter(ask => ask.kind !== 'floating').length
  const parked = open.length - blocked
  if (blocked) return `❗ Waiting on your call${blocked > 1 ? ` (${blocked})` : ''}${parked ? ` · 📌${parked}` : ''} · Lv ${level}`
  if (!game.busy && stalledNow(quest)) return `${quest.stalled ? '⛔ Goal stalled' : '🔁 Goal standoff'} — reply to carry on, or /goal clear · Lv ${level}${parked ? ` · 📌${parked}` : ''}`
  const done = quest.steps.filter(step => step.status === 'completed').length
  const total = quest.steps.length
  const pips = total ? '▰'.repeat(done) + '▱'.repeat(total - done) : '…'
  const combo = game.combo.count > 1 ? ` · 🔥x${game.combo.count}` : ''
  const session = heartsOf(game.limits?.find(one => one.kind === 'five_hour'))
  const hearts = session ? ` · ❤️${session.full}/${HEARTS}` : ''

  const goalOn = quest.sources.includes('goal') && quest.checked !== false
  const parts = goalParts(quest)
  const progress = parts ? `Goal ${parts.short} · 🏁${parts.milestones}` : `Quest ${done}/${total} ${total <= 12 ? pips : ''}`.trim()

  const going = (game.runs ?? []).filter(run => !run.endedAt && run.kind !== 'foreground').length
  const runs = going ? ` · ⏱️ ${going} running` : ''

  return `${game.busy ? '🏃' : goalOn ? '🎯' : '💤'} ${progress} · Lv ${level}${combo}${parked ? ` · 📌${parked}` : ''}${runs}${hearts}`
}

// A title never starts with markdown marks: pasting a copied report ("# Title") into /goal must not give "# # Title".
const firstLine = (text: string) => (unwrap(text).split('\n').find(line => line.trim())?.trim() ?? '').replace(/^(?:[#>*-]+\s*)+/, '').replace(/^goal:\s*/i, '')

const shortTitle = (text: string) => {
  const one = firstLine(text)

  return one.length > 80 ? `${one.slice(0, 79)}…` : one
}

/** `real`: it came in as the /goal command (or a goal Claude proposed), so Claude Code's goal check is running; pasted text is not. */
async function onGoal($: EngineInterface, args: string, real = true) {
  const now = await $.clock.now()
  const goal = unwrap(args)
  if (!goal) return
  if (/^(clear|stop|cancel|off|reset)$/i.test(goal)) return apply($, ctx => ctx.endQuest('cleared'))
  const { value } = await $.state.get({ plugin: 'quest-log', key: 'game' })
  if (value?.quest && !value.quest.finishedAt && value.quest.goal === goal) return
  await update($, gameAtom, g => ({ ...g, goalSetAt: now }))
  // A goal can arrive mid-quest: it takes over a running plan, or updates the goal it rewords.
  await apply($, ctx => ctx.setGoal(shortTitle(goal), goal, real))
}

/** Reads one finished tool call and moves the game. */
async function track($: EngineInterface, call: Loose, ran: { deny?: string; isError?: boolean; result?: unknown }) {
  if (ran.deny) return
  // After a goal is truly met the agent stops until the person speaks. Work with no message from the person since the
  // win means the win was early (the goal is still running): the quest goes on.
  if (!call.agentId) {
    const { value } = await $.state.get({ plugin: 'quest-log', key: 'game' })
    const won = value?.quest
    if (won?.outcome === 'won' && won.sources.includes('goal') && (value?.lastPromptAt ?? 0) < (won.finishedAt ?? 0)) await apply($, ctx => ctx.reopenQuest())
  }
  const failed = !!ran.isError
  const result = (ran.result ?? {}) as Record<string, any>

  switch (call.tool) {
    case 'TodoWrite': {
      if (failed || !Array.isArray(call.todos)) return
      const todos = call.todos as { content: string; status: StepStatus }[]

      return apply($, ctx => ctx.setSteps('todos', todos.map(t => ({ title: t.content, status: t.status }))))
    }
    case 'TaskCreate': {
      if (failed) return
      const id = result.task?.id ?? result.id
      const subject = String(call.subject ?? 'A new step')

      return apply($, ctx => {
        // No id in the result: number it as the task tool will have (the next one along).
        const next = (ctx.game.quest?.steps ?? []).reduce((top, step) => (/^t\d+$/.test(step.key) ? Math.max(top, Number(step.key.slice(1))) : top), 0) + 1
        ctx.addStep(subject, `t${id ?? next}`)
      })
    }
    case 'TaskUpdate': {
      const status = call.status as StepStatus | 'deleted' | undefined
      const subject = typeof call.subject === 'string' ? call.subject : ''
      const blocks = Array.isArray(call.addBlocks) ? call.addBlocks.map(String) : []
      const blockedBy = Array.isArray(call.addBlockedBy) ? call.addBlockedBy.map(String) : []
      if (failed || (!status && !subject && !blocks.length && !blockedBy.length)) return

      return apply($, ctx => {
        if (subject) ctx.renameByKey(`t${call.taskId}`, subject)
        // A task that must come first (or last) moves above (or below) the tasks it is tied to.
        if (blocks.length || blockedBy.length) ctx.placeTask(`t${call.taskId}`, blocks, blockedBy)
        if (status) ctx.setStatusByKey(`t${call.taskId}`, status)
      })
    }
    case 'TaskList': {
      const tasks = Array.isArray(result.tasks) ? (result.tasks as { id: string; subject: string; status: StepStatus }[]) : []
      if (failed || tasks.length === 0) return

      return apply($, ctx => ctx.syncTasks(tasks.map(task => ({ id: String(task.id), subject: task.subject, status: task.status }))))
    }
    case 'ExitPlanMode': {
      const plan = typeof result.plan === 'string' ? result.plan : ''
      if (failed || !plan) return
      const parsed = stepsFromPlan(plan)

      return apply($, ctx => {
        const quest = ctx.game.quest
        // A plan that arrives mid-quest joins it (above, below or around what is there); only an idle log starts a new one.
        const keep = quest && !quest.finishedAt
        if (!keep) ctx.startQuest(parsed.title, 'plan')
        if (parsed.steps.length) ctx.setSteps('plan', parsed.steps.map(title => ({ title, status: 'pending' })))
      })
    }
    case 'mcp__ccd_turn__wrap_up': {
      if (failed) return

      return apply($, ctx => ctx.finishCurrent())
    }
    case 'ProposeGoal': {
      if (failed || typeof call.condition !== 'string') return

      return onGoal($, call.condition)
    }
    case 'mcp__ccd_turn__update_plan': {
      if (failed) return
      const items = Array.isArray(call.items) ? (call.items as { content: string; status: StepStatus }[]) : null

      return apply($, ctx => {
        if (items) {
          if (call.scope === 'new_task') ctx.startQuest(ctx.game.lastPrompt || 'A new quest', 'checklist')
          ctx.setSteps('checklist', items.map(item => ({ title: item.content, status: item.status })))
        }
        if (call.advance === true) ctx.advance()
        if (Array.isArray(call.done)) for (const n of call.done) ctx.setStatusAt(Number(n) - 1, 'completed')
        if (typeof call.start === 'number') ctx.setStatusAt(call.start - 1, 'in_progress')
      })
    }
  }
  if (PLAN_TOOLS.has(call.tool)) return
  const text = describe(call)
  if (!text) return
  const now = await $.clock.now()
  const commit = call.tool === 'Bash' && !failed && typeof call.command === 'string' ? commitOf(call.command) : undefined
  const action: QuestAction = { at: now, text, ok: !failed, look: lookOnly(call), family: familyOf(call), ...(call.agentId ? { byHelper: true } : {}), ...(commit ? { commit } : {}) }
  // Only a goal or a plan makes a quest: work outside one is not logged.
  const { value } = await $.state.get({ plugin: 'quest-log', key: 'game' })
  if (!value?.quest || value.quest.finishedAt) return
  await apply($, ctx => ctx.logAction(action))
}

/** A run begins: a shell command (foreground or sent to the background) or a helper agent. Returns its id. */
async function runStarts($: EngineInterface, call: Loose) {
  if (call.agentId) return undefined
  const now = await $.clock.now()
  // Claude stops a background run itself.
  const stopped = call.tool === 'TaskStop' || call.tool === 'KillShell' ? String(call.task_id ?? call.shell_id ?? '') : ''
  if (stopped) {
    await update($, gameAtom, g => endRun(g, stopped, now, 'killed'))

    return undefined
  }
  if (call.tool !== 'Bash' && call.tool !== 'Agent') return undefined
  const id = String(call.tool_use_id ?? `run${now}`)
  const command = typeof call.command === 'string' ? call.command : ''
  const said = typeof call.description === 'string' && call.description.trim() ? call.description.trim() : ''
  const plain = call.tool === 'Bash' ? explainBash(command) : `Helper: ${said || 'a task'}`
  const label = (said || plain).replace(/ \(\+\d+ more\)$/, '').slice(0, 90)
  // What Claude said this run would take, in the words that started it.
  await update($, gameAtom, g => {
    const hint = g.pendingHint && now - g.pendingHint.at < 90_000 ? g.pendingHint.ms : undefined

    return startRun({ ...g, pendingHint: undefined }, { id, kind: call.tool === 'Agent' ? 'helper' : 'foreground', label, sig: plain, startedAt: now, ...(hint ? { hint } : {}) })
  })

  return id
}

/** A run's call returned: done, or moved to the background (a background command, an async helper) until its notice. */
async function runSettles($: EngineInterface, call: Loose, id: string, ran: { isError?: boolean; result?: unknown; text?: string }) {
  const now = await $.clock.now()
  const result = (ran.result ?? {}) as { backgroundTaskId?: string; agentId?: string; isAsync?: boolean }
  const away = result.backgroundTaskId ?? (result.isAsync ? result.agentId : undefined)
  if (away && !ran.isError) {
    const files = call.tool === 'Bash' && typeof call.command === 'string' ? outputsOf(call.command, ran.text) : []
    const game = await update($, gameAtom, g => ({ ...g, runs: (g.runs ?? []).map(run => (run.id === id ? { ...run, id: away, kind: call.tool === 'Agent' ? ('helper' as const) : ('background' as const), files } : run)) }))
    $.ui.status(statusLine(game))

    return
  }
  const game = await update($, gameAtom, g => endRun(g, id, now, ran.isError ? 'failed' : 'completed'))
  $.ui.status(statusLine(game))
}

/** A background run's notice (it ended, or failed, or was stopped): the run ends. Stops by tool count too. */
async function noticed($: EngineInterface, text: string) {
  const notice = noticeOf(text)
  if (!notice) return
  const now = await $.clock.now()
  const game = await update($, gameAtom, g => endRun(g, notice.id, now, notice.status))
  $.ui.status(statusLine(game))
}

/**
 * Claude said how long a run takes. Said as it starts one ("the gates take ~6 min"), the next run to start takes it;
 * said of one going on ("about 4 minutes left"), the newest run takes it as its time so far plus that.
 */
function noteHint(game: QuestGame, text: string, now: number) {
  const hint = hintOf(text)
  if (!hint) return
  if (hint.kind === 'total') {
    game.pendingHint = { ms: hint.ms, at: now }

    return
  }
  const run = [...liveRuns(game, now)].reverse().find(one => one.kind !== 'foreground')
  if (run) run.hint = now - run.startedAt + hint.ms
}

/**
 * A compaction restarted the conversation: what came before it no longer says who spoke last, and the goal posts its
 * marker again, which is not a verdict.
 */
async function compacted($: EngineInterface) {
  const now = await $.clock.now()
  await update($, gameAtom, g => ({ ...g, lastRow: 'user' as const, compactedAt: now }))
}

/** The quest as plain text, for pasting somewhere. */
function report(game: QuestGame): string {
  const quest = game.quest ?? undefined
  if (!quest) return 'No quest in play.'
  const lines = [`# ${quest.title}`]
  if (quest.goal && quest.goal !== quest.title) lines.push(`Goal: ${quest.goal}`)
  if (quest.verdict) lines.push(`Result: ${quest.verdict}`)
  const open = (quest.asks ?? []).filter(ask => ask.status === 'waiting')
  if (quest.check) {
    lines.push(`Goal check ${quest.check.round}: not met yet`)
    for (const item of quest.check.todo) lines.push(`  - [ ] ${item}`)
    for (const item of quest.check.met) lines.push(`  - [x] ${item}`)
  }
  for (const ask of open) lines.push(`${ask.kind === 'floating' ? 'Parked for you' : 'Waiting on you'}: ${ask.text}`)
  for (const ask of (quest.asks ?? []).filter(one => one.status === 'unanswered')) lines.push(`Left open for you: ${ask.text}`)
  lines.push('')
  for (const step of quest.steps) {
    lines.push(`- [${step.status === 'completed' ? 'x' : ' '}] ${step.title}`)
    // An unplanned step is named after its first action: don't say it twice, and fold repeats into "(x2)".
    const shown = step.auto && step.actions.length === 1 && step.actions[0]?.text === step.title ? [] : step.actions
    let at = 0
    while (at < shown.length) {
      const action = shown[at] as QuestAction
      let run = 1
      while (shown[at + run] && shown[at + run]?.text === action.text && shown[at + run]?.ok === action.ok) run++
      lines.push(`    - ${action.ok ? '' : '(failed) '}${action.text}${run > 1 ? ` (x${run})` : ''}`)
      at += run
    }
  }

  return lines.join('\n')
}

const tally = (quest: Quest) => {
  if (quest.counts) return quest.counts
  const all = [...quest.scouting, ...(quest.lookbuf ?? []), ...quest.steps.flatMap(step => step.actions)]

  return {
    edits: all.filter(a => /^(Edited|Wrote)/.test(a.text)).length,
    reads: all.filter(a => /^Read\b/.test(a.text)).length,
    searches: all.filter(a => /^(Searched|Looked)/.test(a.text)).length,
    failed: all.filter(a => !a.ok).length,
    helpers: all.filter(a => a.byHelper).length,
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'quest', description: 'Open the Quest Log: progress, XP and what was done for each step' })
    // The usage limits the engine already holds: a plain read, no breakdown, so it costs nothing.
    // A different start time than the one kept means a new chat: begin again at Level 1.
    await $.session
      .usage()
      .then(usage =>
        update($, gameAtom, g => {
          const fresh = g.chatStartedAt !== undefined && g.chatStartedAt !== usage.startedAt

          return { ...(fresh ? emptyGame() : g), chatStartedAt: usage.startedAt, limits: usage.rateLimits }
        }),
      )
      .catch(() => undefined)
    const game = await read($, gameAtom)
    $.ui.status(statusLine(game))
    if (game.quest) void openPane($)

    // The runner's legs: a redraw tick while Claude is working or a banner is up.
    $.clock.every(TICK_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        const g = await read($, gameAtom)
        const moving = g.busy || g.quest?.outcome === 'won' || g.quest?.asks?.some(ask => ask.status === 'waiting') || (g.flash && g.flash.until > now) || (g.strike && g.strike.until > now) || foeMoving(g.quest?.foe, now) || (!!g.quest?.roll && now - g.quest.roll.at < ROLL_MS)
        // A run going on while Claude rests: its clock still counts up, once a second.
        const counting = !moving && liveRuns(g, now).length > 0 && Math.floor(now / 1000) !== lastSecond
        if (counting) lastSecond = Math.floor(now / 1000)
        if (moving || counting) await update($, viewAtom, v => ({ ...v, frame: (v.frame + 1) % 12000 }))
      })().catch(() => undefined)
    })

    // A background run's progress, read from its own output every few seconds (a file read: no tokens).
    $.clock.every(PROGRESS_MS, () => {
      void (async () => {
        const now = await $.clock.now()
        const g = await read($, gameAtom)
        for (const run of liveRuns(g, now).filter(one => one.files?.length)) {
          for (const file of run.files ?? []) {
            const text = await $.fs.read(file).catch(() => '')
            const seen = typeof text === 'string' && text ? progressOf(text) : null
            if (!seen) continue
            await update($, gameAtom, game => ({ ...game, runs: (game.runs ?? []).map(one => (one.id === run.id ? { ...one, progress: { ...seen, at: now } } : one)) }))
            break
          }
        }
      })().catch(() => undefined)
    })

    return next(e)
  })

  // The engine pushes the usage limits after each turn and whenever a window moves a point:
  // the hearts follow them. Observe only.
  on('session.measure', async ($, e, next) => {
    try {
      if (e.changed.includes('rateLimits')) {
        const game = await update($, gameAtom, g => ({ ...g, limits: e.rateLimits }))
        $.ui.status(statusLine(game))
      }
    } catch {
      // As above.
    }

    return next(e)
  })

  on('command.run', { command: 'quest' }, async $ => {
    await openPane($)

    return { text: '' }
  })

  // A typed /goal, or a prompt that starts with /goal (a paste), starts a quest.
  on('prompt.submit', async ($, e, next) => {
    try {
      const typed = unwrap(e.text).match(/^\s*\/goal\b([\s\S]*)$/)
      await noticed($, e.text)
      if (e.command?.name === 'goal') await onGoal($, e.command.args)
      else if (typed && !e.isMeta) await onGoal($, typed[1] ?? '', false)
      // A background job's notice or a helper's report arrives like a prompt, but the person did not send it.
      else if (!e.command && !e.isMeta && e.text.trim() && !/^\s*<(?:task-notification|agent-message)\b/.test(e.text)) {
        // What the person typed, without what the app adds around it (the file open in the editor, reminders).
        const typedText = unwrap(e.text.replace(/<(ide_[a-z_]+|system-reminder)>[\s\S]*?<\/\1>/g, ''))
        const title = shortTitle(typedText || e.text)
        const sent = await $.clock.now()
        await update($, gameAtom, game => ({ ...game, lastPrompt: title, lastPromptAt: sent }))
        // The person may be answering a parked ask: settle what the reply answers. A reply also restarts a stalled goal loop.
        await apply($, ctx => {
          ctx.unstall()
          ctx.resolveAsks(typedText || title)
        })
      }
    } catch {
      // The log never gets in the way of a prompt.
    }

    return next(e)
  })

  on('command.run', { command: 'goal' }, async ($, e, next) => {
    try {
      await onGoal($, e.args)
    } catch {
      // As above.
    }

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // The question dialog blocks until the person answers: show the ask now, settle it when they do.
    const questions = e.tool === 'AskUserQuestion' && !(e as { agentId?: string }).agentId ? ((e as unknown as Loose).questions as { question?: string; options?: { label?: string }[] }[] | undefined) : undefined
    if (Array.isArray(questions) && questions.length) {
      try {
        await apply($, ctx => {
          for (const one of questions) ctx.askUser(String(one.question ?? 'A question for you'), 'dialog', (one.options ?? []).map(option => String(option.label ?? '')).filter(Boolean))
        })
      } catch {
        // As below.
      }
    }
    if (e.tool === 'ProposeGoal') {
      const at = await $.clock.now()
      await update($, gameAtom, g => ({ ...g, goalSetAt: at })).catch(() => undefined)
    }
    const runId = await runStarts($, e as unknown as Loose).catch(() => undefined)
    const ran = await next(e)
    if (runId) await runSettles($, e as unknown as Loose, runId, ran as { isError?: boolean; result?: unknown; text?: string }).catch(() => undefined)
    if (Array.isArray(questions) && questions.length) {
      try {
        const answers = ((ran as { result?: { answers?: Record<string, unknown> } }).result?.answers ?? {}) as Record<string, unknown>
        const said = Object.values(answers).map(String).filter(Boolean).join(' · ')
        await apply($, ctx => ctx.resolveAsks(said || 'answered in the dialog', 'dialog'))
      } catch {
        // As below.
      }
    }
    try {
      await track($, e as unknown as Loose, ran as { deny?: string; isError?: boolean; result?: unknown })
    } catch (error) {
      // Best effort: the tool's result always goes through untouched, but a gap is shown.
      const why = `${e.tool}: ${error instanceof Error ? error.message : String(error)}`.slice(0, 160)
      await update($, gameAtom, game => ({ ...game, problem: why })).catch(() => undefined)
    }

    return ran
  })

  // The runner runs from a turn's start to its end.
  on('turn.start', async ($, e, next) => {
    try {
      if (!(e as { agentId?: string }).agentId) {
        const now = await $.clock.now()
        await update($, gameAtom, g => ({ ...g, busy: true, lastAt: now }))
        // A new turn means the agent is working again: a question it only said in words no longer holds it up.
        const game = await apply($, ctx => ctx.softenAsks())
        $.ui.status(statusLine(game))
      }
    } catch {
      // As above.
    }

    return next(e)
  })

  // The agent's words partway through a turn: a question it parks with the person while it carries on
  // is shown as floating. Observe only: the response passes down untouched.
  on('turn.step', async function* ($, e, next) {
    const response = yield* next(e)
    try {
      const said = typeof response.answer === 'string' ? response.answer : ''
      if (!e.agentId && said) {
        await apply($, ctx => {
          ctx.noteNext(said)
          noteHint(ctx.game, said, ctx.now)
          const quest = ctx.game.quest
          if (!quest || !askable(quest, ctx.game)) return
          // A list of decisions makes one ask per item; else the paragraph that hands the decision over.
          const list = parkedList(said)
          if (list.length) {
            ctx.renumber()
            for (const one of list) ctx.askUser(one.text, 'message', undefined, 'floating', one.n)
          }
          else {
            const text = floatingAsk(said)
            if (text) ctx.askUser(text, 'message', undefined, 'floating')
          }
        })
      }
    } catch {
      // As above.
    }

    return response
  })

  // A turn ended: close the plan-less stretch of work it was, and let the runner rest.
  on('turn.complete', async ($, e, next) => {
    try {
      if (!e.agentId) {
        const endedAt = await $.clock.now()
        await update($, gameAtom, g => ({ ...g, busy: false, lastTurnEnd: { at: endedAt, reason: String(e.reason) } }))
        await apply($, ctx => {
          ctx.endTurn()
          if (e.reason === 'answer') ctx.stopped()
        })
        // A turn that ends by handing a decision to the person parks it in the log until they reply.
        const closing = typeof e.answer === 'string' ? e.answer : ''
        if (closing && e.reason === 'answer') {
          await apply($, ctx => {
            ctx.noteNext(closing)
            noteHint(ctx.game, closing, ctx.now)
            const quest = ctx.game.quest
            if (!quest || !askable(quest, ctx.game)) return
            const list = parkedList(closing)
            if (list.length) {
              ctx.renumber()
              for (const one of list) ctx.askUser(one.text, 'message', undefined, one.kind, one.n)
            }
            else {
              const text = parkedAsk(closing, quest.sources.includes('goal'))
              if (text) ctx.askUser(text, 'message')
            }
          })
        }
      }
    } catch {
      // As above.
    }

    return next(e)
  })

  // The goal check posts a `goal_status` attachment row each time it judges the goal, and the row says nothing
  // of the verdict here (its payload is stored, not shown to hooks), so the verdict is read from what surrounds it,
  // as the transcripts show it: a goal that is NOT met is announced by a "Stop hook feedback" row just before it,
  // a goal that IS met follows the agent's own closing words, and the one posted when a goal is set follows the
  // person's command. Only the second wins the quest; a "not met" after a win reopens it.
  on('session.append', async ($, e, next) => {
    try {
      const m = e.message
      if (!e.agentId && e.door === 'compaction') await compacted($)
      if (!e.agentId) {
        const words = (Array.isArray(m.content) ? m.content : []).map(block => (block as { text?: string }).text ?? '').join(' ')
        if (words.includes('<task-notification>')) await noticed($, words)
        if (m.type === 'assistant') {
          await update($, gameAtom, g => ({ ...g, lastRow: 'assistant' as const }))
        } else if (m.type === 'user') {
          const feedback = !!m.isMeta && /^\s*Stop hook feedback:/.test(words)
          const game = await update($, gameAtom, g => ({ ...g, lastRow: feedback ? ('feedback' as const) : ('user' as const) }))
          // The goal is not met yet, so the agent is sent back to work: if the log had called it done, it was early,
          // and anything it handed over in words no longer holds it up.
          // (Only the goal check's feedback counts: another stop hook's feedback does not start with the goal.)
          const reason = feedback ? goalFeedback(words, game.quest?.goal) : null
          if (reason !== null) {
            await apply($, ctx => {
              if (ctx.game.quest?.outcome === 'won' && ctx.game.quest.sources.includes('goal')) ctx.reopenQuest()
              ctx.softenAsks()
              if (reason) ctx.setCheck(reason, parseCheck(reason))
            })
          }
        } else if (m.type === 'system') {
          // Claude Code's own notice that it ended the goal loop: the check kept sending Claude back with nothing new done.
          const capped = words.match(/blocked the turn from ending (\d+) consecutive times/)
          if (capped) await apply($, ctx => ctx.stall(Number(capped[1])))
          if (m.name === 'compact_boundary') await compacted($)
        } else if (m.type === 'attachment' && m.name === 'goal_status') {
          const now = await $.clock.now()
          const game = await read($, gameAtom)
          // The marker a goal posts when it is set, and again when a compaction restarts the conversation, is no verdict.
          const justSet = now - (game.goalSetAt ?? 0) < 8000 || now - (game.compactedAt ?? 0) < COMPACT_MS
          const verdict = words.match(/"reason":\s*"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\n/g, ' ').replace(/\\(.)/g, '$1')
          if (game.lastRow === 'assistant' && !justSet) {
            await apply($, ctx => {
              if (!ctx.game.quest || ctx.game.quest.finishedAt || ctx.game.quest.actionCount === 0) return
              ctx.endTurn()
              ctx.winQuest(verdict)
            })
          }
          await update($, gameAtom, g => ({ ...g, lastRow: 'user' as const }))
        }
      }
    } catch {
      // As above.
    }

    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button } = table
    // The terminal draws no SVG, whatever its table holds: it gets the emoji runner.
    const Svg = e.surface === 'terminal' ? undefined : (table as unknown as { Svg?: (props: { source: string; alt: string; width?: number }) => any }).Svg
    const game = await read($, gameAtom)
    const view = await read($, viewAtom)
    const now = await $.clock.now()
    const cols = Math.max(24, e.props.bodyColumns)
    // A terminal cannot draw the sprite as a picture everywhere, so it draws it as colour blocks beside the HUD (room
    // permitting). A docked side pane is narrow: trim labels and secondary text so nothing runs past the frame.
    const showArt = e.surface === 'terminal' && cols >= 50
    const room = showArt ? cols - HERO_COLUMNS - 5 : cols - 4
    const narrow = room < 40
    const barWidth = Math.max(8, Math.min(24, room - 16))
    const me = levelOf(game.stats.xp)
    const quest = game.quest
    const done = quest ? quest.steps.filter(step => step.status === 'completed').length : 0
    const total = quest ? quest.steps.length : 0
    // A checked goal with no plan has no list to count off: how far along it is, is what the goal check last said.
    const parts = quest ? goalParts(quest) : undefined
    const fraction = quest?.outcome === 'won' ? 1 : parts ? parts.fraction : total ? done / total : 0
    const isDone = quest?.outcome === 'won'
    const asks = quest?.asks ?? []
    const open = quest && !quest.finishedAt ? asks.filter(ask => ask.status === 'waiting') : []
    // Blocking: the agent stopped and waits. Floating: it kept working with the question parked.
    const waiting = open.filter(ask => ask.kind !== 'floating')
    const floating = open.filter(ask => ask.kind === 'floating')
    const ruled = asks.filter(ask => ask.status === 'answered').slice(-3)
    const unanswered = asks.filter(ask => ask.status === 'unanswered')
    // Each decision sits under the step it came up on (older ones with no step go under the step worked on at the time).
    const asksByStep = new Map<string, QuestAsk[]>()
    for (const ask of asks) {
      const steps = quest?.steps ?? []
      const home =
        steps.find(step => step.key === ask.stepKey) ??
        [...steps].filter(step => (step.startedAt ?? Infinity) <= ask.at).sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0] ??
        steps[steps.length - 1]
      if (home) asksByStep.set(home.key, [...(asksByStep.get(home.key) ?? []), ask])
    }

    const setTab = (tab: QuestTab) => () => update($, viewAtom, v => ({ ...v, tab }))
    const toggle = (key: string) => () =>
      update($, viewAtom, v => ({ ...v, open: v.open.includes(key) ? v.open.filter(k => k !== key) : [...v.open, key] }))

    const limits = game.limits ?? []
    const sessionHearts = heartsOf(limits.find(one => one.kind === 'five_hour'))
    const weekHearts = heartsOf(limits.find(one => one.kind === 'seven_day'))
    const celebrating = !!game.flash && game.flash.until > now
    const strike = game.strike && game.strike.until > now ? game.strike.pose : undefined
    const pose = poseOf({ busy: game.busy, outOfHearts: !!sessionHearts && sessionHearts.full === 0, won: isDone, celebrating, strike, waiting: waiting.length > 0 })
    const heartRow = (label: string, hearts: ReturnType<typeof heartsOf>, resetsAt?: string) =>
      hearts ? (
        <Text>
          {hearts.text} <Text weight="bold">{label}</Text>{' '}
          <Text dimColor size="caption">
            {hearts.left}% left{resetsAt && !narrow ? ` · resets in ${duration(Date.parse(resetsAt) - now)}` : ''}
          </Text>
        </Text>
      ) : null
    const latest = Array.from({ length: me.level }, (_, i) => me.level - i)
      .map(level => ({ level, names: featuresAt(level, game.stats.conclave) }))
      .find(one => one.names.length > 0)
    // The class choices made, and those the hero's level has reached but the person has not made yet.
    const picks = game.stats.picks ?? {}
    const waitingChoices = pendingChoices(me.level, picks)
    const picked = (id: string) => CHOICES.find(one => one.id === id)?.options.find(option => option.id === picks[id])?.name
    const build = [
      picked('style'),
      ['enemy-1', 'enemy-6', 'enemy-14'].map(picked).filter(Boolean).join(', '),
      ['terrain-1', 'terrain-6', 'terrain-10'].map(picked).filter(Boolean).join(', '),
      picked('hunter-3') ?? picked('companion') ?? picked('swarm') ?? picked('essence') ?? picked('glamour'),
    ]
      .filter(Boolean)
      .join(' · ')

    // The hero's character sheet (Adventure): who you are, how far to the next level, how much limit is left (the
    // hearts), and the numbers a 5e sheet carries.
    const sheet = heroSheet(me.level, picks)
    const abilityRow = (scores: number[], key: string) => (
      <Box key={key} flexDirection="row" gap={narrow ? 1 : 2} flexWrap="wrap">
        {ABILITIES.map((name, i) => (
          <Box key={`${key}-${name}`} flexDirection="column" alignItems="center">
            <Text dimColor size="footnote">
              {name}
            </Text>
            <Text weight="bold">{scores[i]}</Text>
            <Text dimColor size="caption">
              {mod(scores[i] ?? 10)}
            </Text>
          </Box>
        ))}
      </Box>
    )
    const heroCard = (
      <Box key="hero" borderStyle="round" borderColor="claude" paddingX={1} flexDirection="column">
      <Box flexDirection="row" gap={1} alignItems="center">
        {!showArt && Svg && <Svg source={runnerSvg(view.frame, pose, 56)} alt="The hero" width={70} />}
        {showArt && (
          <Box flexDirection="column" width={HERO_COLUMNS} flexShrink={0}>
            {heroRows(view.frame, pose).map(row => (
              <Text>
                {row.map(run => (
                  <Text color={run.fg} backgroundColor={run.bg}>
                    {run.text}
                  </Text>
                ))}
              </Text>
            ))}
          </Box>
        )}
        <Box flexDirection="column" flexGrow={1}>
          <Text weight="bold" size="heading" color="claude">
            Lv {me.level} {game.stats.conclave ? `${game.stats.conclave} ` : ''}
            {me.rank}
          </Text>
          <Text dimColor size="caption">
            +{profBonus(me.level)} proficiency{latest && !narrow ? ` · latest: ${clip(latest.names.join(', '), Math.max(12, room - 22))}` : ''}
          </Text>
          {build && (
            <Text size="caption" color="claude">
              🏹 {clip(build, Math.max(20, room - 4))}
            </Text>
          )}
          {waitingChoices.length > 0 && (
            <Button key="hud-choices" plain onPress={setTab('adventure')}>
              <Text color="warning" size="caption">
                🎓 {waitingChoices.length} class choice{waitingChoices.length === 1 ? '' : 's'} waiting: {clip(waitingChoices.map(choice => choice.title).join(', '), Math.max(16, room - 30))} ›
              </Text>
            </Button>
          )}
          <Text>
            <Text color="warning">{bar(me.into / me.span, barWidth)}</Text>{' '}
            <Text dimColor size="caption">
              {me.level >= 20 ? 'max level' : `${me.into}/${me.span} XP`}
            </Text>
          </Text>
          {heartRow('Session', sessionHearts, limits.find(one => one.kind === 'five_hour')?.resetsAt)}
          {heartRow('Week', weekHearts, limits.find(one => one.kind === 'seven_day')?.resetsAt)}
          {!sessionHearts && !weekHearts && (
            <Text dimColor size="caption">
              🤍 Usage hearts appear once Claude reports your limits
            </Text>
          )}
        </Box>
      </Box>
        <Box flexDirection="column" marginTop={1} gap={1}>
          {abilityRow(sheet.scores, 'hero-ab')}
          <Box flexDirection="column">
            <Text size="caption">
              <Text weight="bold">HP</Text> {sheet.hp} · <Text weight="bold">AC</Text> {sheet.ac} · <Text weight="bold">Speed</Text> {sheet.speed} · <Text weight="bold">Prof</Text> +{sheet.prof}
            </Text>
            <Text dimColor size="caption">
              🏹 {sheet.attack}
            </Text>
            <Text dimColor size="caption">
              🛡️ Saves {sheet.saves}
              {narrow ? '' : ` · ✨ Spell slots ${sheet.slots}`}
            </Text>
          </Box>
        </Box>
      </Box>
    )

    const flash = game.flash && game.flash.until > now && (
      <Box key="flash" borderStyle="bold" borderColor="warning" paddingX={1}>
        <Text weight="bold" color="warning">
          ⬆️ {clip(game.flash.text, Math.max(20, cols - 8))}
        </Text>
      </Box>
    )

    // A decision the agent handed to the person: the one thing the quest is waiting on, so it leads.
    const stepTitle = (key?: string) => quest?.steps.find(step => step.key === key)?.title
    const callout =
      waiting.length > 0 ? (
        <Box key="asks" flexDirection="column" borderStyle="bold" borderColor="warning" paddingX={1}>
          <Text weight="bold" color="warning">
            ❗ The quest giver awaits your call
          </Text>
          {waiting.map(ask => (
            <Box key={`ask-${ask.id}`} flexDirection="column" marginTop={1}>
              <Text>{ask.text}</Text>
              {ask.options && ask.options.length > 0 && (
                <Text dimColor size="caption">
                  Choices: {ask.options.join(' · ')}
                </Text>
              )}
              <Text dimColor size="caption">
                ⏳ waiting {duration(now - ask.at)}
                {stepTitle(ask.stepKey) && !narrow ? ` · on "${stepTitle(ask.stepKey)}"` : ''} · reply in the chat
              </Text>
            </Box>
          ))}
        </Box>
      ) : null

    // A floating question: Claude kept going. Softer than the call it is waiting on, but never lost.
    const parkedCard =
      floating.length > 0 ? (
        <Box key="floating" flexDirection="column" borderStyle="round" borderColor="warning" borderDimColor paddingX={1}>
          <Text weight="bold" color="warning">
            📌 Parked for you — Claude kept going
          </Text>
          {floating.map(ask => (
            <Box key={`float-${ask.id}`} flexDirection="column" marginTop={1}>
              <Text>{ask.text}</Text>
              <Text dimColor size="caption">
                raised {duration(now - ask.at)} ago{stepTitle(ask.stepKey) && !narrow ? ` · during "${stepTitle(ask.stepKey)}"` : ''} · reply any time
              </Text>
            </Box>
          ))}
        </Box>
      ) : null

    // The heartbeat: says in words what the hero says in motion.
    const quiet = game.busy ? now - game.lastAt : 0
    // Is Claude Code's own goal check still on this goal? A real /goal stays active until it is met or cleared, so between
    // turns Claude may carry on by itself: "Resting" is only for when it is really waiting for the person.
    const goalActive = !!quest && quest.sources.includes('goal') && quest.checked !== false && !quest.finishedAt
    const sinceTurn = game.lastTurnEnd ? now - game.lastTurnEnd.at : Infinity
    const goalTag = goalActive ? ' · 🎯 goal still active' : ''
    // Runs going on now: a foreground command shows once it has gone on a while; background runs and helpers always.
    const running = liveRuns(game, now).filter(run => run.kind !== 'foreground' || now - run.startedAt >= RUN_MIN_MS)
    const away = running.filter(run => run.kind !== 'foreground')
    const ahead = (run: (typeof running)[number]) => estimate(run, now, game.runTimes?.[run.sig], game.runTimes?.[`kind:${run.kind}`])
    const soonest = away
      .map(run => ahead(run).left)
      .filter((left): left is number => left !== undefined)
      .sort((a, b) => a - b)[0]
    const heartbeat = !quest ? null : waiting.length > 0 ? (
      <Text color="warning">⏸ Paused — waiting for your ruling{goalTag}</Text>
    ) : !game.busy && away.length > 0 && !quest.stalled ? (
      <Text color="claude">
        ⏳ Claude is waiting on {away.length === 1 ? 'a run' : `${away.length} runs`} to finish{soonest !== undefined ? ` (the first ≈ ${dur(soonest)})` : ''} — it picks up when {away.length === 1 ? 'it ends' : 'they end'}
        {goalTag}
      </Text>
    ) : quest.stalled && !game.busy ? (
      <Text color="error">
        ⛔ Goal loop stopped {duration(now - quest.stalled.at)} ago — Claude stopped working and the goal check sent it back {quest.stalled.times} times, so Claude Code ended the turn. The goal is still set: reply to carry on, or type /goal clear.
      </Text>
    ) : goalActive && (quest.spins ?? 0) >= SPINS ? (
      <Text color="warning">
        🔁 Standoff — Claude has stopped working, but the goal check has sent it back {quest.spins} times in a row with nothing new done. Reply to steer it, or type /goal clear.
      </Text>
    ) : goalActive && !game.busy && game.lastTurnEnd?.reason === 'aborted' ? (
      <Text color="warning">⏸ Interrupted — the goal is still active; send a message to resume</Text>
    ) : goalActive && !game.busy && (quest.unchecked ?? 0) >= UNCHECKED ? (
      <Text color="warning">
        ⚠️ Goal set, but Claude Code hasn't checked it at the last {quest.unchecked} stops, so the goal isn't sending Claude back to work. Claude carries on only when a background job finishes or you reply (stopped {duration(sinceTurn)} ago).{floating.length > 0 ? ` · 📌 ${floating.length} parked` : ''}
      </Text>
    ) : goalActive && !game.busy && sinceTurn < 150_000 ? (
      <Text color="claude">🎯 Goal active — the goal check is reviewing ({duration(sinceTurn)}); Claude may carry on by itself{floating.length > 0 ? ` · 📌 ${floating.length} parked` : ''}</Text>
    ) : goalActive && !game.busy && game.lastTurnEnd ? (
      <Text color="warning">🎯 Goal active but idle {duration(sinceTurn)} — Claude is waiting for you{floating.length > 0 ? ` · 📌 ${floating.length} parked` : ''}</Text>
    ) : goalActive && !game.busy ? (
      // No turn has ended since the log began (just set, or a reload mid-turn): nothing to time an idle from.
      <Text color="claude">🎯 Goal active{floating.length > 0 ? ` · 📌 ${floating.length} parked` : ''}</Text>
    ) : game.busy ? (
      quiet > QUIET_MS ? (
        running.some(run => run.kind === 'foreground') ? (
          <Text color="claude">⏳ Running for {duration(quiet)} — Claude waits on the command below</Text>
        ) : (
          <Text color="warning">⏳ Quiet for {duration(quiet)} — Claude may be thinking, or waiting on you.</Text>
        )
      ) : (
        <Text color="success">
          ● Working{game.lastAt ? ` · ${duration(quiet)} ago: ${game.lastText}` : ''}
          {goalTag}
          {floating.length > 0 ? ` · 📌 ${floating.length} parked for you` : ''}
        </Text>
      )
    ) : (
      <Text dimColor>
        {quest.outcome === 'won' ? '🏆 Goal met' : '💤 Resting'} — Claude is waiting for you{game.lastAt ? ` (last action ${clock(game.lastAt)})` : ''}{floating.length > 0 ? ` · 📌 ${floating.length} parked` : ''}
      </Text>
    )

    // What is running now, how long it has gone, and how much is likely left.
    const lastRun = game.lastRun && now - game.lastRun.at < 30_000 ? game.lastRun : undefined
    const runsCard =
      running.length > 0 || lastRun ? (
        <Box key="runs" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          {running.length > 0 && (
            <Text weight="bold">
              ⏱️ Running now <Text dimColor size="caption">{running.length > 1 ? `${running.length} runs` : ''}</Text>
            </Text>
          )}
          {running.map(run => {
            const guess = ahead(run)
            const pct = run.progress?.pct

            return (
              <Box key={`run-${run.id}`} flexDirection="column" marginTop={running.length > 1 ? 1 : 0}>
                <Text>
                  {run.kind === 'helper' ? '🤝' : run.kind === 'background' ? '⏳' : '▶️'} {clip(run.label, Math.max(30, cols * 2 - 10))}
                </Text>
                <Text size="caption">
                  <Text weight="bold">{dur(now - run.startedAt)}</Text> so far
                  {guess.left !== undefined ? (
                    <Text color="claude"> · ≈ {dur(guess.left)} left</Text>
                  ) : guess.overdue ? (
                    <Text color="warning"> · running {guess.how}</Text>
                  ) : null}
                  <Text dimColor>{guess.left !== undefined || !guess.overdue ? ` (${guess.how})` : ''}</Text>
                </Text>
                {pct !== undefined && (
                  <Text size="caption">
                    <Text color="claude">{bar(pct / 100, Math.max(8, Math.min(24, cols - 14)))}</Text> {Math.round(pct)}%
                  </Text>
                )}
                {run.progress?.line && !narrow && (
                  <Text dimColor size="footnote">
                    {clip(run.progress.line, cols - 6)}
                  </Text>
                )}
              </Box>
            )
          })}
          {lastRun && (
            <Text size="caption" color={lastRun.status === 'completed' ? 'success' : 'warning'} dimColor={running.length > 0}>
              {lastRun.status === 'completed' ? '✅' : lastRun.status === 'killed' ? '⏹️' : '❌'} {clip(lastRun.label, Math.max(24, cols - 24))} {lastRun.status === 'completed' ? 'finished' : lastRun.status === 'killed' ? 'was stopped' : 'failed'} after {dur(lastRun.took)}
            </Text>
          )}
        </Box>
      ) : null
    const trackWidth = Math.max(200, Math.min(520, cols * 7))
    // The quest's guardian, waiting at the end of the track.
    const guardian = foeInfo(quest?.foe?.id)
    const track = !quest ? null : Svg ? (
      <Svg source={trackSvg(trackWidth, fraction, view.frame, pose, isDone, 64, foeView(quest.foe, now, 1 - fraction))} alt={`The hero has cleared ${done} of ${total} steps${guardian ? `; ${guardian.name} ${quest.foe?.defeatedAt ? 'defeated' : 'waits ahead'}` : ''}`} width={trackWidth + 8} />
    ) : (
      <Text>{textTrack(Math.min(cols - 2, 40), fraction, pose, view.frame, guardian ? { emoji: guardian.emoji, dead: !!quest.foe?.defeatedAt } : undefined)}</Text>
    )

    // The d20: it rolls while Claude works, lands on the goal check's verdict (higher as more is met), and only a passed
    // goal rolls the 20. A stalled goal loop is a natural 1.
    const goalOn = !!quest && quest.sources.includes('goal') && quest.checked !== false
    const roll = quest?.roll
    const sinceRoll = roll ? now - roll.at : Infinity
    const rolling = !quest?.finishedAt && (!roll || (game.busy && sinceRoll > ROLL_MS))
    const shown = rolling ? undefined : roll?.n
    const rollWords =
      shown === 20
        ? '🎲 Natural 20 — the goal passes!'
        : shown === 1
          ? '🎲 Natural 1 — the goal loop stalled. Reply to roll again.'
          : shown !== undefined
            ? `🎲 Rolled ${shown} ;( — not yet (goal check ${roll?.round}). Keep rolling: only a 20 passes.`
            : roll
              ? `🎲 Rolling… last roll ${roll.n}; the goal check rolls again when Claude stops`
              : '🎲 Rolling… the goal check rolls when Claude stops; a 20 passes the goal'
    const diceRow = (
      <Box key="dice" flexDirection="row" gap={1} alignItems="center">
        {Svg && <Svg source={d20Svg(96, shown, view.frame, sinceRoll)} alt={shown ? `The d20 shows ${shown}` : "The d20 is rolling"} width={96} />}
        <Text size="caption" color={shown === 20 ? 'success' : shown === 1 ? 'error' : shown !== undefined ? 'warning' : 'claude'}>
          {rollWords}
        </Text>
      </Box>
    )
    // The encounter (Adventure): the track with the hero and the quest's guardian, its 5e stat block, and the d20.
    const size = (quest?.size ?? 'trivial') as GoalSize
    const foeDown = !!quest?.foe?.defeatedAt
    const favoredFoe = !!guardian && ['enemy-1', 'enemy-6', 'enemy-14'].some(id => picks[id] === guardian.kind)
    const encounter =
      quest && guardian ? (
        <Box key="encounter" flexDirection="column" borderStyle="round" borderColor={foeDown ? 'success' : 'warning'} paddingX={1}>
          <Text weight="bold">
            ⚔️ Encounter{' '}
            <Text dimColor size="caption">
              · guarding a {SIZES[size].name.toLowerCase()} {quest.sources.includes('goal') ? 'goal' : 'quest'}
            </Text>
          </Text>
          {track}
          <Box flexDirection="column" marginTop={1}>
            <Text weight="bold" color={foeDown ? 'success' : undefined}>
              {foeDown ? '💀' : guardian.emoji} {guardian.name}
              {foeDown ? ' — defeated' : ''}
              {favoredFoe ? <Text color="warning"> ⭐ favored enemy</Text> : null}
            </Text>
            <Text dimColor size="caption">
              {guardian.stats.type}
            </Text>
            <Text size="caption">
              CR {guardian.stats.cr} ({xpText(guardian.stats.xp)} XP) ·{' '}
              <Text color={difficulty(guardian.stats.cr, SIZES[size].level).tone} weight="bold">
                {difficulty(guardian.stats.cr, SIZES[size].level).word}
              </Text>{' '}
              for the Lv {SIZES[size].level} hero this goal makes
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1} gap={1}>
            <Text size="caption">
              <Text weight="bold">AC</Text> {guardian.stats.ac} · <Text weight="bold">HP</Text> {foeDown ? 0 : Math.max(1, Math.round(guardian.stats.hp * (1 - fraction)))}/{guardian.stats.hp}{' '}
              <Text color="error">{bar(foeDown ? 0 : 1 - fraction, Math.max(8, Math.min(16, cols - 30)))}</Text> · {guardian.stats.speed}
            </Text>
            {abilityRow(guardian.stats.abilities, 'foe-ab')}
            <Text dimColor size="caption">
              🗡️ {guardian.stats.action}
            </Text>
          </Box>
          {goalOn && <Box marginTop={1}>{diceRow}</Box>}
          <Text dimColor size="footnote">
            {guardian.stats.as ? `Stats of the ${guardian.stats.as}, ` : 'Stats: '}5e SRD 5.1 (CC BY 4.0). Its HP is the work left; it falls when the goal passes.
          </Text>
        </Box>
      ) : null

    // The spoils (Adventure): what this quest is worth, part by part, and what it has paid.
    const finishLine = quest?.road?.finish ?? []
    const plannedSteps = quest ? quest.steps.filter(one => !one.auto) : []
    const earned = quest?.paid?.xp ?? 0
    const worth = SIZES[size].xp
    const spoils = quest ? (
      <Box key="spoils" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
        <Text weight="bold">
          💰 Spoils{' '}
          <Text dimColor size="caption">
            · {SIZES[size].name} {quest.sources.includes('goal') ? 'goal' : 'quest'} · about Lv {SIZES[size].level} on its own
          </Text>
        </Text>
        <Text>
          <Text color="warning">{bar(earned / worth, barWidth)}</Text> <Text weight="bold">{xpText(earned)}</Text>
          <Text dimColor size="caption"> / {xpText(worth)} XP</Text>
        </Text>
        <Box flexDirection="column" marginTop={1}>
          {quest.sources.includes('goal') &&
            finishLine.map(item => {
              const paid = !!quest.paid?.parts.includes(item.text)

              return (
                <Text size="caption" dimColor={paid}>
                  {paid ? '✅' : '⬜'} {clip(item.text, narrow ? 60 : 110)}{' '}
                  <Text color={paid ? 'success' : 'claude'}>
                    {paid ? '✓' : '+'}
                    {xpText(partXp(size, finishLine.length))}
                  </Text>
                </Text>
              )
            })}
          {quest.sources.includes('goal') ? (
            <Text size="caption">
              🏁 Milestones {quest.paid?.milestones ?? 0}/{MILESTONES} <Text color="claude">+{xpText(milestoneXp(size))} each</Text>
            </Text>
          ) : (
            <Text size="caption">
              ☑️ Steps {quest.paid?.steps.length ?? 0}/{plannedSteps.length} <Text color="claude">+{xpText(stepXp(size, plannedSteps.length))} each</Text>
            </Text>
          )}
          <Text size="caption">
            🎲 The rest at the natural 20 <Text color="claude">+{xpText(Math.max(0, worth - earned))}</Text>
            {guardian ? (
              <Text>
                {' '}· 💀 bounty <Text color="claude">+{xpText(bounty(worth, favoredFoe))}</Text>
                {favoredFoe ? ' (favored)' : ''}
              </Text>
            ) : null}
          </Text>
        </Box>
      </Box>
    ) : null

    // Two views: Quest (the goal, the code, the run) and Adventure (the hero, the fight, the class). An older saved
    // tab opens the view that holds it now.
    const tabNow: 'quest' | 'adventure' = view.tab === 'adventure' || view.tab === 'class' ? 'adventure' : 'quest'
    const tabs = (
      <Box flexDirection="row" gap={1} flexWrap="wrap" alignItems="center">
        <Button key="tab-quest" label={`📜 Quest${waiting.length && tabNow !== 'quest' ? ` ❗${waiting.length}` : ''}`} variant={tabNow === 'quest' ? 'primary' : 'secondary'} onPress={setTab('quest')} />
        <Button key="tab-adventure" label={`🐉 Adventure${waitingChoices.length ? ` ❗${waitingChoices.length}` : ''}`} variant={tabNow === 'adventure' ? 'primary' : 'secondary'} onPress={setTab('adventure')} />
        <Text dimColor size="caption">
          Lv {me.level}
          {quest && !narrow ? ` · ${quest.finishedAt ? (quest.outcome === 'won' ? 'quest won' : 'set aside') : SIZES[size].name.toLowerCase()}` : ''}
        </Text>
      </Box>
    )

    const actionLines = (actions: QuestAction[], key: string) => {
      const shown = actions.slice(-20)

      return (
        <Box key={key} flexDirection="column" marginLeft={3}>
          {actions.length === 0 && <Text dimColor>Nothing done here yet.</Text>}
          {actions.length > shown.length && <Text dimColor>…{actions.length - shown.length} earlier actions</Text>}
          {shown.map(action => (
            <Text size="caption">
              <Text color={action.ok ? 'success' : 'error'}>{action.ok ? '✓' : '✗'}</Text> {action.byHelper ? '🤝 ' : ''}
              {action.text}
              <Text dimColor> · {clock(action.at)}</Text>
            </Text>
          ))}
        </Box>
      )
    }

    // The step in play (or one waiting on you, or one you opened) is a card; the rest are single lines, so a long
    // list stays short: finished steps fade, coming ones wait quietly.
    const stepRow = (step: QuestStep, index: number) => {
      const isOpen = view.open.includes(step.key)
      const live = step.status === 'in_progress'
      const complete = step.status === 'completed'
      const parked = waiting.some(ask => ask.stepKey === step.key)
      const icon = complete ? (step.milestone ? '🏁' : '✅') : parked ? '❗' : live ? (game.busy && Math.floor(view.frame / 3) % 2 ? '⚔️' : '🗡️') : '○'
      const took = step.startedAt ? duration((step.doneAt ?? now) - step.startedAt) : ''
      const count = step.n ?? step.actions.length
      const meta = [`${count} action${count === 1 ? '' : 's'}`, took, parked ? 'waiting on you' : open.some(ask => ask.stepKey === step.key) ? '📌 question parked' : '']
        .filter(Boolean)
        .join(' · ')
      const line = (
        <Button key={`step-${step.key}`} plain onPress={toggle(step.key)}>
          {isOpen ? '▾' : '▸'} {icon} {index + 1}. {step.title} <Text dimColor size="caption">{narrow && !live && !isOpen ? '' : meta}</Text>
        </Button>
      )
      const mine = asksByStep.get(step.key) ?? []
      const askLines =
        mine.length > 0 ? (
          <Box key={`asks-${step.key}`} flexDirection="column" marginLeft={3}>
            {mine.map(ask => (
              <Text size="caption" color={ask.status === 'answered' ? undefined : 'warning'} dimColor={ask.status === 'answered'}>
                {ask.status === 'answered' ? '✅ ruled' : ask.status === 'unanswered' ? '⏳ left open' : ask.kind === 'floating' ? '📌 parked' : '❗ waiting'}: {clip(ask.text, narrow ? 80 : 160)}
                {ask.status === 'answered' && ask.answer ? ` → ${clip(ask.answer, 60)}` : ''}
              </Text>
            ))}
          </Box>
        ) : null
      if (!(live || parked || isOpen || mine.length > 0))
        return (
          <Box key={`row-${step.key}`} flexDirection="column" paddingX={1}>
            {line}
          </Box>
        )

      return (
        <Box key={`row-${step.key}`} flexDirection="column" borderStyle="round" borderColor={parked || mine.some(ask => ask.status !== 'answered') ? 'warning' : complete ? 'success' : live ? 'warning' : 'inactive'} paddingX={1}>
          {line}
          {askLines}
          {isOpen && actionLines(step.actions, `log-${step.key}`)}
        </Box>
      )
    }

    const questTab = () => {
      if (!quest) {
        // The quest just ended (a /goal clear, a new chat topic): what it came to stays in view until the next one.
        const last = game.history[0]

        return (
          <Box flexDirection="column" gap={1}>
            <Text weight="bold">🗺️ No quest in play</Text>
            {last && (
              <Box borderStyle="round" borderColor="inactive" paddingX={1} flexDirection="column">
                <Text weight="bold">
                  {last.outcome === 'won' ? '🏆' : '🏳️'} Last quest: {clip(last.title, narrow ? 60 : 120)}
                </Text>
                <Text dimColor size="caption">
                  {last.outcome === 'won' ? 'Won' : 'Set aside'} at {clock(last.finishedAt)} after {duration(last.finishedAt - last.startedAt)} · {last.cleared}/{last.steps} steps · {last.actions} actions · +{last.xpEarned} XP
                </Text>
                {last.left && (
                  <Text size="caption" color="warning">
                    🎯 The goal check's last word: {clip(last.left, narrow ? 120 : 240)}
                  </Text>
                )}
              </Box>
            )}
            <Text dimColor size="caption">
              Type /goal followed by what you want, or let Claude make a plan. The log fills itself in as Claude works, shows any decision Claude hands to you, and costs no tokens.
            </Text>
          </Box>
        )
      }
      const t = tally(quest)
      const size = (quest.size ?? 'trivial') as GoalSize
      const glance = [
        `${quest.actionCount} action${quest.actionCount === 1 ? '' : 's'}`,
        t.edits ? `${t.edits} edit${t.edits === 1 ? '' : 's'}` : '',
        t.reads ? `${t.reads} read${t.reads === 1 ? '' : 's'}` : '',
        t.searches ? `${t.searches} search${t.searches === 1 ? '' : 'es'}` : '',
        t.failed ? `${t.failed} failed` : '',
        t.helpers ? `${t.helpers} by helpers` : '',
      ]
        .filter(Boolean)
        .join(' · ')
      const scoutKey = `scout-${quest.id}`
      // Claude Code's own judgement of the goal: after each turn a checker says which parts are met and which are
      // not. It reaches the agent as feedback; here it is the goal's checklist, read for free.
      const check = quest.check && !quest.finishedAt ? quest.check : undefined
      const metKey = `check-met-${quest.id}`
      const whyKey = `check-why-${quest.id}`
      const checkCard = check ? (
        <Box key="check" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1}>
          <Text weight="bold">
            🎯 Goal check {check.round} · not met yet{' '}
            <Text dimColor size="caption">
              {clock(check.at)}
            </Text>
          </Text>
          {check.todo.length > 0 && (
            <Text weight="bold" size="caption">
              Still to do
            </Text>
          )}
          {check.todo.map(item => (
            <Text size="caption">⬜ {clip(item, narrow ? 90 : 170)}</Text>
          ))}
          {check.met.length > 0 && (
            <Button key={metKey} plain onPress={toggle(metKey)}>
              {view.open.includes(metKey) ? '▾' : '▸'} ✅ {check.met.length} part{check.met.length === 1 ? '' : 's'} done
            </Button>
          )}
          {view.open.includes(metKey) && check.met.map(item => <Text size="caption" dimColor>✅ {clip(item, narrow ? 90 : 170)}</Text>)}
          <Button key={whyKey} plain onPress={toggle(whyKey)}>
            {view.open.includes(whyKey) ? '▾' : '▸'} What the check said
          </Button>
          {view.open.includes(whyKey) && (
            <Text size="caption" dimColor>
              {check.reason}
            </Text>
          )}
        </Box>
      ) : null
      // What is still ahead, from the goal's own words and from what Claude says comes next: known before the work gets there.
      const road = quest.road
      const roadKey = `road-${quest.id}`
      const finishLeft = road ? road.finish.filter(item => item.status === 'open').length : 0
      const roadCard =
        road && (road.finish.length || road.stages.length || road.next) ? (
          <Box key="road" flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
            <Button key={roadKey} plain onPress={toggle(roadKey)}>
              {view.open.includes(roadKey) ? '▸' : '▾'} 🗺️ Road ahead{' '}
              <Text dimColor size="caption">
                {road.finish.length ? `${road.finish.length - finishLeft}/${road.finish.length} of the finish line` : ''}
              </Text>
            </Button>
            {!view.open.includes(roadKey) && (
              <Box flexDirection="column">
                {road.stages.length > 0 && (
                  <Text size="caption">
                    {road.stages
                      .map((stage, index) => {
                        // Until the work names a stage, it is on the first one.
                        const at = Math.max(0, road.stageAt ?? 0)
                        const mark = quest.outcome === 'won' || index < at ? '✅' : index === at ? '⚔️' : '○'

                        return `${mark} ${stage}`
                      })
                      .join('  →  ')}
                  </Text>
                )}
                {road.next && road.next.items.length > 0 && (
                  <Box flexDirection="column" marginTop={road.stages.length ? 1 : 0}>
                    <Text weight="bold" size="caption">
                      ⏭️ Next, as Claude put it <Text dimColor>({clock(road.next.at)})</Text>
                    </Text>
                    {road.next.items.map((item, index) => (
                      <Text size="caption">
                        {index + 1}. {clip(item, narrow ? 90 : 160)}
                      </Text>
                    ))}
                  </Box>
                )}
                {road.finish.length > 0 && (
                  <Box flexDirection="column" marginTop={road.stages.length || road.next ? 1 : 0}>
                    <Text weight="bold" size="caption">
                      🏁 Finish line, from your goal
                    </Text>
                    {road.finish.map(item => (
                      <Text size="caption" dimColor={item.status === 'done'}>
                        {item.status === 'done' ? '✅' : '⬜'} {clip(item.text, narrow ? 90 : 170)}
                      </Text>
                    ))}
                  </Box>
                )}
              </Box>
            )}
          </Box>
        ) : null
      // A long run: once there are many steps, the old finished ones fold into one line you can open.
      const FOLD_AFTER = 40
      const KEEP_SHOWN = 15
      const older = quest.steps.slice(0, Math.max(0, quest.steps.length - KEEP_SHOWN))
      const foldOpen = view.open.includes(`fold-${quest.id}`)
      const folded = new Set(quest.steps.length > FOLD_AFTER && !foldOpen ? older.filter(step => step.status === 'completed' && !view.open.includes(step.key) && !asksByStep.has(step.key)).map(step => step.key) : [])
      const foldedNote =
        quest.steps.length > FOLD_AFTER && older.some(step => step.status === 'completed') ? (
          <Box key={`row-fold-${quest.id}`} flexDirection="column" paddingX={1}>
            <Button key={`fold-${quest.id}`} plain onPress={toggle(`fold-${quest.id}`)}>
              {foldOpen ? '▾' : '▸'} ✅ {older.filter(step => step.status === 'completed').length} earlier steps cleared <Text dimColor size="caption">{foldOpen ? 'tap to fold' : 'tap to show'}</Text>
            </Button>
          </Box>
        ) : null

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text weight="bold" size="heading">
              📜 {quest.title}
            </Text>
            {quest.sources.includes('goal') && quest.checked !== false && (
              <Text size="caption" color={quest.finishedAt ? 'success' : 'claude'}>
                {quest.finishedAt
                  ? '🏆 Goal met'
                  : `🎯 Goal active${quest.check ? ` · check ${quest.check.round}: not met yet` : ' · not checked yet'}${(quest.unchecked ?? 0) >= UNCHECKED ? ` · no check at the last ${quest.unchecked} stops` : ''}`}
              </Text>
            )}
            {quest.sources.includes('goal') && quest.checked === false && !quest.finishedAt && (
              <Text size="caption" color="warning">
                ⚠️ This goal was pasted as text, so Claude Code isn't checking it and won't send Claude back to work. Type /goal yourself for a checked goal.
              </Text>
            )}
            {quest.goal && quest.goal !== quest.title && (
              <Box flexDirection="column">
                <Button key={`goal-text-${quest.id}`} plain onPress={toggle(`goal-text-${quest.id}`)}>
                  <Text dimColor size="caption">
                    {view.open.includes(`goal-text-${quest.id}`) ? '▾ The goal in full' : '▸ The goal in full'}
                  </Text>
                </Button>
                {view.open.includes(`goal-text-${quest.id}`) && (
                  <Text dimColor size="caption">
                    {quest.goal}
                  </Text>
                )}
              </Box>
            )}
            <Text dimColor size="caption">
              {quest.sources.map(sourceName).join(' + ')} · {clock(quest.startedAt)} · {duration((quest.finishedAt ?? now) - quest.startedAt)}
              {narrow ? '' : ` · ${glance}`}
            </Text>
          </Box>
          {isDone && (
            <Box borderStyle="round" borderColor="success" paddingX={1} flexDirection="column">
              <Text weight="bold" color="success">
                🏆 QUEST COMPLETE! 🏆
              </Text>
              <Text>
                {total} step{total === 1 ? '' : 's'} cleared in {duration((quest.finishedAt ?? now) - quest.startedAt)}.
              </Text>
              {quest.verdict && (
                <Text dimColor size="caption">
                  🧾 {quest.verdict}
                </Text>
              )}
              {unanswered.length > 0 && (
                <Box flexDirection="column" marginTop={1}>
                  <Text weight="bold" size="caption" color="warning">
                    📌 Still open for you
                  </Text>
                  {unanswered.map(ask => (
                    <Text size="caption">• {clip(ask.text, narrow ? 60 : 140)}</Text>
                  ))}
                </Box>
              )}
            </Box>
          )}
          {parts && !isDone ? (
            <Text>
              <Text color="claude">{bar(fraction, barWidth)}</Text>{' '}
              <Text weight="bold">{parts.label}</Text>
              <Text dimColor size="caption">
                {' '}
                · 🏁 {parts.milestones} milestone{parts.milestones === 1 ? '' : 's'} landed
              </Text>
            </Text>
          ) : (
            <Text>
              <Text color={fraction === 1 ? 'success' : 'claude'}>{bar(fraction, barWidth)}</Text>{' '}
              <Text weight="bold">
                {done}/{total} steps
              </Text>
              <Text dimColor size="caption">
                {quest.steps.some(step => step.auto) && !isDone ? ' so far' : ` · ${Math.round(fraction * 100)}%`}
              </Text>
              {game.combo.count > 1 && !quest.finishedAt && <Text color="warning"> 🔥x{game.combo.count}</Text>}
            </Text>
          )}
          {runsCard}
          {parkedCard}
          {!isDone && roadCard}
          {checkCard}
          <Box flexDirection="column" gap={quest.steps.length > 8 ? 0 : 1}>
            {total === 0 && (
              <Text dimColor size="caption">
                No steps yet — they appear as Claude works or makes a plan.
              </Text>
            )}
            {quest.scouting.length + (quest.lookbuf?.length ?? 0) > 0 && (
              <Box key={`row-${scoutKey}`} flexDirection="column" paddingX={1}>
                <Button key={scoutKey} plain onPress={toggle(scoutKey)}>
                  {view.open.includes(scoutKey) ? '▾' : '▸'} 🧭 Prep work <Text dimColor size="caption">{quest.scouting.length + (quest.lookbuf?.length ?? 0)} reads and checks outside a step</Text>
                </Button>
                {view.open.includes(scoutKey) && actionLines([...quest.scouting, ...(quest.lookbuf ?? [])], `log-${scoutKey}`)}
              </Box>
            )}
            {foldedNote}
            {quest.steps.map((step, index) => (folded.has(step.key) ? null : stepRow(step, index)))}
          </Box>
          {ruled.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold" size="caption" dimColor>
                🧙 Rulings
              </Text>
              {ruled.map(ask => (
                <Text size="caption" dimColor>
                  ✅ {clip(ask.text, narrow ? 40 : 70)} → {clip(ask.answer ?? '', 50)}
                </Text>
              ))}
            </Box>
          )}
          <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
            <Button
              key="copy-report"
              label="📋 Copy report"
              onPress={async press => {
                const g = await read($, gameAtom)
                const copied = await $.ui.copy({ text: report(g), surface: press.surface })
                $.ui.toast(copied.isCopied ? 'Quest report copied.' : 'Could not copy the report.')
              }}
            />
            {!narrow && (
              <Text dimColor size="caption">
                Click a step to see what was done for it.
              </Text>
            )}
          </Box>
        </Box>
      )
    }

    // The Ranger: choices to make as the hero levels (conclave, fighting style, favored enemies...), from the 5e class
    // at dnd5e.wikidot.com/ranger. Picking is a click here: it changes only the log, never Claude.
    const classTab = () => {
      const mine = conclaveOf(picks.conclave)
      const applies = choicesFor(picks.conclave)
      const choiceLevels = new Set(applies.map(choice => choice.level))
      // The road from 1 to 20: what is reached, where the choices are, which wait for you.
      const track = Array.from({ length: 20 }, (_, i) => i + 1)
        .map(n => {
          const here = applies.filter(choice => choice.level === n)
          if (!choiceLevels.has(n)) return n <= me.level ? '●' : '○'
          if (n > me.level) return '◇'

          return here.every(choice => picks[choice.id]) ? '◆' : '❗'
        })
        .join(narrow ? '' : ' ')
      const made = applies.filter(choice => picks[choice.id])
      const ahead = applies.filter(choice => choice.level > me.level).slice(0, 3)
      const optionRow = (choiceId: string, option: { id: string; name: string; blurb: string }) => (
        <Box key={`opt-${choiceId}-${option.id}`} flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
          <Button key={`pick-${choiceId}-${option.id}`} label={option.name} variant="secondary" onPress={() => apply($, ctx => ctx.pick(choiceId, option.id))} />
          <Text dimColor size="caption">
            {clip(option.blurb, narrow ? 50 : 90)}
          </Text>
        </Box>
      )
      const browseKey = 'class-browse'
      const tableKey = 'class-table'

      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column" borderStyle="round" borderColor="inactive" paddingX={1}>
            <Text weight="bold">
              🎓 Class & levels <Text dimColor size="caption">{mine ? `· ${mine.name} conclave` : '· conclave at Lv 3'}</Text>
            </Text>
            {build ? <Text size="caption">{build}</Text> : <Text dimColor size="caption">No choices made yet.</Text>}
            <Text>{track}</Text>
            <Text dimColor size="footnote">
              ● reached · ◆ chosen · ❗ choice waiting · ◇ choice ahead · ○ ahead
            </Text>
          </Box>

          {waitingChoices.map((choice, index) => {
            const conclaveCards = choice.id === 'conclave'
            // One choice at a time: the next one is open, the rest wait as one line each until opened.
            const openKey = `choice-${choice.id}`
            if (index > 0 && !view.open.includes(openKey))
              return (
                <Box key={`choice-${choice.id}`} flexDirection="column" paddingX={1}>
                  <Button key={openKey} plain onPress={toggle(openKey)}>
                    <Text color="warning">
                      ▸ ❗ Lv {choice.level} · {choice.title}
                    </Text>
                    <Text dimColor size="caption">
                      {' '}
                      — {choice.why}
                    </Text>
                  </Button>
                </Box>
              )

            return (
              <Box key={`choice-${choice.id}`} flexDirection="column" borderStyle="bold" borderColor="warning" paddingX={1}>
                {index > 0 ? (
                  <Button key={openKey} plain onPress={toggle(openKey)}>
                    <Text weight="bold" color="warning">
                      ▾ ❗ Lv {choice.level} · {choice.title}
                    </Text>
                  </Button>
                ) : (
                  <Text weight="bold" color="warning">
                    ❗ Lv {choice.level} · {choice.title}
                    {waitingChoices.length > 1 ? <Text dimColor size="caption"> · next of {waitingChoices.length}</Text> : null}
                  </Text>
                )}
                <Text dimColor size="caption">
                  {choice.why}
                </Text>
                {conclaveCards
                  ? CONCLAVES.map(one => (
                      <Box key={`conclave-${one.id}`} flexDirection="column" marginTop={1}>
                        <Box flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                          <Button key={`pick-conclave-${one.id}`} label={one.name} variant="secondary" onPress={() => apply($, ctx => ctx.pick('conclave', one.id))} />
                          <Text dimColor size="caption">
                            {one.source}
                          </Text>
                        </Box>
                        <Text size="caption">{one.flavor}</Text>
                        <Text dimColor size="caption">
                          {CONCLAVE_LEVELS.map(level => `${level}: ${(one.features[level] ?? []).map(feature => feature.name).join(', ')}`).join(' · ')}
                        </Text>
                      </Box>
                    ))
                  : choice.options.length > 7
                    ? (
                        // A long list of plain names (enemies, lands): a grid of buttons, no blurbs.
                        <Box key={`grid-${choice.id}`} flexDirection="row" gap={1} flexWrap="wrap" marginTop={1}>
                          {choice.options.map(option => (
                            <Button key={`pick-${choice.id}-${option.id}`} label={option.name} variant="secondary" onPress={() => apply($, ctx => ctx.pick(choice.id, option.id))} />
                          ))}
                        </Box>
                      )
                    : choice.options.map(option => optionRow(choice.id, option))}
              </Box>
            )
          })}

          {mine && (
            <Box flexDirection="column">
              <Text weight="bold">🌿 {mine.name}</Text>
              <Text dimColor size="caption">
                {mine.flavor} {mine.source} · {mine.link}
              </Text>
              {CONCLAVE_LEVELS.map(level => (
                <Text size="caption" dimColor={me.level < level}>
                  {me.level >= level ? '✅' : '🔒'} Lv {level} · {(mine.features[level] ?? []).map(feature => `${feature.name}: ${feature.blurb}`).join(' · ')}
                </Text>
              ))}
            </Box>
          )}

          {made.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold">✅ Your choices</Text>
              {made.map(choice => (
                <Box key={`made-${choice.id}`} flexDirection="row" gap={1} alignItems="center" flexWrap="wrap">
                  <Text size="caption">
                    Lv {choice.level} · {choice.title}: <Text weight="bold">{picked(choice.id)}</Text>
                    {narrow ? '' : <Text dimColor> — {clip(choice.options.find(option => option.id === picks[choice.id])?.blurb ?? '', 60)}</Text>}
                  </Text>
                  <Button key={`undo-${choice.id}`} plain onPress={() => apply($, ctx => ctx.unpick(choice.id))}>
                    <Text dimColor size="caption">
                      ↺ change
                    </Text>
                  </Button>
                </Box>
              ))}
            </Box>
          )}

          {ahead.length > 0 && (
            <Box flexDirection="column">
              <Text weight="bold">🔒 Coming up</Text>
              {ahead.map(choice => (
                <Text size="caption" dimColor>
                  ◇ Lv {choice.level} · {choice.title} — {choice.why} ({xpForLevel(choice.level) - game.stats.xp} XP to go)
                </Text>
              ))}
            </Box>
          )}

          {!picks.conclave && !waitingChoices.some(choice => choice.id === 'conclave') && (
            <Box flexDirection="column">
              <Button key={browseKey} plain onPress={toggle(browseKey)}>
                {view.open.includes(browseKey) ? '▾' : '▸'} 🌿 The 8 conclaves you choose from at Lv 3
              </Button>
              {view.open.includes(browseKey) &&
                CONCLAVES.map(one => (
                  <Text size="caption">
                    <Text weight="bold">{one.name}</Text> <Text dimColor>({one.source})</Text> — {one.flavor}
                  </Text>
                ))}
            </Box>
          )}

          <Box flexDirection="column">
            <Button key={tableKey} plain onPress={toggle(tableKey)}>
              {view.open.includes(tableKey) ? '▾' : '▸'} 📖 The Ranger, level by level
            </Button>
            {view.open.includes(tableKey) &&
              Array.from({ length: 20 }, (_, i) => i + 1)
                .filter(n => featuresAt(n).length > 0)
                .map(n => (
                  <Text dimColor={me.level < n} size="caption">
                    {me.level >= n ? '✅' : '🔒'} Lv {n} · {xpForLevel(n)} XP · +{profBonus(n)} · {featuresAt(n, picks.conclave).join(', ')}
                  </Text>
                ))}
            <Text dimColor size="footnote">
              5e Ranger from dnd5e.wikidot.com/ranger (official rules; optional and Unearthed Arcana left out). XP is a fifth of the book's, and it comes from goals: their parts as the goal check meets them, their milestones, and the rest at the natural 20 (a typical goal is worth Lv 10–13 on its own; a chat with several big goals reaches 20). Choices are per chat and cost no tokens.
            </Text>
          </Box>
        </Box>
      )
    }

    const historyTab = () => (
      <Box flexDirection="column" gap={1}>
        {game.history.length === 0 && (
          <Text dimColor size="caption">
            No finished quests in this chat yet.
          </Text>
        )}
        {game.history.slice(0, 10).map(one => (
          <Box flexDirection="column">
            <Text>
              {one.outcome === 'won' ? '🏆' : '🏳️'} <Text weight="bold">{one.title}</Text>
            </Text>
            <Text dimColor size="caption">
              {one.cleared}/{one.steps} steps · {one.actions} actions · {duration(one.finishedAt - one.startedAt)} · +{one.xpEarned} XP
              {one.size && SIZES[one.size as GoalSize] ? ` · ${SIZES[one.size as GoalSize].name}` : ''}
              {one.foe && foeInfo(one.foe.id) ? ` · ${one.foe.defeated ? '💀' : foeInfo(one.foe.id)?.emoji} ${foeInfo(one.foe.id)?.name}${one.foe.defeated ? ' defeated' : ' still stands'}` : ''}
            </Text>
          </Box>
        ))}
      </Box>
    )

    // Recent events, each in the view it belongs to: the adventure's (levels, monsters, rolls, choices, XP) and the
    // quest's (steps, milestones, checks, runs). Decisions have their own cards and are left out.
    const ADVENTURE = /^(?:⬆️|💀|🎓|🐲|🦎|🐍|🧞|👹|🐉|📈|✅ Part met|🏆)/
    const feed = game.feed.filter(item => !/^(?:📌|❗) /.test(item.text) && ADVENTURE.test(item.text) === (tabNow === 'adventure')).slice(narrow ? -3 : -5)
    const historyKey = 'history'
    const usage = [
      sessionHearts ? `session ${sessionHearts.left}% left` : '',
      weekHearts ? `week ${weekHearts.left}% left` : '',
    ]
      .filter(Boolean)
      .join(' · ')

    const questView = () => (
      <Box flexDirection="column" gap={1}>
        {questTab()}
        {!quest && runsCard}
        {game.history.length > 0 && (
          <Box flexDirection="column">
            <Button key={historyKey} plain onPress={toggle(historyKey)}>
              {view.open.includes(historyKey) ? '▾' : '▸'} 📚 Earlier quests in this chat <Text dimColor size="caption">{game.history.length}</Text>
            </Button>
            {view.open.includes(historyKey) && historyTab()}
          </Box>
        )}
      </Box>
    )

    const adventureView = () => (
      <Box flexDirection="column" gap={1}>
        {flash}
        {heroCard}
        {encounter ?? (
          <Text dimColor size="caption">
            🗺️ No encounter yet: start a goal (or let Claude make a plan) and its guardian walks in.
          </Text>
        )}
        {spoils}
        {classTab()}
      </Box>
    )

    // Top to bottom, most pressing first: the views, then what you must decide, then the view itself.
    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {tabs}
        {callout}
        {heartbeat}
        {tabNow === 'adventure' ? adventureView() : questView()}
        {feed.length > 0 && (
          <Box flexDirection="column">
            {feed.map(item => (
              <Text dimColor size="footnote">
                {clock(item.at)} {tabNow === 'quest' ? plainly(item.text) : item.text}
              </Text>
            ))}
          </Box>
        )}
        {game.problem && <Text color="warning">⚠️ Missed a call — {game.problem}</Text>}
        <Text dimColor size="footnote">
          👀 Watching only · 0 tokens · 0 context{usage ? ` · usage: ${usage}` : ''}
          {narrow ? '' : ` · drawn on ${e.surface} · resets each chat`}
        </Text>
      </Box>
    )
  })
}

const HEARTS = 5

/** How many stops with no goal check after them mean the goal is not being checked. */
const UNCHECKED = 2

/** How many goal checks in a row, with no work between, make a standoff. */
const SPINS = 3

/** The goal loop has stopped: Claude Code said it ended it, or the check sent Claude back again and again with nothing done. */
const stalledNow = (quest: Quest) => !quest.finishedAt && (!!quest.stalled || (quest.spins ?? 0) >= SPINS)

/**
 * A checked /goal with no plan: its progress is the goal check's own list (parts done of parts named), and its steps
 * are the milestones landed. Undefined for a plan, a task list, or a goal pasted as text: those count their steps.
 */
function goalParts(quest: Quest) {
  if (!quest.sources.includes('goal') || quest.checked === false || quest.steps.some(step => !step.auto)) return undefined
  const milestones = quest.steps.filter(step => step.milestone).length
  const check = quest.check
  if (!check) {
    const stops = quest.unchecked ?? 0

    return stops >= UNCHECKED
      ? { fraction: 0, milestones, label: `Not checked at ${stops} stops`, short: `⚠️ unchecked at ${stops} stops` }
      : { fraction: 0, milestones, label: 'Not checked yet', short: 'not checked yet' }
  }
  const named = check.met.length + check.todo.length
  // The check's words did not split into parts: say only what is sure.
  if (check.todo.length === 0) return { fraction: named ? check.met.length / (named + 1) : 0, milestones, label: 'Not met yet', short: 'not met yet' }

  return {
    fraction: check.met.length / named,
    milestones,
    label: `${check.todo.length} part${check.todo.length === 1 ? '' : 's'} still to do${check.met.length ? `, ${check.met.length} done` : ''}`,
    short: `${check.todo.length} to do`,
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** A window's hearts: one per 20% of the limit left, a part-heart counting as a heart. */
function heartsOf(limit?: QuestLimit) {
  if (!limit) return null
  const left = Math.max(0, Math.min(100, Math.round(100 - limit.percentUsed)))
  const full = Math.ceil(left / (100 / HEARTS))

  return { left, full, text: '❤️'.repeat(full) + '🖤'.repeat(HEARTS - full) }
}

const bar = (fraction: number, width: number) => {
  const filled = Math.round(Math.max(0, Math.min(1, fraction)) * width)

  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

const clock = (at: number) => {
  const d = new Date(at)

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** A feed line in the Quest view's words: the work, not the game. */
const plainly = (text: string) =>
  text
    .replace(/^⚔️ Now battling: /, '▶ Started: ')
    .replace(/^✅ Step cleared: (.*?)(?: \(\+[\d,]+ XP\))?$/, '✓ Done: $1')
    .replace(/^🏁 Milestone: /, '🏁 Committed: ')

const sourceName = (source: string) =>
  ({ goal: '/goal', plan: '🗺️ plan mode', checklist: '☑️ task list', todos: '☑️ todos', tasks: '☑️ tasks' })[source] ?? source
