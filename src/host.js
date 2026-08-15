/**
 * Cost Meter — Host half (pkg-5 draft: time-segmented pricing).
 *
 * This file keeps the dynamic Cordis Package shape: the body of hostPlugin()
 * (everything between its braces) is what `cordis_define` expects as
 * `code.host`. To reload as a dynamic plugin, pass the function body.
 * For a permanent install, adapt into a package default export and replace
 * `harness.handle` with the real Client<->Host RPC service (see NOTES.md).
 *
 * What changed versus pkg-4:
 *  - Pricing is computed HOST-side from the durable session event log.
 *    Every usage event carries its own `time`, so each token bucket is
 *    attributed to the rate window (flat / peak / off) that was in effect
 *    WHEN IT WAS PRODUCED. Historical segments are never re-priced by later
 *    peak/off-peak switches, and the result survives process restarts.
 *  - Per-request model attribution: each `request/header` event updates the
 *    provider/model in force, so a session that switches models is priced
 *    per model instead of by the deployment default model.
 *  - `set-price` now validates model keys and rejects arbitrary rows;
 *    `reset-prices` restores the official table.
 *  - Balance query: host-side TTL cache + in-flight coalescing, the API key
 *    travels through curl `-K -` stdin (NOT argv, so `ps` cannot see it),
 *    base URL follows the llm-deepseek settings / DEEPSEEK_BASE_URL, and
 *    exit codes / stderr / `error.message` are surfaced.
 */
