// Plain-English lines for tool calls, built from the call's own arguments:
// nothing here asks a model, so describing costs no tokens.

type Call = { tool: string; [argument: string]: unknown }

/** The tools that move the quest itself rather than doing its work. */
export const PLAN_TOOLS = new Set([
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskGet',
  'TaskList',
  'ExitPlanMode',
  'EnterPlanMode',
  'ProposeGoal',
  'ToolSearch',
  'mcp__ccd_turn__update_plan',
  'mcp__ccd_turn__wrap_up',
  'mcp__ccd_session__mark_chapter',
])

const str = (value: unknown) => (typeof value === 'string' ? value : '')

const fileName = (value: unknown) => str(value).split('/').filter(Boolean).pop() ?? 'a file'

const short = (text: string, max = 70) => {
  const one = text.replace(/\s+/g, ' ').trim()

  return one.length > max ? `${one.slice(0, max - 1)}…` : one
}

const sentence = (text: string) => {
  const one = short(text, 110)

  return one.charAt(0).toUpperCase() + one.slice(1)
}

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return short(url, 40)
  }
}

const words = (name: string) => name.replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()

/** One line saying what the call did, or null for a call not worth logging. */
export function describe(call: Call): string | null {
  const a = call
  switch (call.tool) {
    case 'Bash':
      return str(a.description) ? sentence(str(a.description)) : explainBash(str(a.command))
    case 'Read':
      return `Read ${fileName(a.file_path)}`
    case 'Edit':
    case 'MultiEdit':
      return `Edited ${fileName(a.file_path)}`
    case 'Write':
      return `Wrote ${fileName(a.file_path)}`
    case 'NotebookEdit':
      return `Edited the notebook ${fileName(a.notebook_path)}`
    case 'Grep':
      return `Searched the code for "${short(str(a.pattern), 40)}"`
    case 'Glob':
      return `Looked for files matching ${short(str(a.pattern), 40)}`
    case 'WebSearch':
      return `Searched the web for "${short(str(a.query), 60)}"`
    case 'WebFetch':
      return `Read a web page on ${host(str(a.url))}`
    case 'Agent':
    case 'Task':
      return `Sent a helper agent to ${short(str(a.description) || str(a.prompt), 60).replace(/^./, c => c.toLowerCase())}`
    case 'Skill':
      return `Used the ${str(a.skill)} skill`
    case 'AskUserQuestion':
      return 'Asked you a question'
    case 'Artifact':
      return str(a.action) && str(a.action) !== 'publish' ? `Worked with an artifact (${str(a.action)})` : 'Published a page'
    case 'SendUserFile':
      return 'Sent you a file'
    case 'Monitor':
      return 'Started watching for something to finish'
  }
  if (call.tool.startsWith('mcp__')) {
    const [, server = '', tool = ''] = call.tool.split('__')
    if (/browser/i.test(server)) return `Used the browser: ${words(tool)}`
    if (server === 'ccd_session' || server === 'ccd_turn') return null

    return `Used ${words(server.replace(/^[0-9a-f-]{20,}$/, 'a connector'))}: ${words(tool)}`
  }

  return `Used ${words(call.tool)}`
}

/** Commands that only read: listing, printing, searching, comparing, asking git what is there. */
const READ_ONLY = /^(cd|ls|cat|head|tail|sed|grep|egrep|rg|find|wc|pwd|echo|printf|which|type|stat|file|du|df|ps|env|printenv|awk|sort|uniq|cut|tr|diff|jq|test|\[|true|sleep|date|command|timeout|xargs|open|less|more|tree|basename|dirname|realpath|readlink|until|while|do|done|if|then|else|elif|fi|for|time|nl|column|comm|paste|join|md5|md5sum|shasum|sha256sum|lsof|top|uname|whoami|hostname|id|curl|python3?|\.venv\/bin\/python3?|git (status|log|diff|show|branch|ls-files|rev-parse|remote|stash list|blame|grep))\b/
const WRITES = /(^|[^<>-])>{1,2}\s*(?!\/dev\/null)[^&\s]|\bsed\s+(-[a-z]*i)|\btee\b|\brm\b|\bmv\b|\bcp\b|\bmkdir\b|\btouch\b|\bchmod\b|\bgit (add|commit|push|checkout|merge|reset|rebase|restore|stash|tag|pull|clone)\b|\bpip3? install\b|\bbrew (install|upgrade|uninstall|tap|link|unlink)\b|\buv (pip|add|sync)\b|\bnpm (i|install)\b|\bmake\b|\bpytest\b|\bpython3?\s+(?!-c)\S+\.py/

/** Splits a shell line at &&, ||, ;, | and newlines that are not inside quotes. */
function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote = ''
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (quote) {
      current += char
      if (char === '\\' && quote === '"') current += command[++i] ?? ''
      else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
      current += char
    } else if (char === '\\') {
      current += char + (command[++i] ?? '')
    } else if (char === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
      current += char
    } else if (char === ';' || char === '|' || char === '&' || char === '\n') {
      if (current.trim()) parts.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current.trim()) parts.push(current)

  return parts
}

