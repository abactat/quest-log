import { expect, mock, test } from 'claude-code/testing'
import { change, emptyGame, featuresAt, floatingAsk, goalFeedback, goalRoad, levelOf, nextSteps, parkedAsk, parkedList, parseCheck, profBonus, similar, stageIn, unwrap, xpForLevel } from './hooks/game'
import { commitOf, explainBash } from './hooks/describe'
import { bounty, difficulty, foeInfo, FOES, pickFoe } from './hooks/foes'
import { heroSheet } from './hooks/hero'
import { estimate, hintOf, outputsOf, progressOf } from './hooks/runs'
import { grownTo, rollFor, SIZES, sizeOfGoal, sizeOfPlan } from './hooks/sizes'
import { d20Svg, foeMoving, foeView, HERO_COLUMNS, heroRows, poseOf, strikeMs } from './hooks/sprite'

const PANE = {
  plugin: 'quest-log',
  component: 'Pane',
  requestId: 'quest-log',
  props: {
    title: 'Quest Log',
    isFocused: false,
    bodyColumns: 70,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const PLAN = '# Fix the bug\n\n1. Find the cause\n2. Patch it\n3. Add a test'

const boot = async ($: any, on: any) => {
  on('command.register', () => ({ value: { command: 'quest' } }))
  on('ui.open', () => ({ value: { isPlaced: (globalThis as any).placed ?? true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.store(on)
  // A clock that starts at zero would make every finished quest look unfinished (finishedAt 0), which real time never does.
  ;(globalThis as any).clock = mock.clock(on, { now: 1_700_000_000_000 })
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('ui.status', () => ({ value: undefined }))
  on('command.run', () => ({ text: '' }))
  on('ui.toast', (_: any, e: any) => ((globalThis as any).toasts?.push(e.text), { value: undefined }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: (globalThis as any).chatStart ?? 0, context: {}, rateLimits: [] } }))
  on('tool.call', async (_: any, e: any) => ((globalThis as any).toolResult ? (globalThis as any).toolResult : (e.tool === 'AskUserQuestion' && (globalThis as any).gate ? await (globalThis as any).gate : 0, { result: e.tool === 'ExitPlanMode' ? { plan: PLAN, isAgent: false } : e.tool === 'TaskCreate' ? { task: { id: '1', subject: 'One' } } : {} })))
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId ?? 't1' }))
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: e.index, answer: (globalThis as any).stepSays ?? '', toolUses: [], stopReason: 'end_turn', usage: {} } as any
  })
  on('turn.complete', (_: any, e: any) => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
}

test('a /goal quest fills itself in from tool calls', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal ship the login page' })
  await $.tool.call({ tool: 'Read', file_path: '/app/login.tsx' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Build the form', status: 'in_progress', activeForm: 'Building' },
      { content: 'Add tests', status: 'pending', activeForm: 'Testing' },
    ],
  })
  await $.tool.call({ tool: 'Edit', file_path: '/app/login.tsx', old_string: 'a', new_string: 'b' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Build the form', status: 'completed', activeForm: 'Building' },
      { content: 'Add tests', status: 'in_progress', activeForm: 'Testing' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /ship the login page/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1\/2 steps/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✓ Done: Build the form/ })).toBeDefined()
  await ui.press({ key: 'step-' + (await keyOf(ui, 'Build the form')) })
  expect(await ui.find({ type: 'Text', text: /Edited login.tsx/ })).toBeDefined()
  await ui.unmount()
})

test('finishing every step wins the quest', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: 'make it work' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Only step', status: 'completed', activeForm: 'x' }],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE/ })).toBeDefined()
  await ui.unmount()
})

test('a plan from plan mode becomes steps', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: 'fix the bug' })
  await $.tool.call({ tool: 'ExitPlanMode' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Fix the bug/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/3 steps/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Patch it/ })).toBeDefined()
  await ui.unmount()
})

test('the desktop checklist (update_plan) drives progress, advance included', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: 'do the thing' })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'Alpha', status: 'in_progress' },
      { content: 'Beta', status: 'pending' },
    ],
    scope: 'first_task',
  })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1\/2 steps/ })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /QUEST COMPLETE/ })).toBeDefined()
  await ui2.unmount()
})

test('Task tools add, start and finish steps', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: 'tasks please' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'One', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'in_progress' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /0\/1 steps/ })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', status: 'completed' })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /QUEST COMPLETE/ })).toBeDefined()
  await ui2.unmount()
})

test('a goal Claude proposes starts a quest, sized and priced, and there is no Trophies tab', async ($, on) => {
  await boot($, on)
  await $.tool.call({ tool: 'ProposeGoal', condition: 'all tests pass' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'Run tests', status: 'completed', activeForm: 'x' }],
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /all tests pass/ })).toBeDefined()
  await ui.press({ key: 'tab-adventure' })
  expect(await ui.find({ type: 'Text', text: /💰 Spoils · Trivial goal/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\/ 1,300 XP/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', key: 'tab-trophies' })).toBeUndefined()
  expect(await ui.find({ type: 'Button', key: 'tab-adventure' })).toBeDefined()
  await ui.unmount()
})

test('a goal with no plan still gets steps from the work, and wins on the goal notice', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal make hello.py' })
  await $.tool.call({ tool: 'Bash', command: 'mkdir hello-quest', description: 'Create the folder' })
  await $.tool.call({ tool: 'Write', file_path: '/x/hello.py', content: 'print(1)' })
  await $.tool.call({ tool: 'Write', file_path: '/x/test_hello.py', content: 'x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1\/2 steps so far/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Create the folder/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Edited 2 files in x\// })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await said($)
  await check($, 'The test ran and passed.')
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /QUEST COMPLETE/ })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: /The test ran and passed/ })).toBeDefined()
  await ui2.unmount()
})

test('the pane stays closed until a goal or plan starts, and plain work is not logged', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'quest' } }))
  on('ui.open', (_: any, e: any) => {
    opened.push(e.id)

    return { value: { isPlaced: true } }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('tool.call', () => ({ result: {} }))
  mock.store(on)
  mock.clock(on)
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(opened).toEqual([])
  await $.prompt.submit({ text: 'rename the variable' })
  await $.tool.call({ tool: 'Edit', file_path: '/a/b.ts', old_string: 'a', new_string: 'b' })
  expect(opened).toEqual([])
  await $.prompt.submit({ text: '/goal tidy up' })
  expect(opened).toEqual(['quest-log'])
})

test('the terminal draws the hero as colour pixel art plus the emoji track, never an image', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal x' })
  await $.tool.call({ tool: 'Bash', command: 'ls', description: 'List files' })
  const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 70 }, surface: 'terminal' })
  await ui.press({ key: 'tab-adventure' })
  expect(await ui.find({ type: 'Text', text: /[▀▄]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /🧝/ })).toBeDefined()
  expect(await ui.find({ type: 'Image' })).toBeUndefined()
  await ui.unmount()
  // Too narrow for the art beside the HUD: the emoji track alone, still no image.
  const narrow = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns: 36 }, surface: 'terminal' })
  expect(await narrow.find({ type: 'Text', text: /[▀▄]/ })).toBeUndefined()
  expect(await narrow.find({ type: 'Text', text: /🧝/ })).toBeDefined()
  await narrow.unmount()
})

test('the footer names the view that drew the pane, on every surface', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal x' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: new RegExp(`drawn on ${surface}`) })).toBeDefined()
    await ui.unmount()
  }
})

test('the pixel hero has a frame for every pose', () => {
  for (const pose of ['run', 'idle', 'attack', 'thrust', 'slash', 'guard', 'rest'] as const) {
    for (let frame = 0; frame < 12; frame++) {
      const rows = heroRows(frame, pose)
      expect(rows.length).toBe(10)
      expect(rows.every(row => row.reduce((sum, run) => sum + run.text.length, 0) === HERO_COLUMNS)).toBe(true)
    }
  }
})

test('the runner runs while a turn runs and rests after, on every surface', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal x' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Working|Resting/ })).toBeDefined()
    await ui.press({ key: 'tab-adventure' })
    if (surface !== 'terminal') expect(await ui.find({ type: 'Svg' })).toBeDefined()
    await ui.press({ key: 'tab-quest' })
    await ui.unmount()
  }
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Resting/ })).toBeDefined()
  await ui.unmount()
})

test('it costs no tokens: no model calls, results and prompts pass through untouched', async ($, on) => {
  let modelCalls = 0
  on('model.complete', () => {
    modelCalls++

    return { isAnswered: true, text: '', usage: {} } as any
  })
  await boot($, on)
  const submitted = await $.prompt.submit({ text: 'hello there' })
  expect(submitted).toEqual({ text: 'hello there' })
  const measured = await $.session.measure({ context: { percent: 5 } as any, rateLimits: [{ kind: 'five_hour', percentUsed: 10 }], changed: ['rateLimits'] })
  expect(measured).toEqual({ changed: ['rateLimits'] })
  const ran = await $.tool.call({ tool: 'Read', file_path: '/a/b.txt' })
  expect(ran).toEqual({ result: {} })
  const ack = await $.command.run({ command: 'quest', args: '' })
  expect(ack.text ?? '').toBe('')
  expect(ack.context).toBeUndefined()
  expect(modelCalls).toBe(0)
})

test('a plan the agent never updates still follows the work, and a goal win clears the rest', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal build mini-calc' })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'Create calc.py', status: 'in_progress', activeForm: 'x' },
      { content: 'Write test_calc.py and README.md', status: 'pending', activeForm: 'x' },
      { content: 'Run tests and fix failures', status: 'pending', activeForm: 'x' },
      { content: 'Run demo and confirm', status: 'pending', activeForm: 'x' },
    ],
  })
  await $.tool.call({ tool: 'Write', file_path: '/m/calc.py', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/m/test_calc.py', content: 'x' })
  await $.tool.call({ tool: 'Write', file_path: '/m/README.md', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'pytest', description: 'Run the tests' })
  await $.tool.call({ tool: 'Bash', command: 'python demo.py', description: 'Run the demo' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /3\/4 steps/ })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await said($)
  await check($, 'All ran.')
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /4 steps cleared/ })).toBeDefined()
  expect(await ui2.find({ type: 'Text', text: /4\/4 steps/ })).toBeDefined()
  await ui2.unmount()
})

