# 我把一个本地优先的 Coding Agent 开源了：为什么“能跑”不等于“能交付”

很多 Coding Agent 的演示都很顺：模型会思考、会调用工具、能写出几段代码。

真正把它交给本地模型，去完成一个持续数十分钟、要读代码、改文件、启动服务、再验证结果的任务时，问题才开始出现：工具输出越积越长，模型在同一句话里反复打转，后台服务把工具调用卡住，最后用户只看到一条“超时”。

这也是我开源 **MA（my-agent）** 的原因。它不是又一个聊天壳，而是一个本地优先的终端 Coding Agent：把“模型能调用工具”变成“任务能被收口并交付”。

仓库：<https://github.com/zimoos/my-agent>

正式发布：<https://github.com/zimoos/my-agent/releases/tag/v0.2.0-alpha.1>

MA 的实际终端界面会把当前模型、工具能力、上下文和 Agora 运行状态直接呈现出来，不把一切都笼统写成“thinking”。

![MA terminal runtime showing model, tools, and context](../website/assets/tui-preview.svg)

## 这次开源的是什么

MA 支持三条真实的使用路径：

1. **LM Studio 本地模型**：面向 Qwen 等本地模型，保留长上下文、工具调用和模型切换。
2. **DeepSeek API**：通过 `ma init` 完成配置，密钥走系统 Keychain，不把 API Key 明文放在配置里。
3. **Agora 本地运行时**：通过 MCP stdio 启动，不依赖用户自己维护 `127.0.0.1` 的 HTTP 服务；模型载入、生成、记忆挂载都有明确状态。

首次配置和模型选择也在终端内完成，避免把本地运行状态藏在后台。

![MA initialization and model selection flow](../website/assets/init-preview.svg)

现在的 `v0.2.0-alpha.1` 已提供 macOS arm64、Linux x64、Windows x64 的可执行包。下载后不需要先安装全局 Node 或 npm：

```bash
tar -xzf ma-*-macos-arm64.tar.gz
cd ma-*
./ma init
./ma
```

## 我在本地 Agent 上踩到的四个坑

### 1. 模型停住时，不能一律显示为 thinking

本地模型第一次对话常常在载入权重或热身，不是“正在思考”。MA 对 Agora 会区分本地模型载入、记忆挂载、生成和工具调用等阶段，用户能知道它到底在等什么。

### 2. 长任务的关键不是塞更多 prompt，而是控制证据

工具返回的完整日志会迅速吞掉上下文。MA 将工具执行的可用事实保留为结构化证据，并对请求字节和工具输出设置边界；模型仍然知道前面做过什么，但不会因为重复日志把自己淹没。

### 3. 超时不等于失败，重复输出也不等于进展

Agent 很容易出现“还在继续”但实际重复同一段输出的情况。MA 对截断、生成超时、工具调用失败和任务收尾分别处理，并把能恢复的步骤留在会话里，而不是简单丢给用户一句失败信息。

### 4. 记忆必须能验证，不能把提示词注入说成记忆

Agora 的 MemoryPatch 在 MA 中只会在运行时返回匹配 metadata 后显示为已挂载。挂载、停用、内化、回滚都有明确状态；没有验证到就不会假装“已经记住了”。

## 有哪些真实数据

目前的 alpha 基准使用 LM Studio 中的本地 Qwen3-30B，覆盖 70 个 L0-L2 任务：L0 100%、L1 98.7%、L2 95.3%。它证明的是本地模型在连接、稳定工具调用和多轮项目工作中可以实用，**不是通用 Coding Agent 排行榜**。

完整口径和任务边界在仓库的 `docs/benchmark-results.md` 中公开。

## 现在适合谁用

- 想让本地模型真正操作代码仓库，而不只是在终端里聊天的人。
- 希望 DeepSeek 和本地模型可以在同一个工作流切换的人。
- 对长任务、工具调用、后台进程、上下文消耗有真实要求的人。
- 想参与把本地 Coding Agent 做得更可靠的开发者。

MA 还在 alpha 阶段，欢迎直接提 Issue、发 Discussion、贡献真实失败案例。比起“看起来很聪明”，我们更关心它能不能把一个任务真正做完。

GitHub：<https://github.com/zimoos/my-agent>

Release：<https://github.com/zimoos/my-agent/releases/tag/v0.2.0-alpha.1>
