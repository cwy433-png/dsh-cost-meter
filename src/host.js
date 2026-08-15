/**
 * Cost Meter — Host half.
 *
 * This is the EXACT source of the running dynamic Cordis Package `cost-1/pkg-4`
 * (session-local, not yet permanent). It is a plain-JavaScript function body
 * returning a Cordis Plugin, matching what `cordis_define` expects for
 * `code.host`. To reload it as a dynamic plugin, pass the body of hostPlugin()
 * (everything between its braces) as `code.host`.
 *
 * For a permanent install, adapt this file into a package default export and
 * follow the mount steps in NOTES.md ("Permanent mount"). In a permanent
 * package the `harness` builtin does not exist: replace `harness.handle` with
 * a real Client<->Host RPC service, and verify every `ctx.get(...)` against
 * the mounted Host composition.
 *
 * Architecture (current version):
 *  - `prices` / `set-price` — in-memory USD price table per model per scheme
 *    (flat / peak / off), editable from the Client panel.
 *  - `default-model` — the deployment's default model selection, used to pick
 *    which price row applies.
 *  - `balance` — READ-ONLY DeepSeek account balance: resolves the same
 *    DEEPSEEK_API_KEY credential the LLM adapter uses, then GETs
 *    https://api.deepseek.com/user/balance via curl through the subprocess
 *    service. No write path exists; the key is never returned or logged.
 *    Returns EVERY balance_infos entry (accounts can hold CNY + USD at once).
 */