/** True when the call only looked around: a read, a search, or a command that changes nothing. Looking never makes a step of its own. */
export function lookOnly(call: Call): boolean {
  if (['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'ToolSearch', 'TaskGet', 'TaskList'].includes(call.tool)) return true
  if (call.tool !== 'Bash') return false
  const command = str(call.command)
  if (!command || WRITES.test(command)) return false

  return splitCommand(command)
    .map(part => part.trim().replace(/^(\w+=\S+\s+)+/, '').replace(/^timeout\s+\d+\s+/, '').replace(/^\S*\/(?=[^\s/]+(\s|$))/, ''))
    .filter(Boolean)
    .every(part => READ_ONLY.test(part))
}

/** What the call works on, so more work on the same thing joins one step instead of making many. */
export function familyOf(call: Call): string {
  switch (call.tool) {
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
      return `file:${str(call.file_path)}`
    case 'NotebookEdit':
      return `file:${str(call.notebook_path)}`
    case 'Skill':
      return `skill:${str(call.skill)}`
    case 'Agent':
    case 'Task':
      return 'agent'
    case 'Bash': {
      const words = str(call.command).replace(/^(cd [^&;]+(&&|;)\s*)+/, '').trim().split(/\s+/)
      const verb = (words[0] ?? '').split('/').pop() ?? ''
      if (verb === 'git') return `git:${words[1] ?? ''}`
      if (verb === 'make') return `make:${words[1] ?? ''}`
      if (/^python3?$/.test(verb) || verb === 'pytest') return `run:${words.find(word => /\.py$/.test(word)) ?? verb}`

      return `bash:${verb}`
    }
  }

  return `tool:${call.tool}`
}

// ---- Plain English for shell commands --------------------------------------------------------------------------------
// A command with no description of its own is turned into a plain sentence by rule, never by a model: this costs no tokens.

/** Words of a command, honouring quotes (the quotes themselves are dropped). */
function shellWords(command: string): string[] {
  const out: string[] = []
  let current = ''
  let quote = ''
  let has = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (quote) {
      if (char === '\\' && quote === '"') current += command[++i] ?? ''
      else if (char === quote) quote = ''
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
      has = true
    } else if (/\s/.test(char)) {
      if (current || has) out.push(current)
      current = ''
      has = false
    } else {
      current += char
    }
  }
  if (current || has) out.push(current)

  return out
}

const base = (path: string) => (path.replace(/\/+$/, '').split('/').pop() || path).split('::')[0] ?? path

/** "a, b and c" from file arguments: the first, with how many more. */
const files = (list: string[]) => {
  const named = list.filter(one => one && !one.startsWith('-') && !/^(?:\||>|2>|&)/.test(one))
  if (named.length === 0) return 'the files'

  const glob = named.find(one => one.includes('*'))
  if (glob) {
    const ext = glob.match(/\*(\.\w+)$/)?.[1]
    const dir = glob.includes('/') ? base(glob.slice(0, glob.lastIndexOf('/'))) : ''

    return `the ${ext ? `${ext} ` : ''}files${dir ? ` in ${dir}` : ''}`
  }

  return named.length === 1 ? base(named[0] ?? '') : `${base(named[0] ?? '')} and ${named.length - 1} more`
}

const humanize = (script: string) => base(script).replace(/\.[a-z]+$/, '').replace(/[_-]+/g, ' ').trim()

const quoted = (text: string) => {
  const plain = text
    .replace(/\\[bBwWsSdD]/g, '')
    .replace(/\\\|/g, ' or ')
    .replace(/\|/g, ' or ')
    .replace(/\\([.*+?^$()[\]{}])/g, '$1')
    .replace(/[\^$]/g, '')
    .replace(/\s*\bor\b\s*(?:\bor\b\s*)+/g, ' or ')
    .replace(/\s+/g, ' ')
    .trim()

  return `“${short(plain, 38)}”`
}

/** One command (no pipes or joins) in plain English; null for noise like echo. */
function phraseOf(argv: string[], body: string): string | null {
  let w = argv.slice()
  while (['time', 'env', 'nohup', 'caffeinate', 'command'].includes(w[0] ?? '') || /^\w+=/.test(w[0] ?? '')) w.shift()
  if (w[0] === 'timeout') w = w.slice(2)
  if (w[0] === 'nice') w = w.slice(w[1] === '-n' ? 3 : 1)
  const verb = base(w[0] ?? '')
  const args = w.slice(1)
  const plain = args.filter(one => !one.startsWith('-'))
  const flags = args.filter(one => /^-[A-Za-z]+$/.test(one)).join('')
  switch (verb) {
    case 'for':
    case 'while':
    case 'until':
    case 'done':
    case 'then':
    case 'else':
    case 'fi':
    case 'if':
    case 'do':
      return verb === 'do' && args.length ? phraseOf(args, body) : null
    case 'cd':
    case 'echo':
    case 'printf':
    case 'true':
    case 'sleep':
    case 'test':
    case '[':
    case 'export':
      return verb === 'sleep' ? 'Waited a little' : null
    case 'sed': {
      const range = args.find(one => /^\d+(?:,\d+)?p$/.test(one))?.replace(/p$/, '').replace(',', '–')
      if (flags.includes('i') && !range) return `Edited ${files(plain.slice(1))} in place`

      return range ? `Read ${range.includes('–') ? `lines ${range}` : `line ${range}`} of ${files(plain.slice(1))}` : `Read ${files(plain.slice(1))}`
    }
    case 'cat':
      return `Read ${files(plain)}`
    case 'head':
    case 'tail':
      return `Read the ${verb === 'head' ? 'start' : 'end'} of ${files(plain)}`
    case 'less':
    case 'more':
      return `Read ${files(plain)}`
    case 'ls':
      return `Listed ${plain.length ? `the files in ${files(plain)}` : 'the files here'}`
    case 'tree':
      return `Looked at the folder layout of ${files(plain)}`
    case 'wc':
      return `Counted the ${flags.includes('l') ? 'lines' : 'words'} in ${files(plain)}`
    case 'grep':
    case 'egrep':
    case 'rg': {
      const pattern = plain[0] ?? ''
      const where = files(plain.slice(1))
      if (flags.includes('c')) return `Counted matches for ${quoted(pattern)} in ${where}`
      if (flags.includes('l')) return `Found which files mention ${quoted(pattern)}${plain.length > 1 ? ` in ${where}` : ''}`

      return `Searched ${plain.length > 1 ? where : 'the output'} for ${quoted(pattern)}`
    }
    case 'find':
      return `Looked for files${args.includes('-name') ? ` named ${quoted(args[args.indexOf('-name') + 1] ?? '')}` : ''} in ${files(plain.slice(0, 1))}`
    case 'ps':
      return 'Checked what is running'
    case 'git': {
      // "git -C <folder> commit": the folder is not the subcommand.
      const sub = args.find((one, i) => !one.startsWith('-') && args[i - 1] !== '-C') ?? ''
      const message = messageOf(args)
      switch (sub) {
        case 'commit':
          return `Saved a commit to git${message ? `: ${short(message, 60)}` : ''}`
        case 'add':
          return 'Staged changes in git'
        case 'status':
          return 'Checked what changed in git'
        case 'log':
          return 'Looked at recent git history'
        case 'diff':
        case 'show':
          return 'Looked at what changed in git'
        case 'branch':
          return args.includes('--show-current') ? 'Checked which git branch this is' : 'Looked at the git branches'
        case 'checkout':
        case 'switch':
          return 'Switched git branch'
        case 'tag':
          return plain.length > 2 ? 'Tagged a git commit' : 'Looked at the git tags'
        case 'bundle':
          return 'Made a git backup bundle'
        default:
          return `Ran git ${sub}`.trim()
      }
    }
    case 'mkdir':
      return `Created the folder ${files(plain)}`
    case 'cp':
      return `Copied ${files(plain.slice(0, -1))} to ${files(plain.slice(-1))}`
    case 'mv':
      return `Moved ${files(plain.slice(0, -1))} to ${files(plain.slice(-1))}`
    case 'rm':
      return `Deleted ${files(plain)}`
    case 'touch':
      return `Created an empty file ${files(plain)}`
    case 'make':
      return `Ran “make ${plain[0] ?? ''}”`.replace(' ”', '”')
    case 'uv':
    case 'pip':
    case 'pip3':
      return args.includes('install') ? `Installed ${files(plain.filter(one => one !== 'pip' && one !== 'install' && !one.startsWith('/')).slice(0, 3))}`.replace('the files', 'packages') : `Ran ${verb} ${plain[0] ?? ''}`.trim()
    case 'brew':
      return `Ran Homebrew ${plain[0] ?? ''}${plain[1] ? ` ${plain[1]}` : ''}`.trim()
    case 'curl':
    case 'wget':
      return `Fetched a web page${plain[0] ? ` from ${plain[0].replace(/^https?:\/\//, '').split('/')[0]}` : ''}`
    case 'awk':
    case 'cut':
    case 'sort':
    case 'uniq':
    case 'tr':
    case 'xargs':
    case 'jq':
    case 'diff':
      return verb === 'diff' ? `Compared ${files(plain)}` : null
    case 'cat>':
      return null
    case 'python':
    case 'python3': {
      const module = args.indexOf('-m') >= 0 ? args[args.indexOf('-m') + 1] : undefined
      if (module === 'pytest') {
        const targets = plain.filter(one => one !== 'pytest' && !/^-/.test(one) && (one.includes('/') || /\.py/.test(one)))
        const pick = args.indexOf('-k') >= 0 ? args[args.indexOf('-k') + 1] : undefined

        return `Ran ${pick ? `the tests matching “${short(pick, 30)}” in` : 'the tests in'} ${targets.length ? files(targets) : 'the test suite'}`.replace(' in the test suite', ' (the whole suite)')
      }
      // "tools.reports.gen_reachability_sweep": the last part names it.
      if (module) return `Ran the ${(module.split('.').pop() ?? module).replace(/_/g, ' ')} module`
      if (args.includes('-c')) {
        const code = args[args.indexOf('-c') + 1] ?? ''
        const imports = [...code.matchAll(/import ([\w.]+)/g)].map(match => (match[1] ?? '').split('.')[0]).filter(Boolean)

        return imports.length ? `Checked that ${[...new Set(imports)].slice(0, 3).join(', ')} load${imports.length === 1 ? 's' : ''}` : 'Ran a quick Python check'
      }
      const script = plain.find(one => /\.py$/.test(one))
      if (script) return `Ran the ${humanize(script)} script`
      const found = (body.match(/(?:p|path|f|fn|file)\s*=\s*['"]([^'"\n]+)['"]/) ?? body.match(/open\(\s*['"]([^'"\n]+)['"]/))?.[1]
      const target = found && /[\w]\.[\w]+$|\//.test(found) && found.length > 3 ? found : undefined
      const writes = /\.write\(|write_text|open\([^)]*['"][wa]b?['"]|to_csv|\bdump\(/.test(body)

      return target ? `${writes ? 'Edited' : 'Read'} ${base(target)} with a short script` : writes ? 'Wrote files with a short Python script' : 'Ran a short Python script'
    }
  }

  return null
}

/** Pipelines of a command line, each as the words of its first command (filters after a pipe are left out), heredoc bodies kept apart. */
function pipelines(command: string): { argv: string[]; redirect?: 'write' | 'append'; target?: string }[] {
  const out: { argv: string[]; redirect?: 'write' | 'append'; target?: string }[] = []
  let current = ''
  let quote = ''
  let filtered = false
  const flush = () => {
    filtered = false
    const argv = shellWords(current)
    const at = argv.findIndex(one => one === '>' || one === '>>' || /^>>?[^&]/.test(one))
    const item: { argv: string[]; redirect?: 'write' | 'append'; target?: string } = { argv }
    if (at >= 0) {
      const mark = argv[at] ?? ''
      item.redirect = mark.startsWith('>>') ? 'append' : 'write'
      item.target = mark.replace(/^>>?/, '') || argv[at + 1]
      item.argv = argv.slice(0, at)
    }
    if (item.argv.length) out.push(item)
    current = ''
  }
  for (let i = 0; i < command.length; i++) {
    const char = command[i] ?? ''
    if (quote) {
      if (!filtered) current += char
      if (char === '\\' && quote === '"') {
        const next = command[++i] ?? ''
        if (!filtered) current += next
      } else if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
      if (!filtered) current += char
    } else if ((char === '&' && command[i + 1] === '&') || (char === '|' && command[i + 1] === '|')) {
      flush()
      i++
    } else if (char === '|') {
      // What follows a pipe only filters the first command's output: it is left out.
      filtered = true
    } else if (char === ';' || char === '\n') {
      flush()
    } else if (char === '&' && (command[i - 1] === '>' || command[i + 1] === '>')) {
      if (!filtered) current += char
    } else if (char === '&') {
      flush()
    } else if (!filtered) {
      current += char
    }
  }
  flush()

  return out
}

/** A commit's message, first line only: `-m`, `-qm`, `-am`, `--message`. */
function messageOf(args: string[]): string | undefined {
  const at = args.findIndex(one => /^-[a-zA-Z]*m$/.test(one) || one === '--message')
  const message = at >= 0 ? args[at + 1] : args.find(one => one.startsWith('--message='))?.slice(10)
  // "$(cat <<'EOF'": the message is in the heredoc, which commitOf reads.
  if (message?.startsWith('$(')) return undefined

  return message?.split('\n')[0]?.trim() || undefined
}

/** Splits a command line into the shell it runs and the heredoc bodies it feeds, so commands after a heredoc count too. */
function splitHeredocs(command: string): { head: string; body: string } {
  let head = ''
  let body = ''
  let rest = command
  for (let doc = rest.match(/<<-?\s*(['"]?)(\w+)\1/); doc; doc = rest.match(/<<-?\s*(['"]?)(\w+)\1/)) {
    const after = rest.slice((doc.index ?? 0) + doc[0].length)
    const lineEnd = after.indexOf('\n')
    head += rest.slice(0, doc.index) + (lineEnd < 0 ? after : after.slice(0, lineEnd))
    if (lineEnd < 0) return { head, body }
    const end = new RegExp(`\\n\\s*${doc[2]}\\s*(?:\\n|$)`).exec(after.slice(lineEnd))
    body += end ? after.slice(lineEnd, lineEnd + end.index) : after.slice(lineEnd)
    if (!end) return { head, body }
    head += '\n'
    rest = after.slice(lineEnd + end.index + end[0].length)
  }

  return { head: head + rest, body }
}

/** The subject of each commit a shell command makes: a commit is a milestone, named by its own message. */
export function commitOf(command: string): string | undefined {
  // The message in a heredoc: `git commit -F - <<'EOF'` or `git commit -m "$(cat <<'EOF'`.
  const fed =
    command.match(/\bgit\b[^\n]*?\bcommit\b[^\n]*?(?:-F\s*-|--file[= ]-)[^\n]*?<<-?\s*(['"]?)(\w+)\1[^\n]*\n([\s\S]*?)(?:\n\s*\2\s*(?:\n|$)|$)/) ??
    command.match(/\bgit\b[^\n]*?\bcommit\b[^\n]*?-\w*m\s*"\$\(cat\s*<<-?\s*(['"]?)(\w+)\1\s*\n([\s\S]*?)(?:\n\s*\2\b|$)/)
  const fedLine = fed?.[3]?.split('\n').find(line => line.trim())?.trim()
  if (fedLine) return fedLine
  const { head } = splitHeredocs(command)
  for (const part of pipelines(head)) {
    const argv = part.argv
    const git = argv.indexOf('git')
    if (git < 0) continue
    const args = argv.slice(git + 1)
    const sub = args.find((one, i) => !one.startsWith('-') && args[i - 1] !== '-C')
    if (sub === 'commit') return messageOf(args) ?? 'Saved a commit'
  }

  return undefined
}

/** A shell command in plain English, by rule: what it did, not the command itself. */
export function explainBash(command: string): string {
  const { head, body } = splitHeredocs(command)
  const found = pipelines(head)
    .map(part => {
      const phrase = phraseOf(part.argv, body)
      const verb = base(part.argv[0] ?? '')
      if (verb === 'cat' && part.redirect) return { phrase: `${part.redirect === 'append' ? 'Added to' : 'Wrote'} ${base(part.target ?? '') || 'a file'}`, rank: 3 }
      if (part.redirect && phrase && !/^(?:Read|Searched|Listed|Counted)/.test(phrase)) return { phrase, rank: 3 }
      if (!phrase) return null
      const rank = /^(?:Saved a commit|Wrote|Added to|Edited|Created|Deleted|Moved|Copied|Installed|Tagged|Made)/.test(phrase) ? 3 : /^(?:Ran |Staged|Switched|Fetched)/.test(phrase) ? 2 : 1

      return { phrase, rank }
    })
    .filter((one): one is { phrase: string; rank: number } => !!one)
  if (found.length === 0) {
    const verb = base(shellWords(head)[0] ?? '')

    return verb ? `Ran a shell command (${verb} …)` : 'Ran a shell command'
  }
  const top = found.reduce((best, cur) => (cur.rank > best.rank ? cur : best), found[0] as { phrase: string; rank: number })
  const extra = found.length - 1
  // A commit whose message is in a heredoc: name it by that message.
  const subject = top.phrase === 'Saved a commit to git' ? commitOf(command) : undefined
  const phrase = subject && subject !== 'Saved a commit' ? `Saved a commit to git: ${short(subject, 60)}` : top.phrase

  return extra > 0 ? `${phrase} (+${extra} more)` : phrase
}
