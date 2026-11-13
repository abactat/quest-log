// Runs: the long things Claude starts and waits on — a test or gate run, a build, a bake, a sweep, a helper agent.
// Each is tracked from its start to its end (a foreground command's own return, or the notice a background one
// sends when it ends), and how much is left is estimated from what is known: the run's own progress in its output
// (a percentage, "epoch 3/10"), how long the same run took before in this chat, or what Claude said it would take.
// Pure functions: register.tsx feeds them, the pane shows them.
import type { QuestGame, QuestRun } from '../types'

/** A foreground command shorter than this is not a run worth showing or remembering. */
export const RUN_MIN_MS = 8000
/** A run with no end seen after this long is let go (its notice was missed). */
const STALE_MS = 12 * 60 * 60 * 1000
const KEEP_TIMES = 5

/** The progress a run's output shows, from its last lines: a percentage, or a count of a total. */
export function progressOf(output: string): { pct: number; line: string } | null {
  const tail = output.slice(-6000).replace(/\r/g, '\n')
  const lines = tail.split('\n').map(line => line.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 40); i--) {
    const line = lines[i] ?? ''
    // "of a total": tqdm's "37/120 [", or a named unit: "epoch 3/10", "seed 4 of 8", "test 12/40".
    const counted =
      line.match(/(\d+)\s*\/\s*(\d+)\s*\[/) ??
      line.match(/\b(?:step|epoch|iter(?:ation)?|batch|seed|run|replicate|rep|chunk|file|item|case|sample|test|job|task|shard|fold|trial|gen(?:eration)?)s?\s*[:#]?\s*(\d+)\s*(?:\/|of)\s*(\d+)/i)
    if (counted) {
      const done = Number(counted[1])
      const total = Number(counted[2])
      if (total > 1 && done <= total) return { pct: (100 * done) / total, line: line.slice(0, 120) }
    }
    // A percentage: pytest's "[ 45%]", a progress bar's "45%".
    const pcts = [...line.matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)].map(match => Number(match[1])).filter(pct => pct >= 0 && pct <= 100)
    const pct = pcts[pcts.length - 1]
    if (pct !== undefined) return { pct, line: line.slice(0, 120) }
  }

  return null
}

const UNIT: Record<string, number> = { s: 1000, sec: 1000, second: 1000, m: 60_000, min: 60_000, minute: 60_000, h: 3_600_000, hr: 3_600_000, hour: 3_600_000 }

/**
 * How long Claude says a run will take ("the gate run takes ~6 min", "about 20-30 minutes"), as the middle of its range:
 * `total` for the whole run, `left` when it says how much remains ("about 4 minutes left").
 */
export function hintOf(text: string): { ms: number; kind: 'total' | 'left' } | null {
  if (!/\b(?:run|runs|gates?|tests?|suite|build|bake|sweep|smoke|job|training|harness|benchmark|compile|render|export|sim(?:ulation)?|finish|takes?|wait)\b/i.test(text)) return null
  const said = text.match(/(?:takes?|take|about|around|roughly|approximately|~|≈|estimated?(?: at)?|another|needs?)\s*(\d+(?:\.\d+)?)\s*(?:(?:-|–|to)\s*(\d+(?:\.\d+)?))?\s*(seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)\b/i)
  if (!said) return null
  const low = Number(said[1])
  const high = said[2] ? Number(said[2]) : low
  const unit = (said[3] ?? 'm').toLowerCase().replace(/s$/, '')
  const ms = UNIT[unit] ?? UNIT[unit.slice(0, 1)] ?? 60_000
  const after = text.slice((said.index ?? 0) + said[0].length, (said.index ?? 0) + said[0].length + 24)

  return { ms: Math.round(((low + high) / 2) * ms), kind: /^\s*(?:left|remaining|more|to go)\b/i.test(after) || /\banother\s*$/i.test(text.slice(0, said.index ?? 0).slice(-12)) ? 'left' : 'total' }
}

/** Where a background command's output goes: the path the tool said, and any file the command itself writes to. */
export function outputsOf(command: string, text?: string): string[] {
  const out: string[] = []
  const said = text?.match(/Output is being written to:\s*(\S+?)\.?(?:\s|$)/)?.[1]
  if (said) out.push(said)
  for (const match of command.matchAll(/(?:^|[^<>&\d-])(?:>>?|\btee\s+(?:-a\s+)?)\s*([^\s;&|<>]+)/g)) {
    const path = match[1] ?? ''
    if (path && path !== '/dev/null' && !path.startsWith('&')) out.push(path)
  }

  return [...new Set(out)].slice(0, 3)
}

const median = (list: number[]) => {
  const sorted = [...list].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)

  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
}

