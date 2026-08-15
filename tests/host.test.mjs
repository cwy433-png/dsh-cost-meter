import { test } from 'node:test'
import assert from 'node:assert/strict'
import hostPlugin from '../src/host.js'

const CUTOFF_MS = Date.UTC(2026, 7, 16, 16, 0, 0)
const BEFORE = Date.UTC(2026, 7, 15, 12, 0, 0) // flat window
const OFF = Date.UTC(2026, 7, 16, 18, 0, 0) // after cutoff, 18:00 UTC -> off
const PEAK = Date.UTC(2026, 7, 17, 2, 0, 0) // 02:00 UTC -> peak

function makeHarness() {
  const handlers = new Map()
  return {
    handlers,
    handle(method, fn) {
      handlers.set(method, fn)
      return () => handlers.delete(method)
    },
  }
}

function makeCtx(services) {
  return { get: (name) => services[name] }
}

function bootHost(services = {}) {
  const harness = makeHarness()
  const ctx = makeCtx(services)
  // `harness` is a closure symbol injected by the dynamic-plugin runner; the
  // host source references it as a free variable, so expose it for apply().
  const previous = globalThis.harness
  globalThis.harness = harness
  try {
    hostPlugin().apply(ctx)
  } finally {
    if (previous === undefined) delete globalThis.harness
    else globalThis.harness = previous
  }
  return { harness, ctx }
}

function session(log = []) {
  return { id: 's1', log }
}

function sessionsFor(log) {
  return { get: (id) => (id === 's1' ? session(log) : null) }
}

function headerEvent(provider, model, time) {
  return { type: 'request/header', time, data: { header: { config: { provider, model } } } }
}

function usage(inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function messageEvent(turn, step, usageValue, time) {
  return { type: 'assistant/message', time, data: { turn, step, usage: usageValue } }
}

function chunkEvent(turn, step, usageValue, time) {
  return { type: 'assistant/chunk', time, data: { turn, step, chunk: { type: 'usage', usage: usageValue } } }
}

async function sessionCost(harness, log, scheme = 'auto', currency = 'USD') {
  const handler = harness.handlers.get('session-cost')
  return handler({ sessionId: 's1', scheme, currency })
}

function closeTo(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) < eps, `expected ${actual} ≈ ${expected}`)
}

test('flat window: tokens are priced with the old flat rates', async () => {
  const log = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 1e6, 1e6, 0), BEFORE),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log)
  assert.equal(report.available, true)
  assert.equal(report.mode, 'auto')
  assert.equal(report.timeSegments.length, 1)
  assert.equal(report.timeSegments[0].scheme, 'flat')
  // 0.14 (miss) + 0.0028 (cache read) + 0.28 (output)
  closeTo(report.cost, 0.4228)
  assert.equal(report.tokens.uncachedInputTokens, 1e6)
  assert.equal(report.tokens.cacheReadTokens, 1e6)
  assert.equal(report.steps, 1)
})

test('segments are priced at the rate of their own event time (no retroactive repricing)', async () => {
  const log = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 1e6), BEFORE), // flat: 0.14 + 0.28
    messageEvent(2, 1, usage(1e6, 1e6), OFF), // off: 0.22 + 0.66
    messageEvent(3, 1, usage(1e6, 1e6), PEAK), // peak: 0.44 + 1.32
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log)
  assert.equal(report.available, true)
  const byScheme = Object.fromEntries(report.timeSegments.map((s) => [s.scheme, s.cost]))
  closeTo(byScheme.flat, 0.42)
  closeTo(byScheme.off, 0.88)
  closeTo(byScheme.peak, 1.76)
  closeTo(report.cost, 3.06)
})

test('model changes inside one session are attributed per request header', async () => {
  const log = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 2000),
    messageEvent(1, 1, usage(1e6, 1e6), BEFORE - 1000),
    headerEvent('deepseek-official', 'deepseek-v4-pro', BEFORE - 500),
    messageEvent(2, 1, usage(1e6, 1e6), BEFORE),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log)
  assert.equal(report.models.length, 2)
  const costs = Object.fromEntries(report.models.map((m) => [m.model, m.cost]))
  closeTo(costs['deepseek-v4-flash'], 0.42) // 0.14 + 0.28
  closeTo(costs['deepseek-v4-pro'], 1.305) // 0.435 + 0.87
  closeTo(report.cost, 1.725)
  assert.equal(report.modelSource, 'session')
})

