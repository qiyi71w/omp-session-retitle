# OMP 18.1.16 接口与认证核查

## 核查对象

核查基线：`omp --version` 输出 `omp/18.1.16`。本项目开发依赖精确固定 `@oh-my-pi/pi-coding-agent@18.1.16` / `@oh-my-pi/pi-ai@18.1.16`，核查 npm 包内真实 `src/` 与 `dist/types/`。上游：https://github.com/can1357/oh-my-pi/tree/v18.1.16 。这是版本对齐的源码/声明核查，不是已验证每个真实 provider。

以下路径相对于 `node_modules/@oh-my-pi/`。

## 已确认的接口

- `pi-coding-agent/src/extensibility/extensions/types.ts:448–574,1371,1452,1491–1494`：`registerCommand`、只读 `ctx.sessionManager`、`ctx.modelRegistry`、`ctx.model`、`ctx.isIdle()`、`ctx.hasPendingMessages()`、`appendEntry`、异步 `setSessionName(name): Promise<void>`。
- `pi-coding-agent/src/session/session-manager.ts:376–400,2465,2572,2621`：`getBranch()` 返回当前 leaf 到根的路径；`getEntries()` 是全树，不能拿它构建标题内容。`getSessionId/getSessionFile/getLeafId/getSessionName` 用于防过期；全树只读取 `title_change` 的 ID，用于发现外部改名（包括 A→B→A）。
- `pi-coding-agent/src/session/session-entries.ts:166–196`：`custom` 不参与 LLM context；与 `custom_message` 不同。`title_change` 是会话级改名审计。
- `pi-coding-agent/src/modes/controllers/extension-ui-controller.ts:1194`、`src/modes/runtime-init.ts:109`：扩展 setter 转为 `SessionManager.setSessionName(name, "user")`；同步更新内存标题后才 await 持久化。手动标题阻止后续自动标题覆盖。
- `pi-coding-agent/src/session/session-manager.ts:2232`：空标题被忽略；公开 extension facade 不暴露 clear-title、CAS、titleRevision，也丢弃内部 boolean 返回值。因此刷新前要求已有非空标题，setter 后验证实际标题。
- `pi-coding-agent/src/extensibility/extensions/types.ts:185,219,279`：UI notify/status、`onTerminalInput` 取消监听；生命周期提供 before/after switch、branch、tree、compact 及 shutdown。不能用 `ctx.abort()` 取消辅助请求，它会中止主代理。
- `pi-ai/src/stream.ts:1733`、`src/types.ts:606`：`completeSimple(model, context, options)`，`reasoning` 为 `minimal|low|medium|high|xhigh|max`，关闭需 `disableReasoning: true`。`off` 不是 Effort 值。provider 对 off 的映射可能只是最低可用档，不保证零 reasoning token。
- `pi-coding-agent/src/config/model-registry.ts:2405,2418,2428`：`find(provider, id)`、`getProviderHeaders(provider)`、`getApiKey(model, sessionId, {signal})`。保留模型配置中的 URL、headers 和兼容选项。
- `pi-coding-agent/src/extensibility/extensions/loader.ts:489–570`：包可使用 `omp.extensions`；也支持通过 `-e /absolute/path/index.ts` 加载。
- `pi-coding-agent/src/system-prompt.ts:373–383`：`TITLE_SYSTEM.md` 是可选覆盖，项目配置优先于用户配置；内部发现也涉及其他工具配置目录。该函数不由 extension host 根入口导出，扩展不导入它。
- `pi-coding-agent/src/prompts/system/title-system.md`、`src/utils/title-generator.ts:22,247`：没有覆盖时 OMP 使用内置模板，要求约 5 个词及 `<title>` 包装。扩展使用自己的通用 fallback，接受该包装，不依赖 OMP 包资源在原生安装中可读。
- 扩展自动查找当前 `.omp/TITLE_SYSTEM.md`，然后是公开 `getAgentDir()` 下同名文件；其他来源需要显式配置路径。规则每次命令重读，不写回 OMP 文件。

## 多账号认证的实际语义

`ModelRegistry.getApiKey(model, sessionId, {signal})` 进入共享 AuthStorage，尊重已配置 API key/custom provider 与当前 session 的 OAuth sticky 输入，并传递目标 modelId/baseUrl。没有读取或打印用户认证数据库。

**session sticky 不是 global hard switch，也不是永不轮换的强 pin。** `pi-ai/src/auth-storage.ts:5117–5136,5182,5222,5939,6148` 显示：解析凭据时会按模型资格、限额、可用性等排名，pin 可能仅为温热复用或同分优先。模型换到另一个 provider 时当然使用该 provider 的认证；同 provider 换模型也可能改变适用账号。

`ModelRegistry.resolver()` / `src/config/api-key-resolver.ts` 在认证错误的最后一次机会调用 `rotateSessionCredential`。本扩展刻意不使用此 resolver：每次请求通过当前主 sessionId **解析一次**凭据，并把静态 key 交给独立调用，不执行扩展级账号轮换、强制 refresh 或模型回退。这样不因辅助调用的重试主动改变主 session 的 sticky，但初始解析本身仍有 OMP 原生池选择/refresh 语义；不能承诺始终使用主会话上一轮那个账号。provider 自身可能重试同一个静态 key。

请求的 transport `sessionId` 独立生成，和用于认证的主 sessionId 分离；不伪装成主会话续写。只复用主模型标识不代表共享完整主会话 prompt cache，更不保证命中或固定节省价格。不会修改模型、reasoning 或 service-tier 主设置。

## 保护范围与不可越过的公开接口限制

实现可保护同一 OMP extension 实例内的过期请求、切换后又切回、分支变化、主会话开始工作、改名冲突、undo 与多次 retitle。改名提交前无异步间隙地比较快照，再调用真实 setter；持久化期间不接受第二次改名。

公开接口没有跨进程原子 compare-and-set。另一 OMP 进程对同一 session 文件的改名未必即时反映到当前只读 manager；本扩展不能宣称防住所有跨进程竞争，禁止同时由多个进程写同一会话。

setter 在磁盘写成功前已修改内存标题。磁盘故障不等价于“完全没有改名”；失败时只能在仍属同一会话且无其他改名/分支变化的条件下尝试恢复原名，不能保证损坏/只读文件系统的事务回滚。metadata 的同步 append 也没有 durable acknowledgement。文档和测试须保留这些边界，不用直接改 session 文件或 OMP core 隐藏限制。
