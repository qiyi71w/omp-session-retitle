# omp-session-retitle

为 OMP 会话重新生成标题。扩展根据当前会话分支识别主任务，减少末尾测试、修 CI 或开 PR 对标题的干扰。它独立调用模型，只更新会话元数据，不向主会话追加消息。

```text
/retitle
/retitle 本会话主体是实现会话手动重命名扩展，最后的 CI 修复只是收尾
/retitle undo
```

标题格式和语言由提示词决定。例如：

```text
修复移动端登录
Investigate startup crash
```

已验证环境：OMP 18.1.16、Bun 1.3.14、WSL/Linux。其他版本和平台尚未实测。“分支”指 OMP 会话树；扩展不读取 Git 仓库或 diff。

[安装](#安装与加载) · [命令](#命令) · [配置](#模型与-reasoning-配置) · [提示词](#标题提示词与手动刷新规则) · [数据范围](#认证缓存与数据范围)

## 安装与加载

先安装 OMP 和 Bun，并在 OMP 中配置可用模型。下载本项目后，在仓库目录运行：

```bash
bun install --frozen-lockfile
omp -e ./index.ts
```

这会从本仓库启动 OMP，仅为本次启动加载扩展。从其他项目启动时，将入口改为实际绝对路径。

长期启用时，可将该入口加入有效 OMP 配置的 `extensions` 列表，**保留原有列表项**：

```yaml
extensions:
  # 原有扩展保留在这里
  - /absolute/path/to/omp-session-retitle/index.ts
```

替换示例路径后重启 OMP。卸载时移除该配置项并重启；已有标题和撤销元数据会保留。

> [!NOTE]
> 不要把仓库根目录整个复制进主会话消息，也不需要让主模型执行 `/retitle`。直接在 OMP 输入框输入命令。扩展不会替你修改原有自动标题设置；通过公开接口写出的标题标记为手动标题，OMP 18.1.16 会阻止自动标题覆盖它。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/retitle` | 从当前分支提取任务，用独立请求生成并校验标题，然后改名。 |
| `/retitle 补充说明` | 把说明作为本次任务纠偏输入，不加入主会话。最多 2000 字符。 |
| `/retitle undo` | 恢复最后一次成功刷新之前的标题，不读取模型配置、不调用模型。只能撤销一步，不能反复 undo 来回切换。 |
| `/retitle cancel` | 取消本实例正在生成的标题。后续迟到结果不会应用。 |

生成期间可按 `Esc` 取消，或再次刷新以替换前一个请求。进入保存阶段后，需等写入完成才能刷新、撤销或取消。主会话正在工作或有排队消息时，请稍后再试。

只有成功改名才会更新撤销记录。模型返回 `none`、`<title/>` 或空 `<title></title>`、标题未变、生成或校验失败时，原记录保持不变。

会话必须已有标题。若标题为空，请先用 OMP `/rename` 设置一个；公开接口无法撤销回空标题。

## 模型与 reasoning 配置

每次刷新都会重新读取配置，后面的配置覆盖前面的同名字段：默认值 → `<OMP agentDir>/retitle.json` → `<项目 cwd>/.omp/retitle.json` → `OMP_RETITLE_CONFIG` 指定文件。agentDir 由 OMP `getAgentDir()` 决定，通常为 `~/.omp/agent`，支持 profile 和自定义目录。

可以从 [retitle.example.json](retitle.example.json) 开始：

```json
{
  "model": null,
  "reasoning": "off",
  "maxInputChars": 24000,
  "maxOutputTokens": 1024,
  "timeoutMs": 60000
}
```

`model: null` 沿用当前主模型的 provider/model 标识，reasoning 单独配置。要指定其他模型，改为：

```json
{
  "model": {
    "provider": "这里填 OMP 中的精确 provider ID",
    "id": "这里填该 provider 下的精确 model ID"
  },
  "reasoning": "low",
  "maxOutputTokens": 4096
}
```

将示例中的 provider 和 model ID 替换为本机 OMP 模型列表中的精确值。扩展复用 OMP 中的认证、URL、headers 和兼容选项，无需另填 API key。找不到指定模型时会报错。

命令帮助和状态提示为英文，标题语言由提示词和用户任务决定。

**日常刷新推荐 Luna + `medium`。** 在 [Luna 各档位验收](docs/TESTING.md#luna-各档位验收2026-09-11) 的 16 次调用中，15 次标题达到优选标准、1 次可用，耗时中位数 2.63 秒。更重视细节可选 `max`，本次 16 次均为优选，中位数 4.46 秒。结果来自小样本和单一 provider，供选型参考。

推荐配置如下；将 provider 替换为你在 OMP 中配置的 ID，并确认该 provider 提供 `gpt-5.6-luna`：

```json
{
  "model": {
    "provider": "你的 provider ID",
    "id": "gpt-5.6-luna"
  },
  "reasoning": "medium"
}
```

扩展默认仍为 `model: null`、`reasoning: off`，无需预先拥有 Luna。Luna 本次线路中的 `off` 实际映射为 `low`，`minimal` 不受支持。其他模型的效果和参考费用见 [模型对照](docs/TESTING.md#真实模型对照2026-09-11)。

| 字段 | 默认值 / 约束 |
| --- | --- |
| `model` | `null` 或完整 `{ "provider": "…", "id": "…" }`。对象整体替换，不能只覆盖一个字段。 |
| `reasoning` | `off`；允许 `minimal / low / medium / high / xhigh / max`。不支持推理的模型只能配置 `off`。 |
| `maxInputChars` | `24000`；范围 `4000–120000`，限制序列化的历史/说明 JSON，不含 system rules。 |
| `maxOutputTokens` | `1024`；范围 `1024–32768`，还不能超过目标模型声明的上限。开启 reasoning 时可按需求增加预算。 |
| `timeoutMs` | `60000`；范围 `1000–300000`，覆盖配置/规则加载及生成，不对已经开始的标题持久化强行中断。 |
| `titleSystemPath` | `null`：自动选择 OMP 标题文件，没有时使用扩展规则；`"bundled"`：强制使用扩展规则；其他字符串：自定义文件路径。 |
| `manualRefreshPath` | `"bundled"`：追加扩展手动刷新规则；`null`：不追加；其他字符串：自定义手动刷新规则路径。 |

全局和项目配置文件可以省略。只要文件存在，每一层都必须有效：未知字段、无效值或损坏 JSON 会报错，即使更高优先级的配置覆盖了它。显式指定的配置文件缺失也会报错。

## 标题提示词与手动刷新规则

OMP 18.1.16 将 `TITLE_SYSTEM.md` 作为可选覆盖文件，没有时使用内置提示词。本扩展优先读取以下文件，均不存在时使用随扩展提供的规则。

默认 `titleSystemPath: null`，每次刷新依次检查：

1. `<当前 cwd>/.omp/TITLE_SYSTEM.md`。
2. `<OMP getAgentDir()>/TITLE_SYSTEM.md`，通常为 `~/.omp/agent/TITLE_SYSTEM.md`。
3. 本扩展 [TITLE_SYSTEM.md](TITLE_SYSTEM.md)：通用简短标题，跟随用户任务语言，不强制分类前缀。

自动查找仅限上述位置。`.claude`、`.codex`、`.gemini` 和祖先目录中的文件需通过 `titleSystemPath` 指定；SDK 直接传入的内存提示词无法读取。选中的文件为空、过大或不可读时会报错。

强制使用扩展内的规则：

```json
{ "titleSystemPath": "bundled" }
```

自定义标题规则与手动刷新规则：

```json
{
  "titleSystemPath": "./prompts/title.md",
  "manualRefreshPath": "./prompts/manual-refresh.md"
}
```

两个路径都相对于**声明它的 JSON 文件目录**解析；支持绝对路径，不展开 `~`。`bundled` 是保留值；名为 bundled 的本地文件可写为 `./bundled`。高优先级配置中的 `titleSystemPath: null` 可恢复自动发现。

[MANUAL_REFRESH.md](MANUAL_REFRESH.md) 默认追加到基础提示词之后：允许用户纠正原标题，并从分支历史中识别主任务，避免末尾收尾步骤抢占主题。语言和命名风格仍由基础提示词控制。

如果基础规则已包含手动刷新策略，可设置 `"manualRefreshPath": null`。扩展仍会应用单行、80 码点、无任务输出和输入信任边界等协议约束。

## 任务纠偏、输入与校验

基础规则 → 可选手动刷新规则 → 扩展输出协议，按此顺序组成 system prompt。扩展不修改原始规则文件。

手动刷新以用户明确表达的任务为依据，包括后续纠正。助手执行了哪些步骤、最后创建了哪个 PR，都不应单独决定会话主题或来源编号。

输入来自 `getBranch()`：当前分支的用户与助手可见文本，以及作为辅助材料的摘要。兄弟分支、工具输出、图片、thinking、encrypted replay 和 custom messages 均不发送；`/clear` 之前的内容也会排除。长会话优先保留早期用户目标和最近纠正，按预算裁剪其余材料，并在成功提示中说明。

标题必须是非空单行，最多 80 个 Unicode 码点，且不含控制字符、隐藏字符或反引号。接受纯文本或单个 `<title>...</title>` 包装，保存时去掉包装。分类、工作流和来源编号的写法由提示词决定。

> [!IMPORTANT]
> 主任务识别、编号是否有依据、命名风格和语言质量由模型判断，不由本地校验器保证。提示词要求编号来自保留的用户文本或补充说明，不能只引用规则示例、原标题或助手摘要。生成错误可用 undo 恢复，再以明确补充说明重新刷新。`undo`、`cancel` 只有整条参数恰好等于该词时才作为子命令。有限真实模型对照结果见 [验证记录](docs/TESTING.md)。

## 认证、缓存与数据范围

扩展通过当前 OMP registry 为目标模型解析一次凭据，使用主会话 sessionId 参与账号选择，再将凭据交给独立请求。扩展不直接读取原始凭据数据库，也不打印 key。

OMP 的账号池可能因模型资格、额度、可用性或 OAuth refresh 选择不同账号，因此辅助请求不一定使用主会话上一轮的账号。扩展不会在认证失败后主动轮换主会话凭据；provider/SDK 仍可能使用同一凭据重试。详见 [认证核查](docs/API_AUDIT.md#多账号认证的实际语义)。

辅助请求使用独立的 transport sessionId，关闭 Responses 续写。复用主模型不代表能命中主会话的 prompt cache。调用会消耗 provider 额度，但 OMP 主会话的 token 统计不一定包含它。`off` 通过 `disableReasoning` 请求关闭推理；部分 provider 只能降到最低 effort，仍可能产生推理 token。

选择其他 provider 后，提取的历史文本会发送给该 provider。用户或助手消息中的敏感内容不会自动脱敏，请据此选择模型和 provider。

## 竞争与失败边界

扩展在生成前记录会话、目录、分支和标题状态，写入前再次比较。期间切换会话或分支、压缩历史、开始主会话消息、外部改名、撤销、取消或再次刷新，都会使旧结果失效；切走再切回、改名后又改回原名也一样。撤销记录属于当前会话路径，fork 不继承原会话的撤销权限。

这些保护仅覆盖当前 OMP 实例能观察到的状态。公开接口没有跨进程原子比较并写入能力（CAS），请勿让两个进程同时写同一个 session 文件。标题是会话级元数据，各 tree branch 共用一个标题。

OMP 在落盘前就会更新内存标题。保存失败时，扩展只在会话、分支和标题仍匹配的情况下尝试恢复原标题及上一次撤销记录。磁盘故障、进程终止或保存期间切换会话时，回滚可能失败；请按错误提示检查标题和存储。撤销元数据的追加接口也不提供落盘确认。刷新与撤销后的标题来源均为 `user`，不会恢复为 `auto`。

## 开发与验证

```bash
bun install --frozen-lockfile
bun run check
OMP_BINARY=/absolute/path/to/omp bun run test:smoke
npm pack --dry-run --ignore-scripts
```

烟测需显式指定 OMP 二进制，避免误用 `node_modules/.bin/omp`。它在临时 HOME、agent 和配置目录中启动 OMP RPC，使用离线模拟 provider 检查加载、改名、撤销，以及主设置和消息隔离，不使用个人凭据或真实模型。测试夹具不随包发布。

测试覆盖和未测场景见 [验证记录](docs/TESTING.md)，OMP 接口细节见 [接口核查](docs/API_AUDIT.md)。`PLAN.md` 保留初版设计，当前用法以本文为准。
