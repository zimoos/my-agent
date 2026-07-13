# PRD：MA × Agora Memory v2 接入改造

| 项目 | 内容 |
| --- | --- |
| 产品 | my-agent（MA） |
| 依赖 | Agora Memory Runtime v2 |
| 文档状态 | Ready for implementation |
| 目标版本 | MA 0.3.x 后续版本；Agora 以 capability handshake 为准 |
| 关联 | zimoos/my-agent#39、zimoos/agora#23、zimoos/agora PR #22 |

## 1. 产品结论

MA 不再把 Agora 当作“带记忆的普通模型地址”，而应把它产品化为：

> 一个可以运行本地模型，并让用户按会话挂载、组合、迭代和回滚具名记忆的 Agent 工作台。

用户面对的是“记忆”和“记忆版本”，不是 Profile、family、lineage、segment 等底层术语。Agora 负责记忆编译、版本、增量、运行时热切换和真实性；MA 负责用户意图、会话绑定、TUI 交互、自动调度和状态解释。

## 2. 背景与问题

现有 MA PR #40 已完成 Agora MCP stdio、本地模型目录/下载、Memory Console、Profile/Patch 选择、后台 intake 和 Context Usage，但仍建立在 v1 心智上：

- 以 MemoryProfile 为主对象。
- 一次只有一个 `writable_patch_family`。
- 内化使用 `memory_intake_run` 和单 lineage advance。
- 用户无法在一次内化中选择“新建 Memory”或多选已有 Memory。
- 没有使用 Agora v2 的具名 Memory、batch intake、per-target 状态和 PatchSet revision。
- 状态栏只显示 Profile 和 Patch 数量，无法让用户理解当前究竟挂载了哪些记忆。

Agora v2 已提供：

- 具名 Memory CRUD 和数据库唯一性。
- 不可变 MemoryPatch 版本和增量 segments。
- 一次 source snapshot 扇出到多个 create/increment target。
- 多 ModelDelta 同时挂载。
- 单基座、请求边界热切换。
- per-target completed/noop/review/conflict/failed。
- `patchset_revision` 和真实 chat metadata 验证。

本 PRD 的任务是把 Agora 的底层能力转化为自然、低认知负担、可持续迭代的 MA 产品体验。

## 3. 产品目标

### 3.1 核心目标

1. 用户打开任意新会话时，可以选择 0～N 个具名 Memory，并且不同会话可以使用不同组合。
2. 用户可以在对话过程中挂载或拔出任意兼容 Memory，不重启基座模型。
3. 用户内化当前对话时，可以：
   - 新建一个具名 Memory；
   - 增量写入一个已有 Memory；
   - 一次多选多个已有 Memory；
   - 在同一个 batch 中混合“新建 + 增量”。
4. 每个新 Memory 和输出 Patch 都有唯一名称；重名由 Agora 拒绝，MA 保留用户输入并允许修改后重试。
5. 自动内化只处理尚未完成的对话增量；失败目标不能造成其他目标重复编译或漏记。
6. 用户始终知道当前挂载了什么、是否真实生效、后台正在内化什么。
7. Agora 记忆不污染其他 Provider，Context Usage 不因记忆操作丢失或被伪造。

### 3.2 成功指标

- 首次 Agora 使用无需理解 MCP、Profile、family 或 Patch id 即可完成模型下载和第一次对话。
- 用户可在 3 次操作内完成“选择多个记忆并开始聊天”。
- 用户可在一个面板内完成“新建/多选目标 → 确认范围 → 提交内化”。
- 所有挂载成功状态均有真实 `chat_complete` metadata 证明。
- Patch-only 切换不出现模型重新加载阶段。
- 自动内化期间输入框持续可用，transcript 不插入进度噪声。
- 普通 Provider 的请求、stream、tool calling、Context Usage 和状态栏无回归。

## 4. 非目标

- 不在 MA 重新实现 Memory 编译、gate、segment、CAS 或回滚算法。
- 不把记忆事实注入 system prompt 模拟 Agora Memory。
- 不支持生成到一半的 mid-token 热插拔；切换在下一次 chat 边界生效。
- 不支持跨不同 base model 挂载不兼容 Patch。
- 不引入账号、登录、机器绑定、许可证、云同步或 ZimoOS 依赖。
- 不在 TUI 暴露完整 Patch id、binding id、batch id 等调试信息；它们进入详情页和 `/memory status`。
- 不把旧 Agora `0.2.0` 版本号本身当作 v2 可用证明。

