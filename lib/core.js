/**
 * Cost Meter core — pure functions shared by the host plugin and the tests.
 *
 * Pricing is decided per usage event, at the moment the event was produced:
 * which official price card (model generation) applied, and which rate window
 * (old flat price / peak / off-peak). The fold records those two facts next to
 * the token buckets, so historical usage is never re-priced when the schedule
 * moves on, and a replay of the durable session log gives the same answer.
 */

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

/** Peak/off-peak pricing starts: Beijing 2026-08-17 00:00. Before it, one flat price. */
export const PEAK_PRICING_START_MS = Date.UTC(2026, 7, 16, 16, 0, 0)

/**
 * DeepSeek-V4.1-Flash (`deepseek-flash`) launch with its lower price card:
 * Beijing 2026-09-10 00:00. The release note gives the date but not the hour;
 * midnight Beijing time is assumed. From then on `deepseek-v4-flash` is routed
 * to V4.1 Flash and billed on the new card.
 */
export const FLASH_V41_START_MS = Date.UTC(2026, 8, 9, 16, 0, 0)

/** Peak hours, Beijing time, Monday to Friday except Chinese public holidays. */
export const PEAK_HOURS_BEIJING = [[9, 12], [14, 18]]

/**
 * Chinese statutory holiday days that fall on Monday–Friday (weekends are
 * off-peak anyway). Source: 国务院办公厅关于2026年部分节假日安排的通知
 * (国办发明电〔2025〕7号). Make-up working days (调休) are Saturdays or Sundays,
 * which the pricing page's "Monday to Friday" wording leaves off-peak.
 * Extend this list when the 2027 schedule is published.
 */
export const HOLIDAYS = new Set([
  '2026-01-01', '2026-01-02',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-23',
  '2026-04-06',
  '2026-05-01', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07',
])

const BEIJING_OFFSET_MS = 8 * 3600 * 1000

function beijingParts(ms) {
  const d = new Date(ms + BEIJING_OFFSET_MS)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return { date: `${y}-${m}-${day}`, weekday: d.getUTCDay(), hour: d.getUTCHours() }
}

/** Whether a Beijing calendar day can have peak hours at all. */
function isPeakDay(ms) {
  const p = beijingParts(ms)
  return p.weekday >= 1 && p.weekday <= 5 && !HOLIDAYS.has(p.date)
}

/** Rate window in force at `ms`: 'flat' | 'peak' | 'off'. */
export function schemeAt(ms) {
  if (ms < PEAK_PRICING_START_MS) return 'flat'
  if (!isPeakDay(ms)) return 'off'
  const hour = beijingParts(ms).hour
  for (const [start, end] of PEAK_HOURS_BEIJING) {
    if (hour >= start && hour < end) return 'peak'
  }
  return 'off'
}

/** The next instant after `ms` at which `schemeAt` may change (hour granularity). */
export function nextTransition(ms) {
  if (ms < PEAK_PRICING_START_MS) return PEAK_PRICING_START_MS
  const current = schemeAt(ms)
  let t = Math.floor(ms / 3600000) * 3600000 + 3600000
  // Worst case is a long holiday: step hour by hour, bounded to 16 days.
  for (let i = 0; i < 24 * 16; i++, t += 3600000) {
    if (schemeAt(t) !== current) return t
  }
  return t
}

// ---------------------------------------------------------------------------
// Price cards (per 1M tokens). Official USD and CNY cards are independent —
// their ratio is not one exchange rate — so both are kept and never converted.
// ---------------------------------------------------------------------------

export const CURRENCIES = ['USD', 'CNY']
export const SCHEMES = ['flat', 'peak', 'off']

