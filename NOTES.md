# 交接笔记（给下一个对话窗口）

> 目标：把 `cost-1`（动态 Cost Meter 插件）迭代到满意版本，并**永久固化**为 agent preset 里的正式插件。

## 当前状态（2026-08-15 UTC）

- 动态插件 `cost-1` 的 `pkg-4` 正在当前会话运行（pluginId `cost-1`，packages pkg-1..pkg-4 都在）。
- 本仓库 `src/host.js` / `src/client.js` 是 pkg-4 的**精确源码**（函数体即 `cordis_define` 的 `code.host`/`code.client` 原文）。
- 用户对当前版本**不满意**（具体不满意的点尚未收集 —— 新会话第一步先问清楚！候选：UI 位置/样式、计价口径、余额展示方式、峰谷策略）。
- 动态插件不跨进程重启：进程一重启，`cost-1` 全部消失，需重新 define/run。永久固化步骤见下。

## 关键接口备忘（已在本机核实）

- 用量数据（**与自带统计行同源，不要再自己算**）：
  - Client 标准 prop `useProjection('tokenUsage')` → `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`（四桶互斥，整段日志累计，投影推送实时更新）
  - `useProjection('contextPressure')` → `{ pressureTokens?, projectedTokens?, contextWindow? }`
  - 计费输入 = uncached + cacheWrite（按未命中价），cacheRead 按命中价
- 槽位：`conversation.composer.dock`（session 域 list 槽，自带 `stats` 占位 order 0；本插件 id `cost-meter` order 10），标准 props：`useSession` / `useProjection` / `sessionId` / `useInput` / `inputActions`
- Host 服务：`credentials.resolve('DEEPSEEK_API_KEY')`（deepseek 适配器同款凭证）、`subprocess.spawn/resolveExecutable`、`agentDefaultModel.currentSelection()`、`tokenMeter`、`sessions`、`llm`（`llm/stream` 瀑布可拦截 usage chunk —— pkg-1 的旧方案，已废弃）
- 动态插件内置符号：`harness.handle`（Host）、`host.call`/`styles.insert`/`React`/`console`（Client）、两边都有 `ctx`、`timer` 服务（client 需 `inject: ['timer']`）
- 主题变量：`--dsw-alias-bg-layer-1/2`、`--dsw-alias-bg-overlay`、`--dsw-alias-border-l1/l2`、`--dsw-alias-brand-primary`、`--dsw-alias-label-primary/secondary`

## 已知问题 / 未决事项

1. **余额显示 0 疑云**：pkg-3 只取 `balance_infos[0]`，多币种账号会误显示 0。pkg-4 已改为逐币种显示 + 主显取非零项。**用户尚未确认 pkg-4 是否解决**。新会话先问结果：
   - 若仍 0/不可用 → 让用户去 platform.deepseek.com 账单页核对真实扣费（权威数据在那）；核对 key 是否被其他程序共用；记录面板「状态」行文案。
   - 注意：余额接口是**只读 GET**，插件不可能动余额。
2. **密钥短暂出现在 curl 进程 argv**（本机 `ps` 可见）。可选改进：用 `-K` 临时配置文件（0600 权限）传 `Authorization` 头，查询后删除。
3. **峰谷切换待验证**：`Date.UTC(2026,7,16,16)` 为切换点，峰时判定 `(h>=1&&h<4)||(h>=6&&h<10)`（UTC）。8/16 之后观察 `自动 · 峰时/谷时` 标签是否符合官方时段。
4. **余额接口写死 `api.deepseek.com`**：若部署走代理/自定义 baseURL，需从 LLM 配置里取 baseURL 再拼 `/user/balance`（参考 dsh-llm-deepseek 的 resolveAdapterOptions）。
5. **价格表会过期**：官方可能再次调价，需定期回查 https://api-docs.deepseek.com/quick_start/pricing/。
6. **多币种消耗归属**：消耗按 USD 价表计算；若账号主要扣 CNY，可考虑按 `消耗 × 汇率` 折算展示（汇率来源待定）。

## 永久固化步骤（新会话执行）

动态插件（`cordis_define`/`cordis_run`）只在进程内存在。永久固化 = 真插件包 + 用户预设组合行：

1. **改造成真包**（在本仓库）：
   - `package.json`：`"type": "module"`、`"main"`/`exports["."]` = Host 插件（`lib/index.js` 默认导出 `{ apply(ctx){...} }`）、`exports["./client"]` = Client 插件；`"dsh": { "client": { "platform": "web", "inject": [...] } }`（参照 `@deepseek-ai/dsh-client-ui-conversation` 的声明）。
   - Host 半边：`harness.handle` 替换为真实的 Client↔Host RPC 服务（查 `cordis_inspect` 服务目录确定本版本 API）；`ctx.get('credentials')/('subprocess')/('agentDefaultModel')` 在永久包中同样可用（host 组合已挂载）。
   - Client 半边：`host.call` → 对应 RPC 服务；`styles.insert` → Client 样式服务；`React` → peerDependencies 引入；`slots`/`timer` 服务照旧。
   - 本插件不 publish 任何服务（provides 为空），预设中**不需要 isolate realm**，可松散放置；但仍以 `standingKeyFor` 校验为准。
2. **复制预设**：用临时探测插件调 `ctx.agentPresets.copy('standard', '<新id>', '<名称>')`（需 `inject: ['agentPresets','tools']` + `harness.registerTool`，用完 `cordis_unmount`），得到 `~/.dsh/.agent-presets/<id>/agent.cordis.yml`。
3. **加行**：在复制出的组合中追加一行指向本包（`name` 为本包名，本地路径或 `file:` 引用方式以部署为准）。
4. **校验**：`agentPresets.standingKeyFor(id)` 通过后，让用户用该预设开新会话确认工具/UI 正常。
5. 编辑预设文件的沙箱写会被拒 → 按「先拒绝后单次升级重试」处理（workspace-write → workspace 外写需用户批准）。

## 下一步清单（新会话）

- [ ] 问清用户对当前版本具体不满意什么（列候选，逐项确认）
- [ ] 确认 pkg-4 余额显示是否正确（多币种）
- [ ] 按反馈迭代（继续用动态插件快速验证，改动=新 package 追加，不覆盖旧版）
- [ ] 满意后执行「永久固化步骤」1–5
- [ ] （可选）`-K` 配置文件方案消除密钥入 argv
- [ ] （可选）峰谷切换在 8/16 后实测
