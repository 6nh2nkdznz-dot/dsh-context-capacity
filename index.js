/**
 * Tell the model how much of its context window the current session already
 * occupies, before each model request.
 *
 * A reading is appended to the step's messages as a user message whose source
 * is a snapshot: a later reading supersedes an earlier one, and every reading
 * names the turn and step that sampled it so the model can tell a stale
 * number from a fresh one.
 *
 * A reading reports one number only: the prompt size the provider reported for
 * the most recent request. DSH can also reprice the whole session surface, but
 * that price describes history the request pipeline never sends once a
 * compression layer rewrites requests, so it is never shown — a session under
 * compression would otherwise read as many times its own window.
 *
 * The package deliberately imports nothing from the harness. A bundle linked
 * from a local directory resolves its own specifiers from that directory's
 * node_modules chain, where the `@deepseek-ai` packages are not installed, so
 * the message shape and the config schema below are written by hand.
 */

import { randomUUID } from 'node:crypto'

/** Plugin name; also the source kind of every injected reading. */
export const name = 'context-capacity'

/** Both services must be present before the plugin activates. */
export const inject = ['tokenMeter', 'llm']

const SOURCE = 'context-capacity'

const LANGUAGES = ['en', 'zh']

const DEFAULTS = Object.freeze({
  locale: 'en',
  refreshPercent: 10,
  warnPercent: 80,
  windowTokens: undefined,
})

const NUMBER = new Intl.NumberFormat('en-US')

/**
 * Standard-schema config contract: synchronous `validate`, no dependencies.
 */
export const Config = Object.freeze({
  '~standard': Object.freeze({
    version: 1,
    vendor: 'dsh-context-capacity',
    validate(value) {
      const raw = value ?? {}
      if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
        return { issues: [{ message: 'config must be an object' }] }
      }
      const issues = []
      for (const key of Object.keys(raw)) {
        if (!Object.prototype.hasOwnProperty.call(DEFAULTS, key)) {
          issues.push({ message: `unknown option "${key}"`, path: [key] })
        }
      }
      const config = { ...DEFAULTS }
      if (raw.locale !== undefined) {
        if (typeof raw.locale !== 'string' || !LANGUAGES.includes(raw.locale)) {
          issues.push({ message: 'locale must be "en" or "zh"', path: ['locale'] })
        } else {
          config.locale = raw.locale
        }
      }
      const ranges = [['refreshPercent', 0], ['warnPercent', 1]]
      for (const [key, min] of ranges) {
        const candidate = raw[key]
        if (candidate === undefined) continue
        if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate < min || candidate > 100) {
          issues.push({ message: `${key} must be a number from ${min} to 100`, path: [key] })
        } else {
          config[key] = candidate
        }
      }
      if (raw.windowTokens !== undefined) {
        const candidate = raw.windowTokens
        if (typeof candidate !== 'number' || !Number.isInteger(candidate) || candidate <= 0) {
          issues.push({ message: 'windowTokens must be a positive integer', path: ['windowTokens'] })
        } else {
          config.windowTokens = candidate
        }
      }
      return issues.length > 0 ? { issues } : { value: Object.freeze(config) }
    },
  }),
})

/**
 * Build the user message that carries one reading.
 * @param text - the reading, already rendered.
 * @param label - section name shown in the transcript.
 * @returns a frozen user message with a snapshot source.
 */
function readingMessage(text, label) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: SOURCE,
      form: 'snapshot',
      sections: Object.freeze([Object.freeze({ name: label, text })]),
    }),
  })
}

/**
 * Render one reading for the configured language.
 * @param settings - validated plugin config.
 * @param reading - the sampled numbers.
 * @param turn - current turn number.
 * @param step - current step number.
 * @returns the message text.
 */
