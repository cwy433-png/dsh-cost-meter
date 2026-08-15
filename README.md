# dsh-cost-meter

DeepSeek Harness 的动态 Cordis 插件：在 Web GUI 输入框下方显示 **本对话消耗（估算）** 与 **DeepSeek 账户余额** 的实时计数器。

当前版本：`cost-2/pkg-6`（**时间分段计价 + 双币种切换 + 自动跟随有余额币种**；源码在本仓库）。

## 核心设计（pkg-5）

1. **按事件时间分段计价**：Host 逐条读取会话事件日志（`session.log`），把每条用量事件按**它产生时刻**的官方时段（旧价 / 峰时 / 谷时）归段计价。2026-08-16 16:00 UTC 之后只有**新用量**进入峰/谷时段，历史分段金额封存；进程重启后从持久化日志重放结果一致。
2. **双币种官方价目切换**：DeepSeek 官方为 USD 和 CNY 发布**两套独立价目表**（两者比例不是单一汇率：flash 约 7.14、pro 约 6.90）。插件内置两套表，点击胶囊旁的 **`$` / `¥` 图标**把整个计量器切到该币种口径（消耗与余额一起切换），**不做任何汇率折算**。余额接口的 `balance_infos` 本就是分开的币种条目，切到哪个币种就显示哪个条目。
3. **模型归因**：按每次 `request/header` 事件记录的 provider/model 分别计价；同会话换模型不串价。

## 功能

- **常驻胶囊**（`conversation.composer.dock`）：`● 消耗 ¥0.42 · 余额 ¥45.67 ▾` + **`$ / ¥` 币种切换按钮**
  - 未手动选择币种时，自动选中**第一个有非零余额**的币种条目（多数账号只充值一个币种）；手动选择会保存并永久生效
- **展开面板**（上浮 popover，点击外部 / ESC 关闭）：
  - 本对话消耗：总金额、当前模型与计价时段、**分段明细**（旧价段 / 峰时段 / 谷时段各自金额与步数）、按模型明细
  - 账户余额：当前币种的总余额 + 赠送/充值明细、其他币种余额、手动刷新（标注「只读查询」）
  - 单价设置：当前币种的官方报价表（可编辑）、自动 / 手动时段选择、恢复官方价（USD + CNY 一起重置）
- **计价时段自动化**：`自动` = 按事件时刻分段；`手动` = 全部历史按所选单档重算（明示为「手动口径」）

## 架构与数据源

| 数据 | 来源 |
| --- | --- |
| 用量展示（实时） | Client 标准 prop `useProjection('tokenUsage')` / `('contextPressure')` |
| 用量计费（权威） | Host 遍历 `sessions.get(sessionId).log`：`request/header`、`assistant/chunk`(usage)、`assistant/message`(usage) 事件，增量缓存，替换语义与 token-meter 投影一致 |
| 模型归因 | 会话日志中最新 `request/header` 事件的 `header.config.{provider,model}`；无则回退 `agentDefaultModel.currentSelection()`（UI 标注"部署默认"） |
| 单价表 | Host 内存 `prices`（USD + CNY 两套官方价目），`set-price` 按币种白名单校验，`reset-prices` 恢复官方价 |
| 账户余额 | Host 经 `credentials.resolve` 取凭证（key 名跟随 `llm-deepseek` 设置），`curl -K -` 从 **stdin** 读 `Authorization` 头直连 `GET <baseURL>/user/balance`；baseURL 跟随 `llm-deepseek` 设置 / `DEEPSEEK_BASE_URL`。**纯只读，密钥不进 argv、不显示、不记录** |

Host ↔ Client RPC（动态插件为 `harness.handle` / `host.call`）：

- `prices` → `{currencies:['USD','CNY'], rows:[{key, USD:{flat,peak,off}, CNY:{flat,peak,off}}]}`
- `set-price {currency, key, scheme, in, cache, out}` → `{ok, rows, currencies}` / `{ok:false, reason}`
- `reset-prices` → `{ok, rows, currencies}`
- `rates` → `{now, cutoffMs, peakWindows, scheme, nextTransitionMs}`
- `session-cost {sessionId, scheme, currency}` → 分段计费报告（自动时段分段 / 手动整段重算，所选币种金额）
- `balance {force?}` → 多币种余额 + 状态（Host 端 TTL 缓存 + in-flight 合并）