test('chunk usage is replaced by the final message of the same turn/step', async () => {
  const log = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 2000),
    chunkEvent(1, 1, usage(500, 100), BEFORE - 1000),
    messageEvent(1, 1, usage(1000, 200), BEFORE - 500),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log)
  assert.equal(report.tokens.uncachedInputTokens, 1000)
  assert.equal(report.tokens.outputTokens, 200)
  assert.equal(report.steps, 1)
  closeTo(report.cost, (1000 * 0.14 + 200 * 0.28) / 1e6)
})

test('cache read and cache write use their own rates', async () => {
  const readLog = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 0, 1e6, 0), BEFORE),
  ]
  const readHost = bootHost({ sessions: sessionsFor(readLog) })
  const readReport = await sessionCost(readHost.harness, readLog)
  closeTo(readReport.cost, 0.14 + 0.0028)

  const writeLog = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 1000),
    messageEvent(1, 1, usage(0, 0, 0, 1e6), BEFORE),
  ]
  const writeHost = bootHost({ sessions: sessionsFor(writeLog) })
  const writeReport = await sessionCost(writeHost.harness, writeLog)
  closeTo(writeReport.cost, 0.14)
})

test('provider-prefixed model ids normalize to the known price row', async () => {
  const log = [
    headerEvent('pi-ai', 'deepseek/deepseek-v4-pro', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 1e6), BEFORE),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log)
  assert.equal(report.priced, true)
  assert.equal(report.models[0].matched, true)
  closeTo(report.cost, 0.435 + 0.87)
})

test('non-DeepSeek providers are never priced with the DeepSeek table', async () => {
  const log = [
    headerEvent('anthropic', 'claude-sonnet', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 1e6), BEFORE),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log)
  assert.equal(report.priced, false)
  assert.equal(report.models[0].priced, false)
  assert.equal(report.cost, 0)
})

test('CNY uses its own official price card, not an FX conversion of USD', async () => {
  const log = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 1e6, 1e6, 0), BEFORE),
    messageEvent(2, 1, usage(1e6, 1e6), OFF),
    messageEvent(3, 1, usage(1e6, 1e6), PEAK),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log, 'auto', 'CNY')
  assert.equal(report.currency, 'CNY')
  const byScheme = Object.fromEntries(report.timeSegments.map((s) => [s.scheme, s.cost]))
  // flash CNY flat: 1 (miss) + 0.02 (hit) + 2 (out); off: 1.5 + 4.5; peak: 3 + 9
  closeTo(byScheme.flat, 3.02)
  closeTo(byScheme.off, 6)
  closeTo(byScheme.peak, 12)
  closeTo(report.cost, 21.02)

  const manual = await sessionCost(harness, log, 'peak', 'CNY')
  // manual peak reprices ALL three steps: (3 + 0.1 + 9) + (3 + 9) + (3 + 9)
  closeTo(manual.cost, 36.1)
})

test('prices RPC exposes both currency cards', async () => {
  const { harness } = bootHost()
  const payload = await harness.handlers.get('prices')({})
  assert.deepEqual(payload.currencies, ['USD', 'CNY'])
  const flash = payload.rows.find((row) => row.key === 'deepseek-v4-flash')
  assert.equal(flash.USD.flat.in, 0.14)
  assert.equal(flash.CNY.flat.in, 1)
  assert.equal(flash.CNY.off.out, 4.5)
})