## 5. 用户与核心任务

### 5.1 目标用户

- 使用远程 API 模型、但希望在有本地模型时获得长期私有记忆的开发者。
- 在多个项目、角色、工作上下文之间切换的 Agent 用户。
- 没有能力维护数据库、向量库或微调流程，但希望记忆可控、可回滚的普通用户。

### 5.2 核心 Jobs to be Done

- “我打开这个项目时，希望 Agent 自动带上这个项目的记忆。”
- “这次会话只需要产品记忆，不要带入私人偏好。”
- “把刚才的共识同时写入产品记忆和工程记忆。”
- “这是一类新记忆，帮我新建一个名字保存。”
- “刚才内化错了，回滚到上一个版本。”
- “我切走某个记忆后，不希望模型重载并卡住。”

## 6. 产品对象与用户心智

| 用户术语 | 定义 | Agora 对应 |
| --- | --- | --- |
| 记忆 | 有唯一名称、可持续迭代的长期记忆模块 | MemoryRecord |
| 版本 | 某个记忆的一次不可变产物 | MemoryPatch |
| 挂载 | 让一个会话在下一次请求中使用指定版本 | active_memory_patch_ids |
| 记忆组合 | 当前会话挂载的多个记忆版本 | MemoryProfile + binding |
| 内化 | 把一段已确认对话增量编译进一个或多个记忆 | memory_intake_batch_run |
| 自动内化目标 | 自动内化时允许写入的具名记忆列表 | auto_intake_target_memory_ids |

产品规则：

- 主界面不把 Profile 当作第一层对象。
- Profile 作为 MA 管理“项目默认组合、会话 override”的后台实现，可在高级详情中显示。
- 列表优先显示 Memory 名称和版本，例如“Agora 产品记忆 · v4”，不显示原始 id。
- 一个 Memory 同时只能有一个 current head，但历史版本都可查看和回滚。
- 挂载多个 Memory 不代表它们互相合并；它们只是共同参与当前会话推理。
- 内化到多个 Memory 时，同一 source 只提取一次，然后分别推进各自 lineage。

## 7. 产品原则

1. **开箱即用**：Agora chat 与 Memory v2 分层降级；记忆缺能力不能阻止普通聊天。
2. **明确选择**：MA 不猜测内化目标，更不能选择第一个 mounted Patch。
3. **真实状态**：配置成功不等于挂载成功；必须等待下一次 chat metadata。
4. **后台执行**：下载和内化有 Activity，但不阻塞输入、不污染 transcript。
5. **名称优先**：用户操作名称和版本，技术 id 只用于诊断。
6. **可逆**：切换、内化和自动策略都有历史、失败恢复和回滚路径。
7. **Provider 隔离**：只有 active provider 为 Agora 时才能操作和展示 Agora Memory。

## 8. 信息架构

### 8.1 主状态栏

第一行保持通用信息：

```text
Provider: agora · Model: qwen3.6-35b-a3b-q4 · ctx: 12k/197k trigger · win 262k registry
```

第二行仅在 Agora 下出现，优先展示用户可读名称：

```text
Memory: Agora产品@v4 +2 · mounted · auto: 产品, 工程
```

状态规则：

- 0 个 Patch：`Memory: 未挂载`。
- 1 个 Patch：显示完整 Memory 名称和版本。
- 多个 Patch：显示第一个名称、版本和 `+N`；完整列表进入 `/memory`。
- 配置已提交但尚未经过 chat 验证：`pending next chat`。
- metadata ids 与请求不一致：`stale`，不能显示 mounted。
- 后台 intake：在行尾显示 `内化中 1/3`，不显示 batch id。

### 8.2 Memory Console

按 `/memory` 打开，默认分为三层：

```text
┌ Memory · 当前项目 my-agent ────────────────────────────────┐
│ 已挂载                                                     │
│  ◉ Agora 产品记忆        v4   verified                    │
│  ◉ 工程规范记忆          v7   verified                    │
│  ○ 用户偏好记忆          v2                               │
│                                                            │
│ 自动内化目标                                               │
│  ☑ Agora 产品记忆   ☑ 工程规范记忆   ☐ 用户偏好记忆       │
│                                                            │
│ Activity: 正在内化 2 个目标 · 1 完成 / 1 编译中            │
│ Space 挂载 · i 内化 · n 新建 · e 重命名 · h 历史 · Esc 返回│
└────────────────────────────────────────────────────────────┘
```

