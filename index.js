/**
 * Cost Meter — host half.
 *
 * - Registers the `costMeter` session projection: usage folded into segments
 *   priced at the moment each event was produced (see lib/core.js). The
 *   client reads it with `useProjection('costMeter')`; replay and the
 *   projection cache come from the harness, so it survives restarts.
 * - Serves three routes inside the Connection authentication fence:
 *     GET  api/cost-meter/prices   price cards + current rate window
 *     POST api/cost-meter/prices   {action:'set', currency, key, scheme, in, cache, out} | {action:'reset'}
 *     GET  api/cost-meter/balance  read-only DeepSeek account balance (?force=1 bypasses the cache)
 */
import {
  CURRENCIES, DEFAULT_PRICES, PRICE_KEYS, PROJECTION_KEY, SCHEMES, STATE_VERSION,
  applyEvent, clonePrices, initState, nextTransition, schemeAt, stateSchema, viewOf, viewSchema,
} from './lib/core.js'

export const name = 'dsh-cost-meter'
export const inject = ['sessionProjections', 'connection']

const BALANCE_TTL_MS = 30_000
const JSON_HEADERS = { 'cache-control': 'no-store' }

export function apply(ctx) {
  ctx.sessionProjections.register({
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema,
    init: initState,
    apply: applyEvent,
    wire: { viewSchema, view: viewOf },
  })

  // Edited prices live in memory only; a restart restores the official cards.
  let prices = clonePrices(DEFAULT_PRICES)

  const pricesBody = () => {
    const now = Date.now()
    return { currencies: CURRENCIES, prices, scheme: schemeAt(now), nextTransitionMs: nextTransition(now), now }
  }

  ctx.connection.fetch.register({
    path: '/api/cost-meter/prices',
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      if (request.method === 'GET') return Response.json(pricesBody(), { headers: JSON_HEADERS })
      let body
      try { body = await request.json() } catch { return Response.json({ ok: false, reason: '请求不是 JSON' }, { status: 400 }) }
      if (body?.action === 'reset') {
        prices = clonePrices(DEFAULT_PRICES)
        return Response.json({ ok: true, ...pricesBody() }, { headers: JSON_HEADERS })
      }
      if (body?.action !== 'set') return Response.json({ ok: false, reason: '未知操作' }, { status: 400 })
      const { currency, key, scheme } = body
      if (!CURRENCIES.includes(currency) || !PRICE_KEYS.includes(key) || !SCHEMES.includes(scheme)) {
        return Response.json({ ok: false, reason: '币种、模型或时段不合法' }, { status: 400 })
      }
      const rate = {}
      for (const field of ['in', 'cache', 'out']) {
        const v = Number(body[field])
        if (!Number.isFinite(v) || v < 0 || v > 1_000_000) return Response.json({ ok: false, reason: '价格必须是 0–1000000 的数字' }, { status: 400 })
        rate[field] = v
      }
      prices[key][currency][scheme] = rate
      return Response.json({ ok: true, ...pricesBody() }, { headers: JSON_HEADERS })
    },
  })

  // ---------------------------------------------------------------------
  // Balance: GET <origin>/user/balance with the key the DeepSeek adapter
  // uses. The key is resolved per request, sent only to that endpoint, and
  // never returned or logged. Host-side TTL + in-flight coalescing so every
  // open tab together makes at most one request per TTL.
  // ---------------------------------------------------------------------
  const cache = { at: 0, value: null, inflight: null }

  function adapterConfig() {
    let apiKeyEnv = 'DEEPSEEK_API_KEY'
    let baseURL = ''
    try {
      const section = ctx.get('settings')?.describe().find(d => d.ns === 'llm-deepseek')?.value
      if (typeof section?.apiKeyEnv === 'string' && section.apiKeyEnv !== '') apiKeyEnv = section.apiKeyEnv
      if (typeof section?.baseURL === 'string') baseURL = section.baseURL
    } catch { /* settings are optional */ }
    if (baseURL === '') baseURL = ctx.get('launchEnvironment')?.get('DEEPSEEK_BASE_URL')?.value ?? ''
    let origin = 'https://api.deepseek.com'
    try { if (baseURL !== '') origin = new URL(baseURL).origin } catch { /* keep default */ }
    return { apiKeyEnv, origin }
  }

  async function queryBalance() {
    const { apiKeyEnv, origin } = adapterConfig()
    const credentials = ctx.get('credentials')
    let key
    try { key = (await credentials?.resolve(apiKeyEnv))?.value } catch { key = undefined }
    if (key === undefined) key = ctx.get('launchEnvironment')?.get(apiKeyEnv)?.value
    if (typeof key !== 'string' || key === '') return { available: false, reason: `未找到 ${apiKeyEnv}（在 Settings → Models 填写 API key）`, infos: [] }

    let response
    try {
      response = await fetch(`${origin}/user/balance`, {
        headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
        signal: AbortSignal.timeout(15_000),
      })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? '查询超时' : `网络错误：${String(error?.cause?.code ?? error?.message ?? error)}`
      return { available: false, reason, infos: [] }
    }
    let data
    try { data = await response.json() } catch { data = null }
    if (!response.ok) {
      return { available: false, reason: `HTTP ${response.status}${data?.error?.message ? '：' + String(data.error.message).slice(0, 120) : ''}`, infos: [] }
    }
    const infos = Array.isArray(data?.balance_infos) ? data.balance_infos.map(info => ({
      currency: String(info.currency ?? ''),
      total: String(info.total_balance ?? ''),
      granted: String(info.granted_balance ?? ''),
      topped: String(info.topped_up_balance ?? ''),
    })) : []
    return { available: true, isAvailable: data?.is_available === true, infos, fetchedAt: Date.now() }
  }

  function balance(force) {
    if (!force && cache.value !== null && Date.now() - cache.at < BALANCE_TTL_MS) return Promise.resolve(cache.value)
    if (cache.inflight === null) {
      cache.inflight = queryBalance().then((value) => {
        cache.value = value
        cache.at = Date.now()
        return value
      }).finally(() => { cache.inflight = null })
    }
    return cache.inflight
  }

  ctx.connection.fetch.register({
    path: '/api/cost-meter/balance',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const force = new URL(request.url).searchParams.get('force') === '1'
      return Response.json(await balance(force), { headers: JSON_HEADERS })
    },
  })
}
