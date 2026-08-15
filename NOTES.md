# 交接笔记（给下一个对话窗口）

> 目标：把 `cost-1`（动态 Cost Meter 插件）迭代到满意版本，并**永久固化**为 agent preset 里的正式插件。

## 当前状态（2026-08-15 UTC）

- **pkg-6 已实机部署并验证通过（会话内动态包，Host 半边与 pkg-5 相同）**：
  - 同一临时 `cordis` 预设会话 `session-20833b88-e4d8-42f0-951b-7d89108843e1` 执行 `cordis_define(kind:existing, cost-2)` → `pkg-6`；`cordis_run mode:update` → `run-6`，用户批准后完成。
  - `cordis_inspect_self` 终态：plugin `state: running`、`currentPackageId: pkg-6`；Host `running`，6 个 handlers 全注册；Client `running`，无 waitingFor、无诊断。
  - 源码完整性：提交的 client 与仓库逐字节一致；host 仅一处无害换行（与 pkg-5 相同），语义一致。
  - **进程重启即消失**；旧 `cost-1`（pkg-1..4）未观察到共存（用户确认只有一个胶囊）。
- 仓库 `src/host.js` / `src/client.js` 为 pkg-5 草稿，`tests/host.test.mjs` 17 用例全绿（`npm test`）。
- 部署临时会话只用于装载；插件在**所有打开页面**的 dock 槽可见。

## pkg-5 关键设计（新会话先读这个）

1. **分段计价在 Host 做，Client 纯展示**。Host RPC `session-cost {sessionId, scheme, currency}` 遍历 `sessions.get(sessionId).log`：
   - `request/header` 事件 → 更新当前 provider/model（模型归因用）；
   - `assistant/chunk`(usage) 与 `assistant/message`(usage) 事件 → 按 `(turn, step)` 替换语义折叠四个互斥桶；
   - 每条用量按 `event.time` 归入当时费率窗口：`flat`（< 2026-08-16 16:00 UTC）/ `peak`（UTC 1–4、6–10）/ `off`；
   - 增量缓存（WeakMap<Session, {length,last,current,segments}>），每次只走新事件。
2. 因此**未来峰谷切换自动生效**：8/16 16:00 UTC 后新用量自动进 peak/off 段，历史 flat 段金额不变；进程重启后从持久化日志重放同样正确。
3. `scheme: 'flat'|'peak'|'off'` 为手动口径：全部历史按所选单档重算；`auto`（默认）为分段口径。UI 明示"手动 · 峰时"等。
4. **双币种 = 两套官方价目，不做汇率折算**。已核实官方文档：`balance_infos` 的 `currency` 只有 USD / CNY 两种，是分开的余额条目；官方定价页分别发布 USD 价目和 CNY 价目，且两者比例不是单一汇率（flash ≈7.14、pro ≈6.90）。`prices` RPC 返回 `{currencies, rows:[{key, USD:{flat,peak,off}, CNY:{...}}]}`；`set-price` / `session-cost` 都带 `currency` 参数。Client 胶囊旁有 `$`/`¥` 图标按钮，点击切换**整个计量器**（消耗 + 余额 + 价格表），选择存 `localStorage['dsh-cost-meter.currency.v1']`。
5. **pkg-6 自动币种**：`localStorage` 无手动选择时，Client 在余额返回后自动选中第一个 `total > 0` 的币种条目（效果：只有 CNY 余额的账号自动落 ¥）；一旦手动点击 $/¥，`currencyPinned=true` 且持久化，自动选择永久退出。注意：pkg-5 测试期间点过的币种会作为"手动选择"被 pkg-6 尊重。
5. 价格 RPC：`set-price` 只接受 `deepseek-v4-flash` / `deepseek-v4-pro` / `default` 三个 key、币种 USD/CNY、数值 0–1,000,000；`reset-prices` 同时恢复两套官方表。
6. 余额：
   - Host 端 30s TTL 缓存 + in-flight 合并，N 个会话 tab 不再 N 倍请求；`balance {force:true}` 手动绕过 TTL。
   - 密钥经 `curl -sS -m 15 -K - <url>` 的 **stdin** 传入 `header = "Authorization: Bearer …"`，不再出现在 argv；含 `\r\n"\\` 的凭证直接拒绝。
   - apiKeyEnv 与 baseURL 跟随 `settings.get('llm-deepseek')`（fallback `launchEnvironment.DEEPSEEK_BASE_URL` → `https://api.deepseek.com`）。
   - 错误分类：curl exit 28=超时、exit 6=域名解析失败、非零退出带 stderr 首行、`error.message`、非 JSON 带 stdout 首行。