const flashV4 = {
  USD: { flat: { in: 0.14, cache: 0.0028, out: 0.28 }, peak: { in: 0.44, cache: 0.014, out: 1.32 }, off: { in: 0.22, cache: 0.007, out: 0.66 } },
  CNY: { flat: { in: 1, cache: 0.02, out: 2 }, peak: { in: 3, cache: 0.1, out: 9 }, off: { in: 1.5, cache: 0.05, out: 4.5 } },
}
// V4.1 Flash only ever ran under peak/off pricing; `flat` mirrors `off` so a
// manual "flat" override still has a value.
const flashV41 = {
  USD: { flat: { in: 0.15, cache: 0.003, out: 0.6 }, peak: { in: 0.3, cache: 0.006, out: 1.2 }, off: { in: 0.15, cache: 0.003, out: 0.6 } },
  CNY: { flat: { in: 1, cache: 0.02, out: 4 }, peak: { in: 2, cache: 0.04, out: 8 }, off: { in: 1, cache: 0.02, out: 4 } },
}
const proV4 = {
  USD: { flat: { in: 0.435, cache: 0.003625, out: 0.87 }, peak: { in: 1.32, cache: 0.044, out: 3.96 }, off: { in: 0.66, cache: 0.022, out: 1.98 } },
  CNY: { flat: { in: 3, cache: 0.025, out: 6 }, peak: { in: 9, cache: 0.3, out: 27 }, off: { in: 4.5, cache: 0.15, out: 13.5 } },
}

/** Official cards as of 2026-09-29, keyed by price key. */
export const DEFAULT_PRICES = {
  'deepseek-flash': flashV41,
  'deepseek-v4-flash': flashV4,
  'deepseek-v4-pro': proV4,
  // Unrecognised DeepSeek model ids are priced on the current Flash card.
  'default': flashV41,
}
export const PRICE_KEYS = Object.keys(DEFAULT_PRICES)

export function clonePrices(prices) {
  return JSON.parse(JSON.stringify(prices))
}

/**
 * Which price card bills `model` for usage produced at `ms`, or null when the
 * route is not a DeepSeek one (the meter does not price other vendors).
 */
export function priceKeyFor(provider, model, ms) {
  const id = String(model || '').toLowerCase()
  const tail = id.slice(Math.max(id.lastIndexOf('/'), id.lastIndexOf(':')) + 1)
  if (!/deepseek/.test(`${String(provider || '').toLowerCase()} ${id}`)) return null
  if (/pro/.test(tail)) return 'deepseek-v4-pro'
  if (/flash/.test(tail)) return ms >= FLASH_V41_START_MS ? 'deepseek-flash' : 'deepseek-v4-flash'
  return 'default'
}

// ---------------------------------------------------------------------------
// Usage fold — a session projection unit. State is plain JSON so the host can
// persist it in the projection cache; bump STATE_VERSION whenever the fold or
// the schedule above changes meaning, so cached state is refolded.
// ---------------------------------------------------------------------------

export const PROJECTION_KEY = 'costMeter'
export const STATE_VERSION = 1

export function initState() {
  return { model: null, last: null, segments: {} }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
}

function bucketsFrom(usage) {
  return {
    uncachedInputTokens: num(usage.inputTokens),
    outputTokens: num(usage.outputTokens),
    cacheReadTokens: num(usage.cacheReadTokens),
    cacheWriteTokens: num(usage.cacheWriteTokens),
  }
}

const BUCKETS = ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

function sameBuckets(a, b) {
  return BUCKETS.every(k => a[k] === b[k])
}

/** Last usage sample of one durable assistant settlement (v2 session format). */
export function usageOf(event) {
  const data = event.data
  if (data === null || typeof data !== 'object') return undefined
  if (event.type === 'assistant/message' && data.usage != null) return data.usage
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return undefined
  const stream = Array.isArray(data.stream) ? data.stream : []
  for (let i = stream.length - 1; i >= 0; i--) {
    const record = stream[i]
    if (record && record.type === 'chunk' && record.chunk && record.chunk.type === 'usage') return record.chunk.usage
  }
  return undefined
}

/**
 * Fold one session event. Returns the same object when nothing changed.
 *
 * A repeated (turn, step) replaces the earlier sample in place — the segment
 * it was first attributed to keeps it — and `llm/retry-started` closes that
 * slot so a retried attempt adds instead. This matches the built-in
 * `tokenUsage` projection, so both meters count the same tokens.
 */