test('the list follows the agent as it adds, renames, drops and reorders steps', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: 'tasks please' })
  await $.tool.call({ tool: 'TaskCreate', subject: 'One', description: 'd' })
  await $.tool.call({ tool: 'TaskUpdate', taskId: '1', subject: 'Uno renamed' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Alpha step', status: 'in_progress', activeForm: 'x' }, { content: 'Beta step', status: 'pending', activeForm: 'x' }] })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Beta step', status: 'pending', activeForm: 'x' }, { content: 'Alpha step edited', status: 'in_progress', activeForm: 'x' }, { content: 'Gamma step', status: 'pending', activeForm: 'x' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /0\/4 steps/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Uno renamed/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Alpha step edited/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Gamma step/ })).toBeDefined()
  await ui.unmount()
})

test('hearts are the remaining usage limit, read from the engine, on every surface', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal x' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Do it', status: 'in_progress', activeForm: 'x' }] })
  await $.session.measure({
    context: { percent: 10 } as any,
    rateLimits: [
      { kind: 'five_hour', percentUsed: 35, resetsAt: new Date(Date.now() + 3_600_000).toISOString() },
      { kind: 'seven_day', percentUsed: 82 },
    ],
    changed: ['rateLimits'],
  })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The Quest view's footer says it plainly; the Adventure view draws the hearts.
    expect(await ui.find({ type: 'Text', text: /usage: session 65% left · week 18% left/ })).toBeDefined()
    await ui.press({ key: 'tab-adventure' })
    expect(await ui.find({ type: 'Text', text: /Session/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /65% left/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /18% left/ })).toBeDefined()
    // The level table lives in the Class tab, folded.
    await ui.press({ key: 'tab-adventure' })
    // Opened on one surface, it stays open on the next.
    if (!(await ui.find({ type: 'Text', text: /Lv 2 · 60 XP/ }))) await ui.press({ key: 'class-table' })
    expect(await ui.find({ type: 'Text', text: /Lv 2 · 60 XP/ })).toBeDefined()
    await ui.press({ key: 'tab-quest' })
    await ui.unmount()
  }
})

test('with no limit reading the pane says so, and an empty session window knocks the hero out', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-adventure' })
  expect(await ui.find({ type: 'Text', text: /Usage hearts appear/ })).toBeDefined()
  await ui.unmount()
  await $.session.measure({ context: { percent: 1 } as any, rateLimits: [{ kind: 'five_hour', percentUsed: 100 }], changed: ['rateLimits'] })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /0% left/ })).toBeDefined()
  await ui2.unmount()
})

test('a pasted /goal is read through its wrapper tags, and wrap-up finishes the step in progress', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '<\\pasted_content id="1">\n/goal tidy the repo\n</pasted_content id="1">' })
  await $.tool.call({
    tool: 'mcp__ccd_turn__update_plan',
    items: [
      { content: 'First', status: 'completed' },
      { content: 'Last', status: 'in_progress' },
    ],
    scope: 'first_task',
  })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /tidy the repo/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pasted_content/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /1\/2 steps/ })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /QUEST COMPLETE/ })).toBeDefined()
  await ui2.unmount()
})

test('a new chat starts again at Level 1, a reload of the same chat does not', async ($, on) => {
  ;(globalThis as any).chatStart = 100
  await boot($, on)
  await $.prompt.submit({ text: 'x' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'One', status: 'completed', activeForm: 'x' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Lv 1/ })).toBeUndefined()
  await ui.unmount()
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const same = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await same.find({ type: 'Text', text: /QUEST COMPLETE/ })).toBeDefined()
  await same.unmount()
  ;(globalThis as any).chatStart = 200
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const fresh = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await fresh.find({ type: 'Text', text: /Lv 1/ })).toBeDefined()
  expect(await fresh.find({ type: 'Text', text: /QUEST COMPLETE/ })).toBeUndefined()
  await fresh.unmount()
})

test('levels follow the 5e Ranger table, with its features and conclave', () => {
  expect(levelOf(0).level).toBe(1)
  expect(levelOf(xpForLevel(5)).level).toBe(5)
  expect(levelOf(xpForLevel(5) - 1).level).toBe(4)
  expect(levelOf(10_000_000).level).toBe(20)
  expect(featuresAt(5)).toEqual(['Extra Attack'])
  expect(featuresAt(3, 'Hunter')).toContain('Ranger Conclave: Hunter')
  expect(featuresAt(3, 'gloom-stalker')).toEqual(['Primeval Awareness', 'Ranger Conclave: Gloom Stalker', 'Dread Ambusher', 'Umbral Sight', 'Gloom Stalker Magic'])
  expect(featuresAt(11, 'drakewarden')).toEqual(["Drake's Breath"])
  expect(featuresAt(7)).toEqual(['Conclave feature'])
  expect(featuresAt(7, 'Beast Master')).toEqual(['Exceptional Training'])
  expect(featuresAt(20)).toEqual(['Foe Slayer'])
  expect([profBonus(1), profBonus(5), profBonus(9), profBonus(13), profBonus(17)]).toEqual([2, 3, 4, 5, 6])
})

test('a finished quest idles on repeat; running, resting and knocked out keep their poses', () => {
  expect(poseOf({ busy: false, outOfHearts: false, won: true, celebrating: false })).toBe('idle')
  expect(poseOf({ busy: true, outOfHearts: false, won: true, celebrating: false })).toBe('idle')
  expect(poseOf({ busy: true, outOfHearts: false, won: false, celebrating: false })).toBe('run')
  expect(poseOf({ busy: false, outOfHearts: true, won: false, celebrating: false })).toBe('rest')
  expect(poseOf({ busy: false, outOfHearts: false, won: false, celebrating: true })).toBe('slash')
  // Battle: a cleared step strikes, a milestone thrusts, a decision waiting puts the hero on guard.
  expect(poseOf({ busy: true, outOfHearts: false, won: false, celebrating: false, strike: 'attack' })).toBe('attack')
  expect(poseOf({ busy: true, outOfHearts: false, won: false, celebrating: false, strike: 'thrust' })).toBe('thrust')
  expect(poseOf({ busy: false, outOfHearts: false, won: false, celebrating: false, waiting: true })).toBe('guard')
  expect(strikeMs('attack')).toBe(5 * 2 * 160)
})

test('clearing a step makes the hero strike, a milestone makes it thrust, and the strike ends', () => {
  const start = change(emptyGame(), 1_000, ctx => ctx.startQuest('q', 'goal', 'q', true))
  const one = change(start.game, 2_000, ctx => ctx.logAction({ at: 2_000, text: 'Wrote a.py', ok: true, family: 'file:/r/a/a.py' }))
  const two = change(one.game, 3_000, ctx => ctx.logAction({ at: 3_000, text: 'Wrote b.py', ok: true, family: 'file:/r/b/b.py' }))
  expect(two.game.strike?.pose).toBe('attack')
  expect(two.game.strike?.until).toBe(3_000 + strikeMs('attack'))
  const three = change(two.game, 4_000, ctx => ctx.logAction({ at: 4_000, text: 'Saved a commit to git: Land it', ok: true, commit: 'Land the first piece' }))
  expect(three.game.strike?.pose).toBe('thrust')
})

test('pasted-content wrapper lines never reach a title', async ($, on) => {
  expect(unwrap('<\\pasted_content id]"77d7">\nreal text')).toBe('real text')
  await boot($, on)
  await $.prompt.submit({ text: '<pasted_content id="77d7">\n/goal tidy the repo\n</pasted_content id="77d7">' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'One', status: 'in_progress', activeForm: 'x' }] })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /pasted_content/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /tidy the repo/ })).toBeDefined()
  await ui.unmount()
})

const step = async ($: any, says: string) => {
  ;(globalThis as any).stepSays = says
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 3 })
  for await (const _chunk of stream) {
    // Drained: the hook only watches.
  }
  await stream.result
  ;(globalThis as any).stepSays = ''
}

// How the engine orders the rows around a goal check (see the mod's session.append hook).
const said = ($: any, text = 'All done.') => $.session.append({ message: { type: 'assistant', content: [{ type: 'text', text }] } })
const feedback = ($: any) => $.session.append({ message: { type: 'user', isMeta: true, content: [{ type: 'text', text: 'Stop hook feedback:\n[the goal] not yet met' }] } })
const check = async ($: any, reason = 'Done.') => {
  // Time passes between a goal being set and its first verdict.
  await (globalThis as any).clock.advance(10_000)

  return $.session.append({ message: { type: 'attachment', name: 'goal_status', content: [{ type: 'text', text: `{"type":"goal_status","reason":"${reason}"}` }] } })
}

const wait = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))

test('a question dialog parks an ask while it is open and settles when answered', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal pick a database' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Choose storage', status: 'in_progress', activeForm: 'x' }] })
  let release: (value?: unknown) => void = () => undefined
  ;(globalThis as any).gate = new Promise(resolve => (release = resolve))
  const call = $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Which database should we use?', header: 'DB', options: [{ label: 'SQLite' }, { label: 'Postgres' }], multiSelect: false }] })
  await wait()
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /quest giver awaits/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Which database should we use/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Paused/ })).toBeDefined()
    await ui.unmount()
  }
  release()
  await call
  ;(globalThis as any).gate = undefined
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /quest giver awaits/ })).toBeUndefined()
  expect(await after.find({ type: 'Text', text: /Rulings/ })).toBeDefined()
  await after.unmount()
})

test('words that hand a decision to the person park an ask until they reply in the chat', async ($, on) => {
  expect(parkedAsk('Bringing to user instead of making a call: which database should we use?', false)).toMatch(/which database/)
  expect(parkedAsk('All done. Let me know if you want more.', false)).toBeNull()
  expect(parkedAsk('Built it.\n\nShould I keep the old API?', true)).toBe('Should I keep the old API?')
  expect(parkedAsk('Built it.\n\nShould I keep the old API?', false)).toBeNull()
  await boot($, on)
  await $.prompt.submit({ text: '/goal ship it' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Pick the plan', status: 'in_progress', activeForm: 'x' }] })
  await $.turn.complete({ answer: 'Bringing to user instead of making a call: SQLite or Postgres?', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /SQLite or Postgres/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /quest giver awaits/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'Go with SQLite' })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /quest giver awaits/ })).toBeUndefined()
  expect(await ui2.find({ type: 'Text', text: /Go with SQLite/ })).toBeDefined()
  await ui2.unmount()
})

