# dsh-cost-meter

DeepSeek Harness 插件：在对话输入框下方显示 **本对话消耗（估算）** 和 **DeepSeek 账户余额**。

`● 消耗 ¥1.26 · 余额 ¥45.67 ▾  [$|¥]`，点击展开明细：分段金额、按模型金额、token 与缓存命中率、上下文占用、余额明细、单价表。

v0.2 起是**正式插件**（profile bundle），随 harness 启动自动加载，重启不会消失。适配 dsh 0.1.7。

## 安装 / 卸载

用 harness 自带的命令（Harbor 的 harness 在 `~/Library/Application Support/Harbor for DeepSeek Harness/current`）：

```sh
DSH="$HOME/Library/Application Support/Harbor for DeepSeek Harness/current/node_modules/@deepseek-ai/dsh/lib/bin.js"
node "$DSH" plugin --profile web add "$HOME/工作/harbor/dsh-cost-meter"   # 安装（link，改源码即生效）
node "$DSH" plugin --profile web remove dsh-cost-meter                              # 卸载（还需从 package.json 的 dsh.profile.bundles 删掉）
```

装完重启 harness（Harbor 退出再打开）。

## 计价规则

每次模型调用按**它发生那一刻**的官方价目计价，历史金额不会因为之后的调价或时段切换而改变：

| 时间 | 规则 |
| --- | --- |
| 北京时间 2026-08-17 00:00 前 | 旧价（不分峰谷） |
| 之后 | 北京时间**工作日** 9:00–12:00、14:00–18:00 为峰时；其余时间、周末、法定节假日为谷时（谷时 = 峰时半价） |
| flash 自北京时间 2026-09-10 00:00 起 | 按 V4.1 Flash（`deepseek-flash`）新价；`deepseek-v4-flash` 同样路由到 V4.1 |

- 官方只写了 9/10 发布，没写几点生效，这里假设北京时间零点。
- 峰谷的“工作日 + 节假日”规则取自现在的官方定价页；8/13 公告没提这一条，这里按 8/17 起一直适用处理。
- 法定节假日表在 `lib/core.js` 的 `HOLIDAYS`，目前只有 2026 年；2027 年安排公布后要补。
- USD 与 CNY 是两套独立官方价目，插件不做汇率折算。非 DeepSeek 模型不计价。

### 官方价目（每百万 tokens，2026-09-29 核对）

| 模型 | 时段 | 缓存命中 | 未命中 | 输出 |
| --- | --- | --- | --- | --- |
| deepseek-flash（V4.1） | 谷 / 峰 | ¥0.02 / 0.04 · $0.003 / 0.006 | ¥1 / 2 · $0.15 / 0.30 | ¥4 / 8 · $0.60 / 1.20 |
| deepseek-v4-flash（9/10 前） | 旧价 | ¥0.02 · $0.0028 | ¥1 · $0.14 | ¥2 · $0.28 |
| | 谷 / 峰 | ¥0.05 / 0.10 · $0.007 / 0.014 | ¥1.5 / 3 · $0.22 / 0.44 | ¥4.5 / 9 · $0.66 / 1.32 |
| deepseek-v4-pro | 旧价 | ¥0.025 · $0.003625 | ¥3 · $0.435 | ¥6 · $0.87 |
| | 谷 / 峰 | ¥0.15 / 0.30 · $0.022 / 0.044 | ¥4.5 / 9 · $0.66 / 1.32 | ¥13.5 / 27 · $1.98 / 3.96 |

来源：[中文定价页](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/) · [英文定价页](https://api-docs.deepseek.com/quick_start/pricing/) · [更新日志](https://api-docs.deepseek.com/zh-cn/updates)。官方再调价时改 `lib/core.js` 的价目和日期，并把 `STATE_VERSION` 加一。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/core.js` | 纯函数：时段表、价目、用量折叠（session projection）、计价 |
| `index.js` | Host 半：注册 `costMeter` projection；在 Connection 鉴权内注册 `api/cost-meter/prices`（GET/POST）和 `api/cost-meter/balance`（GET） |
| `client.js` | Web 客户端：`conversation.composer.dock` 槽里的胶囊和面板 |
| `cordis.patch.yml` | bundle 补丁，把 host 插件挂进 profile |
| `tests/core.test.mjs` | `npm test` |

- **用量**来自 harness 的 session projection：重放持久化的会话日志，结果进 projection 缓存，重启后照样对。去重规则与内置 `tokenUsage` 一致（同一 turn/step 替换，`llm/retry-started` 后累加）。
- **余额**：Host 用模型调用同一个凭证（`credentials.resolve`，key 名跟随 `llm-deepseek` 设置）直连 `GET <origin>/user/balance`。纯只读；密钥只发给该接口，不返回给页面、不写日志。30 秒缓存，多标签页合并请求。
- **改价**只在本次运行有效，重启恢复官方价。
- 三个接口都在 harness 的登录鉴权之内，未登录请求返回 401。

## 版本史

| 版本 | 变更 |
| --- | --- |
| pkg-1 … pkg-6 | 动态 Cordis 插件（进程内临时，重启即消失），见 git 历史 |
| 0.2.0 | 改成正式 bundle 插件，适配 dsh 0.1.7：数据源改为 session projection；RPC 改为鉴权内的 fetch 路由；余额改用 Node fetch；新增 V4.1 Flash 价目、工作日/法定节假日规则；面板改为固定定位，不再被输入区裁切 |