function render(settings, reading, turn, step) {
  const chinese = settings.locale === 'zh'
  const lines = []
  if (!reading.sampled) {
    if (reading.window === undefined) {
      lines.push(chinese
        ? `上下文容量（第 ${turn} 轮第 ${step} 步开始前）：本次会话还没有已记录的请求，该模型路由也尚未报告窗口容量。`
        : `Context capacity sampled before turn ${turn}, step ${step}: this session has no recorded request yet, and this route has not reported a context window.`)
    } else {
      lines.push(chinese
        ? `上下文容量（第 ${turn} 轮第 ${step} 步开始前）：本次会话还没有已记录的请求，窗口容量 ${NUMBER.format(reading.window)} tokens。`
        : `Context capacity sampled before turn ${turn}, step ${step}: this session has no recorded request yet; the window holds ${NUMBER.format(reading.window)} tokens.`)
    }
  } else if (reading.window === undefined) {
    lines.push(chinese
      ? `上下文容量（第 ${turn} 轮第 ${step} 步开始前，按最近一次请求实测）：已用 ${NUMBER.format(reading.used)} tokens，该模型路由尚未报告窗口容量。`
      : `Context capacity sampled before turn ${turn}, step ${step} (measured on the most recent request): ${NUMBER.format(reading.used)} tokens used; this route has not reported a context window.`)
  } else {
    const qualifier = chinese ? '按最近一次请求实测' : 'measured on the most recent request'
    lines.push(chinese
      ? `上下文容量（第 ${turn} 轮第 ${step} 步开始前，${qualifier}）：已用 ${NUMBER.format(reading.used)} / ${NUMBER.format(reading.window)} tokens（${reading.percent}%），剩余 ${NUMBER.format(reading.remaining)}。`
      : `Context capacity sampled before turn ${turn}, step ${step} (${qualifier}): ${NUMBER.format(reading.used)} of ${NUMBER.format(reading.window)} tokens used (${reading.percent}%), ${NUMBER.format(reading.remaining)} remaining.`)
  }
  if (reading.percent !== undefined && reading.percent > 100) {
    lines.push(chinese
      ? '（实测占用已超过该路由的窗口容量：可能是该路由允许超窗，或窗口取自更早的另一条路由。）'
      : '(the measured prompt exceeds this route window: the route may allow overshoot, or the window came from an earlier route.)')
  }
  if (reading.percent !== undefined && reading.percent >= settings.warnPercent) {
    lines.push(chinese
      ? '已接近上下文上限：后续的长读取先摘要或交接，不要一次性铺开。'
      : 'Approaching the context limit: summarize or hand off before the next long read.')
  }
  return lines.join('\n')
}

/**
 * Register the per-step listener.
 * @param ctx - the plugin context.
 * @param config - validated config; the schema already filled defaults.
 */
export function apply(ctx, config) {
  const settings = config ?? DEFAULTS

  /** Latest injected percentage per session — a cache, never a source of truth. */
  const lastPercent = new WeakMap()

  /** Route → context window; `null` records a lookup that reported nothing. */
  const windows = new Map()

  const contextWindowOf = async (session, selection) => {
    if (settings.windowTokens !== undefined) return settings.windowTokens
    const recorded = (() => {
      try {
        return ctx.tokenMeter.contextPressure(session).contextWindow
      } catch {
        return undefined
      }
    })()
    if (typeof recorded === 'number' && recorded > 0) return recorded
    const route = `${selection.provider}/${selection.model}`
    if (windows.has(route)) return windows.get(route) ?? undefined
    let resolved
    try {
      const info = await ctx.llm.resolveModelInfo(selection.provider, selection.model)
      resolved = info.context?.contextWindow
    } catch {
      resolved = undefined
    }
    const settled = typeof resolved === 'number' && resolved > 0 ? resolved : null
    windows.set(route, settled)
    return settled ?? undefined
  }

  const read = async (session, selection) => {
    let pressure
    try {
      pressure = ctx.tokenMeter.contextPressure(session)
    } catch {
      // A meter that cannot describe this session yields no reading, never a guess.
      return undefined
    }
    const prompt = pressure?.pressureTokens
    const used = typeof prompt === 'number' && Number.isFinite(prompt) && prompt >= 0
      ? Math.round(prompt)
      : undefined
    const window = await contextWindowOf(session, selection)
    if (used === undefined) return { sampled: false, window }
    if (window === undefined) return { sampled: true, used, window }
    return {
      sampled: true,
      used,
      window,
      percent: Math.round((used / window) * 100),
      remaining: Math.max(0, window - used),
    }
  }

  ctx.on('agent/pre-step', async ({ agent, turn, step, signal, modelSelection }, next) => {
    const decision = await next()
    if (decision.kind === 'reject' || signal.aborted) return decision

    const session = agent.session
    const reading = await read(session, modelSelection)
    if (reading === undefined || signal.aborted) return decision

    if (step !== 1) {
      const previous = lastPercent.get(session)
      const grew = reading.percent !== undefined && previous !== undefined
        && reading.percent - previous >= settings.refreshPercent
      if (!grew) return decision
    }

    if (reading.percent !== undefined) lastPercent.set(session, reading.percent)
    const label = settings.locale === 'zh' ? '上下文容量' : 'Context capacity'
    const text = render(settings, reading, turn, step)
    return { ...decision, messages: [...decision.messages, readingMessage(text, label)] }
  }, { prepend: true })
}