交互要求：

- `Space` 多选挂载/拔出。
- `Enter` 应用挂载组合，状态先进入 `pending next chat`。
- `i` 打开内化目标选择器。
- `n` 新建 Memory，不再新建一个用户可见的 Profile。
- `e` 重命名 Memory。
- `h` 查看当前 Memory 的版本历史和回滚。
- 高级区才展示项目/会话 binding、Profile、Patch id 和 revision。

### 8.3 记忆高亮与流动颜色

已真实 mounted 的 Memory 名称使用动态高亮，但必须克制：

- 默认在名称上使用低频 cyan→blue→magenta 流动高光，周期约 2 秒。
- 动画只用于 `verified mounted`；pending、stale、failed 不使用。
- generation、确认框、低性能终端或 `NO_COLOR`/reduced-motion 下停止动画，退化为静态 cyan bold。
- 只更新状态栏/Memory Console 的局部区域，不触发 transcript 重绘。
- 多个 Memory 不同时逐个动画；作为一个组合 badge 统一流动，避免视觉噪声。

## 9. 核心用户流程

### 9.1 首次使用 Agora

1. MA 定位固定 Agora executable，启动 `agora mcp serve`。
2. 执行 MCP initialize、list_tools、runtime_capabilities。
3. 检查 base chat 能力：doctor、models_list、chat_complete。
4. 检查 v2 memory tools 和五项 capability。
5. Model Picker 展示白名单模型和本地状态。
6. 模型缺失时提供一键下载和真实 progress。
7. 下载完成后，用户可以“不使用记忆直接开始”或“选择已有 Memory”。

降级规则：

- base chat 可用、v2 memory 不可用：允许 Agora chat，Memory Console 显示“当前 runtime 不支持 Memory v2”。
- 工具名称存在但 capability 未开启：不显示 v2 操作。
- 版本号相同但 schema/capability 不同：以 handshake 为准。
- 开发环境允许命令覆盖，但必须显示 `unverified runtime`。

### 9.2 新会话选择记忆

绑定优先级固定为：

```text
conversation override > project default > user default > no memory
```

行为：

- 新会话创建时先解析项目默认组合。
- 用户可在第一次发送消息前修改挂载列表。
- 会话 override 不覆盖项目默认配置，只覆盖本会话。
- 切换会话时立即恢复各自挂载组合和验证状态。
- 非 Agora Provider 下不显示 Agora mounted 状态。

### 9.3 挂载和热拔插

1. 用户在 Console 多选 Memory 当前版本。
2. MA 校验 base model 兼容性。
3. MA 更新当前 binding 对应的 active patch ids。
4. UI 显示 `pending next chat`，输入框继续可用。
5. 下一次 chat 返回相同 ordered patch ids 和更高 PatchSet revision 后，状态变为 verified。

禁止行为：

- 不因为 Patch 变化重启 Agora subprocess。
- 不显示“重新加载模型”。
- 不在 profile update 成功后立即声称 mounted。
- 如果验证失败，保留旧 verified 组合并显示可重试错误。

### 9.4 新建和命名

- 新建 Memory 必须输入名称。
- 输出 Patch 名称必须存在；MA 默认建议 `<MemoryName>@v1`。
- 增量版本默认建议 `<MemoryName>@vN`，用户可编辑。
- Agora 返回 `memory_name_conflict` 或 `memory_patch_name_conflict` 时：
  - 不关闭输入框；
  - 保留原输入；
  - 高亮冲突字段；
  - 提示用户修改后重试；
  - 不自动追加随机数字。

### 9.5 手动内化

入口：`i`、`/memory internalize` 或 agent memory tool。

步骤：

1. 展示本次 source range，例如“本会话第 12～28 条消息”。
2. 用户选择一个或多个目标：
   - `新建 Memory`：输入 Memory 名和输出版本名；
   - `增量到已有 Memory`：多选 Memory，确认各自输出版本名。