export type RunEstimate = { left?: number; how: string; overdue?: boolean }

/** How much of a run is likely left, and from what: its progress, its earlier runs, or Claude's word. */
export function estimate(run: QuestRun, now: number, past: number[] = [], pool: number[] = []): RunEstimate {
  const elapsed = now - run.startedAt
  const pct = run.progress?.pct
  if (pct !== undefined && pct >= 2 && pct < 100) return { left: Math.round((elapsed * (100 - pct)) / pct), how: `${Math.round(pct)}% done` }
  if (past.length) {
    const usual = median(past)
    const left = usual - elapsed

    return left > 0 ? { left, how: `usually ${dur(usual)}, from ${past.length} earlier run${past.length === 1 ? '' : 's'}` } : { how: `longer than usual (${dur(usual)})`, overdue: true }
  }
  if (run.hint) {
    const left = run.hint - elapsed

    return left > 0 ? { left, how: `Claude said ~${dur(run.hint)}` } : { how: `past Claude's ~${dur(run.hint)}`, overdue: true }
  }
  // Nothing on this helper itself: what the helpers in this chat have taken, as a rough guide. (Background commands
  // differ too much from one another for that: a 7-minute sweep is no guide to a 1-minute check.)
  if (run.kind === 'helper' && pool.length >= 2) {
    const usual = median(pool)
    const left = usual - elapsed
    const range = `${dur(Math.min(...pool))}–${dur(Math.max(...pool))}`

    return left > 0 ? { left, how: `helpers here took ${range}` } : { how: `longer than most helpers here (${range})`, overdue: true }
  }

  return { how: 'no estimate yet' }
}

export const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`

  return `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The runs still going, oldest first; a run long past any end is dropped. */
export const liveRuns = (game: QuestGame, now: number) => (game.runs ?? []).filter(run => !run.endedAt && now - run.startedAt < STALE_MS)

/** A run started. */
export function startRun(game: QuestGame, run: QuestRun): QuestGame {
  const runs = [...(game.runs ?? []).filter(one => one.id !== run.id && (!one.endedAt || run.startedAt - one.endedAt < 60_000)), run].slice(-12)

  return { ...game, runs }
}

/** A run ended: it leaves the list, and its time is remembered for the next run like it. */
export function endRun(game: QuestGame, id: string, now: number, status: QuestRun['status'] = 'completed'): QuestGame {
  const run = (game.runs ?? []).find(one => one.id === id && !one.endedAt)
  if (!run) return game
  const took = now - run.startedAt
  const runs = (game.runs ?? []).filter(one => one !== run)
  const shown = run.kind !== 'foreground' || took >= RUN_MIN_MS
  const keep = status === 'completed' && shown
  const pool = `kind:${run.kind}`
  const runTimes = keep
    ? { ...(game.runTimes ?? {}), [run.sig]: [...(game.runTimes?.[run.sig] ?? []), took].slice(-KEEP_TIMES), [pool]: [...(game.runTimes?.[pool] ?? []), took].slice(-KEEP_TIMES * 2) }
    : game.runTimes

  return { ...game, runs, ...(runTimes ? { runTimes } : {}), ...(shown ? { lastRun: { label: run.label, took, status: status ?? 'completed', at: now } } : {}) }
}

/** The task a background notice is about, and how it ended. */
export function noticeOf(text: string): { id: string; status: QuestRun['status'] } | null {
  const id = text.match(/<task-id>([^<]+)<\/task-id>/)?.[1]
  if (!id) return null
  const status = text.match(/<status>([^<]+)<\/status>/)?.[1] ?? 'completed'

  return { id, status: /fail|error/i.test(status) ? 'failed' : /kill|stop|cancel/i.test(status) ? 'killed' : 'completed' }
}
