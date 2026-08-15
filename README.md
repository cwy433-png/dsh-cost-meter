# dsh-cost-meter

DeepSeek Harness 的动态 Cordis 插件：在 Web GUI 输入框下方显示 **本对话消耗（金额）** 与 **DeepSeek 账户余额** 的实时计数器。

当前版本：`cost-1/pkg-4`（多币种余额修复版）。

## 功能

- **常驻胶囊**（`conversation.composer.dock`，与自带统计行并排）：`● 消耗 $0.1234 · 余额 $45.67 ▾`
  - 消耗 = 本会话累计用量 × 可编辑单价
  - 余额 = 只读查询 DeepSeek 官方余额接口，每 30 秒自动刷新，多币种账号逐币种显示
- **展开面板**：
  - 本对话消耗：输入/输出 tokens、缓存命中率、上下文占用（估算）
  - 余额：总余额 + 赠送/充值明细 + 手动刷新（标注「只读查询」）
  - 单价设置：官方报价表（USD/1M tokens），时段选择器（自动 / 旧价 / 峰时 / 谷时）
- **计价时段自动化**：2026-08-16 16:00 UTC 之前按旧平价；之后按官方峰/谷时段自动切换（峰时 = UTC 1:00–4:00、6:00–10:00，峰时价为谷时 2 倍）

## 架构与数据源

| 数据 | 来源 |
| --- | --- |
| 会话用量（输入/输出/缓存桶，整段日志累计、实时推送） | Client 标准 prop `useProjection('tokenUsage')` / `('contextPressure')` —— 与 GUI 自带统计行同一数据源 |
| 默认模型 | Host `agentDefaultModel.currentSelection()` |
| 单价表 | Host 内存（`prices` / `set-price` RPC），按模型精确匹配，失败回退 `default` 行 |
| 账户余额 | Host 经 `credentials.resolve('DEEPSEEK_API_KEY')` 取凭证（与 LLM 适配器同源），`subprocess` 调用 `curl` 直连 `GET https://api.deepseek.com/user/balance`，返回全部 `balance_infos` 币种条目。**纯只读，密钥不显示、不记录** |

- Host ↔ Client 通信：Package 私有 JSON RPC（动态插件中为 `harness.handle` / `host.call`）。
- 无轮询用量：用量走投影推送；仅余额 30s 定时查询。

## 仓库结构

```
src/host.js    动态插件 Host 半边（cost-1/pkg-4 精确源码）
src/client.js  动态插件 Client 半边（cost-1/pkg-4 精确源码）
NOTES.md       交接笔记：状态、已知问题、永久固化步骤
README.md      本文件
```

`src/*.js` 以 `export default function` 包裹，函数体即为 `cordis_define` 需要的 `code.host` / `code.client` 原文。

## 版本史

| 版本 | 变更 |
| --- | --- |
| pkg-1 | `llm/stream` 瀑布拦截 + 1.5s 轮询，插件启动起累计，¥ 计价 |
| pkg-2 | 改用 `useProjection` 投影（与统计行同源、含历史），加余额查询（初版，只取 `balance_infos[0]`） |
| pkg-3 | 官方模型表重写（仅 v4-flash / v4-pro）、峰谷计价、UI 重做（消耗 + 余额两项突出） |
| pkg-4 | **多币种余额修复**：返回全部币种条目、逐币种显示、主显取非零项；空值不再显示为 0 |

## 官方价格（USD / 1M tokens，来源见下）

| 模型 | 时期 | 缓存命中 | 缓存未命中 | 输出 |
| --- | --- | --- | --- | --- |
| deepseek-v4-flash | 旧价（≤8/16 16:00 UTC） | $0.0028 | $0.14 | $0.28 |
| deepseek-v4-flash | 谷时 / 峰时（8/16 起） | $0.007 / $0.014 | $0.22 / $0.44 | $0.66 / $1.32 |
| deepseek-v4-pro | 旧价（≤8/16 16:00 UTC） | $0.003625 | $0.435 | $0.87 |
| deepseek-v4-pro | 谷时 / 峰时（8/16 起） | $0.022 / $0.044 | $0.66 / $1.32 | $1.98 / $3.96 |

来源：[DeepSeek 官方定价页](https://api-docs.deepseek.com/quick_start/pricing/)。官方 API 目前**只有两个模型**：`deepseek-v4-flash`、`deepseek-v4-pro`。

## 说明

- 动态插件是**进程内临时**的：进程重启即消失。永久固化方案与步骤见 [NOTES.md](NOTES.md)。
- 金额为按官方刊例价的估算值；单价可在面板中修改（仅存于插件内存，重启回到默认）。
- 余额查询为只读 GET，插件没有任何扣费/写操作路径。

## License

暂未确定。