3. MA 展示摘要：一个 source、N 个目标，不展示实现细节。
4. 用户确认后调用一次 `memory_intake_batch_run`。
5. MA 轮询 `memory_intake_batch_get`，按目标独立展示状态。
6. 只把 completed 的新 Patch 更新到当前挂载组合。
7. noop 不生成新版本；review/conflict/failed 保持未挂载并可单独处理。
8. 下一次 chat 验证 patch ids 和 revision 后报告最终成功。

同一 batch 的目标状态：

| 状态 | 用户文案 | 后续动作 |
| --- | --- | --- |
| completed | 已生成新版本 | 可挂载并验证 |
| noop | 没有提取到可长期保存的信息 | 不重试，除非修改 source |
| review | 需要确认后再写入 | 保留任务，用户审阅 |
| conflict | 记忆已被其他任务更新 | 刷新 head，重新确认版本名后重试 |
| failed | 内化失败 | 只重试该目标 |

### 9.6 自动内化

默认触发条件同时满足：

- active provider 为 Agora。
- runtime 具备完整 v2 capability。
- 当前 Profile 开启 auto policy。
- 明确配置至少一个 `auto_intake_target_memory_id`。
- 自上次已完成 batch 后累计至少 4 个用户回合或约 2000 pending tokens。
- 用户空闲 60 秒。
- 当前无 generation、tool、确认框、模型切换、Memory 切换或其他 intake。

调度规则：

- 每次自动任务固定一个 source range，并一次提交所有目标。
- MA 在会话 meta 持久化 `last_auto_intake_message_end` 和当前 batch/target 状态。
- completed/noop 目标视为完成；review/conflict/failed 不推进本轮全局自动 checkpoint。
- 某个目标失败时，只重试失败目标，不重复提交成功目标。
- 用户明确放弃失败目标后，才允许推进该轮 checkpoint。
- 新加入自动目标默认只接收后续增量；用户可手动选择“用整个会话初始化该记忆”。
- 自动内化不清空 context，不触发 compact，不改写 transcript。

### 9.7 历史与回滚

- 版本历史按 Memory 分组，而不是展示所有 Patch 平铺列表。
- 每个版本显示：版本名、创建时间、source 摘要、状态、是否当前 head、是否已挂载。
- 回滚使用 expected current head 做 CAS。
- 回滚成功只改变 Memory head；当前会话是否切换到回滚版本，由用户确认。
- 如果用户选择“回滚并挂载”，仍需下一次 chat 验证。

### 9.8 Provider 切换

- 从 Agora 切到其他 Provider：隐藏 Memory 行，保留 Agora 会话状态但标记 unavailable。
- 切回 Agora：重新握手并恢复对应会话 binding，不沿用 stale mounted 状态。
- 非 Agora Provider 收到记忆命令时，明确提示需要先切到 Agora；禁止 prompt 模拟。

## 10. 命令设计

| 命令 | 行为 |
| --- | --- |
| `/memory` | 打开 Memory Console |
| `/memory list` | 列出具名 Memory 和当前版本 |
| `/memory mount <name...>` | 挂载一个或多个 Memory 当前版本 |
| `/memory unmount <name...|all>` | 拔出指定或全部 Memory |
| `/memory new <name>` | 创建具名 Memory；没有 source 时允许空壳创建 |
| `/memory rename <name> <new-name>` | 重命名 Memory |
| `/memory internalize` | 打开多目标内化选择器 |
| `/memory internalize --new <name>` | 新建并内化 |
| `/memory internalize --into <name...>` | 多选已有 Memory 增量内化 |
| `/memory auto on --targets <name...>` | 开启自动内化并指定目标 |
| `/memory auto off` | 关闭自动内化 |
| `/memory history <name>` | 查看版本历史 |
| `/memory rollback <name> <version>` | CAS 回滚 |
| `/memory status` | 查看 ids、binding、batch、revision 和 capability 详情 |
| `/memory disable` | 当前 scope 不使用记忆 |

命令、TUI 和 agent tool 必须调用同一个 Controller，禁止三套业务逻辑。

## 11. MA 状态模型