test('new items join the quest smartly: a later plan, work before a plan, finished steps, task order', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal build it' })
  await $.tool.call({ tool: 'Bash', command: 'mkdir app', description: 'Create the app folder' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', scope: 'first_task', items: [{ content: 'Design the schema', status: 'in_progress' }, { content: 'Build the API', status: 'pending' }] })
  // A plan from plan mode with the same items must not duplicate them.
  await $.tool.call({ tool: 'ExitPlanMode' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /Create the app folder/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Design the schema/ })).toBeDefined()
  await ui.unmount()
  // The agent finishes phase one, then sends a list of only the new phase: finished steps stay above it.
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Design the schema', status: 'completed' }, { content: 'Build the API', status: 'completed' }] })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', items: [{ content: 'Write the docs', status: 'in_progress' }] })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /Design the schema/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Write the docs/ })).toBeDefined()
  await ui.unmount()
})

test('task links order tasks: a task that blocks another goes above it', () => {
  const start = change(emptyGame(), 1, ctx => {
    ctx.startQuest('Tasks', 'tasks')
    ctx.addStep('Second', 't1')
    ctx.addStep('Third', 't2')
    ctx.addStep('First', 't3')
    ctx.placeTask('t3', ['1'], [])
  })
  expect(start.game.quest?.steps.map(step => step.title)).toEqual(['First', 'Second', 'Third'])
  const later = change(start.game, 2, ctx => ctx.placeTask('t1', [], ['2']))
  expect(later.game.quest?.steps.map(step => step.title)).toEqual(['First', 'Third', 'Second'])
})

test('the pane fits a narrow side pane and a wide one on every surface', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal fit the pane' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'A long step title that would not fit a narrow side pane at all', status: 'in_progress', activeForm: 'x' }, { content: 'Another', status: 'pending', activeForm: 'x' }] })
  for (const bodyColumns of [28, 40, 90]) {
    for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
      const ui = await $.ui.mount({ ...PANE, props: { ...PANE.props, bodyColumns }, surface })
      expect(await ui.find({ type: 'Text', text: /Lv 1/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /0\/2 steps/ })).toBeDefined()
      await ui.unmount()
    }
  }
})

test('a question parked mid-turn floats in the log while the goal keeps running, and survives to the end if unanswered', async ($, on) => {
  expect(floatingAsk('Moving on with the default.\n\nBringing to user instead of making a call: keep the old API or drop it?')).toMatch(/keep the old API/)
  expect(floatingAsk("I'll proceed with SQLite unless you object.")).toMatch(/SQLite/)
  expect(floatingAsk('Wrote the file. Running tests now.')).toBeNull()
  expect(similar('Keep the old API or drop it?', 'keep the old api or drop it')).toBe(true)
  await boot($, on)
  await $.prompt.submit({ text: '/goal build the thing' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Build it', status: 'in_progress', activeForm: 'x' }, { content: 'Test it', status: 'pending', activeForm: 'x' }] })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await step($, 'Continuing with the default.\n\nBringing to user instead of making a call: keep the old API or drop it?')
  await $.tool.call({ tool: 'Write', file_path: '/x/a.py', content: 'x' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Parked for you — Claude kept going/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /keep the old API or drop it/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Working/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Paused/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /quest giver awaits/ })).toBeUndefined()
    await ui.unmount()
  }
  // The goal finishes with the question never answered: it stays on the finished quest.
  await $.turn.complete({ answer: 'done', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await said($)
  await check($, 'Done.')
  const end = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await end.find({ type: 'Text', text: /Still open for you/ })).toBeDefined()
  expect(await end.find({ type: 'Text', text: /keep the old API or drop it/ })).toBeDefined()
  await end.unmount()
})

test('a floating question becomes a pause if the turn then ends on it, and a reply settles it', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal build the thing' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Build it', status: 'in_progress', activeForm: 'x' }] })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await step($, 'Bringing to user instead of making a call: keep the old API or drop it?')
  await $.turn.complete({ answer: 'Bringing to user instead of making a call: keep the old API or drop it?', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /quest giver awaits/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Parked for you — Claude kept going/ })).toBeUndefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'Drop it' })
  const ui2 = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui2.find({ type: 'Text', text: /quest giver awaits/ })).toBeUndefined()
  expect(await ui2.find({ type: 'Text', text: /Drop it/ })).toBeDefined()
  await ui2.unmount()
})

test('where no pane can be placed, a toast says so once', async ($, on) => {
  ;(globalThis as any).placed = false
  ;(globalThis as any).toasts = []
  await boot($, on)
  await $.prompt.submit({ text: '/goal x' })
  await $.command.run({ command: 'quest', args: '' })
  ;(globalThis as any).placed = undefined
  const said = ((globalThis as any).toasts as string[]).filter(text => /no side pane/.test(text))
  ;(globalThis as any).toasts = undefined
  expect(said.length).toBe(1)
})

test('the same action done again stays in its step instead of making a new one', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal run the suite' })
  await $.tool.call({ tool: 'Bash', command: 'pytest', description: 'Run the test suite' })
  await $.tool.call({ tool: 'Bash', command: 'pytest', description: 'Run the test suite' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /0\/1 steps so far/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /2 actions/ })).toBeDefined()
  await ui.unmount()
  await $.tool.call({ tool: 'Write', file_path: '/x/a.py', content: 'x' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /1\/2 steps so far/ })).toBeDefined()
  await ui.unmount()
})

// Hundreds of actions: CPU-bound, so it gets more time than the default on a busy machine.
test('a very long run stays bounded: old steps fold and keep few actions, with no cap on steps', { timeoutMs: 20_000 }, async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal a very long job' })
  for (let i = 0; i < 130; i++) {
    await $.tool.call({ tool: 'Write', file_path: `/x${i}/f${i}.py`, content: 'x' })
    await $.tool.call({ tool: 'Write', file_path: `/x${i}/f${i}.py`, content: 'x' })
  }
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /\/130 steps so far|129\/130 steps/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /earlier steps cleared/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Wrote f129\.py/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Wrote f3\.py/ })).toBeUndefined()
  await ui.press({ key: await keyOfFold(ui) })
  expect(await ui.find({ type: 'Button', text: /Wrote f3\.py/ })).toBeDefined()
  await ui.unmount()
})

async function keyOfFold(ui: any) {
  const row = await ui.find({ type: 'Button', text: /earlier steps cleared/ })

  return String(row?.key ?? '')
}

test('a goal check that is not met never wins the quest, and a win it called early reopens', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal keep going' })
  await $.tool.call({ tool: 'Write', file_path: '/a/one.py', content: 'x' })
  // Not met: the agent speaks, the engine's feedback row follows, then the check.
  await said($, 'Partway there.')
  await feedback($)
  await check($, 'Not yet.')
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeUndefined()
  await ui.unmount()
  // The check posted when a goal is set follows the person's command, not the agent's words.
  await $.prompt.submit({ text: '/goal another' })
  await check($, 'Set.')
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeUndefined()
  await ui.unmount()
  // Met: it follows the agent's closing words.
  await $.tool.call({ tool: 'Write', file_path: '/a/two.py', content: 'x' })
  await said($, 'Finished.')
  await check($, 'Met.')
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeDefined()
  await ui.unmount()
  // The goal turns out to be still active: the feedback row reopens the quest and logging carries on.
  await feedback($)
  await $.tool.call({ tool: 'Write', file_path: '/b/three.py', content: 'x' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Wrote three\.py/ })).toBeDefined()
  await ui.unmount()
})

test('looking around is not a step: read-only commands fold into the work, repeats and one folder join', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal tidy docs' })
  await $.tool.call({ tool: 'Bash', command: "sed -n '1,40p' docs/plan.md | cut -c1-80" })
  await $.tool.call({ tool: 'Bash', command: "grep -an 'TK-1' docs/open-work.md" })
  await $.tool.call({ tool: 'Bash', command: 'git status --short; git log --oneline -3' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/docs/plan.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/docs/open-work.md', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/docs/plan.md', old_string: 'b', new_string: 'c' })
  const before = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await before.find({ type: 'Button', text: /Edited 2 files in docs\// })).toBeDefined()
  await before.unmount()
  // The commit closes a milestone: the edits and the commit fold into one step; a one-word message keeps the work's name.
  await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m docs', description: 'Commit the docs' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /🏁 1\. Edited 2 files in docs\/ \(committed: “docs”\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Commit the docs/ })).toBeUndefined()
  await ui.unmount()
})

test('a commit names its milestone; work since the last commit folds under it', async ($, on) => {
  expect(commitOf('git add a.py && git commit -qm "TK-62: the request rate limiter\n\nCo-Authored-By: x"')).toBe('TK-62: the request rate limiter')
  expect(commitOf("python3 - <<'EOF'\nopen('x','w').write('git commit -m nope')\nEOF\ngit add x && git commit -m 'Stage C START at e47b150f'")).toBe('Stage C START at e47b150f')
  expect(commitOf('git -C /r commit --message="Fix the ledger"')).toBe('Fix the ledger')
  expect(commitOf('git status && git log -1')).toBeUndefined()
  expect(explainBash('git commit -qm "Land TK-61"')).toBe('Saved a commit to git: Land TK-61')
  await boot($, on)
  await $.prompt.submit({ text: '/goal land stage C' })
  await $.tool.call({ tool: 'Write', file_path: '/r/lib/state.py', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'python -m pytest tests/blocks -q', description: 'Run the block tests' })
  await $.tool.call({ tool: 'Bash', command: 'git add lib && git commit -qm "TK-61: per-user session state"' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/lib/clock.py', old_string: 'a', new_string: 'b' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -am "TK-62: the request rate limiter"' })
  await $.tool.call({ tool: 'Read', file_path: '/r/docs/plan.md' })
  await $.tool.call({ tool: 'Edit', file_path: '/r/docs/plan.md', old_string: 'a', new_string: 'b' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /🏁 1\. TK-61: per-user session state 3 actions/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /🏁 2\. TK-62: the request rate limiter 2 actions/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /3\. Edited plan\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Run the block tests/ })).toBeUndefined()
  await ui.unmount()
})