export default function hostPlugin() {
  return {
    apply(ctx) {
      // ------------------------------------------------------------------
      // Rate schedule. Single source of truth: usage is priced by the
      // scheme in effect at the event timestamp (UTC).
      // ------------------------------------------------------------------
      const CUTOFF_MS = Date.UTC(2026, 7, 16, 16, 0, 0)
      const PEAK_WINDOWS = [[1, 4], [6, 10]]
      const SCHEMES = ['flat', 'peak', 'off']

      function schemeAt(ms) {
        if (ms < CUTOFF_MS) return 'flat'
        const h = new Date(ms).getUTCHours()
        for (const peakWindow of PEAK_WINDOWS) {
          if (h >= peakWindow[0] && h < peakWindow[1]) return 'peak'
        }
        return 'off'
      }

      function nextTransition(ms) {
        if (ms < CUTOFF_MS) return CUTOFF_MS
        const d = new Date(ms)
        let next = null
        for (const peakWindow of PEAK_WINDOWS) {
          for (const hour of peakWindow) {
            const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hour)
            if (t > ms && (next === null || t < next)) next = t
          }
        }
        if (next === null) next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, PEAK_WINDOWS[0][0])
        return next
      }

      // ------------------------------------------------------------------
      // Price table (per 1M tokens), dual official currency cards.
      //
      // DeepSeek publishes TWO independent price cards: a USD card (English
      // pricing page) and a CNY card (Chinese pricing page). Their ratios are
      // NOT one exchange rate (flash ≈ 7.14 CNY/USD, pro ≈ 6.90), i.e. each
      // currency is settled against its own official card. This plugin keeps
      // both cards and switches the whole meter between them — no FX source.
      // Values as of 2026-08-15.
      // ------------------------------------------------------------------
      const CURRENCIES = ['USD', 'CNY']
      const MODEL_KEYS = ['deepseek-v4-flash', 'deepseek-v4-pro', 'default']
      const defaults = [
        { key: 'deepseek-v4-flash',
          USD: { flat: { in: 0.14, cache: 0.0028, out: 0.28 }, peak: { in: 0.44, cache: 0.014, out: 1.32 }, off: { in: 0.22, cache: 0.007, out: 0.66 } },
          CNY: { flat: { in: 1, cache: 0.02, out: 2 }, peak: { in: 3.0, cache: 0.1, out: 9.0 }, off: { in: 1.5, cache: 0.05, out: 4.5 } } },
        { key: 'deepseek-v4-pro',
          USD: { flat: { in: 0.435, cache: 0.003625, out: 0.87 }, peak: { in: 1.32, cache: 0.044, out: 3.96 }, off: { in: 0.66, cache: 0.022, out: 1.98 } },
          CNY: { flat: { in: 3, cache: 0.025, out: 6 }, peak: { in: 9.0, cache: 0.3, out: 27.0 }, off: { in: 4.5, cache: 0.15, out: 13.5 } } },
        { key: 'default',
          USD: { flat: { in: 0.14, cache: 0.0028, out: 0.28 }, peak: { in: 0.44, cache: 0.014, out: 1.32 }, off: { in: 0.22, cache: 0.007, out: 0.66 } },
          CNY: { flat: { in: 1, cache: 0.02, out: 2 }, peak: { in: 3.0, cache: 0.1, out: 9.0 }, off: { in: 1.5, cache: 0.05, out: 4.5 } } },
      ]
      const prices = new Map()

      function cloneRate(rate) {
        return { in: rate.in, cache: rate.cache, out: rate.out }
      }

      function cloneCurrencyCard(card) {
        return { flat: cloneRate(card.flat), peak: cloneRate(card.peak), off: cloneRate(card.off) }
      }

      function loadDefaultPrices() {
        prices.clear()
        for (const row of defaults) {
          prices.set(row.key, { USD: cloneCurrencyCard(row.USD), CNY: cloneCurrencyCard(row.CNY) })
        }
      }

      loadDefaultPrices()

      function priceRows() {
        return {
          currencies: CURRENCIES.slice(),
          rows: [...prices.entries()].map((entry) => ({
            key: entry[0],
            USD: cloneCurrencyCard(entry[1].USD),
            CNY: cloneCurrencyCard(entry[1].CNY),
          })),
        }
      }

      function validPrice(v) {
        const n = Number(v)
        if (!Number.isFinite(n) || n < 0 || n > 1000000) return null
        return n
      }

      function validCurrency(currency) {
        return CURRENCIES.indexOf(currency) !== -1 ? currency : 'USD'
      }

      harness.handle('prices', () => priceRows())

      harness.handle('set-price', (args) => {
        if (args === null || typeof args !== 'object') return { ok: false, reason: '参数无效' }
        const key = typeof args.key === 'string' ? args.key : ''
        if (MODEL_KEYS.indexOf(key) === -1) return { ok: false, reason: '未知模型 key：' + (key === '' ? '(空)' : key) }
        if (SCHEMES.indexOf(args.scheme) === -1) return { ok: false, reason: '未知计价时段：' + String(args.scheme) }
        if (CURRENCIES.indexOf(args.currency) === -1) return { ok: false, reason: '未知币种：' + String(args.currency) }
        const inP = validPrice(args.in)
        const cacheP = validPrice(args.cache)
        const outP = validPrice(args.out)
        if (inP === null || cacheP === null || outP === null) {
          return { ok: false, reason: '价格必须是 0 到 1,000,000 之间的数字' }
        }
        const row = prices.get(key)
        row[args.currency][args.scheme] = { in: inP, cache: cacheP, out: outP }
        return { ok: true, rows: priceRows().rows, currencies: CURRENCIES.slice() }
      })

      harness.handle('reset-prices', () => {
        loadDefaultPrices()
        return { ok: true, rows: priceRows().rows, currencies: CURRENCIES.slice() }
      })

      harness.handle('rates', () => {
        const now = Date.now()
        return {
          now,
          cutoffMs: CUTOFF_MS,
          peakWindows: PEAK_WINDOWS.map((window) => ({ startHour: window[0], endHour: window[1] })),
          scheme: schemeAt(now),
          nextTransitionMs: nextTransition(now),
        }
      })

      function defaultModel() {
        const adm = ctx.get('agentDefaultModel')
        if (adm === undefined || adm === null || typeof adm.currentSelection !== 'function') {
          return { provider: '', model: '' }
        }
        try {
          const sel = adm.currentSelection()
          return {
            provider: sel !== null && sel !== undefined && typeof sel.provider === 'string' ? sel.provider : '',
            model: sel !== null && sel !== undefined && typeof sel.model === 'string' ? sel.model : '',
          }
        } catch (err) {
          return { provider: '', model: '' }
        }
      }

      // ------------------------------------------------------------------
      // Session cost engine.
      //
      // Mirrors dsh-token-meter's usage projection (replace-per-turn/step,
      // four disjoint buckets), but instead of only a running total it folds
      // the buckets into (provider, model, rate-window) segments keyed by
      // each event's timestamp. Incremental: each call walks only the new
      // log entries, so a projection push costs O(new events).
      // ------------------------------------------------------------------
      const analyses = new WeakMap()

      function usageOf(event) {
        if (event.type === 'assistant/chunk' && event.data !== null && event.data !== undefined &&
            event.data.chunk !== null && event.data.chunk !== undefined && event.data.chunk.type === 'usage') {
          return event.data.chunk.usage
        }
        if (event.type === 'assistant/message' && event.data !== null && event.data !== undefined &&
            event.data.usage !== undefined) {
          return event.data.usage
        }
        return null
      }

      function bucketsFrom(usage) {
        if (usage === null || usage === undefined || typeof usage !== 'object') return null
        const num = (v) => {
          const n = Number(v)
          return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0
        }
        return {
          uncachedInputTokens: num(usage.inputTokens),
          outputTokens: num(usage.outputTokens),
          cacheReadTokens: num(usage.cacheReadTokens),
          cacheWriteTokens: num(usage.cacheWriteTokens),
        }
      }

      function bucketsEqual(a, b) {
        return a.uncachedInputTokens === b.uncachedInputTokens &&
          a.outputTokens === b.outputTokens &&
          a.cacheReadTokens === b.cacheReadTokens &&
          a.cacheWriteTokens === b.cacheWriteTokens
      }

      function addBuckets(segment, buckets, sign) {
        const delta = sign === -1 ? -1 : 1
        segment.uncachedInputTokens = Math.max(0, segment.uncachedInputTokens + delta * buckets.uncachedInputTokens)
        segment.outputTokens = Math.max(0, segment.outputTokens + delta * buckets.outputTokens)
        segment.cacheReadTokens = Math.max(0, segment.cacheReadTokens + delta * buckets.cacheReadTokens)
        segment.cacheWriteTokens = Math.max(0, segment.cacheWriteTokens + delta * buckets.cacheWriteTokens)
      }

      function segmentKey(provider, model, scheme) {
        return String(provider) + '\u0000' + String(model) + '\u0000' + scheme
      }

      function ensureSegment(state, key, provider, model, scheme) {
        let segment = state.segments.get(key)
        if (segment === undefined) {
          segment = {
            provider: String(provider),
            model: String(model),
            scheme,
            uncachedInputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            steps: 0,
          }
          state.segments.set(key, segment)
        }
        return segment
      }

      function analyzeSession(session) {
        let state = analyses.get(session)
        if (state === undefined) {
          state = { length: 0, current: null, last: null, segments: new Map() }
          analyses.set(session, state)
        }
        const log = Array.isArray(session.log) ? session.log : []
        for (let i = state.length; i < log.length; i++) {
          const event = log[i]
          if (event === null || event === undefined || typeof event !== 'object') continue

          if (event.type === 'request/header') {
            const data = event.data
            const config = data !== null && data !== undefined && data.header !== null && data.header !== undefined ? data.header.config : null
            if (config !== null && config !== undefined && typeof config === 'object' &&
                typeof config.provider === 'string' && typeof config.model === 'string') {
              state.current = { provider: config.provider, model: config.model }
            }
          }

          const usage = usageOf(event)
          if (usage === null) continue
          const buckets = bucketsFrom(usage)
          if (buckets === null) continue
          const data = event.data
          const key = String(data !== null && data !== undefined ? data.turn : '') + '/' +
            String(data !== null && data !== undefined ? data.step : '')

          if (state.last !== null && state.last.key === key) {
            // Same turn/step: a later sample REPLACES the earlier one (chunk
            // usage replaced by the final assistant message). Correct the
            // segment in place so the step keeps one attribution.
            if (!bucketsEqual(state.last.buckets, buckets)) {
              const segment = state.segments.get(state.last.segmentKey)
              if (segment !== undefined) {
                addBuckets(segment, state.last.buckets, -1)
                addBuckets(segment, buckets, 1)
              }
              state.last.buckets = buckets
            }
            continue
          }

          const provider = state.current !== null ? state.current.provider : ''
          const model = state.current !== null ? state.current.model : ''
          const scheme = schemeAt(typeof event.time === 'number' ? event.time : Date.now())
          const keyOfSegment = segmentKey(provider, model, scheme)
          const segment = ensureSegment(state, keyOfSegment, provider, model, scheme)
          addBuckets(segment, buckets, 1)
          segment.steps += 1
          state.last = { key, buckets, segmentKey: keyOfSegment }
        }
        state.length = log.length
        return state
      }

      function isDeepSeek(provider, model) {
        const haystack = String(provider) + ' ' + String(model)
        return /deepseek/i.test(haystack)
      }

      // Model ids may arrive provider-prefixed (e.g. "deepseek/deepseek-v4-pro"
      // from a multi-provider route). Match the bare tail when it is a known
      // table key; otherwise fall back to the `default` row and mark it.
      function normalizeModel(model) {
        const raw = String(model).trim()
        if (raw === '') return raw
        if (prices.has(raw)) return raw
        const slash = raw.lastIndexOf('/')
        if (slash !== -1) {
          const tail = raw.slice(slash + 1)
          if (prices.has(tail)) return tail
        }
        const colon = raw.lastIndexOf(':')
        if (colon !== -1) {
          const tail = raw.slice(colon + 1)
          if (prices.has(tail)) return tail
        }
        return raw
      }

      function rateFor(model, scheme, currency) {
        const ccy = validCurrency(currency)
        const normalized = normalizeModel(model)
        const matched = prices.has(normalized)
        const zeroCard = { flat: { in: 0, cache: 0, out: 0 }, peak: { in: 0, cache: 0, out: 0 }, off: { in: 0, cache: 0, out: 0 } }
        const row = matched ? prices.get(normalized) : (prices.has('default') ? prices.get('default') : null)
        const card = row !== null && row[ccy] !== undefined && row[ccy] !== null ? row[ccy] : (row !== null && row.USD !== undefined ? row.USD : zeroCard)
        const rate = card[scheme] !== undefined && card[scheme] !== null ? card[scheme] : card.flat
        return { rate: rate !== undefined && rate !== null ? rate : { in: 0, cache: 0, out: 0 }, matched }
      }

      function segmentCost(segment, scheme, currency) {
        const r = rateFor(segment.model, scheme, currency)
        return {
          cost: ((segment.uncachedInputTokens + segment.cacheWriteTokens) * r.rate.in +
                 segment.cacheReadTokens * r.rate.cache +
                 segment.outputTokens * r.rate.out) / 1000000,
          matched: r.matched,
          priced: isDeepSeek(segment.provider, segment.model),
        }
      }

      function buildCostReport(state, override, currency) {
        const ccy = validCurrency(currency)
        const now = Date.now()
        const autoScheme = schemeAt(now)
        const isAuto = override !== 'flat' && override !== 'peak' && override !== 'off'
        const mode = isAuto ? 'auto' : override

        const byModel = new Map()
        const byTime = new Map()

        for (const entry of state.segments.entries()) {
          const segment = entry[1]
          const scheme = isAuto ? segment.scheme : mode
          const priced = segmentCost(segment, scheme, ccy)

          const modelKey = segmentKey(segment.provider, segment.model, '')
          let modelTotal = byModel.get(modelKey)
          if (modelTotal === undefined) {
            modelTotal = {
              provider: segment.provider,
              model: segment.model,
              cost: 0,
              priced: true,
              matched: true,
              uncachedInputTokens: 0,
              outputTokens: 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              steps: 0,
            }
            byModel.set(modelKey, modelTotal)
          }
          modelTotal.uncachedInputTokens += segment.uncachedInputTokens
          modelTotal.outputTokens += segment.outputTokens
          modelTotal.cacheReadTokens += segment.cacheReadTokens
          modelTotal.cacheWriteTokens += segment.cacheWriteTokens
          modelTotal.steps += segment.steps
          modelTotal.cost += priced.priced ? priced.cost : 0
          modelTotal.priced = modelTotal.priced && priced.priced
          modelTotal.matched = modelTotal.matched && priced.matched

          if (isAuto) {
            let timeTotal = byTime.get(scheme)
            if (timeTotal === undefined) {
              timeTotal = {
                scheme,
                cost: 0,
                uncachedInputTokens: 0,
                outputTokens: 0,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
                steps: 0,
              }
              byTime.set(scheme, timeTotal)
            }
            timeTotal.uncachedInputTokens += segment.uncachedInputTokens
            timeTotal.outputTokens += segment.outputTokens
            timeTotal.cacheReadTokens += segment.cacheReadTokens
            timeTotal.cacheWriteTokens += segment.cacheWriteTokens
            timeTotal.steps += segment.steps
            timeTotal.cost += priced.priced ? priced.cost : 0
          }
        }

        let totalCost = 0
        let anyPriced = false
        const models = []
        for (const entry of byModel.entries()) {
          const model = entry[1]
          const report = {
            provider: model.provider,
            model: model.model,
            cost: model.cost,
            priced: model.priced,
            matched: model.matched,
            tokens: {
              uncachedInputTokens: model.uncachedInputTokens,
              outputTokens: model.outputTokens,
              cacheReadTokens: model.cacheReadTokens,
              cacheWriteTokens: model.cacheWriteTokens,
            },
            steps: model.steps,
          }
          models.push(report)
          if (model.priced) {
            totalCost += model.cost
            anyPriced = true
          }
        }

        const timeSegments = []
        const schemeOrder = ['flat', 'peak', 'off']
        for (const scheme of schemeOrder) {
          const total = byTime.get(scheme)
          if (total === undefined) continue
          timeSegments.push({
            scheme: total.scheme,
            cost: total.cost,
            tokens: {
              uncachedInputTokens: total.uncachedInputTokens,
              outputTokens: total.outputTokens,
              cacheReadTokens: total.cacheReadTokens,
              cacheWriteTokens: total.cacheWriteTokens,
            },
            steps: total.steps,
          })
        }

        const totals = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
        let totalSteps = 0
        for (const entry of state.segments.entries()) {
          const segment = entry[1]
          totals.uncachedInputTokens += segment.uncachedInputTokens
          totals.outputTokens += segment.outputTokens
          totals.cacheReadTokens += segment.cacheReadTokens
          totals.cacheWriteTokens += segment.cacheWriteTokens
          totalSteps += segment.steps
        }

        const latest = state.current !== null ? state.current : defaultModel()
        return {
          available: true,
          now,
          cutoffMs: CUTOFF_MS,
          currency: ccy,
          currencies: CURRENCIES.slice(),
          mode,
          autoScheme,
          scheme: isAuto ? autoScheme : mode,
          nextTransitionMs: nextTransition(now),
          cost: totalCost,
          priced: anyPriced,
          provider: latest.provider,
          model: latest.model,
          modelSource: state.current !== null ? 'session' : 'default',
          tokens: totals,
          steps: totalSteps,
          models,
          timeSegments,
        }
      }

      harness.handle('session-cost', (args) => {
        const sessionId = args !== null && args !== undefined && typeof args === 'object' && typeof args.sessionId === 'string' ? args.sessionId : ''
        if (sessionId === '') return { available: false, reason: '缺少 sessionId', sessionId: '' }
        const override = args !== null && args !== undefined && typeof args === 'object' &&
          (args.scheme === 'flat' || args.scheme === 'peak' || args.scheme === 'off') ? args.scheme : 'auto'
        const currency = args !== null && args !== undefined && typeof args === 'object' && typeof args.currency === 'string'
          ? validCurrency(args.currency) : 'USD'

        const sessions = ctx.get('sessions')
        if (sessions === undefined || sessions === null || typeof sessions.get !== 'function') {
          return { available: false, reason: 'sessions 服务不可用', sessionId }
        }
        let session = null
        try {
          session = sessions.get(sessionId)
        } catch (err) {
          session = null
        }
        if (session === null || session === undefined || typeof session !== 'object' || !Array.isArray(session.log)) {
          return { available: false, reason: '会话未加载到当前进程（请先打开该会话）', sessionId }
        }
        const report = buildCostReport(analyzeSession(session), override, currency)
        report.sessionId = sessionId
        return report
      })

      // ------------------------------------------------------------------
      // Balance query. READ-ONLY account balance for the credential the
      // DeepSeek LLM adapter uses. The key is resolved through the
      // credentials seam, passed to curl via `-K -` stdin (never argv),
      // used once, and never returned or logged. Host-side TTL cache +
      // in-flight coalescing so N open sessions make at most one request.
      // ------------------------------------------------------------------
      const BALANCE_TTL_MS = 30000
      const balanceCache = { at: 0, value: null, inflight: null }

      function cleanBaseUrl(value) {
        if (typeof value !== 'string') return ''
        const trimmed = value.trim().replace(/\/+$/, '')
        if (!/^https?:\/\//.test(trimmed)) return ''
        return trimmed
      }

      function strValue(value) {
        if (value === null || value === undefined) return ''
        if (typeof value === 'number' && Number.isFinite(value)) return String(value)
        if (typeof value === 'string') return value
        return ''
      }

      function firstLine(text) {
        const lines = String(text || '').split(/\r?\n/)
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed !== '') return trimmed.slice(0, 160)
        }
        return ''
      }

      async function queryBalance() {
        // Follow the adapter's own configuration: the llm-deepseek settings
        // section wins, then DEEPSEEK_BASE_URL from the launch environment,
        // then the public endpoint.
        let apiKeyEnv = 'DEEPSEEK_API_KEY'
        let baseURL = 'https://api.deepseek.com'
        const settings = ctx.get('settings')
        if (settings !== undefined && settings !== null && typeof settings.get === 'function') {
          try {
            const section = settings.get('llm-deepseek')
            if (section !== null && section !== undefined && typeof section === 'object') {
              if (typeof section.apiKeyEnv === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(section.apiKeyEnv)) apiKeyEnv = section.apiKeyEnv
              const configured = cleanBaseUrl(section.baseURL)
              if (configured !== '') baseURL = configured
            }
          } catch (err) { /* keep defaults */ }
        }
        if (baseURL === 'https://api.deepseek.com') {
          const launchEnvironment = ctx.get('launchEnvironment')
          if (launchEnvironment !== undefined && launchEnvironment !== null && typeof launchEnvironment.get === 'function') {
            try {
              const env = launchEnvironment.get('DEEPSEEK_BASE_URL')
              if (env !== null && env !== undefined && typeof env.value === 'string') {
                const configured = cleanBaseUrl(env.value)
                if (configured !== '') baseURL = configured
              }
            } catch (err) { /* keep defaults */ }
          }
        }

        const credentials = ctx.get('credentials')
        let key = null
        if (credentials !== undefined && credentials !== null && typeof credentials.resolve === 'function') {
          try {
            const hit = await credentials.resolve(apiKeyEnv)
            if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value !== '') key = hit.value
          } catch (err) { key = null }
        }
        if (key === null) {
          return { available: false, reason: '无法解析 ' + apiKeyEnv + ' 凭证（未配置或凭证服务不可用）', infos: [] }
        }
        key = key.trim()
        if (key === '') {
          return { available: false, reason: apiKeyEnv + ' 凭证为空', infos: [] }
        }
        if (/[\r\n"\\]/.test(key)) {
          return { available: false, reason: apiKeyEnv + ' 凭证包含非法字符，已拒绝用于余额查询', infos: [] }
        }

        const subprocess = ctx.get('subprocess')
        if (subprocess === undefined || subprocess === null || typeof subprocess.resolveExecutable !== 'function' || typeof subprocess.spawn !== 'function') {
          return { available: false, reason: 'subprocess 服务不可用', infos: [] }
        }

        let exe = null
        try { exe = await subprocess.resolveExecutable('curl') } catch (err) { exe = null }
        if (exe === null || exe === undefined || exe === '') {
          return { available: false, reason: '未找到 curl 可执行文件', infos: [] }
        }

        const url = baseURL + '/user/balance'
        // curl `-K -` reads its config from stdin; stdin is closed by the
        // subprocess service after this batch payload, so the key exists only
        // in memory — never in argv, never in a file.
        const configText = 'header = "Authorization: Bearer ' + key + '"\n'

        let handle = null
        try {
          handle = subprocess.spawn({
            argv: [exe, '-sS', '-m', '15', '-K', '-', url],
            cwd: '/',
            stdio: {
              stdin: { data: configText },
              stdout: { maxBytes: 65536 },
              stderr: { maxBytes: 4096 },
            },
            graceMs: 5000,
          })
        } catch (err) {
          return { available: false, reason: '无法启动余额查询进程', infos: [] }
        }

        let outcome = null
        try {
          outcome = await handle.done
        } catch (err) {
          return { available: false, reason: '余额查询进程启动失败', infos: [] }
        }

        function readText(reader) {
          try {
            if (reader !== null && reader !== undefined && typeof reader.readFrom === 'function') {
              const read = reader.readFrom(0)
              if (read !== null && read !== undefined && typeof read.text === 'string') return read.text
            }
          } catch (err) { /* ignore */ }
          return ''
        }

        const stdoutText = handle.collected !== null && handle.collected !== undefined && handle.collected.stdout !== undefined
          ? readText(handle.collected.stdout) : ''
        const stderrText = handle.collected !== null && handle.collected !== undefined && handle.collected.stderr !== undefined
          ? readText(handle.collected.stderr) : ''

        const exitCode = outcome !== null && typeof outcome === 'object' && outcome.exitCode !== undefined && outcome.exitCode !== null
          ? outcome.exitCode : null
        if (exitCode !== 0) {
          if (exitCode === 28) return { available: false, reason: '余额接口请求超时（15 秒）', infos: [] }
          if (exitCode === 6) return { available: false, reason: '无法解析余额接口域名：' + baseURL, infos: [] }
          const hint = firstLine(stderrText)
          return {
            available: false,
            reason: '余额接口请求失败（exit ' + String(exitCode) + (hint !== '' ? '：' + hint : '') + '）',
            infos: [],
          }
        }

        let payload = null
        try {
          payload = JSON.parse(stdoutText)
        } catch (err) {
          const hint = firstLine(stdoutText)
          return {
            available: false,
            reason: '余额接口响应不是有效 JSON' + (hint !== '' ? '：' + hint : ''),
            infos: [],
          }
        }

        if (payload !== null && typeof payload === 'object') {
          if (payload.error !== null && payload.error !== undefined && typeof payload.error === 'object' &&
              typeof payload.error.message === 'string') {
            return { available: false, reason: '余额接口错误：' + payload.error.message, infos: [] }
          }
          if (Array.isArray(payload.balance_infos)) {
            const infos = []
            for (const info of payload.balance_infos) {
              if (info === null || info === undefined || typeof info !== 'object') continue
              infos.push({
                currency: typeof info.currency === 'string' ? info.currency : '',
                total: strValue(info.total_balance),
                granted: strValue(info.granted_balance),
                topped: strValue(info.topped_up_balance),
              })
            }
            if (infos.length > 0) {
              return {
                available: true,
                infos,
                queriedAt: Date.now(),
                baseURL,
                isAvailable: payload.is_available !== false,
              }
            }
            if (payload.is_available === false) return { available: false, reason: '余额接口不可用（is_available=false）', infos: [] }
            return { available: false, reason: '余额接口返回空列表', infos: [] }
          }
          if (payload.is_available === false) return { available: false, reason: '余额接口不可用（is_available=false）', infos: [] }
        }
        return { available: false, reason: '余额接口响应无法解析', infos: [] }
      }

      harness.handle('balance', (args) => {
        const force = args !== null && args !== undefined && typeof args === 'object' && args.force === true
        const now = Date.now()
        if (!force && balanceCache.value !== null && now - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value
        if (balanceCache.inflight !== null) return balanceCache.inflight

        const pending = queryBalance().then((value) => {
          balanceCache.value = value
          balanceCache.at = Date.now()
          balanceCache.inflight = null
          return value
        }, (err) => {
          const message = err !== null && err !== undefined && err.message !== undefined ? err.message : String(err)
          const value = { available: false, reason: '余额查询异常：' + message, infos: [] }
          balanceCache.value = value
          balanceCache.at = Date.now()
          balanceCache.inflight = null
          return value
        })
        balanceCache.inflight = pending
        return pending
      })
    },
  }
}
