# omp-session-retitle

手动刷新 OMP 会话标题：识别当前会话树分支的主任务，避免最后几轮修 CI、跑测试或开 PR 把标题带偏。独立调用模型，只更新会话元数据，不修改 OMP core，不向主会话追加消息。

```text
/retitle
/retitle 本会话主体是实现会话手动重命名扩展，最后的 CI 修复只是收尾
/retitle undo
```

标题格式与语言由所选提示词决定，不要求固定 metadata 或工作流。例如：

```text
修复移动端登录
Investigate startup crash
```

**已验证基线：OMP 18.1.16、Bun 1.3.14、WSL/Linux。** 其他版本/平台尚未实测。这里的“分支”指 OMP 会话树，不是 Git branch；扩展不读取 Git 仓库或 diff。

## 安装与加载

在本仓库运行：

```bash
bun install --frozen-lockfile
omp -e ./index.ts
```

以上命令从本仓库启动 OMP，不修改全局配置。从其他项目启动时，使用扩展入口的实际绝对路径。

长期启用时，可将该入口加入有效 OMP 配置的 `extensions` 列表，**保留原有列表项**：

```yaml
extensions:
  # 原有扩展保留在这里
  - /absolute/path/to/omp-session-retitle/index.ts
```

替换示例路径后重启 OMP。项目提供 `omp.extensions` package manifest。移除对应配置项并重启即可卸载；已经设置的标题和会话内的撤销元数据会保留。

> [!NOTE]
> 不要把仓库根目录整个复制进主会话消息，也不需要让主模型执行 `/retitle`。直接在 OMP 输入框输入命令。扩展不会替你修改原有自动标题设置；通过公开接口写出的标题标记为手动标题，OMP 18.1.16 会阻止自动标题覆盖它。

## 命令

| 命令 | 行为 |
| --- | --- |
| `/retitle` | 从当前分支提取任务，用独立请求生成并校验标题，然后改名。 |
| `/retitle 补充说明` | 把说明作为本次任务纠偏输入，不加入主会话。最多 2000 字符。 |
| `/retitle undo` | 恢复最后一次成功刷新之前的标题，不读取模型配置、不调用模型。只能撤销一步，不能反复 undo 来回切换。 |
| `/retitle cancel` | 取消本实例正在生成的标题。后续迟到结果不会应用。 |

TUI 中生成期间还可按 `Esc`。第二次刷新会取消前一个生成请求，以新的请求为准。**保存标题已经开始后不可取消或被另一条刷新/undo 超越**；命令会提示稍后重试。主会话正在工作或有排队消息时拒绝开始刷新，不会中止主代理。

无任务输出 `none`、`<title/>` 或空 `<title></title>`、生成结果与原标题相同、生成失败或校验失败，均不产生新的 undo。没有原标题的会话会拒绝刷新：公开接口不能把标题清空，无法保证 undo 恢复为空；请先用 OMP `/rename` 设置一个标题。

## 模型与 reasoning 配置

每次生成重新读取 JSON。合并顺序：默认值 → `<OMP agentDir>/retitle.json` → `<项目 cwd>/.omp/retitle.json` → `OMP_RETITLE_CONFIG` 指定文件。默认 agentDir 通常是 `~/.omp/agent`，实际路径使用 OMP `getAgentDir()`，尊重 profile/目录设置。

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

`model: null` **只沿用当前主模型的 provider/model 标识**；不继承主会话 reasoning。指定独立模型时改为：

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

这两个模型标识是待替换的说明，不是可直接使用的模型名。使用本机 OMP 模型列表中的值；已有自定义 provider 的 URL、headers 和兼容选项由 OMP registry 提供，无需在这里再填 API key。找不到精确模型时失败，不模糊匹配或回退到其他模型。

命令帮助、状态和错误提示使用英文；生成标题的语言由标题提示词和用户任务决定。扩展默认不指定某家 provider 的模型，便于使用已有配置。

