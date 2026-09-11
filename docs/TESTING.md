# 验证记录

基线：OMP 18.1.16、Bun 1.3.14、WSL/Linux；开发依赖精确匹配 OMP 18.1.16，TypeScript 5.9.3。

## 通用化验证

| 检查 | 结果与证据 |
| --- | --- |
| `bun run check` 与聚焦复验 | 类型检查通过；完整测试首次 83 pass、1 skip、2 fail，失败均为绑定旧中文提示文案的断言。删除这些文案断言，保留取消/撤销行为断言后，受影响的 controller 与 SessionManager 测试 30 pass、0 fail（65 个断言）；其余测试已在完整运行中通过。 |
| `OMP_BINARY=/absolute/path/to/omp bun run test:smoke` | 使用本机 OMP 18.1.16 实际二进制：1 pass、0 fail，10 个断言。无标题覆盖文件时刷新普通标题；运行中创建项目规则后再次刷新，使用新规则；两次 undo 均恢复原名，主会话消息保持为空。 |
| `npm pack --dry-run --ignore-scripts` | 成功，13 个包文件；入口、生产代码、两份提示词、示例配置和文档均包含；测试、依赖和本地索引不包含。未发布。 |

固定的分类枚举、来源标签解析和编号数量限制已移除；相应旧契约测试删除。通用格式测试覆盖自定义 `[T#42]`、`PROJ-42` 和分类前缀，验证器不解释这些标签的业务含义。生产通知已改为英文，行为测试不绑定具体语言文案。

原生烟测还发现 OMP 内部提示词发现模块不能作为扩展宿主公开 API 使用，导入会导致扩展加载失败。实现改用公开 `getAgentDir()` 和项目目录，随后同一原生加载链路通过。没有以 Bun 下模块测试代替原生宿主验证。

## 覆盖行为

**提示词选择：** 项目 `.omp/TITLE_SYSTEM.md` 优先于 agent 目录；都不存在时使用扩展规则；显式 `bundled` 绕过发现；高优先级 `null` 恢复发现；两个自定义规则路径分别相对于声明它们的配置文件解析。手动规则可关闭或替换。选中的文件缺失、空白、过大或不是普通文件时失败关闭。

**标题与来源：** 普通中文/英文标题、自定义分类与 tracker 格式、OMP `<title>` 包装及空标题哨兵；拒绝多行、隐藏/控制字符、超长或损坏包装。编号证据由提示词交给模型判断，本地不提供语义真实性保证。输入 JSON 有预算，保留早期目标和最近纠偏。

**独立调用：** provider/model 和独立 reasoning、关闭推理的真实选项、精确模型匹配、认证与上下文预算检查；认证解析携带主会话 ID，transport sessionId 独立，不共享 Responses 续写或主 prompt。未改变原有模型请求契约。

**状态与撤销：** 旧响应丢弃、cancel/模拟 Esc、provider 忽略 signal、超时、切走再切回、cwd/leaf/新消息变化、busy/queued、外部改名及改回同名；undo 不继承兄弟分支权限；损坏 journal 不复活旧记录；保存期间互斥、失败后条件回滚并保留原 undo。

**真实运行边界：** 原生 RPC 烟测使用临时 HOME/agent/XDG 目录及离线模拟 provider，不加载用户凭据、不调用真实模型；验证 `<title>` 输出被保存为普通标题，以及同一实例重读新项目规则。测试结束终止自己创建的进程并删除临时目录。已有真实 SessionManager 集成覆盖分支投影、元数据不进入模型消息、controller 重建撤销记录和手动标题防止自动覆盖。

## 未实测 / 不承诺

- 已进行下述有限真实模型对照；不代表所有长会话、语言或 provider 的质量。离线烟测另外验证规则传递、输出解析及状态更新。
- 未实测真实 OAuth 多账号、broker/proxy、额度耗尽、refresh 或 failover。认证语义来自 18.1.16 源码及模拟调用参数核查。
- 未手动操作真实 TUI 的 Esc；Windows 原生、macOS、其他 OMP 版本未测试。
- 未验证多个进程同时写同一 session、真实磁盘损坏、掉电、落盘关闭再重开的完整恢复；公开接口没有跨进程 CAS 或事务回滚保证。
- 未执行全局安装、npm 发布、Git commit/push；未修改 OMP core 或用户全局配置。

## 真实模型对照：2026-09-11

### 方法

- OMP 18.1.16 原生 RPC 宿主，使用同一已配置的 OpenAI-compatible provider `ccswitch-codex`。比较 `gpt-5.6-luna`、`gpt-5.6-sol` 与当前会话的 `gpt-6-astra`。
- 调用生产 `buildTitleInput → loadRules → generateTitle → validateTitle` 路径。Luna/Sol 使用显式 model 配置；Astra 使用 `model: null`，从宿主当前模型取得标识。保持 `reasoning: off`、`maxOutputTokens: 1024`、`maxInputChars: 24000`、60 秒超时。
- 首轮每模型 6 个相同样本：本项目真实分支的通用标题、同一分支的用户四段规则、英文家庭旅行规划、明确纠偏后跟随 20 条测试/CI 收尾消息、ticket/Issue/新建 PR 区分、纯问候。轮换各样本的模型调用顺序，串行请求。
- 追加同一四段规则样本的无 hint 重复和明确任务对象 hint 对照，每模型 2 次。共 24 次真实模型调用；没有生成失败、格式失败或超时。没有改任何会话标题；结束后 RPC `get_messages` 仍为空。
- 记录完整调用耗时、真实 usage 和候选标题，不收集或输出凭据、请求 headers、原始 provider 错误。临时 benchmark 扩展和包含会话文本的样本不进入发布包。

