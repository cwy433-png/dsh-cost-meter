/**
 * Cost Meter — web client half. Loaded by the dsh client module loader.
 *
 * Renders a pill in `conversation.composer.dock`: estimated cost of this
 * conversation and the DeepSeek account balance, with a $ / ¥ switch and a
 * detail panel. Usage comes from the host `costMeter` projection; money is
 * computed here from the host's price cards (see `costOf`, a copy of the one
 * in lib/core.js — keep them in step).
 */
window.__ModuleLoader__.load({
  id: 'dsh-cost-meter',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const CSS = `
.cm-root { position: relative; z-index: 40; display: flex; flex-direction: row; align-items: center; gap: 6px; max-width: 100%; }
.cm-pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit; transition: border-color .15s ease, color .15s ease; }
.cm-pill:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.cm-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.cm-dot.cm-peak { background: #d9822b; }
.cm-cost { color: var(--dsw-alias-brand-primary); font-weight: 650; font-variant-numeric: tabular-nums; }
.cm-sep-dot { opacity: .55; }
.cm-caret { opacity: .6; font-size: 9px; }
.cm-ccy-switch { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); box-sizing: border-box; }
.cm-ccy { width: 20px; height: 16px; border-radius: 999px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.cm-ccy:hover { color: var(--dsw-alias-label-primary); }
.cm-ccy:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.cm-ccy.cm-active { background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 650; }
.cm-panel { position: fixed; z-index: 1000; box-sizing: border-box; width: min(380px, calc(100vw - 32px)); overflow: auto; overscroll-behavior: contain; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; font-size: 12px; color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 6px; box-shadow: 0 10px 30px rgba(0, 0, 0, .22); }
.cm-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
.cm-big { font-size: 17px; font-weight: 700; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.cm-sub { color: var(--dsw-alias-label-secondary); font-size: 10.5px; margin-left: 6px; font-weight: 400; }
.cm-row { display: flex; justify-content: space-between; gap: 14px; }
.cm-k { color: var(--dsw-alias-label-secondary); }
.cm-v { font-variant-numeric: tabular-nums; }
.cm-sep { height: 1px; background: var(--dsw-alias-border-l1); margin: 4px 0; flex: none; }
.cm-seg-row .cm-v { color: var(--dsw-alias-brand-primary); }
.cm-price-row { display: flex; align-items: center; gap: 6px; }
.cm-price-row.cm-active .cm-price-key { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cm-price-key { flex: 1 1 auto; min-width: 96px; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cm-col { width: 60px; text-align: center; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.cm-price-input { width: 60px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-primary); padding: 2px 6px; font-size: 11px; font-family: inherit; box-sizing: border-box; }
.cm-price-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.cm-select { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-primary); padding: 2px 6px; font-size: 11px; font-family: inherit; }
.cm-note { color: var(--dsw-alias-label-secondary); font-size: 10.5px; line-height: 1.45; }
.cm-warn { color: #d9822b; font-size: 10.5px; line-height: 1.45; }
.cm-actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.cm-btn { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-family: inherit; }
.cm-btn:hover { border-color: var(--dsw-alias-border-l2); }
`

    const SCHEME_LABELS = { flat: '旧价(8/17前)', peak: '峰时', off: '谷时' }
    const CURRENCY_LABELS = { USD: '$ USD', CNY: '¥ CNY' }
    const PRICE_LABELS = { 'deepseek-flash': 'deepseek-flash (V4.1)', 'deepseek-v4-flash': 'v4-flash (9/10 前)', 'deepseek-v4-pro': 'deepseek-v4-pro', 'default': '其他 DeepSeek 模型' }
    const STORAGE_KEY = 'dsh-cost-meter.currency.v1'

    // Copy of costOf in lib/core.js.
    function costOf(view, prices, currency, override) {
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
        const s = byScheme[seg.scheme] || (byScheme[seg.scheme] = { scheme: seg.scheme, cost: 0, steps: 0 })
        s.cost += cost; s.steps += seg.steps
        const m = byModel[seg.model] || (byModel[seg.model] = { model: seg.model, cost: 0, priced: false })
        m.cost += cost; m.priced = m.priced || !!rate
      }
      return { total, priced, byScheme: Object.values(byScheme), byModel: Object.values(byModel) }
    }

    function storedCurrency() {
      try {
        const saved = window.localStorage.getItem(STORAGE_KEY)
        if (saved === 'USD' || saved === 'CNY') return saved
      } catch (err) { /* storage unavailable */ }
      return null
    }

    function saveCurrency(currency) {
      try { window.localStorage.setItem(STORAGE_KEY, currency) } catch (err) { /* storage unavailable */ }
    }

    const sym = currency => (currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : (currency || '') + ' ')

    function fmtCost(value, currency) {
      const v = Number(value)
      if (!Number.isFinite(v)) return '—'
      if (v === 0) return sym(currency) + '0'
      if (v < 0.0001) return sym(currency) + v.toExponential(1)
      if (v < 0.01) return sym(currency) + v.toFixed(4)
      return sym(currency) + v.toFixed(2)
    }

    function fmtMoney(total, currency) {
      if (total === null || total === undefined || total === '') return '—'
      const v = Number(total)
      if (!Number.isFinite(v)) return '—'
      if (v >= 1000) return sym(currency) + v.toLocaleString(undefined, { maximumFractionDigits: 2 })
      if (v > 0 && v < 0.01) return sym(currency) + v.toFixed(4)
      return sym(currency) + v.toFixed(2)
    }

    function fmtTokens(value) {
      const v = Number(value)
      if (!Number.isFinite(v)) return '—'
      if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
      if (v >= 1e3) return (v / 1e3).toFixed(1) + 'k'
      return String(v)
    }

    function getJson(url, init) {
      return fetch(url, Object.assign({ cache: 'no-store' }, init)).then(res => res.json().then(
        body => (res.ok || body !== null ? body : Promise.reject(new Error('HTTP ' + res.status))),
        () => Promise.reject(new Error('HTTP ' + res.status)),
      ))
    }

    function CurrencyChips(props) {
      return h('div', { className: 'cm-ccy-switch', role: 'group', 'aria-label': '币种切换' },
        props.currencies.map(currency => h('button', {
          key: currency,
          className: 'cm-ccy' + (currency === props.value ? ' cm-active' : ''),
          type: 'button',
          title: '切换为 ' + (CURRENCY_LABELS[currency] || currency) + ' 计价口径',
          'aria-pressed': currency === props.value,
          onClick: () => props.onChange(currency),
        }, currency === 'CNY' ? '¥' : '$')))
    }

    function Row(k, v, className) {
      return h('div', { className: className || 'cm-row', key: k },
        h('span', { className: 'cm-k' }, k),
        h('span', { className: 'cm-v' }, v))
    }

    function CostMeter(props) {
      const view = props.useProjection('costMeter')
      const usage = props.useProjection('tokenUsage')
      const pressure = props.useProjection('contextPressure')
      const [pricing, setPricing] = React.useState(null)
      const [pricesVersion, setPricesVersion] = React.useState(0)
      const [balance, setBalance] = React.useState(null)
      const [balanceLoading, setBalanceLoading] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const [mode, setMode] = React.useState('auto')
      const [currencyPinned, setCurrencyPinned] = React.useState(storedCurrency() !== null)
      const [currency, setCurrency] = React.useState(storedCurrency() || 'CNY')
      const [notice, setNotice] = React.useState('')
      const rootRef = React.useRef(null)
      const pillRef = React.useRef(null)
      const [place, setPlace] = React.useState(null)
      const balanceSeq = React.useRef(0)

      function loadPrices() {
        return getJson('api/cost-meter/prices').then((body) => {
          if (body && body.prices) setPricing(body)
        }, () => { /* keep the last good cards */ })
      }

      function fetchBalance(force) {
        const seq = ++balanceSeq.current
        setBalanceLoading(true)
        getJson('api/cost-meter/balance' + (force ? '?force=1' : '')).then(
          (body) => { if (seq === balanceSeq.current) setBalance(body && typeof body === 'object' ? body : { available: false, reason: '返回异常', infos: [] }) },
          () => { if (seq === balanceSeq.current) setBalance({ available: false, reason: '查询失败', infos: [] }) },
        ).then(() => { if (seq === balanceSeq.current) setBalanceLoading(false) })
      }

      React.useEffect(() => {
        loadPrices()
        fetchBalance(false)
        const prices = setInterval(loadPrices, 60000)
        const bal = setInterval(() => fetchBalance(false), 60000)
        return () => { clearInterval(prices); clearInterval(bal) }
      }, [])

      // New usage lands → the balance moved too (host TTL bounds the calls).
      React.useEffect(() => { if (view !== undefined) fetchBalance(false) }, [view])

      // Re-read the rate window right when it changes.
      React.useEffect(() => {
        if (!pricing || typeof pricing.nextTransitionMs !== 'number') return undefined
        const wait = Math.min(Math.max(pricing.nextTransitionMs - Date.now() + 1000, 1000), 2 ** 31 - 1)
        const timer = setTimeout(loadPrices, wait)
        return () => clearTimeout(timer)
      }, [pricing])

      // Until a manual pick, follow the first funded balance entry.
      React.useEffect(() => {
        if (currencyPinned || !balance || balance.available !== true || !Array.isArray(balance.infos)) return
        const pick = balance.infos.find(info => (info.currency === 'USD' || info.currency === 'CNY') && Number(info.total) > 0)
        if (pick && pick.currency !== currency) setCurrency(pick.currency)
      }, [balance, currencyPinned])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => { if (rootRef.current && !rootRef.current.contains(event.target)) setOpen(false) }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      // The dock sits inside a scroll container that clips overflow, so the
      // panel is fixed to the viewport and placed above the pill.
      React.useLayoutEffect(() => {
        if (!open) return undefined
        const placePanel = () => {
          const r = pillRef.current ? pillRef.current.getBoundingClientRect() : null
          if (!r) return
          const width = Math.min(380, window.innerWidth - 32)
          const left = Math.max(16, Math.min(r.left, window.innerWidth - width - 16))
          const above = r.top - 16
          setPlace({ left, bottom: window.innerHeight - r.top + 8, maxHeight: Math.max(160, Math.min(480, above)) })
        }
        placePanel()
        window.addEventListener('resize', placePanel)
        window.addEventListener('scroll', placePanel, true)
        return () => {
          window.removeEventListener('resize', placePanel)
          window.removeEventListener('scroll', placePanel, true)
        }
      }, [open])

      function toggleOpen() {
        const next = !open
        setOpen(next)
        if (next) { loadPrices(); fetchBalance(false) }
      }

      function selectCurrency(next) {
        setCurrency(next)
        setCurrencyPinned(true)
        saveCurrency(next)
        setNotice('')
      }

      function postPrices(payload, okText) {
        getJson('api/cost-meter/prices', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        }).then((body) => {
          if (body && body.ok === true) {
            setPricing(body)
            setPricesVersion(v => v + 1)
            setNotice(okText)
          } else {
            setNotice(body && body.reason ? body.reason : '保存失败')
          }
        }, () => setNotice('保存失败'))
      }

      function commitPrice(key, scheme) {
        return (event) => {
          const fields = event.currentTarget.parentElement.querySelectorAll('input.cm-price-input')
          const [inP, cacheP, outP] = Array.from(fields, f => Number(f.value))
          if (![inP, cacheP, outP].every(v => Number.isFinite(v) && v >= 0)) { setNotice('价格必须是非负数字'); return }
          const current = pricing.prices[key][currency][scheme]
          if (current.in === inP && current.cache === cacheP && current.out === outP) return
          postPrices({ action: 'set', currency, key, scheme, in: inP, cache: cacheP, out: outP }, '已更新并立即生效（仅本次运行）')
        }
      }

      const liveScheme = pricing ? pricing.scheme : null
      const activeScheme = mode === 'auto' ? (liveScheme || 'off') : mode
      const schemeText = mode === 'auto' ? '自动 · 现在' + (SCHEME_LABELS[liveScheme] || '…') : '手动 · ' + SCHEME_LABELS[mode]

      let cost = null
      let costText = sym(currency) + '…'
      let costWarn = ''
      if (view === undefined) {
        costText = '—'
      } else if (pricing) {
        cost = costOf(view, pricing.prices, currency, mode)
        if (view.segments.length > 0 && !cost.priced) {
          costText = '不适用'
          costWarn = '当前模型不是 DeepSeek，不套用 DeepSeek 价格表'
        } else {
          costText = fmtCost(cost.total, currency)
        }
      }

      const model = view && view.model ? view.model.model : ''
      const modelSub = (model || '尚无请求') + ' · ' + schemeText

      const infos = balance && balance.available === true && Array.isArray(balance.infos) ? balance.infos : []
      const selectedInfo = infos.find(info => info.currency === currency) || null
      const balanceText = balance === null
        ? '…'
        : balance.available !== true ? '不可用'
          : selectedInfo ? fmtMoney(selectedInfo.total, selectedInfo.currency)
            : infos.length > 0 ? '无' + currency : '—'

      const hasUsage = usage && typeof usage === 'object'
      const billedInput = hasUsage ? (usage.uncachedInputTokens || 0) + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0) : 0
      const cacheHit = billedInput > 0 ? Math.round((usage.cacheReadTokens || 0) * 100 / billedInput) : null
      const projected = pressure && typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : 0
      const windowTokens = pressure && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : 0
      const occupancy = windowTokens > 0 ? Math.round(projected * 100 / windowTokens) : null

      let panel = null
      if (open) {
        const segmentRows = cost && mode === 'auto'
          ? ['flat', 'peak', 'off'].map(s => cost.byScheme.find(x => x.scheme === s)).filter(Boolean).map(s =>
            Row((SCHEME_LABELS[s.scheme] || s.scheme) + ' · ' + s.steps + ' 步', fmtCost(s.cost, currency), 'cm-row cm-seg-row'))
          : []
        const modelRows = cost && cost.byModel.length > 1
          ? cost.byModel.map(m => Row(m.model || '未知模型', m.priced ? fmtCost(m.cost, currency) : '不计价'))
          : []

        const balanceRows = []
        if (selectedInfo) {
          balanceRows.push(Row(currency + ' 充值', fmtMoney(selectedInfo.topped, currency)))
          balanceRows.push(Row(currency + ' 赠送', fmtMoney(selectedInfo.granted, currency)))
        } else if (infos.length > 0) {
          balanceRows.push(Row('状态', '该账号没有 ' + currency + ' 余额'))
        }
        for (const other of infos) {
          if (other !== selectedInfo) balanceRows.push(Row(other.currency + ' 余额(其他)', fmtMoney(other.total, other.currency)))
        }
        if (balance && balance.available !== true) balanceRows.push(Row('状态', String(balance.reason || '不可用')))

        const priceRows = pricing ? Object.keys(pricing.prices).map((key) => {
          const r = pricing.prices[key][currency][activeScheme]
          const activeRow = view && view.segments.some(s => s.priceKey === key && s.model === model)
          const onKeyDown = (event) => { if (event.key === 'Enter') event.currentTarget.blur() }
          const input = (field, label) => h('input', {
            className: 'cm-price-input', type: 'number', min: '0', step: '0.0001',
            defaultValue: String(r[field]), 'aria-label': key + ' ' + label, onBlur: commitPrice(key, activeScheme), onKeyDown,
          })
          return h('div', { className: 'cm-price-row' + (activeRow ? ' cm-active' : ''), key: key + currency + activeScheme + pricesVersion },
            h('span', { className: 'cm-price-key', title: key }, PRICE_LABELS[key] || key),
            input('in', '输入(未命中)'), input('cache', '缓存命中'), input('out', '输出'))
        }) : []

        panel = h('div', { className: 'cm-panel', style: place ? { left: place.left + 'px', bottom: place.bottom + 'px', maxHeight: place.maxHeight + 'px' } : { visibility: 'hidden' } },
          h('div', { className: 'cm-title' }, '本对话消耗（估算）'),
          h('div', null, h('span', { className: 'cm-big' }, costText), h('span', { className: 'cm-sub' }, modelSub)),
          costWarn ? h('div', { className: 'cm-warn' }, costWarn) : null,
          segmentRows.length > 0 ? h('div', { className: 'cm-title' }, '分段明细（按产生时刻费率）') : null,
          ...segmentRows,
          modelRows.length > 0 ? h('div', { className: 'cm-title' }, '按模型') : null,
          ...modelRows,
          Row('输入 tokens(计费)', hasUsage ? fmtTokens(billedInput) : '—'),
          Row('输出 tokens', hasUsage ? fmtTokens(usage.outputTokens || 0) : '—'),
          Row('缓存命中率', cacheHit !== null ? cacheHit + '%' : '—'),
          Row('上下文占用(估算)', occupancy !== null ? occupancy + '% · ' + fmtTokens(projected) + ' / ' + fmtTokens(windowTokens) : '—'),
          h('div', { className: 'cm-sep' }),
          h('div', { className: 'cm-title' }, '账户余额 · 只读查询'),
          h('div', null, h('span', { className: 'cm-big' }, balanceText)),
          ...balanceRows,
          h('div', { className: 'cm-actions' },
            h('button', { className: 'cm-btn', type: 'button', onClick: () => fetchBalance(true) }, '刷新余额'),
            balanceLoading ? h('span', { className: 'cm-sub' }, '查询中…') : null),
          h('div', { className: 'cm-sep' }),
          h('div', { className: 'cm-title' }, '单价 · ' + (currency === 'CNY' ? '元' : 'USD') + ' / 百万 tokens'),
          h('div', { className: 'cm-actions' },
            h('select', { className: 'cm-select', value: mode, onChange: e => { setMode(e.currentTarget.value); setNotice('') } },
              h('option', { value: 'auto' }, '自动(按时段分段)'),
              h('option', { value: 'peak' }, '手动·全按峰时'),
              h('option', { value: 'off' }, '手动·全按谷时'),
              h('option', { value: 'flat' }, '手动·全按旧价')),
            h('button', { className: 'cm-btn', type: 'button', onClick: () => postPrices({ action: 'reset' }, '已恢复官方价（USD + CNY）') }, '恢复官方价'),
            h('span', { className: 'cm-sub' }, '显示: ' + SCHEME_LABELS[activeScheme])),
          h('div', { className: 'cm-price-row' },
            h('span', { className: 'cm-price-key' }),
            h('span', { className: 'cm-col' }, '输入(未命中)'),
            h('span', { className: 'cm-col' }, '缓存命中'),
            h('span', { className: 'cm-col' }, '输出')),
          ...priceRows,
          notice ? h('div', { className: 'cm-note' }, notice) : null,
          h('div', { className: 'cm-note' }, '按每次调用产生时刻的官方价目计价：北京时间工作日 9:00–12:00、14:00–18:00 为峰时，其余时间及周末、法定节假日为谷时（8/17 起）；flash 自 9/10 起按 V4.1 新价。USD 与 CNY 是两套独立官方价目，不做汇率折算。改价只在本次运行有效。余额为只读查询，插件没有任何扣费或写操作。'))
      }

      return h('div', { className: 'cm-root', ref: rootRef },
        h('button', {
          className: 'cm-pill', type: 'button', 'aria-expanded': open, onClick: toggleOpen, ref: pillRef,
          title: '本对话估算消耗与账户余额 · 点击展开明细',
        },
          h('span', { className: 'cm-dot' + (liveScheme === 'peak' ? ' cm-peak' : ''), 'aria-hidden': 'true', title: liveScheme ? '现在' + SCHEME_LABELS[liveScheme] : '' }),
          h('span', null, '消耗'),
          h('span', { className: 'cm-cost' }, costText),
          h('span', { className: 'cm-sep-dot' }, '·'),
          h('span', null, '余额'),
          h('span', { className: 'cm-cost' }, balanceText),
          h('span', { className: 'cm-caret', 'aria-hidden': 'true' }, open ? '▴' : '▾')),
        h(CurrencyChips, { currencies: pricing ? pricing.currencies : ['USD', 'CNY'], value: currency, onChange: selectCurrency }),
        panel)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => {
          const style = document.createElement('style')
          style.setAttribute('data-plugin-css', 'dsh-cost-meter')
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        })
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock', id: 'cost-meter', order: 10, label: 'Cost Meter',
        }, CostMeter))
      },
    }
  },
})
