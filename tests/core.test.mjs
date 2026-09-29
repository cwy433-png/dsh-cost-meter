import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  DEFAULT_PRICES, applyEvent, costOf, initState, nextTransition, priceKeyFor, schemeAt, stateSchema, viewOf,
} from '../lib/core.js'

// Beijing = UTC+8; helpers take Beijing wall-clock times.
const bj = (y, mo, d, h, mi = 0) => Date.UTC(y, mo - 1, d, h - 8, mi)

test('schedule: flat before 8/17 Beijing, then weekday peak windows', () => {
  assert.equal(schemeAt(bj(2026, 8, 16, 23, 59)), 'flat')
  assert.equal(schemeAt(bj(2026, 8, 17, 9, 0)), 'peak') // Monday
  assert.equal(schemeAt(bj(2026, 8, 17, 8, 59)), 'off')
  assert.equal(schemeAt(bj(2026, 8, 17, 12, 0)), 'off')
  assert.equal(schemeAt(bj(2026, 8, 17, 14, 0)), 'peak')
  assert.equal(schemeAt(bj(2026, 8, 17, 17, 59)), 'peak')
  assert.equal(schemeAt(bj(2026, 8, 17, 18, 0)), 'off')
})

test('schedule: weekends and statutory holidays are off-peak all day', () => {
  assert.equal(schemeAt(bj(2026, 9, 26, 10)), 'off') // Saturday
  assert.equal(schemeAt(bj(2026, 9, 27, 10)), 'off') // Sunday
  assert.equal(schemeAt(bj(2026, 9, 25, 10)), 'off') // 中秋, Friday
  assert.equal(schemeAt(bj(2026, 10, 5, 10)), 'off') // 国庆, Monday
  assert.equal(schemeAt(bj(2026, 9, 28, 10)), 'peak') // ordinary Monday
  assert.equal(schemeAt(bj(2026, 10, 10, 10)), 'off') // 调休 Saturday: not Mon–Fri
})

test('nextTransition finds the next window edge, across a holiday', () => {
  assert.equal(nextTransition(bj(2026, 9, 28, 10, 30)), bj(2026, 9, 28, 12))
  assert.equal(nextTransition(bj(2026, 9, 30, 18, 30)), bj(2026, 10, 8, 9)) // 国庆 week
})

test('price keys: flash switches card on 9/10, pro stays, other vendors unpriced', () => {
  assert.equal(priceKeyFor('deepseek-official', 'deepseek-v4-flash', bj(2026, 9, 9, 23)), 'deepseek-v4-flash')
  assert.equal(priceKeyFor('deepseek-official', 'deepseek-v4-flash', bj(2026, 9, 10, 0)), 'deepseek-flash')
  assert.equal(priceKeyFor('deepseek-official', 'deepseek-flash', bj(2026, 9, 20, 0)), 'deepseek-flash')
  assert.equal(priceKeyFor('deepseek-official', 'deepseek-v4-pro', bj(2026, 9, 20, 0)), 'deepseek-v4-pro')
  assert.equal(priceKeyFor('openrouter', 'deepseek/deepseek-v4-pro', 0), 'deepseek-v4-pro')
  assert.equal(priceKeyFor('deepseek-official', 'deepseek-reasoner-x', 0), 'default')
  assert.equal(priceKeyFor('anthropic', 'claude-sonnet-5', 0), null)
})

const header = (model, time = 0) => ({ type: 'request/header', time, data: { header: { config: { provider: 'deepseek-official', model } } } })
const message = (turn, step, time, usage) => ({ type: 'assistant/message', time, data: { turn, step, usage } })
const attempt = (turn, step, time, usage) => ({
  type: 'assistant/attempt', time, data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
})
const fold = events => events.reduce(applyEvent, initState())

test('fold attributes each step to its own model and window', () => {
  const peak = bj(2026, 9, 28, 10)
  const off = bj(2026, 9, 28, 20)
  const state = fold([
    header('deepseek-flash'),
    message(1, 0, peak, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 500 }),
    header('deepseek-v4-pro'),
    message(2, 0, off, { inputTokens: 2000, outputTokens: 200 }),
  ])
  const segs = viewOf(state).segments
  assert.equal(segs.length, 2)
  assert.deepEqual(segs.map(s => [s.priceKey, s.scheme, s.steps]), [['deepseek-flash', 'peak', 1], ['deepseek-v4-pro', 'off', 1]])
  assert.equal(segs[0].cacheReadTokens, 500)
})

test('same turn/step replaces in place; retry-started makes the retry add', () => {
  const t = bj(2026, 9, 28, 10)
  const replaced = fold([
    header('deepseek-flash'),
    attempt(1, 0, t, { inputTokens: 10, outputTokens: 1 }),
    message(1, 0, t + 5, { inputTokens: 100, outputTokens: 10 }),
  ])
  assert.equal(viewOf(replaced).segments[0].uncachedInputTokens, 100)
  assert.equal(viewOf(replaced).segments[0].steps, 1)

  const retried = fold([
    header('deepseek-flash'),
    attempt(1, 0, t, { inputTokens: 10, outputTokens: 1 }),
    { type: 'llm/retry-started', time: t + 1, data: { turn: 1, step: 0 } },
    message(1, 0, t + 5, { inputTokens: 100, outputTokens: 10 }),
  ])
  assert.equal(viewOf(retried).segments[0].uncachedInputTokens, 110)
})

test('unchanged events return the same state object', () => {
  const s = fold([header('deepseek-flash')])
  assert.equal(applyEvent(s, header('deepseek-flash')), s)
  assert.equal(applyEvent(s, { type: 'user/message', time: 0, data: {} }), s)
})

test('state is plain JSON and survives the cache round trip', () => {
  const s = fold([header('deepseek-flash'), message(1, 0, bj(2026, 9, 28, 10), { inputTokens: 1, outputTokens: 1 })])
  const copy = JSON.parse(JSON.stringify(s))
  assert.deepEqual(stateSchema.parse(copy), s)
  assert.throws(() => stateSchema.parse({}))
})

test('costOf: official CNY card, auto vs manual override, other vendors excluded', () => {
  const state = fold([
    header('deepseek-flash'),
    message(1, 0, bj(2026, 9, 28, 10), { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheReadTokens: 1_000_000 }), // peak
    message(2, 0, bj(2026, 9, 28, 20), { inputTokens: 1_000_000, outputTokens: 0 }), // off
    { type: 'request/header', time: 0, data: { header: { config: { provider: 'anthropic', model: 'claude-sonnet-5' } } } },
    message(3, 0, bj(2026, 9, 28, 20), { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
  ])
  const auto = costOf(viewOf(state), DEFAULT_PRICES, 'CNY', 'auto')
  assert.equal(Math.round(auto.total * 100) / 100, 2 + 0.04 + 8 + 1) // peak miss+hit+out, off miss
  assert.equal(auto.priced, true)
  const allOff = costOf(viewOf(state), DEFAULT_PRICES, 'CNY', 'off')
  assert.equal(Math.round(allOff.total * 100) / 100, 1 + 0.02 + 4 + 1)
})

test('client carries an identical copy of costOf', () => {
  const source = readFileSync(new URL('../lib/core.js', import.meta.url), 'utf8')
  const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const body = src => src.slice(src.indexOf('let total = 0'), src.indexOf('return { total, priced'))
    .replace(/\?\?/g, '||').replace(/\s+/g, ' ')
  assert.equal(body(client), body(source))
})