## 关键接口备忘（已在本机核实）

- 用量投影：Client `useProjection('tokenUsage')` → `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`；`contextPressure` → `{pressureTokens?, projectedTokens?, contextWindow?}`。计费输入 = uncached + cacheWrite 按未命中价，cacheRead 按命中价。
- 会话日志：`ctx.sessions.get(id).log`（事件带 `time`）；`request/header` 的 `data.header.config.{provider,model}`；usage 事件形如 `assistant/chunk` `data.chunk.type==='usage'` 或 `assistant/message` `data.usage`，`data.turn/step` 做替换去重。
- 槽位：`conversation.composer.dock`（session 域 list 槽，自带 stats order 0；本插件 id `cost-meter` order 10）。`slots.inject(key, () => slots.register(...))` 自带 fiber 清理。
- Host 服务：`credentials.resolve`、`subprocess.resolveExecutable/spawn`（`stdin:{data}` 为批式写入并关闭）、`agentDefaultModel.currentSelection()`、`settings.get('llm-deepseek')`、`launchEnvironment.get`、`sessions`。
- 动态插件内置：`harness.handle`（Host）、`host.call`/`styles.insert`/`React`/`console`（Client），`ctx.effect` 回调返回清理函数即可；client 计时需 `inject:['timer']`。
- Host handler 返回值必须是**纯 JSON**（无 undefined/Map/Date），`harness.handle` 会做跨 realm cloneJson 校验。

## 已知问题 / 未决事项

1. **运行时验证已通过，但 UI 观感待用户确认**：`cost-2/pkg-5` 已 running、Client 已装载。剩余确认项：胶囊是否正常显示、`$`/`¥` 切换、面板是否被 composer 裁切、余额显示；以及旧 `cost-1` 若仍存活是否会与本包同时出现（重复胶囊 → 需要在**定义 cost-1 的那个会话**用 `cordis_stop`/`cordis_undefine` 停掉旧包，或等进程重启）。
2. **面板裁剪风险**：`.cm-panel` 是向上 popover，锚在 composer card 内；如果容器 overflow 裁切，改用 portal 或收紧 `max-height`。已在 CSS 里给 `max-height:min(460px,55vh)`。
3. **价格表会过期**：官方若再调价（USD 或 CNY 任一价目），改 `src/host.js` 的 `defaults` + README 表格；两套表必须同步核对官方中英文定价页。
4. **`session.log` 只覆盖进程内已加载会话**：旧会话重启后需先打开；`session-cost` 会报"会话未加载"，客户端表现为 `不可用`。
5. **同一步 usage 跨时段**：chunk 采样与最终 message 替换在原始分段内就地修正，不跨段拆分（O(1) 增量代价换来的近似，跨小时边界的整步归入首次采样所在时段）。
6. **永久固化后**：`harness.handle` 要换成真实 Client↔Host RPC 服务；`ctx.get(...)` 在 host 组合已挂载；Client 的 `host.call`/`styles.insert`/`React` 也要换成包运行时对应服务（照 NOTES 旧步骤 + `cordis_inspect` 核实）。

## 永久固化步骤（新会话执行）

1. **改造成真包**：`package.json`（已有雏形）补 `exports` / `dsh` client 声明；Host 半边 `harness.handle` → 真实 RPC 服务；Client 半边 `host.call`/`styles.insert`/`React` → 包运行时对应服务。先查 `cordis_inspect` 服务目录。
2. **复制预设**：临时探测插件调 `ctx.agentPresets.copy(...)`（用完卸载），得到 `~/.dsh/.agent-presets/<id>/agent.cordis.yml`。
3. **加行**：追加本包组合行（本地路径 / `file:`）。
4. **校验**：`agentPresets.standingKeyFor(id)` 通过后开新会话确认工具/UI。
5. 预设文件沙箱写会被拒 → 按「先拒绝后单次升级重试」处理。

## 下一步清单（新会话）

- [x] 部署 pkg-5 动态 package（`cost-2/pkg-5`，run-5，Host/Client 均 running）
- [x] 部署 pkg-6 更新（`cost-2/pkg-6`，run-6：自动选择有余额币种）
- [x] 用户确认 UI：胶囊/$¥ 切换正常，无旧包重复
- [ ] 用户确认 pkg-6 自动币种行为（未手动选择时应自动落 ¥）
- [ ] 确认 8/16 16:00 UTC 后 `自动 · 谷时/峰时` 标签与分段明细符合官方时段
- [ ] 收集用户对 UI 的进一步反馈
- [ ] 满意后执行「永久固化步骤」1–5
- [ ] （可选）面板裁剪兜底（portal）