```ts
type AgoraMemoryV2State = {
  providerId: 'agora';
  runtimeMode: 'v2' | 'legacy' | 'unavailable';
  sessionId?: string;
  profileId?: string;
  bindingId?: string;
  mounted: Array<{
    memoryId: string;
    memoryName: string;
    patchId: string;
    patchName: string;
    version: string;
  }>;
  requestedPatchIds: string[];
  verifiedPatchIds: string[];
  patchsetRevision?: number;
  status: 'unavailable' | 'disabled' | 'selecting' | 'pending' | 'mounted' | 'stale' | 'failed';
  autoTargetMemoryIds: string[];
  activeBatch?: {
    batchId: string;
    sourceStart: number;
    sourceEnd: number;
    targets: Array<{
      memoryId?: string;
      name: string;
      status: 'queued' | 'compiling' | 'completed' | 'noop' | 'review' | 'conflict' | 'failed';
      outputPatchId?: string;
      error?: string;
    }>;
  };
  lastVerifiedAt?: string;
};
```

状态来源：

- Memory/版本目录：Agora MCP list/get tools。
- requested：用户当前提交的选择。
- verified：最近一次 `chat_complete` metadata。
- revision：Agora runtime metadata。
- Activity：batch get 和 progress notification。
- Context Usage：始终来自 `agent.getContextUsage()`，不从 Agora Memory 推断。

## 12. Controller 改造

现有 `AgoraMemoryController` 升级为 v2，TUI、命令和 agent tool 共同复用：

```text
capabilities()
memories.list/create/rename/get
memories.mount/unmount
memories.history/rollback
profiles.resolve/updateAutoTargets
intake.plan/start/get/retryTarget/abandonTarget
verification.applyChatMetadata
models.list/download/status
```

必须替换的 v1 主路径：

- `writable_patch_family` 用户选择。
- `memory_intake_run` 单目标主流程。
- `memory_lineage_advance` 由 MA 手工推进 lineage。
- 根据 patch family 推断主记忆/overlay。
- 仅用 Profile 名称表达用户记忆。

保留为兼容层：

- Agora v2 flag 关闭时，旧单目标 memory tool 可以继续工作。
- legacy mode 只提供“单记忆内化”，并明确标记能力受限。
- 任何 v2 功能都必须由 tool + runtime capability 双重确认。

## 13. Agora MCP 映射

| 产品动作 | MCP |
| --- | --- |
| 能力握手 | runtime_capabilities + list_tools |
| 创建/列出/重命名 Memory | memories_create/list/get/rename |
| 多目标内化 | memory_intake_batch_run/get |
| 挂载组合 | memory_profiles_create/update + bindings |
| 自动目标 | memory_profiles_update.auto_intake_target_memory_ids |
| 版本列表 | memory_patch_versions |
| 回滚 | memories_rollback |
| 真实挂载验证 | chat_complete metadata + patchset_revision |

v2 必需 capability：

- `named_memories`
- `multi_target_intake`
- `incremental_segments`
- `multi_model_delta_mount`
- `request_boundary_hot_swap`

注意：increment target 字段以 MCP schema 为准，使用 `expected_parent_patch_id`，不能使用旧文档中的 `expected_head_patch_id`。

## 14. Context Usage

- Context Usage 与 Agora Memory 是两个独立系统。
- 所有 Provider、所有终端宽度持续显示 used/trigger/window/source。
- 内化成功不清空 context。
- Context compact 不推进 Memory checkpoint。
- 模型切换分别刷新 context capability 与 Memory/Patch 兼容性。
- 记忆通过零外部上下文运行，不代表 MA context used 归零。

## 15. 错误与恢复

| 场景 | MA 行为 |
| --- | --- |
| v2 capability 缺失 | chat 可用，Memory v2 禁用并展示升级提示 |
| 名称冲突 | 保留输入，定位冲突字段，允许重试 |
| head conflict | 刷新 Memory，展示“已被其他任务更新” |
| 某 target failed | 其他成功结果保留，只重试失败目标 |
| Patch 不兼容 | 不更新 requested 组合，旧 mounted 状态保留 |
| 下一次 chat 未验证 Patch | 状态 stale，不声称成功 |
| Agora subprocess 退出 | Memory unavailable，保留可恢复状态，不影响其他 Provider |
| 用户切换 Profile/会话 | 使用 revision/CAS，旧后台任务不得覆盖新选择 |

## 16. 隐私与安全

- 内化前清晰展示 source 范围；大范围历史或敏感内容必须确认。
- Memory 数据和模型权重放在可写 user data 目录，不放入不可变 app bundle。
- MA 不读取或重写 Agora Patch artifact 内容。
- 日志默认不记录对话原文、Memory 内容或 tool 参数。
- binary package 必须通过 manifest SHA、签名和协议握手；版本号相同但 hash/capability 不同视为不同 runtime。
- `MA_AGORA_COMMAND` 仅用于开发覆盖，TUI 显示 unverified。

