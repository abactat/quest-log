"""Replays a real Claude Code chat through the mod and prints what the pane showed at chosen moments.

    python3 -I tools/replay.py <transcript.jsonl> [--view quest|adventure] [--grep REGEX] [--every-stop]

It copies the mod to a temporary folder (the copy's redraw timers slowed so hours of chat replay in seconds),
turns the transcript into the events the mod hooks (goal commands, prompts, tool calls with their real results and
durations, the agent's words, goal-check feedback, goal_status rows, notices), and runs them through
`claude plugin test`. Snapshots are taken before each prompt, at each goal check, at each notice and, with
--every-stop, a minute after each stop. Nothing is sent to a model: it costs no tokens.
"""
import argparse, datetime, json, os, re, shutil, subprocess, sys, tempfile

root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ap = argparse.ArgumentParser()
ap.add_argument('transcript')
ap.add_argument('--view', default='quest', choices=['quest', 'adventure'])
ap.add_argument('--grep', default='', help='only print pane lines matching this regex (snapshot headers always print)')
ap.add_argument('--every-stop', action='store_true')
args = ap.parse_args()

rows = [json.loads(line) for line in open(args.transcript)]


def ts(r):
    t = r.get('timestamp')
    return int(datetime.datetime.fromisoformat(t.replace('Z', '+00:00')).timestamp() * 1000) if t else None


results, records = {}, {}
for r in rows:
    if r.get('type') == 'user' and isinstance((r.get('message') or {}).get('content'), list):
        for b in r['message']['content']:
            if isinstance(b, dict) and b.get('type') == 'tool_result':
                results[b['tool_use_id']] = bool(b.get('is_error'))
                c = b.get('content')
                txt = c if isinstance(c, str) else ' '.join(x.get('text', '') for x in (c or []) if isinstance(x, dict))
                tur = r.get('toolUseResult') if isinstance(r.get('toolUseResult'), dict) else {}
                records[b['tool_use_id']] = ({k: tur[k] for k in ('backgroundTaskId', 'agentId', 'isAsync') if k in tur}, txt[:400], ts(r))

ev, state = [], {'inturn': False, 'last': 0, 'said': ''}
add = ev.append


def endturn(at):
    if state['inturn']:
        add({'k': 'tc', 'at': at, 'reason': 'answer', 'answer': state['said']})
        state['inturn'] = False
        if args.every_stop:
            add({'k': 'snap', 'at': at + 60_000, 'label': 'a minute after a stop'})


def startturn(at):
    if not state['inturn']:
        add({'k': 'ts', 'at': at})
        state['inturn'] = True
        state['said'] = ''


def summary(t):
    m = re.search(r'<summary>([^<]{0,80})', t)
    return m.group(1) if m else ''