export default function hostPlugin() {
  return {
    apply(ctx) {
      // Price table in USD per 1M tokens. Official DeepSeek API model list (as of 2026-08-13):
      // exactly two models — deepseek-v4-flash and deepseek-v4-pro.
      // flat: rates valid until 2026-08-16 16:00 UTC; peak/off: rates effective from then.
      const defaults = [
        { key: 'deepseek-v4-flash',
          flat: { in: 0.14, cache: 0.0028, out: 0.28 },
          peak: { in: 0.44, cache: 0.014, out: 1.32 },
          off: { in: 0.22, cache: 0.007, out: 0.66 } },
        { key: 'deepseek-v4-pro',
          flat: { in: 0.435, cache: 0.003625, out: 0.87 },
          peak: { in: 1.32, cache: 0.044, out: 3.96 },
          off: { in: 0.66, cache: 0.022, out: 1.98 } },
        { key: 'default',
          flat: { in: 0.14, cache: 0.0028, out: 0.28 },
          peak: { in: 0.44, cache: 0.014, out: 1.32 },
          off: { in: 0.22, cache: 0.007, out: 0.66 } },
      ]
      const prices = new Map()
      for (const row of defaults) {
        prices.set(row.key, {
          flat: { in: row.flat.in, cache: row.flat.cache, out: row.flat.out },
          peak: { in: row.peak.in, cache: row.peak.cache, out: row.peak.out },
          off: { in: row.off.in, cache: row.off.cache, out: row.off.out },
        })
      }

      function priceRows() {
        const rows = []
        for (const entry of prices.entries()) {
          rows.push({
            key: entry[0],
            flat: { in: entry[1].flat.in, cache: entry[1].flat.cache, out: entry[1].flat.out },
            peak: { in: entry[1].peak.in, cache: entry[1].peak.cache, out: entry[1].peak.out },
            off: { in: entry[1].off.in, cache: entry[1].off.cache, out: entry[1].off.out },
          })
        }
        return rows
      }

      harness.handle('prices', () => priceRows())

      harness.handle('set-price', (args) => {
        if (args === null || typeof args !== 'object') return null
        const key = typeof args.key === 'string' ? args.key : ''
        if (key === '') return null
        const scheme = args.scheme === 'flat' || args.scheme === 'peak' || args.scheme === 'off' ? args.scheme : null
        if (scheme === null) return null
        const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : null }
        const inP = num(args.in)
        const crP = num(args.cache)
        const outP = num(args.out)
        if (inP === null || crP === null || outP === null) return null
        const existing = prices.get(key) !== undefined ? prices.get(key) : { flat: { in: 0, cache: 0, out: 0 }, peak: { in: 0, cache: 0, out: 0 }, off: { in: 0, cache: 0, out: 0 } }
        existing[scheme] = { in: inP, cache: crP, out: outP }
        prices.set(key, existing)
        return priceRows()
      })

      harness.handle('default-model', () => {
        const adm = ctx.get('agentDefaultModel')
        if (adm === undefined) return { provider: '', model: '' }
        try {
          const sel = adm.currentSelection()
          return { provider: String(sel.provider), model: String(sel.model) }
        } catch (err) {
          return { provider: '', model: '' }
        }
      })

      // Read-only GET of the DeepSeek account balance for the same credential the
      // LLM adapter uses. The key is resolved through the credentials seam, used once
      // for this HTTPS call, and never returned, stored, or logged. This handler has
      // NO write path — it cannot modify the account balance.
      harness.handle('balance', async () => {
        const credentials = ctx.get('credentials')
        let key = null
        if (credentials !== undefined) {
          try {
            const hit = await credentials.resolve('DEEPSEEK_API_KEY')
            if (hit !== undefined && hit !== null && typeof hit.value === 'string' && hit.value !== '') key = hit.value
          } catch (err) { key = null }
        }
        if (key === null) return { available: false, reason: '无法解析 DEEPSEEK_API_KEY 凭证（credentials 服务不可用或未配置）' }

        const subprocess = ctx.get('subprocess')
        if (subprocess === undefined) return { available: false, reason: 'subprocess 服务不可用' }

        let exe = null
        try { exe = await subprocess.resolveExecutable('curl') } catch (err) { exe = null }
        if (exe === null || exe === undefined || exe === '') return { available: false, reason: '未找到 curl 可执行文件' }

        let handle = null
        try {
          handle = subprocess.spawn({
            argv: [exe, '-s', '-m', '15', '-H', 'Authorization: Bearer ' + key, 'https://api.deepseek.com/user/balance'],
            cwd: '/',
            stdio: { stdin: 'ignore', stdout: { maxBytes: 65536 }, stderr: { maxBytes: 4096 } },
            graceMs: 5000,
          })
        } catch (err) {
          return { available: false, reason: '无法启动余额查询进程' }
        }

        try {
          await handle.done
        } catch (err) {
          return { available: false, reason: '余额查询进程启动失败' }
        }

        let text = ''
        try {
          if (handle.collected !== undefined && handle.collected !== null && handle.collected.stdout !== undefined) {
            text = handle.collected.stdout.readFrom(0).text
          }
        } catch (err) { text = '' }

        try {
          const payload = JSON.parse(text)
          if (payload !== null && typeof payload === 'object') {
            if (Array.isArray(payload.balance_infos)) {
              // An account can hold several currencies at once (e.g. CNY + USD);
              // return EVERY entry so the UI can show each instead of only the first.
              const infos = []
              for (const info of payload.balance_infos) {
                if (info !== null && typeof info === 'object') {
                  infos.push({
                    currency: typeof info.currency === 'string' ? info.currency : '',
                    total: info.total_balance !== undefined && info.total_balance !== null ? String(info.total_balance) : '',
                    granted: info.granted_balance !== undefined && info.granted_balance !== null ? String(info.granted_balance) : '',
                    topped: info.topped_up_balance !== undefined && info.topped_up_balance !== null ? String(info.topped_up_balance) : '',
                  })
                }
              }
              if (infos.length > 0) return { available: true, infos }
              if (payload.is_available === false) return { available: false, reason: '余额接口不可用（is_available=false）', infos: [] }
              return { available: false, reason: '余额接口返回空列表', infos: [] }
            }
            if (payload.is_available === false) return { available: false, reason: '余额接口不可用（is_available=false）', infos: [] }
          }
          return { available: false, reason: '余额接口响应无法解析', infos: [] }
        } catch (err) {
          return { available: false, reason: '余额接口响应不是有效 JSON', infos: [] }
        }
      })
    },
  }
}