## 仓库结构

```
src/host.js          动态插件 Host 半边（pkg-5 草稿，函数体即 code.host）
src/client.js        动态插件 Client 半边（pkg-5 草稿，函数体即 code.client）
tests/host.test.mjs  Host 引擎单元测试（分段计价 / 模型归因 / 双币种 / 余额安全）
package.json         npm test 入口（无运行时依赖）
README.md            本文件
NOTES.md             交接笔记：部署状态、已知问题、永久固化步骤
```

运行测试：`npm test`（Node 内置 test runner，17 个用例）。

## 版本史

| 版本 | 变更 |
| --- | --- |
| pkg-1 | `llm/stream` 瀑布拦截 + 1.5s 轮询，插件启动起累计，¥ 计价 |
| pkg-2 | 改用 `useProjection` 投影，加余额查询（初版，只取 `balance_infos[0]`） |
| pkg-3 | 官方模型表重写、峰谷计价、UI 重做 |
| pkg-4 | 多币种余额修复：返回全部币种条目、逐币种显示 |
| pkg-5 | **时间分段计价**（事件日志逐条归段、历史不重算）+ 按 request/header 模型归因 + Host 权威计价；**双币种官方价目切换**（$ / ¥ 图标，无汇率折算）；余额：stdin 传密钥、TTL 缓存、baseURL 跟随适配器、错误分类；价格 RPC 白名单 + 恢复默认 |
| pkg-6 | Client 增加**自动币种选择**：无手动选择时跟随第一个非零余额币种；手动选择持久化后不再自动跳转。Host 半边与 pkg-5 完全一致 |

## 官方价格（per 1M tokens，来源见下）

### USD 价目（英文官方定价页）

| 模型 | 时期 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 旧价（≤8/16 16:00 UTC） | $0.0028 | $0.14 | $0.28 |
| deepseek-v4-flash | 谷时 / 峰时（8/16 起） | $0.007 / $0.014 | $0.22 / $0.44 | $0.66 / $1.32 |
| deepseek-v4-pro | 旧价（≤8/16 16:00 UTC） | $0.003625 | $0.435 | $0.87 |
| deepseek-v4-pro | 谷时 / 峰时（8/16 起） | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

### CNY 价目（中文官方定价页，元）

| 模型 | 时期 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 旧价（≤北京时间 8/17 00:00） | 0.02 | 1 | 2 |
| deepseek-v4-flash | 谷时 / 峰时（8/17 起） | 0.05 / 0.10 | 1.5 / 3.0 | 4.5 / 9.0 |
| deepseek-v4-pro | 旧价（≤北京时间 8/17 00:00） | 0.025 | 3 | 6 |
| deepseek-v4-pro | 谷时 / 峰时（8/17 起） | 0.15 / 0.30 | 4.5 / 9.0 | 13.5 / 27.0 |

来源：[DeepSeek 官方定价页（EN/USD）](https://api-docs.deepseek.com/quick_start/pricing/) · [DeepSeek 官方定价页（中文/CNY）](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)。峰时 = UTC 1:00–4:00、6:00–10:00（北京时间 9:00–12:00、14:00–18:00）。

## 说明与限制

- 动态插件是**进程内临时**的：进程重启即消失，需重新 define/run。永久固化方案见 [NOTES.md](NOTES.md)。
- 金额为按官方刊例价的估算值；手动改价仅存于插件内存，重启回到默认。
- 用量事件按 `(turn, step)` 替换语义去重（chunk 采样被最终 assistant 消息替换），与自带统计行同口径；被压缩 shadow 掉的步骤仍计入（与官方 token-meter 一致）。
- USD 与 CNY 是两套独立官方价目，插件不引入任何汇率来源；若 DeepSeek 将来官方调价，需同步更新 `src/host.js` 的 `defaults` 与本表。
- 余额查询为只读 GET，插件没有任何扣费/写操作路径。

## License

暂未确定。