test('set-price validates keys, schemes, currency and numeric bounds; reset restores defaults', async () => {
  const log = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 1e6, 1e6), BEFORE),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const setPrice = harness.handlers.get('set-price')
  const resetPrices = harness.handlers.get('reset-prices')

  const badKey = await setPrice({ currency: 'USD', key: 'evil', scheme: 'flat', in: 1, cache: 1, out: 1 })
  assert.equal(badKey.ok, false)
  const badNumber = await setPrice({ currency: 'USD', key: 'deepseek-v4-flash', scheme: 'flat', in: -1, cache: 1, out: 1 })
  assert.equal(badNumber.ok, false)
  const badScheme = await setPrice({ currency: 'USD', key: 'deepseek-v4-flash', scheme: 'nope', in: 1, cache: 1, out: 1 })
  assert.equal(badScheme.ok, false)
  const badCurrency = await setPrice({ currency: 'EUR', key: 'deepseek-v4-flash', scheme: 'flat', in: 1, cache: 1, out: 1 })
  assert.equal(badCurrency.ok, false)

  const changed = await setPrice({ currency: 'USD', key: 'deepseek-v4-flash', scheme: 'flat', in: 1, cache: 2, out: 3 })
  assert.equal(changed.ok, true)
  const payload = await harness.handlers.get('prices')({})
  const flash = payload.rows.find((row) => row.key === 'deepseek-v4-flash')
  assert.deepEqual(flash.USD.flat, { in: 1, cache: 2, out: 3 })
  // CNY card must be untouched by a USD edit.
  assert.equal(flash.CNY.flat.in, 1)

  const priced = await sessionCost(harness, log)
  closeTo(priced.cost, 1 + 2 + 3)

  const cnyChanged = await setPrice({ currency: 'CNY', key: 'deepseek-v4-flash', scheme: 'off', in: 10, cache: 0.5, out: 20 })
  assert.equal(cnyChanged.ok, true)
  const cnyPriced = await sessionCost(harness, log, 'off', 'CNY')
  closeTo(cnyPriced.cost, 10 + 0.5 + 20)

  const reset = await resetPrices({})
  assert.equal(reset.ok, true)
  const payloadAfter = await harness.handlers.get('prices')({})
  const flashAfter = payloadAfter.rows.find((row) => row.key === 'deepseek-v4-flash')
  assert.equal(flashAfter.USD.flat.in, 0.14)
  assert.equal(flashAfter.CNY.off.in, 1.5)
})

test('rates handler reports cutoff and peak windows', async () => {
  const { harness } = bootHost()
  const rates = await harness.handlers.get('rates')({})
  assert.equal(rates.cutoffMs, CUTOFF_MS)
  assert.equal(rates.peakWindows.length, 2)
  assert.ok(rates.nextTransitionMs > rates.now)
})

test('manual scheme override reprices all history with the selected row', async () => {
  const log = [
    headerEvent('deepseek-official', 'deepseek-v4-flash', BEFORE - 1000),
    messageEvent(1, 1, usage(1e6, 1e6), BEFORE),
  ]
  const { harness } = bootHost({ sessions: sessionsFor(log) })
  const report = await sessionCost(harness, log, 'peak')
  assert.equal(report.mode, 'peak')
  closeTo(report.cost, 0.44 + 1.32)
  assert.equal(report.timeSegments.length, 0)
})

test('missing session and missing sessions service report distinct reasons', async () => {
  const none = bootHost({ sessions: { get: () => null } })
  const missingSession = await sessionCost(none.harness, [])
  assert.equal(missingSession.available, false)
  assert.match(missingSession.reason, /未加载|请先打开/)

  const noService = bootHost()
  const missingService = await noService.harness.handlers.get('session-cost')({ sessionId: 's1', scheme: 'auto' })
  assert.equal(missingService.available, false)
  assert.match(missingService.reason, /sessions 服务不可用/)
})

function balanceHandle({ exitCode = 0, stdout = '', stderr = '' } = {}) {
  const reader = (text) => ({ readFrom: () => ({ text, nextOffset: text.length, lossy: false }) })
  return {
    done: Promise.resolve({ exitCode, signal: null }),
    collected: { stdout: reader(stdout), stderr: reader(stderr) },
  }
}

test('balance: multi-currency entries, host cache, force refresh, key via stdin only', async () => {
  let spawnCount = 0
  let lastSpec = null
  const resolvedNames = []
  const subprocess = {
    resolveExecutable: async (name) => (name === 'curl' ? '/usr/bin/curl' : null),
    spawn: (spec) => {
      spawnCount += 1
      lastSpec = spec
      return balanceHandle({
        stdout: JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: 'CNY', total_balance: '10.50', granted_balance: '1.00', topped_up_balance: '9.50' },
            { currency: 'USD', total_balance: '12.34', granted_balance: '0', topped_up_balance: '12.34' },
          ],
        }),
      })
    },
  }
  const credentials = {
    resolve: async (name) => {
      resolvedNames.push(name)
      return { value: 'sk-secret-123' }
    },
  }
  const { harness } = bootHost({ subprocess, credentials })
  const balance = harness.handlers.get('balance')

  const first = await balance({})
  assert.equal(first.available, true)
  assert.equal(first.infos.length, 2)
  assert.equal(first.infos.find((i) => i.currency === 'USD').total, '12.34')
  assert.equal(spawnCount, 1)

  // Key must never appear in argv; it travels in the curl -K stdin config.
  const argvText = JSON.stringify(lastSpec.argv)
  assert.ok(!argvText.includes('sk-secret-123'), 'key leaked into argv')
  assert.ok(lastSpec.stdio.stdin.data.includes('Authorization: Bearer sk-secret-123'))
  assert.equal(lastSpec.argv[lastSpec.argv.length - 1], 'https://api.deepseek.com/user/balance')

  // Cache hit: no second spawn.
  const second = await balance({})
  assert.equal(spawnCount, 1)
  assert.equal(second.infos.length, 2)

  // Forced refresh bypasses the TTL.
  await balance({ force: true })
  assert.equal(spawnCount, 2)
})

