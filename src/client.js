/**
 * Cost Meter — Client half (pkg-6 draft: display-only, dual-currency,
 * auto-select the funded currency).
 *
 * Same dynamic Cordis Package shape as src/host.js: the body of clientPlugin()
 * (everything between its braces) is `code.client` for `cordis_define`.
 *
 * Currency model: DeepSeek keeps SEPARATE balance entries and SEPARATE
 * official price cards for USD and CNY (their ratios are not one FX rate).
 * The pill shows clickable currency icons ($ / ¥); picking one switches the
 * whole meter to that currency card and that balance entry. No exchange-rate
 * conversion is ever applied. Until the user picks one manually, the meter
 * follows the first balance entry with a positive total (most accounts hold
 * only one funded currency); a manual pick is persisted and always wins.
 *
 * The client never computes money: Host's `session-cost` prices the durable
 * event log by rate window at event time in the selected currency. The client
 * re-queries on tokenUsage pushes, on currency/mode/price changes, and every
 * 15s (rate-window crossings).
 */
export default function clientPlugin() {
  return {
    inject: ['timer'],
    apply(ctx) {
      const slots = ctx.get('slots')
      if (slots === undefined) return

      ctx.effect(() => {
        const removeStyles = styles.insert(`
.cm-root { position: relative; z-index: 40; display: flex; flex-direction: row; align-items: center; gap: 6px; max-width: 100%; }
.cm-pill { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 9px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit; transition: border-color .15s ease, color .15s ease; }
.cm-pill:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.cm-pill:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.cm-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.cm-cost { color: var(--dsw-alias-brand-primary); font-weight: 650; font-variant-numeric: tabular-nums; }
.cm-sep-dot { opacity: .55; }
.cm-caret { opacity: .6; font-size: 9px; }
.cm-ccy-switch { display: inline-flex; align-items: center; gap: 2px; height: 22px; padding: 2px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 999px; background: var(--dsw-alias-bg-layer-1); }
.cm-ccy { width: 20px; height: 16px; border-radius: 999px; border: none; background: transparent; color: var(--dsw-alias-label-secondary); font-size: 11px; line-height: 1; cursor: pointer; font-family: inherit; padding: 0; display: inline-flex; align-items: center; justify-content: center; }
.cm-ccy:hover { color: var(--dsw-alias-label-primary); }
.cm-ccy:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 0; }
.cm-ccy.cm-active { background: var(--dsw-alias-brand-primary); color: #fff; font-weight: 650; }
.cm-panel { position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 60; box-sizing: border-box; width: min(360px, calc(100vw - 32px)); max-height: min(460px, 55vh); overflow: auto; overscroll-behavior: contain; background: var(--dsw-alias-bg-overlay); border: 1px solid var(--dsw-alias-border-l1); border-radius: 10px; padding: 10px 12px; font-size: 12px; color: var(--dsw-alias-label-primary); display: flex; flex-direction: column; gap: 6px; box-shadow: 0 10px 30px rgba(0, 0, 0, .22); }
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
.cm-actions { display: flex; gap: 8px; align-items: center; }
.cm-btn { background: var(--dsw-alias-bg-layer-2); border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-primary); border-radius: 6px; padding: 3px 8px; font-size: 11px; cursor: pointer; font-family: inherit; }
.cm-btn:hover { border-color: var(--dsw-alias-border-l2); }
`)
        return () => { removeStyles() }
      })

      const SCHEME_LABELS = { flat: '旧价(8/16前)', peak: '峰时', off: '谷时' }
      const CURRENCY_LABELS = { USD: '$ USD', CNY: '¥ CNY' }

      function storedCurrency() {
        try {
          const saved = window.localStorage.getItem('dsh-cost-meter.currency.v1')
          if (saved === 'USD' || saved === 'CNY') return saved
        } catch (err) { /* ignore */ }
        return null
      }

      function saveCurrency(currency) {
        try { window.localStorage.setItem('dsh-cost-meter.currency.v1', currency) } catch (err) { /* ignore */ }
      }

      function currencySymbol(currency) {
        return currency === 'CNY' ? '¥' : '$'
      }

      function fmtCost(value, currency) {
        if (value === null || value === undefined) return '—'
        const v = Number(value)
        if (!Number.isFinite(v)) return '—'
        const sym = currencySymbol(currency)
        if (v === 0) return sym + '0'
        if (v < 0.0001) return sym + v.toExponential(1)
        if (v < 0.01) return sym + v.toFixed(4)
        return sym + v.toFixed(2)
      }

      function fmtMoney(total, currency) {
        if (total === null || total === undefined || total === '') return '—'
        const v = Number(total)
        if (!Number.isFinite(v)) return '—'
        const sym = currency === 'USD' ? '$' : (currency === 'CNY' ? '¥' : (currency || '') + ' ')
        if (v >= 1000) return sym + v.toLocaleString(undefined, { maximumFractionDigits: 2 })
        if (v === 0) return sym + '0'
        if (v > 0 && v < 0.01) return sym + v.toFixed(4)
        return sym + v.toFixed(2)
      }

      function fmtTokens(value) {
        if (value === null || value === undefined) return '—'
        const v = Number(value)
        if (!Number.isFinite(v)) return '—'
        if (v >= 1000000) return (v / 1000000).toFixed(2) + 'M'
        if (v >= 1000) return (v / 1000).toFixed(1) + 'k'
        return String(v)
      }

      function CurrencyChips(props) {
        const currencies = props.currencies
        const value = props.value
        const onChange = props.onChange
        return React.createElement('div', { className: 'cm-ccy-switch', role: 'group', 'aria-label': '币种切换' },
          currencies.map((currency) => React.createElement('button', {
            key: currency,
            className: 'cm-ccy' + (currency === value ? ' cm-active' : ''),
            type: 'button',
            title: '切换为 ' + (CURRENCY_LABELS[currency] || currency) + ' 计价口径',
            'aria-pressed': currency === value,
            onClick: () => onChange(currency),
          }, currency === 'CNY' ? '¥' : '$')))
      }

      function CostMeter(props) {
        const usage = props.useProjection('tokenUsage')
        const pressure = props.useProjection('contextPressure')
        const [prices, setPrices] = React.useState(null)
        const [pricesVersion, setPricesVersion] = React.useState(0)
        const [currencies, setCurrencies] = React.useState(['USD', 'CNY'])
        const [report, setReport] = React.useState(null)
        const [balance, setBalance] = React.useState(null)
        const [balanceLoading, setBalanceLoading] = React.useState(false)
        const [open, setOpen] = React.useState(false)
        const [mode, setMode] = React.useState('auto')
        const [currencyPinned, setCurrencyPinned] = React.useState(storedCurrency() !== null)
        const [currency, setCurrency] = React.useState(storedCurrency() || 'USD')
        const [notice, setNotice] = React.useState('')
        const modeRef = React.useRef('auto')
        const currencyRef = React.useRef(currency)
        const costSeqRef = React.useRef(0)
        const balanceSeqRef = React.useRef(0)
        const rootRef = React.useRef(null)

        React.useEffect(() => { modeRef.current = mode }, [mode])
        React.useEffect(() => { currencyRef.current = currency }, [currency])

        function loadPrices() {
          host.call('prices', {}).then((result) => {
            if (result !== null && typeof result === 'object' && Array.isArray(result.rows)) {
              setPrices(result.rows)
              if (Array.isArray(result.currencies) && result.currencies.length > 0) setCurrencies(result.currencies)
              setPricesVersion((version) => version + 1)
            }
          }).catch(() => { /* ignore */ })
        }

        function refreshCost(scheme, ccy) {
          const sessionId = props.sessionId
          if (sessionId === null || sessionId === undefined || sessionId === '') return
          costSeqRef.current += 1
          const seq = costSeqRef.current
          const args = {
            sessionId: String(sessionId),
            scheme: scheme === 'flat' || scheme === 'peak' || scheme === 'off' ? scheme : 'auto',
            currency: ccy === 'CNY' ? 'CNY' : 'USD',
          }
          host.call('session-cost', args)
            .then((result) => {
              if (seq !== costSeqRef.current) return
              if (result !== null && typeof result === 'object') setReport(result)
              else setReport({ available: false, reason: '会话成本查询返回异常' })
            })
            .catch(() => {
              if (seq === costSeqRef.current) setReport({ available: false, reason: '会话成本查询失败' })
            })
        }

        function fetchBalance(force) {
          balanceSeqRef.current += 1
          const seq = balanceSeqRef.current
          setBalanceLoading(true)
          host.call('balance', { force: force === true })
            .then((result) => {
              if (seq !== balanceSeqRef.current) return
              if (result !== null && typeof result === 'object') setBalance(result)
              else setBalance({ available: false, reason: '余额查询返回异常', infos: [] })
            })
            .catch(() => {
              if (seq === balanceSeqRef.current) setBalance({ available: false, reason: '查询失败', infos: [] })
            })
            .then(() => {
              if (seq === balanceSeqRef.current) setBalanceLoading(false)
            })
        }

        React.useEffect(() => {
          loadPrices()
          refreshCost(modeRef.current, currencyRef.current)
          fetchBalance(false)
          const stop = ctx.interval(() => {
            refreshCost(modeRef.current, currencyRef.current)
            fetchBalance(false)
          }, 15000)
          return () => { stop() }
        }, [props.sessionId])

        // A projection push means new usage arrived: recompute the bill.
        React.useEffect(() => {
          refreshCost(modeRef.current, currencyRef.current)
        }, [usage, pricesVersion, currency])

        // Until the user makes a manual currency choice, follow the account:
        // select the first balance entry with a positive total. Manual picks
        // are persisted and always win from then on.
        React.useEffect(() => {
          if (currencyPinned) return
          if (balance === null || balance.available !== true || !Array.isArray(balance.infos)) return
          let pick = null
          for (const info of balance.infos) {
            if (info !== null && info !== undefined &&
                (info.currency === 'USD' || info.currency === 'CNY') &&
                Number(info.total) > 0) {
              pick = info
              break
            }
          }
          if (pick === null || pick.currency === currencyRef.current) return
          const next = pick.currency
          setCurrency(next)
          currencyRef.current = next
          setNotice('已按余额自动切换为 ' + (CURRENCY_LABELS[next] || next))
          refreshCost(modeRef.current, next)
        }, [balance, currencyPinned])

        // Close on outside click / Escape.
        React.useEffect(() => {
          if (!open) return
          const onPointerDown = (event) => {
            if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false)
          }
          const onKeyDown = (event) => {
            if (event.key === 'Escape') setOpen(false)
          }
          document.addEventListener('pointerdown', onPointerDown, true)
          document.addEventListener('keydown', onKeyDown, true)
          return () => {
            document.removeEventListener('pointerdown', onPointerDown, true)
            document.removeEventListener('keydown', onKeyDown, true)
          }
        }, [open])

        function toggleOpen() {
          const next = !open
          setOpen(next)
          if (next) {
            loadPrices()
            refreshCost(modeRef.current, currencyRef.current)
            fetchBalance(false)
          }
        }

        function changeMode(event) {
          const next = event.currentTarget.value
          setMode(next)
          modeRef.current = next
          setNotice('')
          refreshCost(next, currencyRef.current)
        }

        function selectCurrency(next) {
          if (next !== 'USD' && next !== 'CNY') return
          setCurrency(next)
          currencyRef.current = next
          setCurrencyPinned(true)
          saveCurrency(next)
          setNotice('')
          refreshCost(modeRef.current, next)
        }

        const hasUsage = usage !== null && usage !== undefined && typeof usage === 'object'
        const uncached = hasUsage ? (Number(usage.uncachedInputTokens) || 0) : 0
        const output = hasUsage ? (Number(usage.outputTokens) || 0) : 0
        const cacheRead = hasUsage ? (Number(usage.cacheReadTokens) || 0) : 0
        const cacheWrite = hasUsage ? (Number(usage.cacheWriteTokens) || 0) : 0
        const billedInput = uncached + cacheRead + cacheWrite
        const totalTokens = billedInput + output
        const cacheHit = billedInput > 0 ? Math.round(cacheRead * 100 / billedInput) : null

        const projected = pressure !== null && pressure !== undefined && typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens : 0
        const windowTokens = pressure !== null && pressure !== undefined && typeof pressure.contextWindow === 'number' ? pressure.contextWindow : 0
        const occupancy = windowTokens > 0 ? Math.round(projected * 100 / windowTokens) : null

        const autoScheme = report !== null && typeof report.autoScheme === 'string' ? report.autoScheme : 'flat'
        const activeScheme = mode === 'auto' ? autoScheme : mode
        const schemeText = mode === 'auto'
          ? '自动 · ' + (SCHEME_LABELS[autoScheme] || autoScheme)
          : '手动 · ' + (SCHEME_LABELS[mode] || mode)

        let costText = '$…'
        let costWarn = ''
        if (report === null) {
          costText = currencySymbol(currency) + '…'
        } else if (report.available !== true) {
          costText = '不可用'
          costWarn = typeof report.reason === 'string' ? report.reason : '会话成本不可用'
        } else if (report.priced !== true) {
          costText = '不适用'
          costWarn = '当前模型不是 DeepSeek，不套用 DeepSeek 价格表'
        } else {
          costText = fmtCost(report.cost, currency)
        }

        const modelLabel = report !== null && typeof report.model === 'string' && report.model !== '' ? report.model : '未知模型'
        const modelSub = modelLabel + (report !== null && report.modelSource === 'default' ? '(部署默认)' : '') + ' · ' + schemeText

        const infos = balance !== null && balance.available === true && Array.isArray(balance.infos) ? balance.infos : []
        const selectedInfo = infos.find((info) => info !== null && info !== undefined && info.currency === currency) || null
        const otherInfos = infos.filter((info) => info !== selectedInfo)
        const balanceText = balanceLoading && balance === null
          ? '…'
          : (balance !== null
            ? (balance.available === true
              ? (selectedInfo !== null ? fmtMoney(selectedInfo.total, selectedInfo.currency) : (infos.length > 0 ? '无' + currency + '余额' : '—'))
              : '不可用')
            : '…')

        function Row(k, v, className) {
          return React.createElement('div', { className: className || 'cm-row', key: k },
            React.createElement('span', { className: 'cm-k' }, k),
            React.createElement('span', { className: 'cm-v' }, v))
        }

        function commitPrice(rowKey, schemeName, ccy) {
          return (event) => {
            const group = event.currentTarget.parentElement
            if (group === null || group === undefined) return
            const fields = group.querySelectorAll('input.cm-price-input')
            if (fields.length < 3) return
            const inP = Number(fields[0].value)
            const cacheP = Number(fields[1].value)
            const outP = Number(fields[2].value)
            if (!Number.isFinite(inP) || !Number.isFinite(cacheP) || !Number.isFinite(outP)) {
              setNotice('价格必须是数字')
              return
            }
            if (inP < 0 || cacheP < 0 || outP < 0) {
              setNotice('价格不能为负')
              return
            }
            host.call('set-price', { currency: ccy, key: rowKey, scheme: schemeName, in: inP, cache: cacheP, out: outP }).then((result) => {
              if (result !== null && typeof result === 'object' && result.ok === true && Array.isArray(result.rows)) {
                setPrices(result.rows)
                setPricesVersion((version) => version + 1)
                setNotice('已更新并立即生效')
                refreshCost(modeRef.current, ccy)
              } else {
                setNotice(result !== null && typeof result === 'object' && typeof result.reason === 'string' ? result.reason : '保存失败')
              }
            }).catch(() => { setNotice('保存失败') })
          }
        }

        function resetPrices() {
          host.call('reset-prices', {}).then((result) => {
            if (result !== null && typeof result === 'object' && result.ok === true && Array.isArray(result.rows)) {
              setPrices(result.rows)
              setPricesVersion((version) => version + 1)
              setNotice('已恢复官方默认价（USD + CNY）')
              refreshCost(modeRef.current, currencyRef.current)
            } else {
              setNotice('恢复默认失败')
            }
          }).catch(() => { setNotice('恢复默认失败') })
        }

        const legend = React.createElement('div', { className: 'cm-price-row', key: 'legend' },
          React.createElement('span', { className: 'cm-price-key' }),
          React.createElement('span', { className: 'cm-col' }, '输入(未命中)'),
          React.createElement('span', { className: 'cm-col' }, '缓存命中'),
          React.createElement('span', { className: 'cm-col' }, '输出'))

        const priceRows = prices !== null && Array.isArray(prices) ? prices.map((row) => {
          const card = row[currency] !== undefined && row[currency] !== null ? row[currency] : row.USD
          const r = card !== undefined && card[activeScheme] !== undefined && card[activeScheme] !== null ? card[activeScheme] : { in: 0, cache: 0, out: 0 }
          const isActive = report !== null && typeof report.model === 'string' && row.key === report.model
          return React.createElement('div', { className: 'cm-price-row' + (isActive ? ' cm-active' : ''), key: row.key + ':' + currency + ':' + activeScheme + ':' + pricesVersion },
            React.createElement('span', { className: 'cm-price-key', title: row.key }, row.key),
            React.createElement('input', { className: 'cm-price-input', type: 'number', min: '0', step: '0.0001', defaultValue: String(r.in), 'aria-label': row.key + ' 输入(未命中)单价', onBlur: commitPrice(row.key, activeScheme, currency), onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() } }),
            React.createElement('input', { className: 'cm-price-input', type: 'number', min: '0', step: '0.0001', defaultValue: String(r.cache), 'aria-label': row.key + ' 缓存命中单价', onBlur: commitPrice(row.key, activeScheme, currency), onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() } }),
            React.createElement('input', { className: 'cm-price-input', type: 'number', min: '0', step: '0.0001', defaultValue: String(r.out), 'aria-label': row.key + ' 输出单价', onBlur: commitPrice(row.key, activeScheme, currency), onKeyDown: (event) => { if (event.key === 'Enter') event.currentTarget.blur() } }))
        }) : []

        const segmentRows = report !== null && report.mode === 'auto' && Array.isArray(report.timeSegments)
          ? report.timeSegments.map((segment) => Row(
            (SCHEME_LABELS[segment.scheme] || segment.scheme) + ' · ' + String(segment.steps) + ' 步',
            fmtCost(segment.cost, currency),
            'cm-row cm-seg-row'))
          : []

        const modelRows = report !== null && Array.isArray(report.models) && report.models.length > 1
          ? report.models.map((model) => Row(
            model.model + (model.matched ? '' : '(未匹配→default)'),
            model.priced ? fmtCost(model.cost, currency) : '不计价'))
          : []

        const balanceRows = []
        if (selectedInfo !== null) {
          const cur = selectedInfo.currency !== undefined && selectedInfo.currency !== '' ? selectedInfo.currency : '?'
          balanceRows.push(Row(cur + ' 总余额', fmtMoney(selectedInfo.total, selectedInfo.currency)))
          if (selectedInfo.granted !== undefined && selectedInfo.granted !== '') balanceRows.push(Row(cur + ' 赠送', fmtMoney(selectedInfo.granted, selectedInfo.currency)))
          if (selectedInfo.topped !== undefined && selectedInfo.topped !== '') balanceRows.push(Row(cur + ' 充值', fmtMoney(selectedInfo.topped, selectedInfo.currency)))
        } else if (balance !== null && balance.available === true && infos.length > 0) {
          balanceRows.push(Row('状态', '该账号没有 ' + currency + ' 余额条目'))
        }
        for (const other of otherInfos) {
          if (other !== null && other !== undefined && other.total !== undefined && other.total !== '') {
            balanceRows.push(Row(other.currency + ' 余额(其他)', fmtMoney(other.total, other.currency)))
          }
        }
        if (balance !== null && balance.available !== true) {
          balanceRows.push(Row('状态', String(balance.reason || '不可用')))
        }

        const priceUnit = currency === 'CNY' ? 'CNY(元)/1M tokens' : 'USD/1M tokens'

        const panel = open ? React.createElement('div', { className: 'cm-panel' },
          React.createElement('div', { className: 'cm-title' }, '本对话消耗（估算）'),
          React.createElement('div', null,
            React.createElement('span', { className: 'cm-big' }, costText),
            React.createElement('span', { className: 'cm-sub' }, modelSub)),
          costWarn !== '' ? React.createElement('div', { className: 'cm-warn' }, costWarn) : null,
          segmentRows.length > 0 ? React.createElement('div', { className: 'cm-title' }, '分段明细（按产生时刻费率）') : null,
          ...segmentRows,
          modelRows.length > 0 ? React.createElement('div', { className: 'cm-title' }, '按模型') : null,
          ...modelRows,
          Row('输入 tokens(计费)', hasUsage ? fmtTokens(billedInput) : '—'),
          Row('输出 tokens', hasUsage ? fmtTokens(output) : '—'),
          Row('缓存命中率', cacheHit !== null ? cacheHit + '%' : '—'),
          Row('上下文占用(估算)', occupancy !== null ? occupancy + '% · ' + fmtTokens(projected) + ' / ' + fmtTokens(windowTokens) : '—'),
          React.createElement('div', { className: 'cm-sep' }),
          React.createElement('div', { className: 'cm-title' }, '账户余额 · 只读查询'),
          React.createElement('div', { className: 'cm-actions' },
            React.createElement(CurrencyChips, { currencies, value: currency, onChange: selectCurrency }),
            React.createElement('span', { className: 'cm-sub' }, CURRENCY_LABELS[currency] || currency)),
          React.createElement('div', null,
            React.createElement('span', { className: 'cm-big' }, balanceText),
            React.createElement('span', { className: 'cm-sub' }, selectedInfo !== null && selectedInfo.currency !== undefined ? selectedInfo.currency : '')),
          ...balanceRows,
          React.createElement('div', { className: 'cm-actions' },
            React.createElement('button', { className: 'cm-btn', type: 'button', onClick: () => fetchBalance(true) }, '刷新余额'),
            balanceLoading ? React.createElement('span', { className: 'cm-sub' }, '查询中…') : null),
          React.createElement('div', { className: 'cm-sep' }),
          React.createElement('div', { className: 'cm-title' }, '单价设置 · ' + priceUnit),
          React.createElement('div', { className: 'cm-actions' },
            React.createElement('select', { className: 'cm-select', value: mode, onChange: changeMode },
              React.createElement('option', { value: 'auto' }, '自动(按时段分段)'),
              React.createElement('option', { value: 'flat' }, '手动·旧价'),
              React.createElement('option', { value: 'peak' }, '手动·峰时'),
              React.createElement('option', { value: 'off' }, '手动·谷时')),
            React.createElement('button', { className: 'cm-btn', type: 'button', onClick: resetPrices }, '恢复官方价'),
            React.createElement('span', { className: 'cm-sub' }, '当前: ' + schemeText)),
          legend,
          ...priceRows,
          notice !== '' ? React.createElement('div', { className: 'cm-note' }, notice) : null,
          React.createElement('div', { className: 'cm-note' }, 'USD 与 CNY 是 DeepSeek 两套独立官方价目，点击 $ / ¥ 切换整个口径（消耗 + 余额），不做汇率折算；未手动选择时自动跟随有非零余额的币种。自动模式按每条用量事件产生时刻的官方时段分段累计：UTC 1:00–4:00、6:00–10:00 为峰时（北京时间 9:00–12:00、14:00–18:00），自 8/16 16:00 UTC 起生效；此前按旧价。单价仅存于本插件内存，重启恢复官方默认。余额为只读查询：复用模型调用的凭证直连官方 GET 接口（密钥经 stdin 传入，不进进程参数），插件没有任何扣费或写操作。'),
        ) : null

        return React.createElement('div', { className: 'cm-root', ref: rootRef },
          React.createElement('button', {
            className: 'cm-pill',
            type: 'button',
            'aria-expanded': open,
            onClick: toggleOpen,
            title: '本对话估算消耗与账户余额(只读) · 点击展开明细',
          },
            React.createElement('span', { className: 'cm-dot', 'aria-hidden': 'true' }),
            React.createElement('span', null, '消耗'),
            React.createElement('span', { className: 'cm-cost' }, costText),
            React.createElement('span', { className: 'cm-sep-dot' }, '·'),
            React.createElement('span', null, '余额'),
            React.createElement('span', { className: 'cm-cost' }, balanceText),
            React.createElement('span', { className: 'cm-caret', 'aria-hidden': 'true' }, open ? '▴' : '▾')),
          React.createElement(CurrencyChips, { currencies, value: currency, onChange: selectCurrency }),
          panel)
      }

      slots.inject('conversation.composer.dock', () => slots.register(
        { name: 'conversation.composer.dock', id: 'cost-meter', order: 10, label: 'Cost Meter' },
        (props) => React.createElement(CostMeter, props),
      ))
    },
  }
}
