# MA
[English](README.md) | **中文**

DeepSeek 无脑配置，本地小模型也能变生产力。

MA 的核心不是“又接了一个模型”，而是两件事：远程模型配置必须无脑，本地小模型必须能做真实项目。DeepSeek 走交互式配置，LM Studio/Qwen 则通过长上下文、工具调用加固、模型切换和 benchmark 驱动修复，把小模型转化成能持续工作的生产力。

`v0.3.0` 当前支持 LM Studio 本地模型、DeepSeek 官方 API，以及通过 MCP stdio 接入的 Agora。Agora 是 MA 的本地优先深度适配：它展示真实的模型加载和 MemoryPatch 状态，不会把记忆伪装成一段 prompt。

官网：https://zimoos.github.io/my-agent/

发布页：https://github.com/zimoos/my-agent/releases/tag/v0.3.0

[路线图](ROADMAP.md) · [变更记录](CHANGELOG.md) · [参与贡献](CONTRIBUTING.md) · [Discussions](https://github.com/zimoos/my-agent/discussions)

![MA 终端界面预览](website/assets/tui-preview.svg)

![MA 初始化流程预览](website/assets/init-preview.svg)

## 真实运行记录

[MA Showcase](https://github.com/zimoos/ma-showcase) 保留了 MA + Agora 的真实运行：每条记录都包含原始提示词、生成物、验收命令和终端或浏览器录制。它是可审计示例，不是跑分宣传。

## 第一个有用任务

完成 `ma init` 后，可以先在可信项目中跑一条不修改文件的任务：

```bash
ma run --prompt "阅读当前项目的 README 和 package.json，告诉我如何启动和测试；不要修改文件。"
```

这样用户能先看到可观察的结果，再决定是否让 Agent 改代码。需要浏览器交互案例时，可直接查看 [MA Showcase](https://github.com/zimoos/ma-showcase) 的提示词、生成物和验收器。

## 噱头和证据

- **本地小模型能变生产力**：MA 的 alpha gate 用 LM Studio + 本地 Qwen3-30B 跑 70 道 L0-L2 任务。
- **DeepSeek 是无脑 fallback**：`ma init` 让 LM Studio 和 DeepSeek 走同一套上下键交互流程，远程 key 安全保存，最终直接产出可用 profile，不让用户手搓配置。
- **近似无限工作空间**：自动检测 context window、显示占用、压缩输出，面向长时间本地 Agent 循环设计。
- **小模型优化是产品本体**：Qwen/LM Studio 采样参数、图片 payload 兼容、tool-call 自愈、消息完整性都进入测试和发布门槛。
- **Agent 工具内置**：shell、文件读写、结构化编辑、grep、web 初始化后直接可用。

## 为什么是 MA

很多终端 AI 工具默认 hosted model 才是产品。MA 的判断是：工作流才是产品。DeepSeek 要配置到“别让我想”，本地 Qwen 要优化到“能一直干活”，这样 token 成本和上下文压力才不会把 Agent 用法卡死。

所以 MA 的产品优先级也不同：

- DeepSeek 一轮配置直接产出可用 profile
- 本地模型用 profile 管理，而不是一个全局字符串
- 用本地 benchmark gate 验证小模型生产力，不靠截图 demo
- API Key 进 Keychain，不进明文 JSON
- 用 `AGENT.md`、`.ma/skills/` 和工具循环承接项目工作流

## Benchmark

MA 用 benchmark 数据证明这个判断：LM Studio + 本地 Qwen3-30B 通过 alpha 阶段 L0-L2 发布门槛。

| 模型 | 运行环境 | 任务数 | L0 | L1 | L2 |
| --- | --- | ---: | ---: | ---: | ---: |
| Qwen3-30B local | LM Studio | 70 | 100% | 98.7% | 95.3% |

这个 benchmark 是“本地小模型经过 Agent-loop 工程优化后能产生生产力”的证据。它覆盖连接稳定性、工具调用稳定性和多轮本地项目任务，不是通用 coding-agent 排行榜。

详情见 [docs/benchmark-results.md](docs/benchmark-results.md)。

## 安装

### 免安装二进制包

从 Release 下载对应平台资产：

- `ma-*-macos-arm64.tar.gz`
- `ma-*-linux-x64.tar.gz`
- `ma-*-windows-x64.zip`

macOS / Linux:

```bash
tar -xzf ma-*.tar.gz
cd ma-*
./ma init
./ma
```

Windows:

```powershell
Expand-Archive ma-*.zip
cd ma-*
.\ma.cmd init
.\ma.cmd
```

portable 包内置 Node.js 和生产依赖，不要求用户提前安装全局 Node 或 npm。

### 从源码安装

```bash
git clone https://github.com/zimoos/my-agent.git
cd my-agent
npm install
npm run build
npm link
ma init
ma
```

## 快速开始

```bash
ma init
ma
```

初始化流程：

1. 选择模型来源：LM Studio local 或 DeepSeek official。
2. 按需输入 base URL。
3. 远程 provider 输入 API Key。
4. 用上下键选择发现到的模型。

两条首启路径都要保持无脑：

```text
LM Studio local   -> Base URL -> credential name -> 发现本地模型
DeepSeek official -> Base URL -> credential name -> Keychain API key -> 发现 DeepSeek 模型
```

进入 MA 后：

```text
/          显示斜杠指令提示
/model     用上下键切换模型/profile
/memory    打开项目记忆控制台
Tab        补全当前选中的指令
Enter      执行当前选中的斜杠指令
ESC ESC    切换历史会话
```

## 指令

面向用户展示的斜杠指令：

| 指令 | 用途 |
| --- | --- |
| `/model` | 打开模型/profile 选择器 |
| `/memory` | 管理具名 Memory、多记忆挂载、多目标内化、自动策略和回滚 |
| `/help` | 查看用户可用指令 |
| `/clear` | 清空当前对话 |
| `/exit` | 退出 MA |

CLI 指令：

```bash
ma                         # 开始聊天
ma chat --resume           # 恢复最近会话
ma chat --resume <id>      # 恢复指定会话
ma sessions                # 查看会话列表
ma profiles                # 查看模型 profiles
ma profile use <profile>   # 设置默认 profile
ma secrets list            # 查看安全凭据列表
ma secrets view <id>       # 系统认证后查看脱敏 key
ma secrets delete <id>     # 系统认证后删除 key
ma secrets repair <id>     # 修复 macOS Keychain trusted access
ma init                    # 交互式初始化
ma version
```

## Model Profiles

MA 把 credential 和 model profile 分开管理。

模型 id 示例：

```text
LMStudio-local/qwen/qwen3.6-27b
DeepSeek/deepseek-v4-flash
```

`/model` 会聚合所有配置 provider 下的模型，用 credential/provider 前缀区分同名模型，并记住上一次选择。

## Agora：本地运行时和原生记忆

MA 可以把 Agora 作为 provider 自己管理的 MCP stdio 子进程运行，不要求用户维护本地 HTTP 服务。TUI 会展示真实的本地模型加载、记忆挂载和生成阶段。

当 Agora 是当前 provider 时，用户操作的是名称唯一、可持续迭代的 Memory；MemoryPatch 是它的不可变版本。只有下一次 Agora 响应 metadata 返回相同的 ordered Patch ids 和更新后的 PatchSet revision，MA 才会显示 `mounted`；不会把一段事实塞进 prompt 伪装成记忆。

`/memory` 可在项目或单个会话中同时挂载 0～N 个 Memory，并在下一次请求边界热拔插，不重启基座。内化时可以在一个 batch 中混合“新建 Memory”和“增量到多个旧 Memory”；同一 source 只提取一次，各目标独立报告 completed/noop/review/conflict/failed。自动内化必须显式选择目标，默认在 4 个新增用户回合或约 2000 pending tokens、空闲 60 秒后运行；失败目标可单独重试或明确放弃，输入框和 transcript 不受影响。

Context Usage 与 MemoryPatch 是两条独立状态：底栏始终从 `agent.getContextUsage()` 显示 used/trigger/window/source；内化不会清空 context，compact 也不会冒充记忆内化。

正式 MA portable 包锁定 Agora `0.2.0` 的 Mach-O 平台制品。Agora npm 用户制品不包含 `.py/.pyc/.js/.map`；用户无需登录或机器授权即可运行。

## 内置工具

MA 默认启动以下 MCP server：

- `exec`：执行 shell 命令，带危险命令保护
- `fs`：文件读写
- `fs-edit`：结构化文件编辑
- `grep`：代码/文本搜索
- `web`：DuckDuckGo 搜索和网页抓取，支持 curl fallback

## Skills

创建 `.ma/skills/deploy.md`：

```markdown
---
name: deploy
description: Deploy this project
arguments:
  - name: environment
    description: Target environment
    required: false
    default: staging
---

Deploy this project to {{environment}}.
Run tests first, build, deploy, then verify.
```

使用：

```text
/deploy environment=production
```

如果不和内置指令冲突，skills 会出现在斜杠指令建议里。

## 配置

全局配置：

```text
~/.my-agent/config.json
```

项目配置：

```text
./config.json
```

项目配置会覆盖全局配置。MA 会从当前目录向上读取 `AGENT.md`，并额外读取 `~/.my-agent/AGENT.md`。

## 安全边界

MA 可以执行 shell 命令并编辑文件，请在可信工作区使用。

当前保护：

- 危险 shell 命令确认
- 远程 API Key 存入 macOS Keychain
- `ma secrets view/delete` 需要系统认证
- 非交互 agent 工作流使用 session-local runtime secret，避免每次启动都弹窗

alpha 阶段边界：当前 Keychain helper 足够本地 alpha 使用；如果要做到更严格的进程级信任，需要后续引入签名 helper/ACL 设计。

## 开发

```bash
npm run dev
npm test
npm run build
npm run release:check
```

正式功能变更见 [CHANGELOG.md](CHANGELOG.md)，公开产品方向见 [ROADMAP.md](ROADMAP.md)。

## 社区参与

- 提交 PR 前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。
- 安全问题请按 [SECURITY.md](SECURITY.md) 私下披露，不要公开提交 Issue。
- 仓库已启用 Discussions，用于提问、产品建议和模型/运行时反馈。

## 许可证

MA 使用 [MIT License](LICENSE) 开源。你可以使用、修改、分发、再授权和商业化 MA，只需保留版权与许可证声明。
