# gpui-shell benchs

用 AI 从零生成的一组 [gpui-shell](https://gpui-kit.com/shell/) 应用，用来验证两件事：

1. **AI 友好度** —— 只给设计图 / 需求和 `gpui-shell` 生成的 `AGENTS.md`、`gpui-kit.d.ts`，AI 能多快、多省地写出可运行的原生应用；
2. **功能能力** —— gpui-shell 的运行时（布局、绘制、输入、文件、网络、存储、进程……）能否支撑一个真正可用的应用，而不只是一张静态界面。

每个应用都是一个独立的 gpui-shell 应用目录，可以单独运行：

```bash
gpui-shell types -d apps/<name>          # 生成 gpui-kit.d.ts（不提交）
gpui-shell check -d apps/<name>          # 加载、渲染、物化一次
gpui-shell run -d apps/<name> --watch    # 运行并在保存时重载
```

## 目录

```text
AGENTS.md                gpui-shell 0.7.3 生成的开发说明，对所有应用生效（勿手改，升级后重新生成）
scripts/session-stats.py 从 Claude Code / Codex 会话记录统计耗时与 token
apps/
  folio-deck/            Folio Desk：Gmail 桌面客户端
  tendra/                Tendra：投标管线看板
  ocean-view/            OceanView：船队实时追踪
  signed/                Signed：PDF 签名工具
  skills-manager/        Skills：Agent Skills 管理器
```

## 结果

时间与 token 均取自本机 AI 会话记录（统计方法见下文）。**墙钟**是会话首尾事件的时间差；**活跃**只累计相邻事件间隔小于 15 分钟的部分，排除隔夜、人离开等空档。Token 总量 = 未缓存输入 + 缓存写入 + 缓存读取 + 输出；绝大部分是缓存读取，真正新增的输入/输出单列出来。

| 应用 | 说明 | Agent / 模型 | 墙钟 | 活跃 | 提示数 | 未缓存输入 | 缓存写入 | 缓存读取 | 输出 | 总 token | 状态 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| [folio-deck](apps/folio-deck) | 第 1 阶段：还原设计 → 演示版邮件应用 | Codex / gpt-6.1-sol（low） | 591 min | 61 min | 14 | 126,571 | 0 | 6,747,520 | 27,382 | 6,901,473 | ✅ |
| [folio-deck](apps/folio-deck) | 第 2 阶段：Gmail 直连、本地缓存、一键安装、macOS `.app` | — | — | — | — | — | — | — | — | — | 记录缺失 |
| [tendra](apps/tendra) | 投标管线看板，拖拽换阶段、持久化 | Claude Code / claude-opus-5-5 | 124 min | 32 min | 23 | 25,283 | 364,069 | 30,464,858 | 70,427 | 30,924,637 | ✅ |
| [ocean-view](apps/ocean-view) | 船队追踪：大圆航迹推算、海路寻路、ETA、油耗、告警、报告导出 | Claude Code 子 agent / claude-opus-5-5 | 21 min | 21 min | 2 | 1,611 | 138,266 | 16,455,907 | 89,542 | 16,685,326 | ✅ |
| [signed](apps/signed) | 打开真实 PDF（纯 JS 解析 + inflate）、手绘/键入签名库、增量更新保存带签名的 PDF、Save As | Claude Code 子 agent / claude-opus-5-5 | 48 min | 48 min | 22 | 8,949 | 285,600 | 61,209,444 | 199,693 | 61,703,686 | ✅ |
| [skills-manager](apps/skills-manager) | 扫描 / 启停 / 卸载（可恢复）/ 新建 / 导入本机 Agent Skills，从 GitHub 发现并安装 | Claude Code 子 agent / claude-opus-5-5 | 42 min | 42 min | 1 | 5,112 | 289,836 | 48,095,477 | 147,206 | 48,537,631 | ✅ |

说明：

- **folio-deck** 第 1 阶段对应提交 `59c1cc1`（2026-10-13 09:52）之前的会话，开始于 00:07，中间隔夜，所以墙钟远大于活跃时间。第 2 阶段（`4cb5fb2` 到 `ea51ddc`，10:20–18:55 的提交）在本机找不到对应会话记录，暂缺；补到记录后用同一脚本更新这一行。
- **tendra** 原为独立仓库 [huacnlee/tendra](https://github.com/huacnlee/tendra)，按原样并入 `apps/tendra`；会话含 15:59 最后一次提交后约 50 分钟的收尾与上下文压缩。
- ocean-view、signed、skills-manager 三个应用由同一会话内的三个子 agent 并行生成，每个 agent 独立统计（`<session>/subagents/agent-*.jsonl`）。子 agent 继承了主会话上下文，缓存读取里包含这部分；提示数为主会话转达的需求条数加上用户直接发给该子 agent 的消息（signed 有 18 条界面反馈直接发给了它）。

## 发现的 gpui-shell 问题

AI 在生成过程中遇到并绕过的运行时问题（gpui-shell 0.7.3），按影响排序。修复后应在对应应用里去掉绕过代码。

| 问题 | 影响 | 绕过方式 | 发现于 |
| --- | --- | --- | --- |
| manifest 中应用目录以外的 `fs` 授权被忽略（只保留 `${pluginDir}` 与 `${dataDir}`） | 无法读写用户文件、`~/.claude/skills` 等目录 | 通过白名单命令（`base64`、`ls`、`cat`、`mv`、`cp`、`find`…）间接读写 | signed、skills-manager |
| 运行时拿不到 home 目录、环境变量和数据目录路径；`import.meta.url` 为 `undefined` | 无法拼出用户路径或显示输出位置 | 安装脚本写入绝对路径；用 `find` 反推数据目录 | signed、skills-manager |
| `run -d` 时数据目录是 `<dir>-<hash>`，不是 manifest `id` | 开发与安装版数据不互通，路径难以显示 | 运行时推算真实目录名 | signed |
| `window.open_dialog` / `window.push_toast` 报 “needs a ShellRoot as the window's first view” | 系统弹窗与通知不可用 | 视图里自绘对话框和通知 | signed、skills-manager |
| `gpui-component` 用 `new Type(...)` 构造，与 AGENTS.md 要求的 `Type.new(...)`（`gpui-base`）不一致 | AI 按文档写会直接报错 | 两套库分别用不同构造方式 | signed、skills-manager |
| `gpui-component` 的 `Input` 不能配 `gpui-base` 的 `InputState`，自身 state 没有 change / submit 事件 | 输入框难以受控 | 改用 `gpui-base` 输入框 | signed |
| `fs/promises` 缺 `stat`、`rename`、`readlink`；`fetch` 缺 `arrayBuffer()` | 二进制下载与文件元数据需要绕路 | GitHub API 取 base64；命令行取元数据 | skills-manager |
| `fetch` 不发送 `User-Agent` | GitHub API 返回 403 | 手动设置请求头 | skills-manager |
| `flex_shrink()` 无参调用在渲染时报 “expected a number, got nil” | 与 Rust 无参方法习惯不符 | 显式传参 | skills-manager |
| `line_height(n)` 是倍数而非像素 | 与其他长度参数不一致，容易排版错乱 | 按倍数传值 | signed |

## 规范

新增例子必须遵守以下规范，否则不计入结果。

### 1. 必须具备实际功能

例子要能**真正完成它声称的任务**，界面还原只是起点：

- 数据来自真实来源（本机文件、网络 API、系统能力）或真实计算，而不是写死在界面里的数字；确需示例数据时，要在 README 里写明哪部分是模拟的、为什么。
- 主要操作有真实效果：保存要写到磁盘/存储并在重启后恢复，导出要产出能被其他软件打开的文件，增删改要改到真实对象上。
- 有加载中、空状态、失败与重试；破坏性操作要二次确认，且尽量可撤销。
- 纯逻辑（解析、计算、文件格式）拆成独立模块，用 `node --test` 覆盖；测试和 `check` 不得改动用户的真实数据。

### 2. 只用 gpui-shell 自身

- 只用 `AGENTS.md` 列出的内置模块（`gpui-kit`、`gpui-base`、`gpui-component`、`gpui-fps`）和相对模块；不引入 npm 包，不用 DOM / Web API。
- 以 `gpui-shell types` 生成的 `gpui-kit.d.ts` 为 API 依据；`gpui-kit.d.ts` 不提交。
- `gpui-shell.json` 只申请最窄的权限（`fs`、`network`、`clipboard`、`process`），并在应用 README 里解释每项权限的用途。

### 3. 目录与文档

- 每个例子放在 `apps/<kebab-name>/`，是一个可直接 `gpui-shell run -d` 的完整应用；`id` 用 `com.huacnlee.<name>` 并保持稳定。
- 应用自带 `README.md`：是什么、设计/灵感来源及链接（借用他人设计必须注明作者与出处）、运行方法、功能与快捷键、权限、与原作的差异和已知限制。
- 提交前 `gpui-shell check -d apps/<name>` 和该应用的测试必须通过；行为相关的改动还要实际运行检查。

### 4. 记录成本

- 从 0 到完成尽量在**同一个会话**内进行，开始时记下时间，过程中不要清空会话记录。
- 完成后用 `scripts/session-stats.py` 统计，把结果填进上面的表格（墙钟、活跃、提示数、各类 token、模型），并在“说明”里写明特殊情况（中断、多会话、人工修改等）。

## 统计方法

```bash
# Claude Code：~/.claude/projects/<路径转义后的目录>/<session>.jsonl
# 子 agent 的记录在 <session>/subagents/agent-*.jsonl
python3 scripts/session-stats.py ~/.claude/projects/-Users-me-work-app/<session>.jsonl

# Codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
python3 scripts/session-stats.py ~/.codex/sessions/2026/10/13/rollout-*.jsonl

# 多个会话合计，或只截取某段时间
python3 scripts/session-stats.py a.jsonl b.jsonl --from 2026-10-13T06:00:00Z --to 2026-10-13T08:00:00Z
```

- Claude Code 按消息 `id` 去重后累加每次调用的 `usage`（流式输出同一条消息会写多行）。
- Codex 取最后一个 `token_count` 事件里的累计用量；`cached_input_tokens` 计为缓存读取，其余输入计为未缓存输入，`reasoning_output_tokens` 已包含在输出中。
- “提示数”是人发出的消息数（含只发截图的消息），不含工具结果和系统注入内容。

## 协议

- **代码**：本仓库中的代码以 [MIT](LICENSE) 协议发布。
- **设计与功能**：各应用的视觉设计、交互和产品功能归原始参考设计图或软件的作者所有（见各应用 README 的 *Reference* 一节）。这些应用只用于验证 gpui-shell，**不可商用**；如需商用，请先取得原作者授权，或替换为自己的设计。
- 示例数据均为虚构；第三方名称与商标归各自所有者。
