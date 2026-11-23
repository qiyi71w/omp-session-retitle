# omp-session-retitle 实施计划

> 初版历史记录。标题格式、提示词选择和手动刷新配置已通用化；当前使用契约见 `README.md`，验证证据见 `docs/TESTING.md`。

状态：已按先落盘计划 → 接口核查 → 实现 → 测试的顺序完成。基线：`38db236`，`main`，开始时工作树干净且仅有 LICENSE。未修改 OMP core，未自动提交、推送、发布或变更用户全局配置。

## 需求与已有设计

- `/retitle [补充说明]`：只读取当前 OMP 会话分支，独立调用模型后更新会话元数据；不追加用户/助手消息、不更改主模型或 reasoning。
- `/retitle undo`：恢复最后一次成功改名前的标题，不调用模型；取消正在运行的请求。另提供 `/retitle cancel` 用于无 UI 场景的显式取消。
- 标题为 `[来源][类型][工作流] 任务主题`。来源 `I#数字|PR#数字|T#数字|-`；类型 `bug|enhancement|refactor|test|docs|chore`；工作流 `implement|review|grill|triage|wayfinder|architecture|research`。
- 初版规则来自作者的个人标题约定，项目副本是整理版，不代表 OMP 自带默认规则。
- 手动刷新是自动稳定性规则的显式例外：可结合本分支后续用户明确意图纠正最初泛化标题；测试、CI、commit、push、开 PR 等执行步骤不能覆盖主任务。新建 PR 不自动变成来源；只引用输入中可核验的工作项。
- 未检索到上一会话完整设计稿；以用户本次明确需求及已读 TITLE_SYSTEM 规则为实现依据，不假造额外既定决策。

## 实施顺序

1. **接口与认证核查（实现前门禁）**
   - 本机 `omp --version` = `18.1.16`，Bun `1.3.14`，Node `22.23.2`。
   - 邻近 `oh-my-pi` checkout 为 `18.0.1`，不能作为运行时接口依据。
   - 安装精确 `18.1.16` 开发依赖，核查 ExtensionAPI、上下文、分支 entries、rename、custom metadata、UI 取消、completeSimple、ModelRegistry/AuthStorage 及多 credential/pin 语义。将证据与限制写入 `docs/API_AUDIT.md`。
2. **项目骨架与标题策略**
   - TypeScript/Bun 测试与严格类型检查，默认入口为 OMP extension。
   - 先写一条失败测试再做对应纵向切片；通过公开 module interface 验证行为。
   - 保留完整基础 TITLE_SYSTEM 规则，额外追加手动纠偏协议。对模型输出单行、长度、枚举、控制字符、来源证据严格验证；无任务 `none` 不改名。
   - 上下文只取当前分支的可见文本，明确区分用户指令和不可信工具/助手材料；裁剪有预算并保留早期任务、用户纠偏和近期上下文，不发送图片、thinking 或凭据。
3. **独立模型调用与配置**
   - 全局/项目 JSON 配置及可选显式配置文件；精确 provider/model 与独立 reasoning，可省略模型以沿用主模型的标识但不继承主 reasoning。
   - 不复用或注入主会话消息、不人为复用缓存 session 标识；限制输入、输出、超时；不自动回退另一模型。
   - 使用实查支持的认证接口，禁止读取/打印原始认证数据库、猜 active credential。明确说明辅助请求与主会话 pin 是否等价；无法保证的行为不宣称支持。
4. **安全更新与撤销**
   - 生成开始快照 session ID/file、分支 leaf、原标题与 generation token；提交前再比对，过期结果丢弃。
   - 后来的请求取消旧请求；切换、fork/tree、新消息、外部改名、undo、cancel 或超时都不得让旧结果覆盖当前标题。请求错误、格式失败不改标题、不覆盖 undo。
   - 利用已核查的 OMP 元数据接口实现撤销；如不能提供跨进程原子 CAS 或精确空标题恢复，明确限制并采用失败关闭策略，不直接改 session 文件。
5. **验证与交付**
   - 自动化测试覆盖格式、来源、纠偏输入、分支裁剪、配置、独立请求、取消、超时、竞争、switch-away-and-back、改名冲突、undo、错误路径。
   - 类型检查对真实 `18.1.16` 声明；尽可能使用本机 OMP loader/RPC 做不联网、不消耗模型额度的烟测，隔离临时用户目录。
   - README：安装、命令、配置、模型/认证/缓存语义、卸载、边界及故障说明。
   - `docs/TESTING.md` 记录实际执行命令/结果，严格分开已测、模拟、静态核查和未实测（真实模型、OAuth 多账号、真实终端交互等）。

## 范围控制与验收

只修改本项目，不安装到用户全局 OMP，不调用真实付费模型，不提交/推送/发布。不增加自动标题刷新、代理模板、模型工具调用或 OMP core patch。最终核对 git 状态和 diff，提供用户可直接执行的本地加载命令。

## 实施结果与边界

五个阶段均已完成；接口核查见 `docs/API_AUDIT.md`，安装与使用见 `README.md`，验证记录见 `docs/TESTING.md`。

生产入口 `index.ts`；配置、标题策略、独立 OMP 请求、状态/undo 分别封装在 `src/config.ts`、`src/title-policy.ts`、`src/omp.ts`、`src/controller.ts`。四段规则保留为整理版 `TITLE_SYSTEM.md`，手动纠偏独立于 `MANUAL_REFRESH.md`；支持显式指定个人完整规则文件，没有修改全局规则。

最终 `bun run check`：86 pass / 1 skip / 0 fail，类型检查通过。被默认跳过的 native smoke 单独指定本机安装的 `omp` 可执行文件执行：1 pass / 0 fail。共 87 个独立测试通过。打包 dry-run 成功，包清单没有开发测试夹具或用户配置。

明确没有宣称：真实模型标题语义质量已验证、OAuth 多账号实测、保证不发生原生池重选、保证 prompt cache 命中、跨进程原子 CAS、磁盘故障完整事务回滚、真实 TUI Esc 手测、磁盘关闭再打开的 undo 恢复实测。上述限制均已写入安装与验证文档。

实现采取的失败关闭策略：无原标题不刷新；来源无证据拒绝；损坏配置拒绝；过期快照丢弃；正在保存时拒绝竞争命令；外部改名/无当前分支 journal 不 undo。初始认证沿用当前 sessionId 但不用会主动轮换凭据的 resolver。