const DECISIONS = `Stage A is done and committed.

**Decisions waiting on you**

* D-DATA-2: the Pro plan's usage history isn't exported. The options are to ask the vendor, rebuild it from the raw event logs (needs a warehouse login), or use the sample dataset I downloaded as a stand-in. I recommend rebuilding it, with the stand-in as a comparison.
* E.9: the vendor data (a 2.80-point annual price spread) suggests the 0.0293 fee rate is per year, not per quarter as assumed.
* Delete the 20 duplicate dashboard reports: your permission settings blocked me twice. The IDs are in \`docs/designs/pass2/duplicate-reports-to-delete.txt\`.
* An off-disk copy of \`~/Backups/shop/shop-20261026.bundle\`.
* D-1 and D-2 have defaults and only matter in Stage E.

Next I will start Stage B.`

test('a list of decisions under a heading becomes one ask per item', async ($, on) => {
  const list = parkedList(DECISIONS)
  expect(list.length).toBe(5)
  expect(list[0]?.text).toMatch(/^D-DATA-2: the Pro plan/)
  expect(list[2]?.text).toMatch(/duplicate dashboard reports/)
  expect(list[2]?.text).not.toMatch(/`/)
  expect(list.map(one => one.kind)).toEqual(['blocking', 'blocking', 'blocking', 'blocking', 'floating'])
  expect(parkedList('Done.\n\n- one\n- two')).toEqual([])
  await boot($, on)
  await $.prompt.submit({ text: '/goal finish stage A' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Stage A', status: 'in_progress', activeForm: 'x' }] })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await step($, DECISIONS)
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /D-DATA-2: the Pro plan/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /E\.9: the vendor data/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /off-disk copy/ })).toBeDefined()
    await ui.unmount()
  }
  // The turn ends on the same list: the open decisions now pause the quest; the defaulted one keeps floating.
  await $.turn.complete({ answer: DECISIONS, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /quest giver awaits/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Parked for you — Claude kept going/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /D-1 and D-2 have defaults/ })).toBeDefined()
  await ui.unmount()
  await $.prompt.submit({ text: 'Rebuild it; skip the rest for now' })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /quest giver awaits/ })).toBeUndefined()
  await after.unmount()
})

test('a question the agent only said stops pausing the quest once the goal sends it back to work', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal keep working' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Work', status: 'in_progress', activeForm: 'x' }] })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete({ answer: 'Bringing to user instead of making a call: which dataset?', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Paused/ })).toBeDefined()
  await ui.unmount()
  // The goal check says "not met": the engine posts its feedback row and the agent carries on.
  await feedback($)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Paused/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /quest giver awaits/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Parked for you — Claude kept going/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /which dataset/ })).toBeDefined()
  await ui.unmount()
})

test('a new turn softens a spoken ask, but a question dialog keeps blocking', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal keep working' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Work', status: 'in_progress', activeForm: 'x' }] })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete({ answer: 'Waiting on you: which dataset?', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.turn.start({ text: '', turnId: 't2' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /Paused/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Parked for you — Claude kept going/ })).toBeDefined()
  await ui.unmount()
  ;(globalThis as any).gate = new Promise(() => undefined)
  // Left open on purpose (the dialog never answers): the call is torn down with the test, and that rejection is expected.
  $.tool.call({ tool: 'AskUserQuestion', questions: [{ question: 'Pick one?', header: 'Pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }] }).catch(() => undefined)
  await wait()
  await $.turn.start({ text: '', turnId: 't3' })
  const held = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await held.find({ type: 'Text', text: /quest giver awaits/ })).toBeDefined()
  await held.unmount()
  ;(globalThis as any).gate = undefined
})

test('work that carries on after a win with no message from the person reopens the quest; after they speak it does not', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal long job' })
  await $.tool.call({ tool: 'Write', file_path: '/a/one.py', content: 'x' })
  await said($)
  await check($)
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeDefined()
  await ui.unmount()
  // Still working with no word from the person: the win was early.
  await $.tool.call({ tool: 'Write', file_path: '/b/two.py', content: 'x' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeUndefined()
  expect(await ui.find({ type: 'Button', text: /Wrote two\.py/ })).toBeDefined()
  await ui.unmount()
  // A real win, then the person speaks and asks for something else: that work is not the finished quest's.
  await said($)
  await check($)
  await $.prompt.submit({ text: 'thanks, now something unrelated' })
  await $.tool.call({ tool: 'Write', file_path: '/c/three.py', content: 'x' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Wrote three\.py/ })).toBeUndefined()
  await ui.unmount()
})

test('each decision shows under the step it came up on, in every state', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal two stages' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Stage one', status: 'in_progress', activeForm: 'x' }, { content: 'Stage two', status: 'pending', activeForm: 'x' }] })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await step($, 'Continuing.\n\nBringing to user instead of making a call: which dataset?')
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /📌 parked: Bringing to user instead of making a call: which dataset/ })).toBeDefined()
  await ui.unmount()
  // Left open when the goal is met: it stays under its step, and in the summary.
  await $.tool.call({ tool: 'Write', file_path: '/s/one.py', content: 'x' })
  await said($)
  await check($)
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /⏳ left open: Bringing to user/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Still open for you/ })).toBeDefined()
  await ui.unmount()
})

const REASON =
  "Not satisfied. The plan was updated (Part 28 staged plan, E.9 settled, TK-182 filed), the requested items were implemented (20 dashboard duplicates deleted, fee-rate measures committed), and handoffs were committed (5c215641, 25e789d9) with strict provenance at 0 problems. But the condition's core requirement, implementing the new checkout and pipeline with a finished, tested foundation stage, is unmet: the full a-gates test run is still in progress and not counted, Stage B is not tagged, and TK-182 (computing the usage transition matrix) was left uncomputed."

test('the goal check is read as a checklist: parts met, parts to do, and what the checker said', async ($, on) => {
  const parsed = parseCheck(REASON)
  expect(parsed.met.length).toBe(3)
  expect(parsed.todo).toEqual(['The full a-gates test run is still in progress and not counted', 'Stage B is not tagged', 'TK-182 (computing the usage transition matrix) was left uncomputed'])
  expect(goalFeedback('Stop hook feedback:\n[the goal text]: ' + REASON, 'the goal text')).toBe(REASON)
  expect(goalFeedback('Stop hook feedback:\nledger guard found 2 problems', 'the goal text')).toBeNull()
  await boot($, on)
  await $.prompt.submit({ text: '/goal the goal text' })
  await $.tool.call({ tool: 'Write', file_path: '/a/one.py', content: 'x' })
  await said($)
  await $.session.append({ message: { type: 'user', isMeta: true, content: [{ type: 'text', text: 'Stop hook feedback:\n[the goal text]: ' + REASON }] } })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Goal check 1 · not met yet/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⬜ Stage B is not tagged/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: /3 parts done/ })).toBeDefined()
    await ui.unmount()
  }
  // Another stop hook's feedback is not the goal check.
  await $.session.append({ message: { type: 'user', isMeta: true, content: [{ type: 'text', text: 'Stop hook feedback:\nledger guard found 2 problems' }] } })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^🎯 Goal check 2 · not met/ })).toBeUndefined()
  await ui.unmount()
  // Met: the card is gone.
  await said($)
  await check($)
  const done = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await done.find({ type: 'Text', text: /^🎯 Goal check 1 · not met/ })).toBeUndefined()
  await done.unmount()
})

const CLOSING = `The stats helper is built in \`quest-check\`. All 4 tests pass.

- **Planned failure:** the first run failed as intended.

## Decisions waiting on you

- **Should \`median([])\` (and \`mean([])\`) raise an error or return \`None\`?** Right now both raise \`ValueError\`, the same as the standard library.
- **How should \`mean\` round its result?** Right now it doesn't round and returns the full float. *This one has a default and only matters later*, since callers can round the result themselves.

ALL CHECKS PASSED: 4/4`

test('decisions in the closing message are kept even when the wrap-up already closed the quest', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '/goal build the stats helper' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', scope: 'first_task', items: [{ content: 'Write stats.py', status: 'in_progress' }, { content: 'Write the README', status: 'pending' }] })
  await $.tool.call({ tool: 'Write', file_path: '/q/stats.py', content: 'x' })
  await $.tool.call({ tool: 'mcp__ccd_turn__update_plan', advance: true })
  await $.tool.call({ tool: 'Write', file_path: '/q/README.md', content: 'x' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  // The last step is ticked off at wrap-up, before the closing message is written.
  await $.tool.call({ tool: 'mcp__ccd_turn__wrap_up', recap: 'done' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeDefined()
  await ui.unmount()
  await $.turn.complete({ answer: CLOSING, durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /Still open for you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /raise an error or return None/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /How should mean round its result/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /⏳ left open: Should median/ })).toBeDefined()
    await ui.unmount()
  }
  // Once the person has spoken, later closing words are not folded into the finished quest.
  await $.prompt.submit({ text: 'raise an error; round to 2 places' })
  await $.turn.complete({ answer: 'Bringing to user instead of making a call: something new?', durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  const after = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await after.find({ type: 'Text', text: /something new/ })).toBeUndefined()
  await after.unmount()
})

test('a goal pasted as text says it is not being checked; a real /goal command does not', async ($, on) => {
  await boot($, on)
  await $.prompt.submit({ text: '<pasted_content id="1">\n/goal pasted one\n</pasted_content id="1">' })
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /pasted as text, so Claude Code isn't checking it/ })).toBeDefined()
  await ui.unmount()
  await $.command.run({ command: 'goal', args: 'a real one' })
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /a real one/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /pasted as text/ })).toBeUndefined()
  await ui.unmount()
})

test('a goal pasted from a copied report keeps a clean title', async ($, on) => {
  await boot($, on)
  await $.command.run({ command: 'goal', args: '# Build the thing\n\nGoal: Build the thing for real' })
  await $.tool.call({ tool: 'Write', file_path: '/a/one.py', content: 'x' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^📜 Build the thing$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /📜 # / })).toBeUndefined()
  await ui.unmount()
})

test('the heartbeat says whether the goal is still active, and shows Resting only when Claude is really waiting', async ($, on) => {
  const text = async (re: RegExp, surface: 'desktop' | 'terminal' = 'desktop') => {
    const ui = await $.ui.mount({ ...PANE, surface })
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return hit
  }
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'a checked goal' })
  await $.tool.call({ tool: 'Write', file_path: '/a/one.py', content: 'x' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  expect(await text(/Working.*🎯 goal still active/)).toBeDefined()
  expect(await text(/🎯 Goal active · not checked yet/)).toBeDefined()
  await $.turn.complete({ answer: 'Stage one done.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  // The turn just ended: the goal check is reviewing, and Claude may carry on by itself.
  expect(await text(/Goal active — the goal check is reviewing/)).toBeDefined()
  expect(await text(/Resting/)).toBeUndefined()
  // Long after, with nothing happening: the goal is still active but Claude is waiting for the person.
  await (globalThis as any).clock.advance(200_000)
  expect(await text(/Goal active but idle .* Claude is waiting for you/)).toBeDefined()
  expect(await text(/Resting/)).toBeUndefined()
  // The person interrupts: still active, but it needs a message to resume.
  await $.turn.start({ text: 'y', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 5, isAborted: true, turnId: 't2', reason: 'aborted' })
  expect(await text(/Interrupted — the goal is still active/)).toBeDefined()
  // Met: the goal is done and Claude is waiting for the person.
  await $.tool.call({ tool: 'Write', file_path: '/b/two.py', content: 'x' })
  await said($)
  await check($)
  expect(await text(/Goal met — Claude is waiting for you/)).toBeDefined()
  // A goal pasted as text has no checker: plain Resting.
  await $.prompt.submit({ text: '<pasted_content id="1">\n/goal pasted\n</pasted_content id="1">' })
  await $.tool.call({ tool: 'Write', file_path: '/c/three.py', content: 'x' })
  expect(await text(/Resting — Claude is waiting for you/)).toBeDefined()
  expect(await text(/Goal active/)).toBeUndefined()
})

test('a shell command with no description is explained in plain English, never as "Ran the command"', async ($, on) => {
  const cases: [string, RegExp][] = [
    ["sed -n 2580,2680p docs/plan-shop.md", /^Read lines 2580–2680 of plan-shop\.md$/],
    ['/usr/bin/grep -a -n "PASS-2 AMENDMENTS" docs/open-work.md | grep -v "see" ; ls docs | head', /^Searched open-work\.md for “PASS-2 AMENDMENTS” \(\+1 more\)$/],
    ['grep -rln "every_appparams_field\\|fields(AppParams)" tests/ tools/', /^Found which files mention “every_appparams_field or fields\(AppPa…” in tests and 1 more$/],
    ["cat >> docs/parameter-ledger.toml <<'EOF'\n[[param]]\nname = 'x'\nEOF", /^Added to parameter-ledger\.toml$/],
    ["cat > /tmp/probe.py <<'EOF'\nprint(1)\nEOF", /^Wrote probe\.py$/],
    ["python3 - <<'EOF'\np='lib/engine/engine.py'\ns=open(p).read()\nopen(p,'w').write(s)\nEOF", /^Edited engine\.py with a short script$/],
    ["python3 - <<'EOF'\np='docs/a.md'\ns=open(p).read()\nprint(len(s))\nEOF", /^Read a\.md with a short script$/],
    [".venv/bin/python -m pytest tests/blocks/test_checkout_flow.py -q", /^Ran the tests in test_checkout_flow\.py$/],
    ["time .venv/bin/python -m pytest tests/engine -k scheduler", /^Ran the tests matching “scheduler” in engine$/],
    ['git add lib/a.py && git commit -m "Add the rate limiter (C1.2)"', /^Saved a commit to git: Add the rate limiter \(C1\.2\) \(\+1 more\)$/],
    ["git status --short; git log --oneline -3", /^Checked what changed in git \(\+1 more\)$/],
    [".venv/bin/python tools/gates/ledger_guard.py", /^Ran the ledger guard script$/],
    ["nice -n 5 .venv/bin/python tools/build/all_on_smoke.py --tiny", /^Ran the all on smoke script$/],
    ["cd quest-verify && python3 -m pytest -q 2>&1 | tail -15", /^Ran the tests \(the whole suite\)$/],
    ["wc -l lib/engine/*.py", /^Counted the lines in the \.py files in engine$/],
    ["mkdir -p out/logs", /^Created the folder logs$/],
  ]
  for (const [command, want] of cases) {
    const said = explainBash(command)
    expect(said).toMatch(want)
    expect(said).not.toMatch(/Ran the command/)
  }
  await boot($, on)
  await $.prompt.submit({ text: '/goal explain commands' })
  await $.tool.call({ tool: 'Bash', command: 'sed -n 1,40p docs/plan.md' })
  await $.tool.call({ tool: 'Bash', command: "cat > /r/out.py <<'EOF'\nprint(1)\nEOF" })
  await $.tool.call({ tool: 'Bash', command: '.venv/bin/python -m pytest tests/a/test_x.py' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Button', text: /Wrote out\.py/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Ran the tests in test_x\.py/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /Ran the command/ })).toBeUndefined()
  await ui.unmount()
})

// The key of a step row's button is `step-<step key>`; steps made at one time
// are numbered, so the test finds the row by its words instead.
async function keyOf(ui: any, title: string) {
  const row = await ui.find({ type: 'Button', text: new RegExp(title) })

  return String(row?.key ?? '').replace(/^step-/, '')
}

// From a 12-hour Stage C goal run: what the log must get right over a long chat.
test('a long goal run: progress is the goal check, a goal loop that stalls says so, and the last quest stays in view', async ($, on) => {
  const notes: string[] = []
  on('ui.notify', (_: any, e: any) => (notes.push(String(e.text ?? e.body ?? '')), { value: undefined }))
  const text = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return hit
  }
  const goalCheck = (reason: string) => $.session.append({ message: { type: 'user', isMeta: true, content: [{ type: 'text', text: `Stop hook feedback:\n[land stage C]: ${reason}` }] } })
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'land stage C' })
  await $.tool.call({ tool: 'Write', file_path: '/r/lib/a.py', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -qm "TK-61: per-user session state"' })
  expect(await text(/Not checked yet · 🏁 1 milestone landed/)).toBeDefined()
  await said($, 'C1.1 landed.')
  await goalCheck('Stage C is not complete. API3 was not defined, and the early slice was not run. The last assistant message states Stage C is still incomplete.')
  expect(await text(/2 parts still to do · 🏁 1 milestone landed/)).toBeDefined()
  expect(await text(/⬜ API3 was not defined/)).toBeDefined()
  expect(await text(/⬜ Stage C is not complete/)).toBeUndefined()
  expect(await text(/last assistant message/)).toBeUndefined()
  expect(await text(/\d+\/\d+ steps/)).toBeUndefined()
  // Claude stops and holds; the check sends it back again and again with nothing done: a standoff, then Claude Code ends it.
  for (let i = 0; i < 3; i++) {
    await said($, 'Holding at the handoff. Run /goal clear to stop these prompts.')
    await goalCheck('Stage C is not complete. API3 was not defined.')
  }
  expect(await text(/🔁 Standoff — Claude has stopped working/)).toBeDefined()
  await $.session.append({ message: { type: 'system', name: 'informational', content: [{ type: 'text', text: 'A hook blocked the turn from ending 9 consecutive times — overriding and ending turn.' }] } })
  expect(await text(/⛔ Goal loop stopped .* reply to carry on, or type \/goal clear/)).toBeDefined()
  expect(await text(/reviewing|may carry on by itself/)).toBeUndefined()
  expect(notes.filter(one => /Goal loop stopped/.test(one)).length).toBe(1)
  // Work again clears it.
  await $.tool.call({ tool: 'Edit', file_path: '/r/lib/b.py', old_string: 'a', new_string: 'b' })
  expect(await text(/^⛔ Goal loop stopped|^🔁 Standoff —/)).toBeUndefined()
  // Set aside: the pane keeps what it came to.
  await $.command.run({ command: 'goal', args: 'clear' })
  expect(await text(/Last quest: land stage C/)).toBeDefined()
  expect(await text(/goal check's last word: API3 was not defined/)).toBeDefined()
})

test('a question back to Claude settles no parked decision; a reply about one does; a re-raised decision notifies once', async ($, on) => {
  const notes: string[] = []
  on('ui.notify', (_: any, e: any) => (notes.push(String(e.text ?? e.body ?? '')), { value: undefined }))
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'land stage C' })
  await $.tool.call({ tool: 'Write', file_path: '/r/lib/a.py', content: 'x' })
  const closing = 'Handed off.\n\n**Decisions waiting on you**\n\n- D-9: whether to re-express the v1 app (default: no).\n- An off-disk copy of the backup bundle, which only matters later.'
  for (let i = 0; i < 4; i++) {
    await $.turn.start({ text: 'x', turnId: `t${i}` })
    await $.turn.complete({ answer: closing, durationMs: 5, isAborted: false, turnId: `t${i}`, reason: 'answer' })
    await $.session.append({ message: { type: 'user', isMeta: true, content: [{ type: 'text', text: 'Stop hook feedback:\n[land stage C]: Stage C is not complete. API3 was not defined.' }] } })
  }
  expect(notes.filter(one => /D-9/.test(one)).length).toBeLessThanOrEqual(1)
  const parked = async () => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const all = await ui.findAll({ type: 'Text', text: /^📌 parked: / })
    await ui.unmount()

    return all.length
  }
  expect(await parked()).toBe(2)
  await $.prompt.submit({ text: "explain why stage C isn't complete" })
  expect(await parked()).toBe(2)
  await $.prompt.submit({ text: 'D-9: keep the v1 app as it is' })
  expect(await parked()).toBe(1)
})

const STAGE_GOAL = 'Stage C of the build. COMPLETE when tag api3-candidate exists: every Stage C item in plan 28.3 is landed (or parked with a reason), API3 is defined, and the all-on smoke prints every row with residuals at machine precision.\n\nDO: plan 28.3 C1 -> C2 -> C3 -> C4 in order, one module per landing.'

test('the road ahead is known from the start: the goal\'s finish line and stages, then what Claude says comes next', async ($, on) => {
  const road = goalRoad(STAGE_GOAL)
  expect(road.finish.map(item => item.text)).toEqual(['Tag api3-candidate exists', 'Every Stage C item in plan 28.3 is landed (or parked with a reason)', 'API3 is defined', 'The all-on smoke prints every row with residuals at machine precision'])
  expect(road.stages).toEqual(['C1', 'C2', 'C3', 'C4'])
  expect(goalRoad('- write the parser\n- add tests\n- ship it').finish.length).toBe(3)
  expect(nextSteps('Done.\n\n**Next:** TK-65 (each shop sets its own price), then TK-169, then the C1.2 landing.\n\nMore.')).toEqual(['TK-65 (each shop sets its own price)', 'TK-169', 'The C1.2 landing'])
  expect(nextSteps('## Next steps\n\n1. Wire the clock\n2. Run the gates')).toEqual(['Wire the clock', 'Run the gates'])
  expect(nextSteps('Next time I will be faster.')).toEqual([])
  expect(stageIn(['C1', 'C2', 'C3'], 'C1.3 build step 0 (TK-157)')).toBe(0)
  expect(stageIn(['C1', 'C2', 'C3'], 'TK-169 status, TK-184 (plan-driven cache warming: the co-requisite, C2.1)')).toBe(-1)
  const text = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return hit
  }
  await boot($, on)
  await $.command.run({ command: 'goal', args: STAGE_GOAL })
  // Before any work: the whole finish line and the stages are already in view.
  expect(await text(/⚔️ C1 {2}→ {2}○ C2 {2}→ {2}○ C3 {2}→ {2}○ C4/)).toBeDefined()
  expect(await text(/⬜ API3 is defined/)).toBeDefined()
  await $.tool.call({ tool: 'Write', file_path: '/r/lib/a.py', content: 'x' })
  await $.tool.call({ tool: 'Bash', command: 'git commit -qm "C2.1 landed: the payment queue"' })
  expect(await text(/✅ C1 {2}→ {2}⚔️ C2/)).toBeDefined()
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete({ answer: 'C2.1 is in.\n\n**Next:** C2.2 (credit), then the early slice.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await text(/^1\. C2\.2 \(credit\)/)).toBeDefined()
  expect(await text(/^2\. The early slice/)).toBeDefined()
  // The goal check ticks the finish line: met is done, still to do stays open, "No ... was created" is not met.
  await $.session.append({ message: { type: 'user', isMeta: true, content: [{ type: 'text', text: `Stop hook feedback:\n[${STAGE_GOAL}]: Not met. API3 is defined and committed. No api3-candidate tag was created, and the all-on smoke residuals are not at machine precision.` }] } })
  expect(await text(/✅ API3 is defined/)).toBeDefined()
  expect(await text(/⬜ Tag api3-candidate exists/)).toBeDefined()
  expect(await text(/1\/4 of the finish line/)).toBeDefined()
})

// From the VS Code Stage C chat: heredoc commit messages, a bold numbered decision list, a numbered reply, and a goal
// Claude Code never checked.
test('heredoc commits, numbered decisions and replies, and a goal nobody is checking', async ($, on) => {
  expect(commitOf("git add a && git commit -q -F - <<'EOF'\nC1.4 TK-125: a read-only caller\n\nBody.\nEOF")).toBe('C1.4 TK-125: a read-only caller')
  expect(commitOf('git commit -m "$(cat <<\'EOF\'\nC1.6 TK-147: national tax scope\nEOF\n)"')).toBe('C1.6 TK-147: national tax scope')
  expect(explainBash("git commit -q -F - <<'EOF'\nLand TK-61\nEOF")).toBe('Saved a commit to git: Land TK-61')
  expect(explainBash('.venv/bin/python -m tools.reports.model.gen_reachability_sweep')).toBe('Ran the gen reachability sweep module')
  expect(goalRoad('THIS CHAT is COMPLETE when the sub-stage holding the item named next: in the stage log is finished: every one of its items landed or parked with a reason, AND a HANDOFF is committed with a clean tree.').finish.map(item => item.text)).toEqual([
    'The sub-stage holding the item named next: in the stage log is finished',
    'Every one of its items landed or parked with a reason',
    'A HANDOFF is committed with a clean tree',
  ])
  const LIST = '## The decisions waiting on you, in plain English\n\n**1. Who owns the caches.**\n- **What changed:** ownership is spread.\n- **Your choice:** keep the spread ownership (default), or concentrate it.\n\n**2. A small bug in the v1 app\'s model.**\n- **The bug:** one stock is not rescaled.\n- **Your choice:** fix it everywhere too, or leave the v1 app as published.\n\n**3. Two process points (not strictly your decisions, but you should know):**\n- one\n- two'
  expect(parkedList(LIST).map(one => [one.n, one.text])).toEqual([
    [1, 'Who owns the caches. Your choice: keep the spread ownership (default), or concentrate it.'],
    [2, "A small bug in the v1 app's model. Your choice: fix it everywhere too, or leave the v1 app as published."],
  ])
  const text = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return hit
  }
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'finish C1' })
  await $.tool.call({ tool: 'Write', file_path: '/r/lib/a.py', content: 'x' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete({ answer: 'Built.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await text(/goal check is reviewing/)).toBeDefined()
  await $.turn.start({ text: 'x', turnId: 't2' })
  await $.turn.complete({ answer: LIST, durationMs: 5, isAborted: false, turnId: 't2', reason: 'answer' })
  // Two stops and no goal check after either: say so, instead of "reviewing".
  expect(await text(/hasn't checked it at the last 2 stops/)).toBeUndefined() // a decision is waiting: the pause leads
  expect(await text(/no check at the last 2 stops/)).toBeDefined()
  expect(await text(/^Two process points/)).toBeUndefined()
  // A numbered reply: 1 asks back (stays open), 2 rules.
  await $.prompt.submit({ text: "1. Shouldn't ownership follow investment? Explain.\n2. fix it everywhere" })
  expect(await text(/✅ ruled: A small bug in the v1 app's model.* → fix it everywhere/)).toBeDefined()
  expect(await text(/(?:❗ waiting|📌 parked): Who owns the caches/)).toBeDefined()
  await $.prompt.submit({ text: 'keep the spread ownership for now' })
  await $.turn.start({ text: 'x', turnId: 't3' })
  await $.turn.complete({ answer: 'Done.', durationMs: 5, isAborted: false, turnId: 't3', reason: 'answer' })
  expect(await text(/⚠️ Goal set, but Claude Code hasn.t checked it at the last 3 stops, so the goal isn.t sending Claude back/)).toBeDefined()
})

test('a background job finishing is not the person replying', async ($, on) => {
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'finish C1' })
  await $.tool.call({ tool: 'Write', file_path: '/r/lib/a.py', content: 'x' })
  await $.turn.start({ text: 'x', turnId: 't1' })
  await $.turn.complete({ answer: '**Decisions waiting on you**\n\n1. D-9: re-express the v1 app?\n2. An off-disk backup copy.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await $.prompt.submit({ text: '<task-notification>\n<task-id>b1</task-id>\n<status>completed</status>\n<summary>1. done\n2. yes</summary>\n</task-notification>' })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /✅ ruled/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /❗ waiting: D-9/ })).toBeDefined()
  await ui.unmount()
})

test('the Class tab: choices wait for the person at their level, the conclave brings its own, and any can be changed', async ($, on) => {
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'level up' })
  // Busywork pays nothing now; a goal passed does (a trivial one: about Lv 5), with nothing chosen for the person.
  for (let i = 0; i < 16; i++) await $.tool.call({ tool: 'Write', file_path: `/r/d${i}/f${i}.py`, content: 'x' })
  const idle = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await idle.press({ key: 'tab-adventure' })
  expect(await idle.find({ type: 'Text', text: /^Lv 1 Ranger/ })).toBeDefined()
  await idle.unmount()
  await said($)
  await (globalThis as any).clock.advance(20_000)
  await check($)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Lv [3-9] Ranger/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /🎓 \d+ class choices waiting: Favored Enemy, Natural Explorer/ })).toBeDefined()
  expect(String((await ui.find({ type: 'Button', key: 'tab-adventure' }))?.props?.label)).toMatch(/🐉 Adventure ❗\d/)
  await ui.press({ key: 'tab-adventure' })
  expect(await ui.find({ type: 'Text', text: /❗ Lv 1 · Favored Enemy/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /❗ Lv 3 · Ranger Conclave/ })).toBeDefined()
  // One choice at a time: the conclave's list opens once it is the next choice.
  expect(await ui.find({ type: 'Text', text: /Xanathar's Guide to Everything/ })).toBeUndefined()
  await ui.press({ key: 'pick-enemy-1-dragons' })
  await ui.press({ key: 'pick-terrain-1-forest' })
  await ui.press({ key: 'pick-style-archery' })
  expect(await ui.find({ type: 'Text', text: /Xanathar's Guide to Everything/ })).toBeDefined()
  await ui.press({ key: 'pick-conclave-hunter' })
  // The Hunter's own choice at Lv 3 appears once the Hunter is chosen.
  expect(await ui.find({ type: 'Text', text: /❗ Lv 3 · Hunter's Prey/ })).toBeDefined()
  await ui.press({ key: 'pick-hunter-3-colossus' })
  if (await ui.find({ type: 'Text', text: /❗ Lv 4 · Ability Score Improvement/ })) await ui.press({ key: 'pick-asi-4-dex' })
  expect(await ui.find({ type: 'Text', text: /^❗ Lv/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Lv 2 · Fighting Style: Archery/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Archery · Dragons · Forest · Colossus Slayer/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Lv \d+ Hunter Ranger/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /✅ Lv 3 · Hunter's Prey/ })).toBeDefined()
  // Changing the conclave takes back its own choices.
  await ui.press({ key: 'undo-conclave' })
  expect(await ui.find({ type: 'Text', text: /❗ Lv 3 · Ranger Conclave/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Lv 3 · Hunter's Prey: Colossus Slayer/ })).toBeUndefined()
  await ui.press({ key: 'pick-conclave-drakewarden' })
  expect(await ui.find({ type: 'Text', text: /❗ Lv 3 · Drake Essence/ })).toBeDefined()
  await ui.unmount()
  for (const surface of ['terminal', 'vscode', 'mobile'] as const) {
    const other = await $.ui.mount({ ...PANE, surface })
    await other.press({ key: 'tab-adventure' })
    expect(await other.find({ type: 'Text', text: /● reached/ })).toBeDefined()
    await other.unmount()
  }
})

test('a guardian bars each new quest: sized to it, struck by milestones, striking back at a "not met", falling at the win', async ($, on) => {
  // The size of the quest picks the guardian's tier; a reload keeps the same one.
  // Each goal size has its guardian, its challenge rating near the level that goal brings the hero to.
  expect(pickFoe('q1', 'trivial')).toBe('lizard')
  expect(pickFoe('q1', 'small')).toBe('whelp')
  expect(pickFoe('q1', 'medium')).toBe('medusa')
  expect(['jinn', 'demon']).toContain(pickFoe('q1', 'large'))
  expect(pickFoe('q1', 'epic')).toBe('dragon')
  expect(pickFoe('q42', 'large')).toBe(pickFoe('q42', 'large'))
  expect(FOES.map(one => one.stats.cr)).toEqual(['½', '4', '6', '11', '11', '17'])
  expect(difficulty('½', 5).word).toBe('Easy')
  expect(difficulty('11', 13).word).toBe('Hard')
  expect(difficulty('17', 15).word).toBe('Deadly')
  expect(bounty(24_000, false)).toBe(2_400)
  expect(bounty(24_000, true)).toBe(3_000)
  // It walks in, roars, then waits; once fallen it stays down on its last death frame.
  const walking = foeView({ id: 'dragon', at: 0 }, 1200, 1)
  expect(walking?.enter).toBe(0.5)
  expect(foeView({ id: "dragon", at: 0 }, 60_000, 0.4)?.hp).toBe(0.4)
  expect(foeView({ id: 'dragon', at: 0, defeatedAt: 1000 }, 99_000, 0)?.hp).toBeUndefined()
  expect(foeMoving({ id: 'dragon', at: 0 }, 60_000)).toBe(false)
  expect(foeMoving({ id: 'dragon', at: 0, act: { anim: 'hurt', at: 59_500 } }, 60_000)).toBe(true)

  // The game itself: a milestone wounds it, a "not met" makes it strike back, the win fells it for its bounty.
  const start = change(emptyGame(), 1_000, ctx => ctx.startQuest('make hello.py', 'goal', 'make hello.py', true))
  const foe = start.game.quest?.foe
  expect(['whelp', 'lizard']).toContain(foe?.id)
  expect(start.events.some(one => one.includes(`A ${foeInfo(foe?.id)?.name} guards this quest`))).toBe(true)
  const hit = change(start.game, 2_000, ctx => ctx.logAction({ at: 2_000, text: 'Saved a commit to git: Add it', ok: true, commit: 'Add the hello script' }))
  expect(hit.game.quest?.foe?.act?.anim).toBe('hurt')
  const back = change(hit.game, 3_000, ctx => ctx.setCheck('Not met.', { met: [], todo: ['The script does not print yet'] }))
  expect(back.game.quest?.foe?.act?.anim).toBe('attack')
  // Its bounty, a quarter more when the hero chose its kind as a Favored Enemy.
  const kind = foeInfo(foe?.id)?.kind as string
  const favored = change({ ...back.game, stats: { ...back.game.stats, picks: { 'enemy-1': kind } } }, 4_000, ctx => ctx.winQuest())
  expect(favored.game.quest?.foe?.defeatedAt).toBe(4_000)
  expect(favored.game.quest?.foe?.favored).toBe(true)
  expect(favored.events.some(one => one.startsWith(`💀 The ${foeInfo(foe?.id)?.name} is defeated! +163 XP (favored enemy)`))).toBe(true)
  expect(favored.game.history[0]?.foe).toEqual({ id: foe?.id as string, defeated: true })

  // The pane names it, the terminal track ends on its emoji, and after the win on a skull.
  const text = async (re: RegExp, surface: 'desktop' | 'terminal' = 'desktop') => {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'tab-adventure' })
    const found = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return found
  }
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'make hello.py' })
  expect(await text(/^🦎 Lizardfolk/)).toBeDefined()
  expect(await text(/🦎$/, 'terminal')).toBeDefined()
  await $.tool.call({ tool: 'Write', file_path: '/r/a/hello.py', content: 'x' })
  await said($)
  await (globalThis as any).clock.advance(20_000)
  await check($)
  expect(await text(/^💀 Lizardfolk — defeated/)).toBeDefined()
  expect(await text(/💀$/, 'terminal')).toBeDefined()
})

test('goals that arrive mid-quest: one joins a running plan, a reworded one updates in place, a different one starts afresh', async ($, on) => {
  const text = async (re: RegExp, tab: 'quest' | 'adventure' = 'quest') => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: `tab-${tab}` })
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return hit
  }
  const button = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'tab-quest' })
    const hit = await ui.find({ type: 'Button', text: re })
    await ui.unmount()

    return hit
  }
  await boot($, on)
  // A plan is running (a small quest, a small guardian)...
  await $.prompt.submit({ text: 'tidy the docs' })
  await $.tool.call({ tool: 'TodoWrite', todos: [{ content: 'Rewrite the README', status: 'in_progress', activeForm: 'x' }, { content: 'Fix the links', status: 'pending', activeForm: 'x' }] })
  await $.tool.call({ tool: 'Edit', file_path: '/r/README.md', old_string: 'a', new_string: 'b' })
  expect(await text(/^🦎 Lizardfolk/, 'adventure')).toBeDefined()
  // ...and a goal arrives: it takes the quest over, steps and all, and a goal-sized guardian takes over.
  await $.command.run({ command: 'goal', args: 'Docs are done. COMPLETE when the README is rewritten, every link resolves, and the changelog is updated.' })
  expect(await button(/1\. Rewrite the README/)).toBeDefined()
  expect(await button(/2\. Fix the links/)).toBeDefined()
  expect(await text(/\/goal \+ ☑️ todos/)).toBeDefined()
  expect(await text(/Goal set on this quest/)).toBeDefined()
  expect(await text(/^🐍 Medusa/, 'adventure')).toBeDefined()
  expect(await text(/takes over from the Lizardfolk/, 'adventure')).toBeDefined()
  expect(await text(/⬜ Every link resolves/)).toBeDefined()
  // The same goal again changes nothing; reworded, it updates in place and keeps the work.
  await $.command.run({ command: 'goal', args: 'Docs are done. COMPLETE when the README is rewritten, every link resolves, and the changelog is updated.' })
  await $.command.run({ command: 'goal', args: 'Docs are done. COMPLETE when the README is rewritten, every link resolves, the changelog is updated, and the API page is regenerated.' })
  expect(await text(/Goal updated/)).toBeDefined()
  expect(await button(/1\. Rewrite the README/)).toBeDefined()
  expect(await text(/⬜ The API page is regenerated/)).toBeDefined()
  // A different goal is a new quest: the old one is set aside, its guardian still standing.
  await $.command.run({ command: 'goal', args: 'ship the login page' })
  expect(await text(/📜 ship the login page/)).toBeDefined()
  expect(await button(/Rewrite the README/)).toBeUndefined()
  expect(await text(/^🦎 Lizardfolk/, 'adventure')).toBeDefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'tab-quest' })
  await ui.press({ key: 'history' })
  expect(await ui.find({ type: 'Text', text: /(?:Medusa|Djinni|Horned Devil) still stands/ })).toBeDefined()
  await ui.press({ key: 'tab-quest' })
  await ui.unmount()
  // Won, then a new goal: a fresh quest and a fresh guardian walks in.
  await $.tool.call({ tool: 'Write', file_path: '/r/login.tsx', content: 'x' })
  await said($)
  await (globalThis as any).clock.advance(20_000)
  await check($)
  expect(await text(/^💀 Lizardfolk — defeated/, 'adventure')).toBeDefined()
  await $.prompt.submit({ text: 'thanks' })
  await $.tool.call({ tool: 'ProposeGoal', condition: 'all tests pass' })
  expect(await text(/📜 all tests pass/)).toBeDefined()
  expect(await text(/^🦎 Lizardfolk/, 'adventure')).toBeDefined()
})

test('runs: what is running, for how long, and how much is likely left', async ($, on) => {
  // Progress from a run's own output, Claude's estimate in its words, and where the output goes.
  expect(progressOf('collecting...\ntests/a.py ....  [ 12%]\ntests/b.py ......... [ 45%]\n')?.pct).toBe(45)
  expect(progressOf('epoch 3/10 loss=0.2')?.pct).toBe(30)
  expect(progressOf(' 37/120 [00:12<00:28, 3.1it/s]')?.pct).toBeGreaterThan(30)
  expect(progressOf('released 2026/10/27, nothing else')).toBeNull()
  expect(hintOf('Starting the gate run; it takes about 6 minutes.')).toEqual({ ms: 360_000, kind: 'total' })
  expect(hintOf('The sweep has about 4 minutes left.')).toEqual({ ms: 240_000, kind: 'left' })
  expect(hintOf('I fixed 6 files.')).toBeNull()
  expect(outputsOf('make a-gates > /tmp/gates.log 2>&1', 'Command running in background with ID: b1. Output is being written to: /tmp/tasks/b1.output. You will be notified')).toEqual(['/tmp/tasks/b1.output', '/tmp/gates.log'])
  // The estimate: from progress, then from earlier runs like it, then from Claude's word.
  const run = { id: 'b1', kind: 'background' as const, label: 'Run the gates', sig: 'Ran “make a-gates”', startedAt: 0 }
  expect(estimate({ ...run, progress: { pct: 25, line: '', at: 0 } }, 60_000).left).toBe(180_000)
  expect(estimate(run, 60_000, [300_000, 360_000]).left).toBe(270_000)
  expect(estimate(run, 400_000, [300_000]).overdue).toBe(true)
  expect(estimate({ ...run, hint: 600_000 }, 60_000).left).toBe(540_000)
  expect(estimate(run, 60_000, [], [100_000, 200_000]).how).toBe('no estimate yet')

  const text = async (re: RegExp) => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return hit
  }
  await boot($, on)
  await $.command.run({ command: 'goal', args: 'land the gates' })
  await $.tool.call({ tool: 'Write', file_path: '/r/a.py', content: 'x' })
  // A quick foreground command is no run worth showing.
  await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'quick' })
  expect(await text(/Running now/)).toBeUndefined()
  // Claude says how long it takes, then sends it to the background (the stub answers as the tool would).
  await $.turn.start({ text: 'x', turnId: 't1' })
  ;(globalThis as any).stepSays = 'Starting the gate run in the background; it takes about 6 minutes.'
  const s = $.turn.step({ turnId: 't1', index: 0, model: 'm', messageCount: 3 })
  for await (const _c of s) {
    // drained
  }
  await s.result
  ;(globalThis as any).stepSays = ''
  ;(globalThis as any).toolResult = { result: { backgroundTaskId: 'b7' }, text: 'Command running in background with ID: b7. Output is being written to: /tmp/tasks/b7.output.' }
  await $.tool.call({ tool: 'Bash', command: 'make a-gates', description: 'Run the gates', run_in_background: true, tool_use_id: 'u1' })
  ;(globalThis as any).toolResult = undefined
  await $.turn.complete({ answer: 'Waiting for the gates.', durationMs: 5, isAborted: false, turnId: 't1', reason: 'answer' })
  await (globalThis as any).clock.advance(120_000)
  expect(await text(/⏱️ Running now/)).toBeDefined()
  expect(await text(/^⏳ Run the gates/)).toBeDefined()
  expect(await text(/2m so far · ≈ 4m left \(Claude said ~6m\)/)).toBeDefined()
  expect(await text(/Claude is waiting on a run to finish \(the first ≈ 4m\)/)).toBeDefined()
  // Its notice ends it.
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: '<task-notification>\n<task-id>b7</task-id>\n<status>completed</status>\n<summary>Background command "make a-gates" completed (exit code 0)</summary>\n</task-notification>' }] } })
  expect(await text(/^⏳ Run the gates/)).toBeUndefined()
  expect(await text(/✅ Run the gates finished after 2m/)).toBeDefined()
  // The next run like it is timed against this one; one Claude stops by hand ends as stopped.
  ;(globalThis as any).toolResult = { result: { backgroundTaskId: 'b8' }, text: 'Command running in background with ID: b8.' }
  await $.tool.call({ tool: 'Bash', command: 'make a-gates', description: 'Run the gates again', run_in_background: true, tool_use_id: 'u2' })
  ;(globalThis as any).toolResult = undefined
  await (globalThis as any).clock.advance(30_000)
  expect(await text(/30s so far · ≈ 1m 30s left \(usually 2m, from 1 earlier run\)/)).toBeDefined()
  await $.tool.call({ tool: 'TaskStop', task_id: 'b8' })
  expect(await text(/⏹️ Run the gates again was stopped after 30s/)).toBeDefined()
})

test('goals are sized and paid: parts as the check meets them, milestones, the rest at the natural 20', async ($, on) => {
  // Sizes: what the brief asks, mostly its finish line.
  expect(sizeOfGoal('make hello.py', 0, 0)).toBe('trivial')
  expect(sizeOfGoal('Docs are done. COMPLETE when the README is rewritten, every link resolves, and the changelog is updated.', 3, 0)).toBe('medium')
  expect(sizeOfGoal('x'.repeat(3900), 3, 4)).toBe('large')
  expect(sizeOfGoal('x'.repeat(3900), 5, 4)).toBe('epic')
  expect(sizeOfPlan(4)).toBe('small')
  expect(grownTo('small', 12, 1)).toBe('medium')
  expect(grownTo('small', 3, 13)).toBe('large')
  // The scale: a trivial goal is about Lv 5, a large one Lv 13, three large ones reach Lv 20.
  expect(levelOf(SIZES.trivial.xp).level).toBe(5)
  expect(levelOf(SIZES.large.xp).level).toBe(13)
  expect(levelOf(SIZES.epic.xp).level).toBe(15)
  expect(levelOf(3 * SIZES.large.xp).level).toBe(20)
  // The d20: higher as more is met, never 20 before the pass.
  expect(rollFor(0, 1)).toBeLessThan(6)
  expect(rollFor(1, 1)).toBe(19)
  for (let round = 1; round < 30; round++) expect(rollFor(0.9, round)).toBeLessThan(20)
  expect(d20Svg(96, 6, 0).length).toBeLessThan(131_072)
  expect(d20Svg(96, 20, 0)).toContain('rotate(180.0')

  // Paid as it goes: a part met, a milestone, the rest when it passes; busywork pays nothing.
  const GOAL = 'Docs are done. COMPLETE when the README is rewritten, every link resolves, and the changelog is updated.'
  let g = change(emptyGame(), 1_000, ctx => ctx.startQuest('Docs', 'goal', GOAL, true)).game
  expect(g.quest?.size).toBe('medium')
  g = change(g, 2_000, ctx => ctx.logAction({ at: 2_000, text: 'Edited README.md', ok: true, family: 'file:/r/README.md' })).game
  expect(g.stats.xp).toBe(0)
  g = change(g, 3_000, ctx => ctx.logAction({ at: 3_000, text: 'Saved a commit to git: README', ok: true, commit: 'Rewrite the README' })).game
  expect(g.stats.xp).toBe(256)
  const checked = change(g, 4_000, ctx => ctx.setCheck('Not met.', { met: ['The README is rewritten'], todo: ['Every link resolves', 'The changelog is updated'] }))
  expect(checked.game.stats.xp).toBe(256 + 2_560)
  expect(checked.events.some(one => one.startsWith('✅ Part met: The README is rewritten (+2,560 XP)'))).toBe(true)
  expect(checked.game.quest?.roll?.n).toBeGreaterThan(1)
  expect(checked.game.quest?.roll?.n).toBeLessThan(20)
  const won = change(checked.game, 5_000, ctx => ctx.winQuest())
  expect(won.game.quest?.roll?.n).toBe(20)
  // The goal's worth in all, plus the guardian's bounty (a tenth of it).
  expect(won.game.stats.xp).toBe(12_800 + 1_280)

  // The pane: the size and worth, each part's XP, and the d20 from rolling to its verdict.
  const text = async (re: RegExp, tab: 'quest' | 'adventure' = 'quest') => {
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: `tab-${tab}` })
    const hit = await ui.find({ type: 'Text', text: re })
    await ui.unmount()

    return hit
  }
  await boot($, on)
  await $.command.run({ command: 'goal', args: GOAL })
  expect(await text(/💰 Spoils · Medium goal/, 'adventure')).toBeDefined()
  expect(await text(/0 \/ 12,800 XP/, 'adventure')).toBeDefined()
  expect(await text(/⬜ The README is rewritten \+2,560/, 'adventure')).toBeDefined()
  expect(await text(/🎲 Rolling… the goal check rolls when Claude stops/, 'adventure')).toBeDefined()
  await $.tool.call({ tool: 'Write', file_path: '/r/README.md', content: 'x' })
  await said($)
  await $.session.append({ message: { type: 'user', isMeta: true, content: [{ type: 'text', text: `Stop hook feedback:\n[${GOAL}]: Not met. The README is rewritten and committed. Every link does not resolve yet, and the changelog is not updated.` }] } })
  expect(await text(/🎲 Rolled \d+ ;\( — not yet \(goal check 1\)/, 'adventure')).toBeDefined()
  expect(await text(/✅ The README is rewritten ✓2,560/, 'adventure')).toBeDefined()
  await said($)
  await (globalThis as any).clock.advance(20_000)
  await check($)
  expect(await text(/🎲 Natural 20 — the goal passes!/, 'adventure')).toBeDefined()
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'tab-adventure' })
  expect(await ui.find({ type: 'Svg' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /🎲 Natural 20/ })).toBeDefined()
  await ui.unmount()
})

