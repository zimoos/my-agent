# MA

**English** | [中文](#中文)

Local-first multi-model coding agent for your terminal.

MA is built for developers who switch between local models and remote APIs, work inside real repositories, and want a terminal agent that is pleasant to configure instead of painful to babysit.

`v0.1.0-alpha` supports LM Studio local models and DeepSeek official API today. More OpenAI-compatible providers are next.

Website: https://zhuqingyv.github.io/my-agent/  
Release: https://github.com/zhuqingyv/my-agent/releases/tag/v0.1.0-alpha

## Why MA

- **Multi-model by default**: LM Studio local models plus DeepSeek profiles; switch with `/model`.
- **Good setup UX**: `ma init` is interactive, discovers models, and writes a usable config.
- **Secure remote keys**: DeepSeek API keys are stored in macOS Keychain; config stores only `secretRef`.
- **Real project tools**: built-in MCP tools for shell, files, structured edits, grep, and web.
- **Keyboard-first TUI**: slash command suggestions, Tab completion, sessions, revert, and model picker.
- **Local instructions**: reads `AGENT.md` from your project and global config.
- **Skills**: project-local `.ma/skills/*.md` commands with YAML frontmatter.

## Benchmark

MA passes its alpha L0-L2 internal benchmark with a local Qwen3-30B model through LM Studio:

| Model | Runtime | Tasks | L0 | L1 | L2 |
| --- | --- | ---: | ---: | ---: | ---: |
| Qwen3-30B local | LM Studio | 70 | 100% | 98.7% | 95.3% |

This benchmark covers connectivity, stable tool use, and multi-turn local project work. It is a release gate for MA's local-agent loop, not a universal coding-agent leaderboard.

See [docs/benchmark-results.md](docs/benchmark-results.md).

## Install

### Portable bundle

Download the release asset for your platform:

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

The portable bundle includes Node.js and production dependencies. No global Node or npm install is required.

### From source

```bash
git clone https://github.com/zhuqingyv/my-agent.git
cd my-agent
npm install
npm run build
npm link
ma init
ma
```

## Quick Start

```bash
ma init
ma
```

During init:

1. Choose model source: LM Studio local or DeepSeek official.
2. Enter base URL if needed.
3. Enter API key for remote providers.
4. Pick a discovered model with arrow keys.

Inside MA:

```text
/          show slash command suggestions
/model     switch model/profile with arrow keys
Tab        complete selected command
Enter      run selected slash command
ESC ESC    switch session
```

## Commands

User-facing slash commands:

| Command | Purpose |
| --- | --- |
| `/model` | Open the model/profile picker |
| `/help` | Show user-facing commands |
| `/clear` | Clear current conversation |
| `/exit` | Exit MA |

CLI commands:

```bash
ma                         # chat
ma chat --resume           # resume latest session
ma chat --resume <id>      # resume specific session
ma sessions                # list sessions
ma profiles                # list model profiles
ma profile use <profile>   # set default profile
ma secrets list            # list secure credentials
ma secrets view <id>       # view masked key after system auth
ma secrets delete <id>     # delete key after system auth
ma secrets repair <id>     # repair macOS Keychain trusted access
ma init                    # interactive setup
ma version
```

## Model Profiles

MA separates credentials from model profiles.

Example model ids:

```text
LMStudio-local/qwen/qwen3.6-27b
DeepSeek/deepseek-v4-flash
```

`/model` aggregates models from configured providers, prefixes them by credential/provider name, and remembers the last selected profile.

## Built-In Tools

MA starts with built-in MCP servers:

- `exec`: shell command execution with danger guard
- `fs`: file read/write
- `fs-edit`: structured file edits
- `grep`: code/text search
- `web`: DuckDuckGo search and web fetch with curl fallback

## Skills

Create `.ma/skills/deploy.md`:

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

Use it:

```text
/deploy environment=production
```

Skills appear in slash command suggestions unless they conflict with a built-in command.

## Configuration

Global config:

```text
~/.my-agent/config.json
```

Project config:

```text
./config.json
```

Project config overrides global config. `AGENT.md` files are loaded from the current directory upward, plus `~/.my-agent/AGENT.md`.

## Security

MA can run shell commands and edit files. Use it in trusted workspaces.

Current safeguards:

- dangerous shell command confirmation
- macOS Keychain for remote API keys
- explicit `ma secrets view/delete` authentication
- session-local runtime secret loading for unattended agent work

Known alpha boundary: the current Keychain helper is good enough for local alpha use, but stricter process-level trust would require a signed helper/ACL design.

## Development

```bash
npm run dev
npm test
npm run build
npm run release:check
```

## License

MIT

---

# 中文

[English](#ma) | **中文**

MA 是一个本地优先、多模型的终端编程 Agent。

它面向经常在本地模型和远程 API 之间切换、需要在真实仓库里完成工作的开发者。目标不是做一个炫技聊天壳，而是做一个配置舒服、键盘友好、能长期工作的终端 Agent。

`v0.1.0-alpha` 当前支持 LM Studio 本地模型和 DeepSeek 官方 API。后续会继续扩展 GLM、Qwen、Kimi、MiniMax 等 OpenAI-compatible provider。

官网：https://zhuqingyv.github.io/my-agent/  
发布页：https://github.com/zhuqingyv/my-agent/releases/tag/v0.1.0-alpha

## 为什么是 MA

- **默认多模型**：支持 LM Studio 本地模型和 DeepSeek profile，通过 `/model` 切换。
- **初始化体验好**：`ma init` 是交互式流程，可以发现模型并写入可用配置。
- **远程密钥更安全**：DeepSeek API Key 存在 macOS Keychain，配置文件只保存 `secretRef`。
- **真实项目工具**：内置 shell、文件读写、结构化编辑、grep、web 等 MCP 工具。
- **键盘优先 TUI**：支持斜杠指令提示、Tab 补全、会话恢复、回退、模型选择器。
- **项目指令**：读取项目和全局 `AGENT.md`。
- **技能系统**：支持项目内 `.ma/skills/*.md`，用 YAML frontmatter 定义命令。

## Benchmark

MA 使用 LM Studio + 本地 Qwen3-30B 通过了 alpha 阶段 L0-L2 内部 benchmark：

| 模型 | 运行环境 | 任务数 | L0 | L1 | L2 |
| --- | --- | ---: | ---: | ---: | ---: |
| Qwen3-30B local | LM Studio | 70 | 100% | 98.7% | 95.3% |

这个 benchmark 覆盖连接稳定性、工具调用稳定性和多轮本地项目任务。它是 MA 本地 Agent 循环的发布门槛，不是通用 coding-agent 排行榜。

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
git clone https://github.com/zhuqingyv/my-agent.git
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

进入 MA 后：

```text
/          显示斜杠指令提示
/model     用上下键切换模型/profile
Tab        补全当前选中的指令
Enter      执行当前选中的斜杠指令
ESC ESC    切换历史会话
```

## 指令

面向用户展示的斜杠指令：

| 指令 | 用途 |
| --- | --- |
| `/model` | 打开模型/profile 选择器 |
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

## License

MIT