checks = 0
for i, r in enumerate(rows):
    at = max(ts(r) or state['last'], state['last'])
    state['last'] = at
    t, m = r.get('type'), r.get('message') or {}
    c = m.get('content')
    if r.get('isSidechain'):
        continue
    if t == 'user':
        texts = [c] if isinstance(c, str) else [b.get('text', '') for b in (c or []) if isinstance(b, dict) and b.get('type') == 'text']
        txt = '\n'.join(texts)
        if not txt:
            continue
        if r.get('isCompactSummary'):
            continue
        if r.get('isMeta'):
            if txt.startswith('Stop hook feedback'):
                endturn(at)
                checks += 1
                add({'k': 'app', 'at': at, 'msg': {'type': 'user', 'isMeta': True, 'content': [{'type': 'text', 'text': txt}]}})
                add({'k': 'snap', 'at': at, 'label': f'goal check {checks}: not met'})
                startturn(at)
            continue
        if '<command-name>/goal' in txt:
            endturn(at)
            add({'k': 'goal', 'at': at, 'args': txt.split('<command-args>')[1].split('</command-args>')[0]})
            add({'k': 'snap', 'at': at + 1, 'label': 'goal set'})
            continue
        if '<command-name>' in txt:
            continue
        if txt.startswith('<task-notification>'):
            add({'k': 'app', 'at': at, 'msg': {'type': 'user', 'content': [{'type': 'text', 'text': txt}]}})
            startturn(at)
            continue
        if txt.startswith('<agent-message'):
            startturn(at)
            continue
        endturn(at)
        add({'k': 'snap', 'at': at, 'label': 'before the prompt: ' + txt[:60].replace('\n', ' ')})
        add({'k': 'prompt', 'at': at, 'text': txt})
        startturn(at)
    elif t == 'assistant':
        startturn(at)
        add({'k': 'app', 'at': at, 'msg': {'type': 'assistant', 'content': [{'type': 'text', 'text': 'x'}]}})
        for b in c or []:
            if b.get('type') == 'text' and b.get('text', '').strip():
                state['said'] = b['text']
                add({'k': 'step', 'at': at, 'text': b['text']})
            if b.get('type') == 'tool_use':
                inp = dict(b.get('input') or {})
                for k, v in list(inp.items()):
                    if isinstance(v, str) and len(v) > 4000 and k != 'command':
                        inp[k] = v[:300]
                rec = records.get(b['id'], ({}, '', at))
                inp['tool_use_id'] = b['id']
                add({'k': 't', 'at': at, 'tool': b['name'], 'input': inp, 'err': results.get(b['id'], False), 'result': rec[0], 'text': rec[1], 'dt': max(0, (rec[2] or at) - at)})
    elif t == 'attachment':
        a = r.get('attachment') or {}
        if a.get('type') == 'goal_status':
            if state['inturn'] and not a.get('sentinel') and a.get('met'):
                endturn(at)
            add({'k': 'app', 'at': at, 'msg': {'type': 'attachment', 'name': 'goal_status', 'content': [{'type': 'text', 'text': 'goal'}]}})
            if not a.get('sentinel'):
                add({'k': 'snap', 'at': at + 1, 'label': 'goal check: ' + ('MET' if a.get('met') else 'not met')})
        elif a.get('type') == 'queued_command':
            pr = a.get('prompt')
            pr = pr if isinstance(pr, str) else ' '.join(x.get('text', '') for x in (pr or []) if isinstance(x, dict))
            if pr.startswith('<task-notification>'):
                add({'k': 'app', 'at': at, 'msg': {'type': 'user', 'content': [{'type': 'text', 'text': pr}]}})
                startturn(at)
            elif not pr.startswith('<agent-message'):
                add({'k': 'prompt', 'at': at, 'text': pr})
    elif t == 'system' and r.get('subtype') == 'stop_hook_summary':
        endturn(at)
    elif t == 'system' and r.get('subtype') == 'informational':
        endturn(at)
        add({'k': 'app', 'at': at, 'msg': {'type': 'system', 'name': 'informational', 'content': [{'type': 'text', 'text': str(r.get('content'))}]}})
    elif t == 'system' and r.get('subtype') == 'compact_boundary':
        endturn(at)
        add({'k': 'app', 'at': at, 'msg': {'type': 'system', 'name': 'compact_boundary', 'content': [{'type': 'text', 'text': 'Conversation compacted'}]}})
        add({'k': 'snap', 'at': at + 1, 'label': 'compacted'})
endturn(state['last'])
add({'k': 'snap', 'at': state['last'] + 1000, 'label': 'end of the chat'})