export function applyEvent(state, event) {
  if (event === null || typeof event !== 'object') return state

  if (event.type === 'request/header') {
    const config = event.data && event.data.header ? event.data.header.config : undefined
    if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
      if (state.model && state.model.provider === config.provider && state.model.model === config.model) return state
      return { ...state, model: { provider: config.provider, model: config.model } }
    }
    return state
  }

  if (event.type === 'llm/retry-started') {
    const d = event.data || {}
    return state.last && state.last.turn === d.turn && state.last.step === d.step ? { ...state, last: null } : state
  }

  const usage = usageOf(event)
  if (usage === undefined || usage === null || typeof usage !== 'object') return state
  const turn = num(event.data.turn)
  const step = num(event.data.step)
  const buckets = bucketsFrom(usage)
  const segments = { ...state.segments }

  if (state.last && state.last.turn === turn && state.last.step === step) {
    if (sameBuckets(state.last.buckets, buckets)) return state
    const seg = segments[state.last.segment]
    if (seg) {
      const next = { ...seg }
      for (const k of BUCKETS) next[k] = Math.max(0, next[k] - state.last.buckets[k] + buckets[k])
      segments[state.last.segment] = next
    }
    return { ...state, segments, last: { ...state.last, buckets } }
  }

  const provider = state.model ? state.model.provider : ''
  const model = state.model ? state.model.model : ''
  const time = typeof event.time === 'number' ? event.time : 0
  const priceKey = priceKeyFor(provider, model, time)
  const scheme = schemeAt(time)
  const id = `${provider}\u0000${model}\u0000${priceKey ?? ''}\u0000${scheme}`
  const seg = segments[id] ?? {
    provider, model, priceKey, scheme,
    uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, steps: 0,
  }
  const next = { ...seg, steps: seg.steps + 1 }
  for (const k of BUCKETS) next[k] += buckets[k]
  segments[id] = next
  return { ...state, segments, last: { turn, step, buckets, segment: id } }
}

/** What the client receives: the current model plus every priced segment. */
export function viewOf(state) {
  return { model: state.model, segments: Object.values(state.segments) }
}

/** Minimal structural check with the `parse` face the projection registry expects. */
export const stateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || value.segments === null || typeof value.segments !== 'object') {
      throw new Error('costMeter: malformed cached state')
    }
    for (const seg of Object.values(value.segments)) {
      if (seg === null || typeof seg !== 'object' || !BUCKETS.every(k => Number.isFinite(seg[k]))) {
        throw new Error('costMeter: malformed cached segment')
      }
    }
    return value
  },
}

export const viewSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || !Array.isArray(value.segments)) {
      throw new Error('costMeter: malformed view')
    }
    return value
  },
}

// ---------------------------------------------------------------------------
// Pricing a view. The client carries a copy of this function (it cannot
// import host modules); keep the two in step.
// ---------------------------------------------------------------------------

/**
 * @param view - projection view
 * @param prices - price cards keyed by price key
 * @param currency - 'USD' | 'CNY'
 * @param override - 'auto' prices each segment at its own window; a scheme name reprices everything at it
 */
export function costOf(view, prices, currency, override) {
  let total = 0
  let priced = false
  const byScheme = {}
  const byModel = {}
  for (const seg of view.segments) {
    const scheme = override === 'auto' ? seg.scheme : override
    const card = seg.priceKey ? prices[seg.priceKey] : undefined
    const rate = card && card[currency] ? card[currency][scheme] : undefined
    const cost = rate
      ? ((seg.uncachedInputTokens + seg.cacheWriteTokens) * rate.in + seg.cacheReadTokens * rate.cache + seg.outputTokens * rate.out) / 1e6
      : 0
    if (rate) { total += cost; priced = true }
    const s = byScheme[seg.scheme] ?? (byScheme[seg.scheme] = { scheme: seg.scheme, cost: 0, steps: 0 })
    s.cost += cost; s.steps += seg.steps
    const m = byModel[seg.model] ?? (byModel[seg.model] = { model: seg.model, cost: 0, priced: false })
    m.cost += cost; m.priced = m.priced || !!rate
  }
  return { total, priced, byScheme: Object.values(byScheme), byModel: Object.values(byModel) }
}
