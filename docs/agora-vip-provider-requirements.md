# MA Agora VIP Provider 适配需求

## 目标

MA 将 Agora 作为内部 VIP provider 适配：Agora 不再只是一个 OpenAI-compatible 地址，而是 MA 可以直接理解的本地运行时。MA 要展示 Agora 的真实运行阶段、模型状态和 MemoryPatch 状态，同时不能影响 DeepSeek、LM Studio、OpenAI-compatible 等普通 provider 的既有能力。

## 核心原则

- Agora 走 MCP stdio，MA 自己启动 `agora mcp serve`，不依赖 `127.0.0.1:8000/v1`。
- Agora memory 只能通过 Agora MCP 和 `chat_complete` 响应 metadata 验证，不能把记忆塞进 prompt 伪装。
- Agora 的模型加载、会话解析、记忆挂载、生成阶段是 provider 内部状态，应在 TUI 里作为 Agora 状态展示。
- 普通 provider 只保留通用状态：等待响应、重试、超时、token 输出；不要求暴露 Agora 专属状态。
- Agora 专属适配必须是增量能力，不能改变普通 provider 的请求、重试、stream parser、tool-call 主循环语义。

## 功能需求

1. Agora provider 运行时
   - `provider: "agora"` 必须使用 MCP stdio runtime。
   - runtime readiness 仍以 `doctor`、`models_list`、`chat_complete` 为基础能力。
   - memory 使用 granular capability matrix；缺少目录、下载或 intake 工具时只降级对应功能，不能关闭 Agora chat。
   - provider-owned Agora subprocess 必须在 MA 退出时关闭。

2. Agora 进度展示
   - MA 对 Agora `chat_complete` 发起 MCP request 时必须携带 progress token。
   - MA 必须接收 MCP `notifications/progress`，并转换为 provider progress event。
   - Agora 阶段至少展示：排队、校验、会话/记忆解析、本地模型加载、记忆挂载、生成、完成。
   - 第一次本地模型聊天时，TUI 不能只显示 `thinking`，要显示类似 `Agora · 加载本地模型 ...`。
   - 如果 Agora 只提供阶段级进度，MA 只展示阶段，不伪造文件级、权重级百分比。

3. Agora 状态层级
   - 第一行始终展示 provider、model 和 Context Usage（used/trigger/window/source）。
   - 第二行仅在 Agora 下展示具名 Memory、版本、`+N`、verified/pending/stale 和后台 intake activity。
   - session/binding/job/完整 patch id 只放在 `/memory status`，不再堆入主底栏。
   - 该状态来自 runtime 当前 state 或 session meta 的 `providerState`。
   - 普通 provider 不展示 Agora 专属 memory/session 信息。

4. MemoryPatch 状态
   - Session meta 保留 `providerState`，字段包括 `provider_id`、`agora_session_id`、`memory.status`、`profile_id`、`binding_id`、`active_memory_patch_ids`、`last_verified_at`。
   - MA 只能从 Agora `chat_complete` 响应 metadata 更新 mounted 证据。
   - mount、disable、internalize、rollback 必须验证下一次 `chat_complete` metadata 后才报告成功。
   - `/memory` 以具名 Memory 为第一层，提供多 Memory 挂载、新建/重命名、混合多目标内化、显式自动目标、历史和 CAS 回滚；Profile 仅作为后台 binding 实现。
   - 自动 intake 一次提交显式目标列表；completed/noop 不重复，review/conflict/failed 只重试未完成目标；后台任务不得禁用输入框或写入 transcript。

5. 普通 provider 回归边界
   - DeepSeek、LM Studio、OpenAI-compatible 的请求参数、重试策略、stream parser、tool-call 解析保持不变。
   - MCP progress 支持对普通 MCP tool call 是兼容扩展：未传 progress callback 时行为必须和以前一致。
   - StatusBar 新增 Agora 信息时，普通 provider 的 context window、debug、task 数展示不能变化。

## 功能 Case

- Case A：Agora 第一次本地模型聊天
  - 输入普通用户消息。
  - TUI 先显示 `Agora · 加载本地模型 ...` 或同级状态，再进入 `Agora · 生成回复`。
  - 不把模型加载误导成纯 `thinking`。

- Case B：Agora memory 已挂载
  - Agora `chat_complete` 返回 metadata，包含 `session_id` 和 memory patch ids。
  - MA 更新 session meta。
  - TUI 底栏显示 `mem mounted(1)` 和 session 简写。

- Case C：Agora memory 未启用或未挂载
  - Agora response metadata 没有 active patch。
  - MA 显示 `mem unmounted`、`mem empty` 或 `mem disabled`，不说已挂载。

- Case D：普通 provider 聊天
  - DeepSeek/LM Studio/OpenAI-compatible 仍显示通用等待、重试、ctx 信息。
  - 不出现 Agora memory/session 文案。

- Case E：Agora tool calling
  - Agora `chat_complete` 返回 tool_calls。
  - MA 继续复用现有 `StreamParser` 和 tool-call 主循环。
  - progress 事件不能插入 assistant 文本流。

## 验收标准

- TypeScript build 通过。
- MCP client 单测覆盖 progress token 发送和 progress notification 分发。
- CLI hook 单测覆盖 Agora provider progress 不再显示 thinking label。
- Agora provider runtime 单测继续通过，证明 synthetic streaming 和 tool_calls 没破。
- 普通 provider runtime 单测继续通过，证明重试/stream 行为没被 Agora 适配改坏。