// From a long C4.1e goal chat: a compaction re-posted the goal's marker and the log called the goal won; the reopen
// then left the finish line ticked; and a clause about the HANDOFF became a condition of its own.
test('a compaction is no verdict, a reopen undoes the early win, and a describing clause stays with its condition', async ($, on) => {
  const GOAL = 'Land C4.1e. COMPLETE when TK-137 is landed, the smoke passes, and a stage-handoff HANDOFF is committed with a clean tree, its scope: line naming that rule and its next: line naming C4.2.'
  expect(goalRoad(GOAL).finish.map(item => item.text)).toEqual([
    'TK-137 is landed',
    'The smoke passes',
    'A stage-handoff HANDOFF is committed with a clean tree, its scope: line naming that rule and its next: line naming C4.2',
  ])

  // The early win, undone: the ticks it made, its natural 20, its XP and the guardian's fall.
  let g = change(emptyGame(), 1_000, ctx => ctx.startQuest('C4.1e', 'goal', GOAL, true)).game
  g = change(g, 2_000, ctx => ctx.setCheck('Not met.', { met: ['TK-137 is landed'], todo: ['The smoke passes'] })).game
  const before = { xp: g.stats.xp, roll: g.quest?.roll?.n, done: g.quest?.road?.finish.filter(item => item.status === 'done').length }
  g = change(g, 3_000, ctx => ctx.winQuest()).game
  expect(g.quest?.roll?.n).toBe(20)
  expect(g.stats.xp).toBeGreaterThan(before.xp)
  const back = change(g, 4_000, ctx => ctx.reopenQuest())
  g = back.game
  expect(g.quest?.outcome).toBeUndefined()
  expect(g.stats.xp).toBe(before.xp)
  expect(g.quest?.roll?.n).toBe(before.roll)
  expect(g.quest?.road?.finish.filter(item => item.status === 'done').length).toBe(before.done)
  expect(g.quest?.foe?.defeatedAt).toBeUndefined()
  expect(back.events.some(one => /XP is taken back/.test(one))).toBe(true)
  // Winning again pays the same as the first time.
  expect(change(g, 5_000, ctx => ctx.winQuest()).game.stats.xp).toBe(change(change(change(emptyGame(), 1_000, ctx => ctx.startQuest('C4.1e', 'goal', GOAL, true)).game, 2_000, ctx => ctx.setCheck('Not met.', { met: ['TK-137 is landed'], todo: ['The smoke passes'] })).game, 3_000, ctx => ctx.winQuest()).game.stats.xp)

  // In the pane: the agent's words, then a compaction, then the goal's marker again: not a win.
  await boot($, on)
  await $.prompt.submit({ text: `/goal ${GOAL}` })
  await $.tool.call({ tool: 'Write', file_path: '/a/one.py', content: 'x' })
  await said($, 'Partway there.')
  await (globalThis as any).clock.advance(60_000)
  await $.session.append({ message: { type: 'system', name: 'compact_boundary', content: [{ type: 'text', text: 'Conversation compacted' }] } })
  await check($, 'Goal is set.')
  let ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeUndefined()
  await ui.unmount()
  // Later, the agent finishes and the check passes: that is a win.
  await (globalThis as any).clock.advance(60_000)
  await $.tool.call({ tool: 'Write', file_path: '/a/two.py', content: 'x' })
  await said($, 'Finished.')
  await check($, 'Met.')
  ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /QUEST COMPLETE! 🏆/ })).toBeDefined()
  await ui.unmount()
})