### 价格口径

本地自定义 provider 给三个模型的 cost 都配置为 0，usage.cost 因而也是 0；这不能证明免费。以下采用 [OpenAI 官方 Standard 定价](https://developers.openai.com/api/docs/pricing) 的短上下文价格作参考估算，**不是代理线路账单或订阅额度扣减**。

| 模型 | 输入 USD / 1M token | 输出 USD / 1M token |
| --- | ---: | ---: |
| Luna | 0.20 | 1.20 |
| Sol | 4.00 | 20.00 |
| Astra | 10.00 | 50.00 |

所有调用的 cacheRead/cacheWrite 均为 0。费用按 `input × inputRate + output × outputRate` 除以一百万计算；output 已含 reasoning，不重复加算。24 次总参考费用约 $0.31243。

### 首轮同组比较

| 模型 | 格式有效 | 耗时中位数 | 6 次总输入 / 输出 token | 平均每次参考费用 | 按同组分布推算 1000 次 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Luna | 6/6 | 4.09 秒 | 11964 / 288 | $0.000456 | $0.46 |
| Sol | 6/6 | 2.36 秒 | 11964 / 203 | $0.008653 | $8.65 |
| Astra（复用当前模型） | 6/6 | 2.43 秒 | 11964 / 87 | $0.020665 | $20.67 |

这是小样本、单一代理线路的端到端延迟，不是模型吞吐排名。`off` 不保证零 reasoning：首轮 Luna 报告 200 个 reasoning token，Sol 115 个，Astra 未报告非零 reasoning。

| 样本 | Luna | Sol | Astra |
| --- | --- | --- | --- |
| 本项目，通用规则 | 完善通用化并评测多模型重命名效果 | 通用化 OMP Retitle 扩展并评测模型 | OMP 标题扩展通用化与模型性价比评测 |
| 本项目，用户四段规则（主题部分） | 通用性检查与模型效果评估 | OMP 会话标题扩展通用化 | OMP 标题扩展通用化 |
| 英文非代码任务 | Kyoto Three-Day Family Itinerary PDF | Plan a Budget-Friendly Family Kyoto Itinerary | Three-Day Kyoto Family Itinerary Under $800 in November |
| 明确纠偏与尾部 CI 干扰 | 实现应用多语言设置与切换 | 实现应用多语言设置与切换 | 实现应用多语言设置与切换 |
| ticket 与新建 PR 区分 | `[T#08][enhancement][implement] 应用设置` | 同左 | 同左 |
| 问候 | `none` | `none` | `none` |

人工观察：Luna 首轮两次真实分支标题偏泛，漏掉 OMP 标题扩展这个具体对象；Sol/Astra 的主体更明确。旅行标题中 Luna 附带了 PDF 产物，但仍保留旅行主体。格式通过不能等同于语义完全正确。

### 重复与 hint 对照

同一真实分支、同一四段规则：

| 模型 | 无 hint 重复的主题 | 带明确对象 hint 的主题 |
| --- | --- | --- |
| Luna | OMP 标题扩展通用化 | OMP 会话标题扩展通用化 |
| Sol | OMP 标题扩展通用化与模型选型 | OMP 会话标题扩展通用化与模型选型 |
| Astra | OMP 标题扩展通用化 | OMP 会话标题扩展通用化与模型评估 |

三者均保留了 `[-][enhancement][implement]` 前缀。Luna 无 hint 重复也改善了，因此不能把改善全部归因于 hint；这同时说明单次输出存在波动。hint 内容为明确“OMP 会话标题扩展是主任务对象，并保留具体对象”，不是指定固定答案。

### 使用建议

- 成本优先的日常刷新可选 Luna + `off`；主题含糊时补一句对象说明。首轮参考平均费用约为 Sol 的 1/19、Astra 的 1/45。
- 要求少纠偏、稳定保留具体工作对象时可选 Sol + `off`；本组结果比 Luna 明确，成本又低于 Astra。
- `model: null` 保留为扩展默认值，保证新用户沿用已有 provider/model，无需预先拥有上述模型。当前主模型很贵时不应把“复用”误解成便宜：本次 Astra 没有带来足以证明其价格优势的标题质量差距，也没有共享主会话缓存。
- 先保持 `off` 和现有 1024 输出上限，不因模型支持 reasoning 就默认开启高档。上限不是实际消费量；本组实际输出很短，主要费用在输入。真实分支配用户长规则时输入 4474 token，通用规则为 2029 token，规则长度也是成本因素。
- 不实现自动多模型重试或把某个个人 provider 写成默认值。代理计费、其他语言、长会话和更大样本需要单独测量。