## 17. 发布与兼容策略

### 17.1 开发联调

- 在独立 MA worktree 开发。
- 在 Agora PR #22 未发布前，使用源码 v2 MCP 或重新构建的本地二进制。
- 不使用当前本机旧 schema 2 的全局 `0.2.0` 作为 v2 验收对象。

### 17.2 正式发布

- Agora PR #22 先合并并发布最终平台包。
- MA 使用 exact package version、npm integrity、manifest SHA 和 capability handshake。
- 如果最终 v2 仍发布为 0.2.0，必须以最终 manifest SHA 区分本机旧构建；推荐避免同版本不同能力的分发歧义。
- MA portable 包内置相同固定 Agora artifact。

## 18. 实施阶段

### Phase 1：契约与 Controller

- capability handshake。
- Memory/版本类型。
- batch intake 和 per-target 状态。
- metadata/revision verification。
- legacy compatibility adapter。

### Phase 2：TUI 与命令

- 以 Memory 为中心重构 Console。
- 多挂载、命名、重试、历史、回滚。
- 状态栏名称摘要和 verified/pending/stale。
- 动态高亮与 reduced-motion 降级。

### Phase 3：自动内化

- 明确目标列表。
- source range 和会话 checkpoint。
- idle trigger。
- target 独立重试/放弃。
- 后台 Activity。

### Phase 4：真实验收与发布

- 源码 v2 MCP E2E。
- packaged Agora E2E。
- 远程 Provider 回归。
- PTY/visual/窄终端。
- 固定版本与 hash。

## 19. 验收 Case

### Case 1：首次使用

- clean data root 启动 Agora。
- doctor/capability 成功。
- 白名单模型缺失时一键下载并显示真实进度。
- 下载后无需配置 Profile 即可开始无记忆聊天。

### Case 2：不同会话不同组合

- 会话 A 挂载“产品@v3 + 用户偏好@v2”。
- 会话 B 只挂载“工程@v5”。
- 交替对话，metadata 和回答无串扰。

### Case 3：多 Patch 热拔插

- 无 Patch → A → A+B+C → B+C → 无 Patch。
- TUI 不出现模型重载阶段。
- 每次下一 chat 的 ordered ids 和 revision 正确。

### Case 4：唯一命名

- 创建重复 Memory 名被拒绝。
- 创建重复 Patch 输出名被拒绝。
- 输入框不关闭，用户修改后成功。

### Case 5：多目标内化

- 一个 source 同时：新建 A、增量 B、增量 C。
- source 只提交一次。
- A completed、B noop、C conflict 分别展示。
- 只挂载 A 的新版本；B 无版本；C 可单独重试。

### Case 6：自动内化

- 配置两个 auto target。
- 达到 4 用户回合/约 2000 tokens，空闲 60 秒后启动。
- 输入框可继续使用，transcript 无进度文本。
- 成功/失败目标按规则推进或保留 checkpoint。

### Case 7：回滚

- Memory 从 v4 回滚到 v2。
- CAS 冲突不会覆盖新的 head。
- “回滚并挂载”后经下一 chat 验证。

### Case 8：Context Usage

- Agora/远程 Provider、宽/窄终端都显示 used/trigger/window/source。
- 内化、挂载、回滚、compact 后数据源和语义保持独立。

### Case 9：Provider 隔离

- 从 Agora 切到 DeepSeek/OpenAI-compatible。
- Memory UI 不泄漏 mounted 状态。
- stream、tool calling、retry、Context Usage 不回归。

### Case 10：旧 runtime

- 使用 schema 2、无 v2 tools 的 Agora。
- MA 允许基础 chat，Memory v2 明确不可用。
- 不因同为 `0.2.0` 而错误开启新交互。

## 20. 关闭标准