有限真实对照中，Luna 的参考费用最低，但有标题漏掉具体对象；Sol 的主体更明确，是质量/成本折中；直接复用昂贵主模型并不保证缓存命中或更低成本。建议先用 `off`，需要时通过 `/retitle 具体任务对象` 纠偏，不必默认启用高 reasoning。测试样本、实际输出、耗时和官方价估算见 [模型对照](docs/TESTING.md#真实模型对照2026-09-11)。这些模型不是安装前提，扩展仍默认 `model: null`。

| 字段 | 默认值 / 约束 |
| --- | --- |
| `model` | `null` 或完整 `{ "provider": "…", "id": "…" }`。对象整体替换，不能只覆盖一个字段。 |
| `reasoning` | `off`；允许 `minimal / low / medium / high / xhigh / max`。不支持推理的模型只能配置 `off`。 |
| `maxInputChars` | `24000`；范围 `4000–120000`，限制序列化的历史/说明 JSON，不含 system rules。 |
| `maxOutputTokens` | `1024`；范围 `1024–32768`，还不能超过目标模型声明的上限。开启 reasoning 时可按需求增加预算。 |
| `timeoutMs` | `60000`；范围 `1000–300000`，覆盖配置/规则加载及生成，不对已经开始的标题持久化强行中断。 |
| `titleSystemPath` | `null`：自动选择 OMP 标题文件，没有时使用扩展规则；`"bundled"`：强制使用扩展规则；其他字符串：自定义文件路径。 |
| `manualRefreshPath` | `"bundled"`：追加扩展手动刷新规则；`null`：不追加；其他字符串：自定义手动刷新规则路径。 |

未知字段、拼写错误、损坏 JSON、缺失的显式配置文件都会报错，不会静默忽略。全局/项目默认配置不存在可以跳过。已存在但错误的低优先级配置也不能被后面的层掩盖。

## 标题提示词与手动刷新规则

**OMP 18.1.16 不要求存在 `TITLE_SYSTEM.md`。** 它将该文件作为可选覆盖；不存在时使用编译进 OMP 的默认提示词，要求约 5 个词并使用 `<title>` 标记。扩展不依赖安装目录里是否存在 OMP 内部提示词资源。

默认 `titleSystemPath: null`，每次刷新依次检查：

1. `<当前 cwd>/.omp/TITLE_SYSTEM.md`。
2. `<OMP getAgentDir()>/TITLE_SYSTEM.md`，通常为 `~/.omp/agent/TITLE_SYSTEM.md`。
3. 本扩展 [TITLE_SYSTEM.md](TITLE_SYSTEM.md)：通用简短标题，跟随用户任务语言，不强制分类前缀。

这是 OMP 项目/agent 文件的复用，不是 OMP 所有内部发现来源的完整复刻。不会自动搜索 `.claude`、`.codex`、`.gemini` 或祖先目录，也无法获取 SDK 调用者直接传入的内存提示词。需要这些来源时，用 `titleSystemPath` 显式指定文件。选中的文件为空、过大或无法读取时会报错，不偷偷换用另一份规则。

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

[MANUAL_REFRESH.md](MANUAL_REFRESH.md) 默认追加，负责允许用户纠正原标题、从整个分支识别主体、避免末尾执行步骤抢占主题。它不指定中文、四段格式、ticket 文件命名或个人 skill 名称。基础提示词控制语言和命名风格，手动规则覆盖自动标题的稳定性限制。

如果自己的基础规则已经处理了手动刷新，可设置 `"manualRefreshPath": null`。这只关闭手动策略，不关闭单行、80 码点、无任务输出和输入信任边界等协议约束。

## 任务纠偏、输入与校验

基础规则 → 可选手动刷新规则 → 扩展输出协议，按此顺序组成 system prompt。扩展不修改原始规则文件。

手动刷新允许用后续**用户明确意图**纠正最初泛化或错误的任务判断。不能仅因助手写了代码就更换工作流，也不能用末尾“修 CI / 测试 / commit / push / 开 PR”代替贯穿会话的工作对象。新建 PR 是产物，不自动取代原 ticket/Issue 来源。

只取 `getBranch()` 的用户/助手可见文本和低信任摘要；不读取兄弟分支，不把工具输出、图片、thinking、encrypted replay 或 custom messages 发给标题模型。`/clear` 的 reset boundary 之前内容不再纳入。长会话保留早期用户目标和最近纠偏，压缩/裁剪辅助材料；预算过小时进一步裁剪，并在成功提示中说明。

本地校验要求非空单行、无控制/隐藏字符、无反引号且最多 80 个 Unicode 码点。支持纯文本或单个 `<title>...</title>` 包装，保存时去掉包装。分类、工作流、来源编号和文件命名由所选提示词决定；扩展不硬编码特定 tracker 的编号语法，也不因会话包含很多编号而拒绝生成。

> [!IMPORTANT]
> 主任务识别、编号是否有依据、命名风格和语言质量由模型判断，不由本地校验器保证。提示词要求编号来自保留的用户文本或补充说明，不能只引用规则示例、原标题或助手摘要。生成错误可用 undo 恢复，再以明确补充说明重新刷新。`undo`、`cancel` 只有整条参数恰好等于该词时才作为子命令。有限真实模型对照结果见 [验证记录](docs/TESTING.md)。

## 认证、缓存与数据范围

使用当前 OMP registry，一次调用 `getApiKey(model, 主会话 sessionId, { signal })`，将解析结果作为静态 key 交给辅助请求。扩展不读原始凭据数据库，不打印 key，不新增登录、强制账号切换或扩展级模型回退。

**同一个 sessionId 不代表永不换账号。** OMP 18.1.16 的原生池可能在初始解析时按模型资格、额度、可用性、OAuth refresh 等重新选择；session sticky/pin 不是 global hard switch。因此本扩展不能保证使用主会话上一轮的同一 OAuth 账号。这里刻意不使用会在认证失败时 `rotateSessionCredential` 的官方 resolver，避免辅助请求重试主动轮换主 session；provider/SDK 自身仍可能用同一静态 key 重试。

辅助请求使用新的 transport sessionId，关闭 Responses 续写，不共享主会话的 provider-session state。沿用相同模型不保证主会话 prompt-cache 命中；没有承诺特定价格或缓存节省。`off` 使用实际 `disableReasoning` 接口；有些 provider 只能降到最低支持 effort，并不保证零推理 token。辅助调用会使用真实 provider 额度，但没有向主对话伪造 usage 消息，也不承诺 OMP 的主会话 token 统计已包含这次调用。

选另一个 provider 就会把被提取的历史文本发给那个 provider。排除工具/凭据数据库不等于自动脱敏用户以前粘贴到可见消息里的秘密；敏感会话应先审慎选择模型和 provider。

## 竞争与失败边界

生成开始记录 session ID/file、cwd、branch leaf、原标题和最近 title-change ID；写入前再比较。切换、fork/tree、压缩、开始新主代理消息、外部改名、undo/cancel 或下一次刷新都会使旧结果失效，包括“切走再切回来”和“改名后又改回同名”。undo 记录属于当前会话路径，fork 不继承原会话的 undo 权限。

**保护范围是一个 OMP 实例可观察到的状态。** 公开扩展接口没有跨进程原子 CAS，不要让两个 OMP 进程同时写同一个 session 文件。OMP 标题是会话级元数据，不是每个 tree branch 一份；分支变化保护针对过期任务和撤销记录，不会把 OMP 改造成分支独立标题系统。

公开 setter 在磁盘写成功前已修改内存。保存失败时，只在仍为原会话/分支且没有其他改名时尝试恢复原标题；失败也会尽量保留上一次成功刷新对应的 undo。磁盘损坏、只读、进程被杀或保存中途切换的场景不能承诺事务回滚；提示会明确说明需要检查原标题和磁盘。custom metadata 的 append 也没有公开 durable acknowledgement。成功 retitle 和 undo 均保持 `user` 标题来源，不能恢复内部的 `auto` 标记。

## 开发与验证

```bash
bun install --frozen-lockfile
bun run check
OMP_BINARY=/absolute/path/to/omp bun run test:smoke
npm pack --dry-run --ignore-scripts
```

烟测要求显式给出 OMP 二进制，避免 `bun run` 的 PATH 优先级误选 `node_modules/.bin/omp`。它在自己的临时 HOME/agent/config 目录中启动真实 RPC runtime，注册离线模拟 provider，验证加载、改名、undo、主设置和消息隔离；不使用用户登录凭据或真实模型。测试夹具不会包含在发布包文件清单里。

详细已测/未测范围见 [docs/TESTING.md](docs/TESTING.md)，接口证据和认证限制见 [docs/API_AUDIT.md](docs/API_AUDIT.md)。仓库中的 `PLAN.md` 是初版历史设计记录，当前行为以本文为准。
