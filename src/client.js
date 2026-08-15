/**
 * Cost Meter — Client half.
 *
 * EXACT source of the running dynamic Cordis Package `cost-1/pkg-4`, wrapped
 * the same way as src/host.js. To reload as a dynamic plugin, pass the body of
 * clientPlugin() as `code.client` to `cordis_define`.
 *
 * Rendering: registers a pill + expandable panel in the
 * `conversation.composer.dock` slot (the band under the composer, beside the
 * shipped stats line).
 *
 * Data sources (no polling for usage):
 *  - `props.useProjection('tokenUsage')` / `('contextPressure')` — the SAME
 *    session-projection store the shipped stats line reads: durable whole-log
 *    provider usage, pushed live.
 *  - `host.call('prices' | 'default-model')` — price table + default model.
 *  - `host.call('balance')` — read-only account balance, refreshed every 30s.
 *
 * In a permanent package: `host` and `styles` builtins do not exist — use the
 * package-private RPC and stylesheet services of the mounted Client runtime
 * (verify exact names via cordis_inspect before writing code). React comes
 * from peerDependencies.
 */
export default function clientPlugin() {
  return {
    inject: ['timer'],
    apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => styles.insert(`
.cm-root { position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; max-width: 100%; }
.cm-pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit; transition: border-color .15s ease, color .15s ease; }
.cm-pill:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.cm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.cm-cost { color: var(--dsw-alias-brand-primary); font-weight: 650; font-variant-numeric: tabular-nums; }
.cm-sep-dot { opacity: .55; }
.cm-caret { opacity: .6; font-size: 9px; }
.cm-panel { background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; font-size: 12px; color: var(--dsw-alias-label-primary); min-width: 260px; display: flex; flex-direction: column; gap: 6px; box-shadow: 0 10px 30px rgba(0, 0, 0, .22); }
.cm-title { font-weight: 600; font-size: 12px; margin-bottom: 2px; }
.cm-big { font-size: 17px; font-weight: 700; color: var(--dsw-alias-brand-primary); font-variant-numeric: tabular-nums; }
.cm-sub { color: var(--dsw-alias-label-secondary); font-size: 10.5px; margin-left: 6px; font-weight: 400; }
.cm-row { display: flex; justify-content: space-between; gap: 14px; }
.cm-k { color: var(--dsw-alias-label-secondary); }
.cm-v { font-variant-numeric: tabular-nums; }
.cm-sep { height: 1px; background: var(--dsw-alias-border-l1); margin: 4px 0; }
.cm-price-row { display: flex; align-items: center; gap: 6px; }
.cm-price-row.cm-active .cm-price-key { color: var(--dsw-alias-label-primary); font-weight: 600; }
.cm-price-key { flex: 1 1 auto; min-width: 96px; color: var(--dsw-alias-label-secondary); font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cm-col { width: 60px; text-align: center; font-size: 10px; color: var(--dsw-alias-label-secondary); }
.cm-price-input { width: 60px; background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-primary); padding: 2px 6px; font-size: 11px; font-family: inherit; box-sizing: border-box; }
.cm-price-input:focus { outline: none; border-color: var(--dsw-alias-brand-primary); }
.cm-select { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); border-radius: 6px; color: var(--dsw-alias-label-primary); padding: 2px 6px; font-size: 11px; font-family: inherit; }
.cm-note { color: var(--dsw-alias-label-secondary); font-size: 10.5px; line-height: 1.45; }
.cm-actions { display: flex; gap: 8px; align-items: center; }
.cm-btn { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-family: inherit; }
.cm-btn:hover { border-color: var(--dsw-alias-border-l2); }
`))

      function fmtCost(value) {
        if (value === null || value === undefined) return '—'
        const v = Number(value)
        if (!Number.isFinite(v)) return '—'
        if (v < 0.01) return '$' + v.toFixed(4)
        return '$' + v.toFixed(2)
      }

      function fmtMoney(total, currency) {
        if (total === null || total === undefined || total === '') return '—'
        const v = Number(total)
        if (!Number.isFinite(v)) return '—'
        const sym = currency === 'USD' ? '$' : (currency === 'CNY' ? '¥' : (currency || '') + ' ')
        return sym + (v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v))
      }

      function fmtTokens(value) {
        if (value === null || value === undefined) return '—'
        const v = Number(value)
        if (!Number.isFinite(v)) return '—'
        if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M'
        if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
        return String(v)
      }

      const CUTOFF_MS = Date.UTC(2026, 7, 16, 16, 0, 0)
      function peakNow() {
        const h = new Date().getUTCHours()
        return (h >= 1 && h < 4) || (h >= 6 && h < 10)
      }
      function effectiveScheme(mode) {
        if (mode === 'flat' || mode === 'peak' || mode === 'off') return mode
        return Date.now() < CUTOFF_MS ? 'flat' : (peakNow() ? 'peak' : 'off')
      }
      const schemeLabels = { flat: '旧价(8/16前)', peak: '峰时', off: '谷时' }

      function CostMeter(props) {
        const usage = props.useProjection('tokenUsage')
        const pressure = props.useProjection('contextPressure')
        const [prices, setPrices] = React.useState(null)
        const [modelInfo, setModelInfo] = React.useState(null)
        const [open, setOpen] = React.useState(false)
        const [balance, setBalance] = React.useState(null)
        const [balanceLoading, setBalanceLoading] = React.useState(false)
        const [mode, setMode] = React.useState('auto')

        React.useEffect(() => {
          let cancelled = false
          const load = async () => {
            try {
              const rows = await host.call('prices', {})
              if (!cancelled && rows !== null && Array.isArray(rows)) setPrices(rows)
            } catch (err) { /* ignore */ }
            try {
              const mi = await host.call('default-model', {})
              if (!cancelled && mi !== null) setModelInfo(mi)
            } catch (err) { /* ignore */ }
          }
          load()
          return () => { cancelled = true }
        }, [props.sessionId])

        const fetchBalance = () => {
          setBalanceLoading(true)
          host.call('balance', {}).then((r) => { setBalance(r) }).catch(() => {
            setBalance({ available: false, reason: '查询失败', infos: [] })
          }).then(() => { setBalanceLoading(false) })
        }

        React.useEffect(() => {
          fetchBalance()
          const stop = ctx.interval(fetchBalance, 30000)
          return () => { stop() }
        }, [props.sessionId])

        const hasUsage = usage !== undefined && usage !== null
        const uncached = hasUsage ? (Number(usage.uncachedInputTokens) || 0) : 0
        const output = hasUsage ? (Number(usage.outputTokens) || 0) : 0
        const cacheRead = hasUsage ? (Number(usage.cacheReadTokens) || 0) : 0
        const cacheWrite = hasUsage ? (Number(usage.cacheWriteTokens) || 0) : 0
        const billedInput = uncached + cacheRead + cacheWrite
        const totalTokens = billedInput + output
        const cacheHit = billedInput > 0 ? Math.round(cacheRead * 100 / billedInput) : null

        const projected = pressure !== undefined && pressure !== null && typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : 0
        const windowTokens = pressure !== undefined && pressure !== null && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : 0
        const occupancy = windowTokens > 0 ? Math.round(projected * 100 / windowTokens) : null

        const model = modelInfo !== null && modelInfo.model !== undefined ? String(modelInfo.model) : ''
        const scheme = effectiveScheme(mode)
        let matchedRow = null
        if (prices !== null && Array.isArray(prices)) {
          for (const row of prices) if (row.key === model) { matchedRow = row; break }
          if (matchedRow === null) for (const row of prices) if (row.key === 'default') { matchedRow = row; break }
        }
        let cost = null
        if (matchedRow !== null) {
          const r = matchedRow[scheme]
          if (r !== undefined && r !== null) {
            cost = ((uncached + cacheWrite) * r.in + cacheRead * r.cache + output * r.out) / 1000000
          }
        }
        const costText = prices === null ? '$…' : (cost === null ? '未计价' : fmtCost(cost))

        // Multi-currency balance: an account may hold CNY AND USD entries.
        const infos = balance !== null && balance.available === true && Array.isArray(balance.infos) ? balance.infos : []
        let primary = null
        for (const info of infos) {
          if (info !== null && info !== undefined && Number(info.total) > 0) { primary = info; break }
        }
        if (primary === null && infos.length > 0) primary = infos[0]
        const balanceText = balanceLoading && balance === null ? '…' : (balance !== null ? (balance.available === true ? (primary !== null ? fmtMoney(primary.total, primary.currency) : '—') : '不可用') : '…')
        const multiHint = infos.length > 1 ? ' 等' + infos.length + '币种' : ''
        const modelLabel = model !== '' ? model : ''

        function Row(k, v) {
          return React.createElement('div', { className: 'cm-row', key: k },
            React.createElement('span', { className: 'cm-k' }, k),
            React.createElement('span', { className: 'cm-v' }, v))
        }

        function commitPrice(rowKey, schemeName) {
          return (ev) => {
            const group = ev.currentTarget.parentElement
            if (group === null || group === undefined) return
            const fields = group.querySelectorAll('input.cm-price-input')
            if (fields.length < 3) return
            const inP = Number(fields[0].value)
            const crP = Number(fields[1].value)
            const outP = Number(fields[2].value)
            if (!Number.isFinite(inP) || !Number.isFinite(crP) || !Number.isFinite(outP)) return
            host.call('set-price', { key: rowKey, scheme: schemeName, in: inP, cache: crP, out: outP }).then((rows) => {
              if (rows !== null && Array.isArray(rows)) setPrices(rows)
            }).catch(() => { /* ignore */ })
          }
        }

        const legend = React.createElement('div', { className: 'cm-price-row', key: 'legend' },
          React.createElement('span', { className: 'cm-price-key' }),
          React.createElement('span', { className: 'cm-col' }, '输入(未命中)'),
          React.createElement('span', { className: 'cm-col' }, '缓存命中'),
          React.createElement('span', { className: 'cm-col' }, '输出'))

        const priceRows = prices !== null && Array.isArray(prices) ? prices.map((row) => {
          const r = row[scheme] !== undefined && row[scheme] !== null ? row[scheme] : { in: 0, cache: 0, out: 0 }
          return React.createElement('div', { className: 'cm-price-row' + (matchedRow !== null && row.key === matchedRow.key ? ' cm-active' : ''), key: row.key },
            React.createElement('span', { className: 'cm-price-key', title: row.key }, row.key),
            React.createElement('input', { className: 'cm-price-input', type: 'number', min: '0', step: '0.0001', defaultValue: String(r.in), onBlur: commitPrice(row.key, scheme), onKeyDown: (ev) => { if (ev.key === 'Enter') ev.currentTarget.blur() } }),
            React.createElement('input', { className: 'cm-price-input', type: 'number', min: '0', step: '0.0001', defaultValue: String(r.cache), onBlur: commitPrice(row.key, scheme), onKeyDown: (ev) => { if (ev.key === 'Enter') ev.currentTarget.blur() } }),
            React.createElement('input', { className: 'cm-price-input', type: 'number', min: '0', step: '0.0001', defaultValue: String(r.out), onBlur: commitPrice(row.key, scheme), onKeyDown: (ev) => { if (ev.key === 'Enter') ev.currentTarget.blur() } }))
        }) : []

        const schemeText = mode === 'auto' ? '自动 · ' + schemeLabels[scheme] : schemeLabels[mode]

        const balanceRows = []
        for (const info of infos) {
          const cur = info.currency !== undefined && info.currency !== '' ? info.currency : '?'
          balanceRows.push(Row(cur + ' 总余额', fmtMoney(info.total, info.currency)))
          if (info.granted !== undefined && info.granted !== '') balanceRows.push(Row(cur + ' 赠送', fmtMoney(info.granted, info.currency)))
          if (info.topped !== undefined && info.topped !== '') balanceRows.push(Row(cur + ' 充值', fmtMoney(info.topped, info.currency)))
        }
        if (balance !== null && balance.available !== true) {
          balanceRows.push(Row('状态', String(balance.reason || '不可用')))
        }

        const panel = open ? React.createElement('div', { className: 'cm-panel' },
          React.createElement('div', { className: 'cm-title' }, '本对话消耗'),
          React.createElement('div', null,
            React.createElement('span', { className: 'cm-big' }, costText),
            React.createElement('span', { className: 'cm-sub' }, modelLabel + ' · ' + schemeText)),
          Row('输入 tokens(计费)', hasUsage ? fmtTokens(billedInput) : '—'),
          Row('输出 tokens', hasUsage ? fmtTokens(output) : '—'),
          Row('缓存命中率', cacheHit !== null ? cacheHit + '%' : '—'),
          Row('上下文占用(估算)', occupancy !== null ? occupancy + '% · ' + fmtTokens(projected) + ' / ' + fmtTokens(windowTokens) : '—'),
          React.createElement('div', { className: 'cm-sep' }),
          React.createElement('div', { className: 'cm-title' }, '余额 · 只读查询'),
          React.createElement('div', null,
            React.createElement('span', { className: 'cm-big' }, balanceText),
            React.createElement('span', { className: 'cm-sub' }, primary !== null && primary.currency !== undefined ? primary.currency : '')),
          ...balanceRows,
          React.createElement('div', { className: 'cm-actions' },
            React.createElement('button', { className: 'cm-btn', type: 'button', onClick: fetchBalance }, '刷新余额')),
          React.createElement('div', { className: 'cm-sep' }),
          React.createElement('div', { className: 'cm-title' }, '单价设置 · USD/1M tokens'),
          React.createElement('div', { className: 'cm-actions' },
            React.createElement('select', { className: 'cm-select', value: mode, onChange: (ev) => setMode(ev.currentTarget.value) },
              React.createElement('option', { value: 'auto' }, '自动(官方时段)'),
              React.createElement('option', { value: 'flat' }, '旧价(8/16前)'),
              React.createElement('option', { value: 'peak' }, '峰时'),
              React.createElement('option', { value: 'off' }, '谷时')),
            React.createElement('span', { className: 'cm-sub' }, '当前: ' + schemeText)),
          legend,
          ...priceRows,
          React.createElement('div', { className: 'cm-note' }, '官方 API 现仅有 deepseek-v4-flash 与 deepseek-v4-pro 两个模型；单价为官方美元报价，峰谷时段（UTC 1:00-4:00、6:00-10:00 为峰时）自 8/16 16:00 UTC 起生效。单价仅存于本插件内存，修改后立即生效。余额为只读查询：复用模型调用的 DEEPSEEK_API_KEY 凭证直连官方 GET 接口，插件没有任何扣费或写操作，密钥不会显示或记录。'),
        ) : null

        return React.createElement('div', { className: 'cm-root' },
          React.createElement('button', { className: 'cm-pill', type: 'button', onClick: () => setOpen(!open), title: '本对话消耗与账户余额(只读) · 点击展开明细' },
            React.createElement('span', { className: 'cm-dot' }),
            React.createElement('span', null, '消耗'),
            React.createElement('span', { className: 'cm-cost' }, costText),
            React.createElement('span', { className: 'cm-sep-dot' }, '·'),
            React.createElement('span', null, '余额'),
            React.createElement('span', { className: 'cm-cost' }, balanceText + multiHint),
            React.createElement('span', { className: 'cm-caret' }, open ? '▴' : '▾')),
          panel)
      }

      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'cost-meter', order: 10, label: 'Cost Meter' },
        (props) => React.createElement(CostMeter, props),
      ))
    },
  }
}