test('balance: curl timeout, invalid JSON and API error bodies surface useful reasons', async () => {
  const timeoutSubprocess = {
    resolveExecutable: async () => '/usr/bin/curl',
    spawn: () => balanceHandle({ exitCode: 28, stderr: 'curl: (28) timed out\n' }),
  }
  const timeoutHost = bootHost({ subprocess: timeoutSubprocess, credentials: { resolve: async () => ({ value: 'sk-x' }) } })
  const timeout = await timeoutHost.harness.handlers.get('balance')({ force: true })
  assert.equal(timeout.available, false)
  assert.match(timeout.reason, /超时/)

  const jsonSubprocess = {
    resolveExecutable: async () => '/usr/bin/curl',
    spawn: () => balanceHandle({ exitCode: 0, stdout: '<html>gateway error</html>' }),
  }
  const jsonHost = bootHost({ subprocess: jsonSubprocess, credentials: { resolve: async () => ({ value: 'sk-x' }) } })
  const invalid = await jsonHost.harness.handlers.get('balance')({ force: true })
  assert.equal(invalid.available, false)
  assert.match(invalid.reason, /不是有效 JSON/)

  const apiErrorSubprocess = {
    resolveExecutable: async () => '/usr/bin/curl',
    spawn: () => balanceHandle({ exitCode: 0, stdout: JSON.stringify({ error: { message: 'Invalid API key' } }) }),
  }
  const apiErrorHost = bootHost({ subprocess: apiErrorSubprocess, credentials: { resolve: async () => ({ value: 'sk-x' }) } })
  const apiError = await apiErrorHost.harness.handlers.get('balance')({ force: true })
  assert.equal(apiError.available, false)
  assert.match(apiError.reason, /Invalid API key/)
})

test('balance: follows llm-deepseek settings for baseURL and apiKeyEnv', async () => {
  const resolvedNames = []
  let lastSpec = null
  const subprocess = {
    resolveExecutable: async () => '/usr/bin/curl',
    spawn: (spec) => {
      lastSpec = spec
      return balanceHandle({ stdout: JSON.stringify({ balance_infos: [{ currency: 'USD', total_balance: '1' }] }) })
    },
  }
  const settings = {
    get: (ns) => (ns === 'llm-deepseek'
      ? { apiKeyEnv: 'DS_CUSTOM_KEY', baseURL: 'https://gateway.example.com/v1/' }
      : null),
  }
  const credentials = {
    resolve: async (name) => {
      resolvedNames.push(name)
      return { value: 'sk-custom' }
    },
  }
  const { harness } = bootHost({ subprocess, settings, credentials })
  const result = await harness.handlers.get('balance')({})
  assert.equal(result.available, true)
  assert.deepEqual(resolvedNames, ['DS_CUSTOM_KEY'])
  assert.equal(lastSpec.argv[lastSpec.argv.length - 1], 'https://gateway.example.com/v1/user/balance')
})

test('balance: credentials with illegal characters are rejected before spawning', async () => {
  let spawnCount = 0
  const subprocess = {
    resolveExecutable: async () => '/usr/bin/curl',
    spawn: () => {
      spawnCount += 1
      return balanceHandle({})
    },
  }
  const credentials = { resolve: async () => ({ value: 'sk-bad\n"line' }) }
  const { harness } = bootHost({ subprocess, credentials })
  const result = await harness.handlers.get('balance')({})
  assert.equal(result.available, false)
  assert.match(result.reason, /非法字符/)
  assert.equal(spawnCount, 0)
})