TEST = r"""
import { mock, test } from 'claude-code/testing'
import { EVENTS } from './events'

const PANE = { plugin: 'quest-log', component: 'Pane', requestId: 'quest-log', props: { title: 'Quest Log', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 80 }, view: {} } } as const
const flat = (n: any): string => (typeof n === 'string' ? n : Array.isArray(n) ? n.map(flat).join('') : n && n.children ? flat(n.children) : '')
function lines(n: any): string[] {
  if (n == null || n === false) return []
  if (typeof n === 'string') return n.trim() ? [n] : []
  if (Array.isArray(n)) return n.flatMap(lines)
  if (n.type === 'Text') { const s = flat(n).replace(/\s+/g, ' '); return /^[▀▄ ]+$/.test(s) ? [] : [s] }
  if (n.type === 'Button') return ['[' + (n.props?.label ?? flat(n.children)).replace(/\s+/g, ' ') + ']']
  if (n.type === 'Svg') return ['〔' + (n.props?.alt ?? 'picture') + '〕']
  const kids = (Array.isArray(n.children) ? n.children : [n.children]).flat(3)
  let out = kids.flatMap((c: any) => lines(c))
  if (n.props?.borderStyle) out = ['╭──', ...out.map((l: string) => '│ ' + l), '╰──']
  return out
}

test('replay', { timeoutMs: 590_000 }, async ($, on) => {
  const g = globalThis as any
  on('command.register', () => ({ value: { command: 'quest' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: any, e: any) => ({ cwd: e.cwd }))
  mock.store(on)
  const start = EVENTS[0].at - 60_000
  const clock = mock.clock(on, { now: start })
  g.now = start
  on('prompt.submit', (_: any, e: any) => ({ text: e.text }))
  on('command.run', () => ({ text: '' }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.notify', () => ({ value: undefined }))
  on('session.measure', (_: any, e: any) => ({ changed: e.changed }))
  on('session.usage', () => ({ value: { startedAt: start, context: {}, rateLimits: [] } }))
  on('tool.call', async (_: any, e: any) => {
    const ev = g.ev
    if (ev?.dt > 0) {
      await clock.advance(ev.dt)
      g.now += ev.dt
    }
    return g.err ? { result: {}, isError: true, text: ev?.text } : { result: ev?.result ?? {}, text: ev?.text }
  })
  on('turn.start', (_: any, e: any) => ({ turnId: e.turnId ?? 't1' }))
  on('turn.step', async function* (_: any, e: any) {
    return { turnId: e.turnId, index: 0, answer: g.says ?? '', toolUses: [], stopReason: 'end_turn', usage: {} } as any
  })
  on('turn.complete', () => ({ text: '' }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const keep = new RegExp(__GREP__)
  let out = ''
  let turn = 0
  for (const ev of EVENTS) {
    if (ev.at > g.now) {
      await clock.advance(ev.at - g.now)
      g.now = ev.at
    }
    if (ev.k === 'goal') await $.command.run({ command: 'goal', args: ev.args } as any)
    else if (ev.k === 'prompt') await $.prompt.submit({ text: ev.text })
    else if (ev.k === 'ts') await $.turn.start({ text: 'x', turnId: `t${++turn}` } as any)
    else if (ev.k === 'tc') await $.turn.complete({ turnId: `t${turn}`, reason: ev.reason, answer: ev.answer } as any)
    else if (ev.k === 'step') {
      g.says = ev.text
      const s = $.turn.step({ turnId: `t${turn}`, index: 0, model: 'm', messageCount: 3 } as any)
      for await (const _c of s) {
        // drained
      }
      await s.result
      g.says = ''
    } else if (ev.k === 't') {
      g.err = ev.err
      g.ev = ev
      await $.tool.call({ tool: ev.tool, ...ev.input } as any)
      g.err = false
      g.ev = undefined
    } else if (ev.k === 'app') await $.session.append({ message: ev.msg, door: 'note', origin: { kind: 'engine' }, uuid: String(ev.at) } as any)
    else if (ev.k === 'snap') {
      const p = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
      await p.press({ key: 'tab-__VIEW__' })
      const all = lines(await p.drawn()).filter(l => keep.test(l))
      await p.unmount()
      out += `\n#### ${new Date(g.now).toISOString().slice(5, 16).replace('T', ' ')} UTC · ${ev.label}\n` + all.join('\n')
    }
  }
  throw new Error('REPLAY' + out + '\nEND')
})
"""

work = tempfile.mkdtemp(prefix='quest-replay-')
mod = os.path.join(work, 'mod')
os.makedirs(mod)
for part in ('.claude-plugin', 'hooks', 'types'):
    shutil.copytree(os.path.join(root, part), os.path.join(mod, part), ignore=shutil.ignore_patterns('types'))if part == '.claude-plugin' else shutil.copytree(os.path.join(root, part), os.path.join(mod, part))
reg = os.path.join(mod, 'hooks', 'register.tsx')
src = open(reg).read()
src = re.sub(r'^const TICK_MS = \d+$', 'const TICK_MS = 100_000_000', src, flags=re.M)
src = re.sub(r'^const PROGRESS_MS = \d+$', 'const PROGRESS_MS = 100_000_000', src, flags=re.M)
open(reg, 'w').write(src)
open(os.path.join(mod, 'events.ts'), 'w').write('export const EVENTS: any[] = ' + json.dumps(ev) + '\n')
open(os.path.join(mod, 'replay.test.tsx'), 'w').write(TEST.replace('__GREP__', json.dumps(args.grep or '.')).replace('__VIEW__', args.view))
out = subprocess.run(['claude', 'plugin', 'test', mod], capture_output=True, text=True).stdout
body = out.split('Error: REPLAY', 1)[-1].split('\nEND', 1)[0] if 'Error: REPLAY' in out else out
print('\n'.join(line[2:] if line.startswith('  ') else line for line in body.splitlines()))
shutil.rmtree(work, ignore_errors=True)
