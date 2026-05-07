# 重构追踪 Issues

## Issue #1: [Phase 3] 补齐核心循环的单元测试

### 背景
Phase 1 和 Phase 2 把消息管理和核心循环拆分成了 `MessageStore`、`ErrorTracker`、`StreamParser`、`ToolExecutor`。但这些模块的单元测试仍不完整。

### 待测试场景
| 场景 | 优先级 | 说明 |
|------|--------|------|
| `StreamParser` 处理 thinking token | P0 | `<think>`、`<\|channel>thought`、`reasoning_content` |
| `StreamParser` 聚合 tool_calls | P0 | 流式返回的 tool_calls 分片拼装 |
| `ErrorTracker` 阻断重复错误 | P0 | 同一 (name, args) 错误 2 次后阻断 |
| `ErrorTracker` 成功调用后清除历史 | P0 | 成功后该 key 的错误计数清零 |
| `ToolExecutor` 空参数拦截 | P1 | schema 有 required 字段但 args 为空 |
| `ToolExecutor` 危险命令拦截 | P1 | deny 模式、confirm 模式、白名单 |
| `ToolExecutor` MCP 调用异常 | P1 | route 不存在、conn.call 抛异常 |
| `runTask` 空参数重试 | P1 | 所有 tool_calls 参数为空时 pop + 低 temperature 重试 |
| `runTask` maxLoops 触发 | P1 | 循环达到上限时的终止逻辑 |

### 验收标准
- [ ] `test/agent/` 目录下有 `error-tracker.test.ts`、`stream-parser.test.ts`、`tool-executor.test.ts`
- [ ] 每个测试文件覆盖该模块的核心分支（正常路径 + 错误路径）
- [ ] 不依赖外部 LLM 调用，全部在毫秒级完成

---

## Issue #2: [Phase 4] 清理类型安全，消除 `as any`

### 背景
当前代码有约 30 处显式 `as any` / `as unknown` 类型断言，集中在：
1. OpenAI SDK 流式响应体处理
2. `messages[0]` 的 content 访问
3. 通用工具函数把 message 当 `any` 处理

### 具体任务
- [ ] `src/agent.ts` L651 `stream as any` → 使用 OpenAI SDK 正确的流式类型
- [ ] `src/agent.ts` L656 `(delta as any).reasoning_content` → 类型守卫或扩展类型
- [ ] `src/agent.ts` L565/630 `(messages[0] as any).content` → 已通过 MessageStore 消除，确认无残留
- [ ] `src/agent/tokenCount.ts` 多处 `(msg as any).content` / `(msg as any).tool_calls` → 类型守卫
- [ ] `src/agent/summarize.ts` 多处响应体 `as any` → 定义接口
- [ ] `src/agent/normalize.ts` L49 `call as any` → 收窄类型
- [ ] `src/cli/App.tsx` L94 `(send as any)` → 正确定义 send 类型
- [ ] `src/config.ts` L39-43 `target as any` → 泛型约束

### 验收标准
- `npx tsc --noEmit` 通过
- `grep -rn "as any\|as unknown" src/` 数量从 30 降到 ≤5（仅保留确实无法类型的边界情况）

---

## Issue #3: [Phase 5] 工具 Schema 简化与参数预校验

### 背景
本地小模型（30B+）对复杂 JSON Schema 的理解能力有限。当前 `mcpToolsToOpenAI` 直接把 MCP server 的 `inputSchema` 透传给模型，导致：
- 模型传错参数类型
- 模型遗漏 required 字段
- 模型发明不存在的字段

### 具体任务
- [ ] 引入 `ajv` 做调用前参数校验（在 `ToolExecutor` 中集成）
- [ ] 对常见错误做分类和模板化错误提示（ENOENT → "文件不存在"，EACCES → "权限不足" 等）
- [ ] 设计 `toolDescriptionRewrite` 层：
  - 只保留 1-2 个最关键参数
  - 扁平化嵌套结构
  - 限制每个 MCP server 暴露的工具数量（默认最多 5 个）

### 验收标准
- [ ] 新增 `test/agent/tool-executor.test.ts` 覆盖参数校验失败场景
- [ ] e2e 测试中"模型传错参数类型"场景通过率 > 85%

---

## Issue #4: [Phase 6] 减少每轮工具数量，增加工具调用回退机制

### 背景
本地模型在 `tools.length > 10` 时的选择准确率显著下降。当模型连续多轮 tool call 失败时，缺乏主动降级策略。

### 具体任务
- [ ] **工具预筛选**：根据用户 query 关键词匹配，只把相关工具放入 `request.tools`
- [ ] **工具分组**：文件操作组、代码搜索组、网络组，需要时再切换
- [ ] **主动回退**：连续 2 轮 tool call 失败后：
  1. 把 `tool_choice` 改为 `none`，让模型直接文字回答
  2. 或只保留 1 个核心工具，降低决策复杂度

### 验收标准
- [ ] `tools.length > 10` 时自动触发预筛选
- [ ] 新增 e2e 测试验证回退机制生效

---

## Issue #5: [Phase 7] 上下文压缩可靠性提升

### 背景
`maybeCompact` 在每次循环开头调用，会异步调用 LLM 进行摘要。如果摘要失败，当前逻辑只是跳过压缩，但没有对失败原因做分类处理。

### 具体任务
- [ ] 区分"摘要内容太短"和"LLM 调用异常"两种失败
- [ ] 摘要内容太短时，尝试更激进的截断策略（只保留 system + 最近 4 条）
- [ ] 增加 `compact` 的单元测试：确保压缩后 tool_call/tool_result 配对不被破坏

### 验收标准
- [ ] `test/agent/message-store.test.ts` 中有 `compact` 的边界测试
- [ ] 长对话（>50 轮）e2e 测试不因为上下文爆炸而失败