- MA 不再以 `writable_patch_family` 作为 Memory Console 主交互。
- TUI、命令、agent tool 全部复用同一个 v2 Controller。
- 具名 Memory、多挂载、多目标内化、自动目标、回滚、revision 验证全部可用。
- 所有挂载成功都有真实 chat metadata 证据。
- Patch-only 切换不重启 Agora、不显示模型重新加载。
- MA build、全量测试、PTY、visual、真实 MCP、packaged E2E 通过。
- DeepSeek、LM Studio、OpenAI-compatible 等普通 Provider 回归通过。
- Context Usage 始终存在且不与 Memory 生命周期混淆。
- Agora 最终 runtime version、integrity、manifest SHA 和 capability 已锁定。

在以上标准全部满足前，不得仅以“Agora #23 已关闭”或“MA PR #40 已存在”宣称 MA × Agora 产品体验完成。

## 21. 当前证据

MA 当前实现：

- `src/provider/agora.ts` 的主内化路径仍是 `memory_intake_run`、`writable_patch_family`、`memory_lineage_advance`。
- `src/cli/components/MemoryConsole.tsx` 仍以 Profile、writable family 和 overlay 为用户第一层心智。
- `src/cli/App.tsx` 的自动内化要求唯一 writable family。
- `src/cli/utils/commands.ts` 仍提供 `--into <family>` 单目标命令。
- `StatusBar`、MCP subprocess、模型目录/下载、project/conversation binding、Context Usage 和后台 Activity 已存在，可继续复用。

Agora v2 当前证据：

- Agora #23 已关闭，PR #24/#25/#26 已进入 Agora PR #22 集成分支。
- 源码 MCP stdio 已验证具名 Memory、batch intake 和 v2 capability 全部存在。
- 核心 registry/intake/runtime v2 测试已复跑 20/20。
- Agora 提交的真实证据覆盖 35B 单基座、A/B/C Patch 热切换、双 session 无串扰、resident compile、旧库恢复和 packaged MCP。
- 当前本机全局 Agora `0.2.0` 仍是 registry schema 2，缺少 v2 tools；不能作为本 issue 的验收 runtime。

## 22. 复用与替换计划

### 22.1 继续复用

- Agora MCP stdio 启动、进程退出和 progress 管道。
- Model Picker、白名单目录、下载和状态查询。
- MemoryProfile/binding 作为后台 scope 绑定机制。
- `providerState` 持久化框架。
- StatusBar 第一行 Context Usage。
- Memory Console 的 modal、键盘导航和 Activity 区域。
- 命令注册和 agent tool 暴露框架。
- 现有 PTY、provider runtime、普通 Provider 和 Context Usage 测试基础。

### 22.2 必须替换

- 以 Profile 为中心的用户界面 → 以具名 Memory 为中心。
- 唯一 writable family → 显式多目标 Memory 列表。
- 单目标 intake + MA 手工 lineage advance → Agora batch intake + per-target result。
- family 推断主记忆/overlay → Memory 当前 head + ordered mounted PatchSet。
- 配置成功即近似成功 → 下一次 chat ids + revision 真实验证。

### 22.3 Redline

完成后，v2 主路径不得再调用 `memory_intake_run`、依赖 `writable_patch_family` 或由 MA 调用 `memory_lineage_advance`。这些符号只允许存在于明确标记的 legacy compatibility adapter 和对应测试中。

## 23. 实施清单

### Contract / Controller

- [ ] 增加 runtime_capabilities 握手和五项 v2 capability gate。
- [ ] 增加 Memory、Patch version、batch、target、PatchSet revision 类型。
- [ ] 增加 memories list/create/get/rename/rollback Controller 方法。
- [ ] 增加 batch plan/start/get/retry/abandon 方法。
- [ ] 增加 auto_intake_target_memory_ids 读写。
- [ ] 将 chat metadata 统一映射到 requested/verified/revision 状态。
- [ ] 保留 legacy adapter，但不能让 legacy 状态伪装成 v2。

### TUI / Commands

- [ ] Memory Console 以具名 Memory 为第一层，Profile 移入高级详情。
- [ ] 支持多选挂载、拔出和不同 conversation 组合。
- [ ] 支持新建、重命名、版本历史和 CAS 回滚。
- [ ] 支持新建/增量混合的多目标内化表单。
- [ ] 名称冲突保留输入并允许原地重试。
- [ ] StatusBar 显示 Memory 名称、版本、+N、verified/pending/stale 和 Activity。
- [ ] 实现 mounted badge 流动高光及 NO_COLOR/reduced-motion 降级。
- [ ] 重写 `/memory` 命令并确保与 TUI、agent tool 共用 Controller。

### Automatic intake

- [ ] 以明确 auto target ids 替换 writable family。
- [ ] 持久化 source range、batch 和 target 状态。
- [ ] 实现 4 回合/约 2000 tokens + idle 60 秒触发。
- [ ] 失败目标单独重试；未解决失败前不推进整轮 checkpoint。
- [ ] 自动任务不阻塞输入、不写 transcript、不触发 context compact。

### Verification / Release

- [ ] 使用 Agora v2 源码 MCP 完成确定性 contract E2E。
- [ ] 使用最终 packaged Agora 完成真实 E2E。
- [ ] 验证 Patch-only 切换期间 MA 不重启 subprocess、不显示 model reload。
- [ ] 验证内化期间只存在一个 Agora resident base，不启动第二个 compiler runtime。
- [ ] 执行全量单测、PTY、visual、窄终端和真实模型流程。
- [ ] 执行 DeepSeek、LM Studio、OpenAI-compatible 回归。
- [ ] 锁定最终 package version、integrity、manifest SHA 和 capability。

## 24. Parent Scope Status

`zimoos/my-agent#39`: **partial**。

本 issue 完成后，#39 的 MA 产品交互和 Agora v2 接入部分才可视为完成。以下父范围仍不由本 issue 自动完成：

- Agora PR #22 合并到 main。
- Developer ID 签名、公证和 Gatekeeper 证据。
- 最终 npm 平台包发布。
- MA 最终 release 合并、发布和 #39 关闭。

现有 MA PR #40 不是废弃实现：MCP runtime、模型流程、Context Usage、binding、Activity 和基础 TUI 可复用；但它的 v1 memory contract 不能作为本 issue 已完成证据。

## 25. Acceptance Mapping

| Acceptance criterion | Code or system path | Validation/proof | Old path status | Notes |
| --- | --- | --- | --- | --- |
| v2 能力准确启用/降级 | `src/provider/agora.ts`, MCP startup | schema 2 与 schema 3 双 runtime contract test | old version-only gate removed | 版本号不能替代 capability |
| 具名 Memory 成为用户主对象 | `MemoryConsole.tsx`, controller types, commands | PTY + visual + create/rename E2E | Profile-first UI removed | Profile 仅高级详情 |
| 不同会话挂载不同多 Memory | binding resolution, session meta, controller | 两会话交替真实 chat，ids/revision 无串扰 | single global selection removed | conversation override 优先 |
| Patch 请求边界热拔插 | mount flow, providerState verification | 无 Patch→A→A+B+C→B+C→无 Patch | config-only success removed | 不重启 subprocess |
| 唯一命名与重试 | intake form, typed MCP errors | Memory/Patch 重名 PTY + contract test | silent suffix unchanged by design: prohibited | 保留用户输入 |
| 新建/多目标增量内化 | batch controller, Activity, profile update | create A + increment B/C 单 snapshot E2E | `memory_intake_run` bypassed | 每目标独立状态 |
| 自动内化不重复不漏记 | scheduler, session meta, target retry | success/noop/review/conflict/failed matrix | writable-family scheduler removed | 放弃失败需显式操作 |
| 回滚可验证 | history UI, memories_rollback, chat verification | CAS conflict + rollback-and-mount E2E | family replacement rollback removed | head 与 mounted 分离 |
| mounted 真实性 | chat metadata mapper, StatusBar | requested 与 returned ids/revision 不一致测试 | profile-update-only proof removed | stale 不得显示 mounted |
| 动态高亮可访问 | StatusBar/MemoryConsole rendering | color、NO_COLOR、reduced-motion visual tests | unchanged by design | 只高亮 verified |
| Context Usage 独立保留 | `agent.getContextUsage()`, StatusBar | Agora/远程、宽/窄终端 PTY | unchanged by design | 内化不 compact |
| 普通 Provider 无 Agora 泄漏 | provider switch, state projection | DeepSeek/LM Studio/OpenAI-compatible 回归 | unchanged by design | 非 Agora 不模拟记忆 |
| 单基座与单 runtime | Agora provider lifecycle, batch path | subprocess count + progress + packaged real E2E | separate compiler runtime removed | runtime 真实性由 capability + evidence 保证 |
| 正式包可复现 | package resolver, manifest verifier | exact version/integrity/SHA clean install | dev override compat only | dev override 显示 unverified |
