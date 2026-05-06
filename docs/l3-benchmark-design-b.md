# L3+ 通用 Agent Benchmark — 裁判系统与评分维度设计（方案 B）

> 设计员 B 出品。调研目标：**通用 CLI agent 评测框架**的 L3 级裁判设计。
>
> **一句话定位**：任何 CLI agent（claude-code / my-agent / cursor-agent / 自研 agent）接入，跑一遍固定题目，由第三方裁判 agent 打分，输出一个综合分数和诊断报告。不依赖被测 agent 的内部事件、日志、API。
>
> **区别于 M1 的 L0–L2**：M1 用硬断言（读内部事件流、统计 tool_call）看被测 agent 内部行为，只能测 my-agent 自己。L3+ 只看**外部可观察物**——文件系统的 diff、命令的 stdout/stderr、最终回复文本——这样才能测任何 agent。

---

## 0. 核心认知：为什么 L3+ 必须用裁判

用户原话摘录（最高优先级）：

1. **"一个 agent 进来跑一遍，就要有一个分数出来"** — 通用性高于一切。评测框架不能绑定任何特定 agent 的内部接口。
2. **"由三方 agent 做裁判，从任务耗时、任务质量等维度给打分"** — 多维度 + LLM judge，不是单一 pass/fail。
3. **"L3 是及格线 —— 能独立完成完整小任务，多轮推理+工具调用"** — L3 是"像样的 agent"的最低标准。
4. **"我们测的是完整的 CLI agent 能力，不绑定内部 API"** — 硬边界：只能看 CLI 外部行为。

### 0.1 L3 和 L0–L2 的根本区别

| | M1 的 L0–L2 | L3+ |
|--|------------|------|
| **评测对象** | my-agent 自己（有事件流可读） | 任意 CLI agent（黑盒） |
| **信息源** | 内部事件流 + 文件系统 | **只有** 文件系统 diff + stdout/stderr + 最终回复 |
| **断言方式** | 硬断言（tool_called、event_sequence） | 裁判 LLM + 少量客观锚点（文件存在 / 命令退出码） |
| **任务复杂度** | 单轮单工具 / 多轮读改写 | 完整小任务（10+ 轮推理、跨文件、需规划） |
| **输出粒度** | 每题 0 或 1（pass/fail） | 每题每维度 0–1 连续分 + 综合评语 |
| **防作弊** | 事件流可审计 | 必须靠裁判 + 交叉验证 |

**核心转变**：L3+ 的 benchmark 是一个**对外开放的接口**。被测 agent 只需提供一个命令：`<agent-cmd> "<prompt>"`，跑在一个目录里，结束后评测框架抓取"跑完的目录"和"agent 最后说的话"，交给裁判打分。

这让 benchmark 能：
- 测 Claude Code（作为 baseline）
- 测 my-agent（作为 target）
- 测任何第三方 CLI agent（横向对比）
- 给团队里的每个人的 agent 版本打分（持续指标）

---

## 1. 被测 Agent 执行协议（Universal Agent Interface, UAI）

### 1.1 输入/输出合约

**输入**：
- `workdir`：一个临时目录，已经从 fixture 复制好（`cp -r fixtures/<fixture-name> $TMPDIR`）
- `prompt`：一段自然语言任务描述（不超过 2KB）
- `env`：环境变量（可选：模型 API key、超时、max_rounds 之类）

**执行**：
```bash
cd $workdir
<AGENT_CMD> "$PROMPT" > stdout.log 2> stderr.log
EXIT_CODE=$?
```

`<AGENT_CMD>` 是被测 agent 的 CLI 入口命令模板，由接入方提供，例如：
- Claude Code: `claude --dangerously-skip-permissions --print "$PROMPT"`
- my-agent: `my-agent run --prompt "$PROMPT"`
- Aider: `aider --yes --message "$PROMPT"`
- 自研: `python my_agent.py --task "$PROMPT"`

**评测框架只关心**：
1. 命令是否退出（超时则 kill）
2. 退出码
3. stdout 的最后一段（用作"最终回复"）
4. 退出后 `workdir` 的文件系统状态 diff（相对于 fixture 初始状态）

### 1.2 "最终回复"怎么抓

这是个现实问题：不同 agent 的输出格式千差万别。对策：

**约定输出格式（推荐但非强制）**：agent 在最后一行输出 `===FINAL_ANSWER===\n<text>\n===END===`，裁判优先抓这段。

**兜底**：如果没有标记，取 stdout 最后 4KB 文本作为"最终回复"。

**接入适配层**：每个 agent 可以写一个 10 行的 adapter 脚本做 stdout 清洗（去掉 ANSI 转义、去掉 tool call 日志行），只保留人话。adapter 由接入方提供。

### 1.3 超时 / 结束信号

| 场景 | 检测 | 处理 |
|------|------|------|
| 正常退出 | 进程退出码 ≠ 124（timeout 信号） | 走正常评分 |
| 超时 | 到 `timeout_sec` 进程还在，SIGTERM 后 5s 再 SIGKILL | 标记 `timed_out=true`，裁判知情后打分（效率维度 0，其他维度按当时状态） |
| Crash | 退出码非 0 且非 124 | 裁判看 stderr 评估是"agent 自己崩了"还是"任务本就该报错" |
| 卡死（无输出） | stdout/stderr 90s 无新输出 → 认为卡死 | 同超时处理 |

### 1.4 为什么只给 CLI，不给 SDK/API

用户原话："我们测的是完整的 CLI agent 能力"。CLI 是 agent 作为产品交付给用户的最终形态，包含了：
- 启动开销
- 交互协议处理
- 错误输出规范
- 超时/中断行为

测 API 层只能测到"模型调用对不对"，测 CLI 才能测"用户真实能用不能用"。

---

## 2. 裁判 Agent 详细设计

### 2.1 裁判看什么（输入）

裁判的输入包含 **5 个字段**（JSON 结构化）：

```json
{
  "task": {
    "id": "L3-003",
    "prompt": "<原始用户 prompt>",
    "fixture_name": "express-api-starter",
    "expected_outcome": "<预期结果的自然语言描述，来自 task YAML>",
    "rubric_points": [
      "新增 GET /health 端点返回 200",
      "端点在 routes/ 目录下而不是堆在 server.ts",
      "跑 npm test 不报错"
    ]
  },
  "run": {
    "agent_name": "claude-code-1.0.5",
    "duration_sec": 127,
    "stdout_tail_4kb": "<string>",
    "stderr_tail_2kb": "<string>",
    "final_answer": "<提取出来的最终回复>",
    "exit_code": 0,
    "timed_out": false
  },
  "filesystem": {
    "files_created": [
      {"path": "routes/health.ts", "content": "<最多 8KB 内容>"}
    ],
    "files_modified": [
      {"path": "server.ts", "diff_unified": "<standard unified diff>"}
    ],
    "files_deleted": ["tmp/old.txt"]
  },
  "objective_checks": {
    "file_exists_routes_health": true,
    "npm_test_exit_code": 0,
    "typecheck_exit_code": 0
  },
  "reference": {
    "reference_duration_sec": 90,
    "reference_files_touched": 2,
    "claude_code_baseline_final_answer": "<可选：Claude Code 跑同题的最终回复，用作对比>"
  }
}
```

**关键设计**：
- 裁判**不看** agent 中间过程（事件流、tool call）——因为通用性要求只信外部物证
- 裁判**能看到**客观指标（objective_checks），这些由框架在评测后自动跑，例如"跑 npm test 通不通"
- 裁判**可选择看到**参考对比（reference），用来判断"相对优劣"而不是绝对标准

### 2.2 裁判输出什么

```json
{
  "dimensions": {
    "TaskCompletion": {"score": 0.85, "reason": "主要目标达成，缺少错误处理分支"},
    "Correctness":    {"score": 1.00, "reason": "npm test 通过，代码逻辑正确"},
    "CodeQuality":    {"score": 0.70, "reason": "路由直接堆 server.ts，未遵循项目目录惯例"},
    "Efficiency":     {"score": 0.60, "reason": "耗时 127s 比参考 90s 慢 40%"},
    "Robustness":     {"score": 0.80, "reason": "通过 typecheck 但无新增单测"},
    "NoRegression":   {"score": 1.00, "reason": "未修改既有文件"},
    "Communication":  {"score": 0.75, "reason": "最终回复清楚但未提文件路径"}
  },
  "overall": {
    "weighted_score": 0.82,
    "pass": true,
    "verdict": "合格：功能做出来了但代码组织不规范，效率偏慢",
    "top_issues": [
      "health 路由应该放 routes/ 目录",
      "可以加一个 health.test.ts"
    ]
  }
}
```

### 2.3 裁判模型怎么选

**推荐**：**Claude Sonnet 4.6**（单裁判 × 3 次取中位数）

| 方案 | 优点 | 缺点 | 决定 |
|------|------|------|------|
| Claude Opus 单次 | 最强判断力 | 太贵（每题 $0.1+），3 次更贵 | 放弃 |
| Claude Sonnet 4.6 × 3 中位数 | 平衡 + 抗方差 | 略贵（每题 $0.03） | **默认** |
| Claude Haiku × 5 投票 | 便宜 | Haiku 对"代码质量"类维度偏弱 | 备选（成本敏感场景） |
| 多模型投票（Sonnet + GPT-4 + Gemini）| 抗单模型偏见 | 集成复杂、API key 管理复杂 | L5 高价值题目专用 |

**红线**：
1. **被测 agent 和裁判 agent 必须不同源**。测 MAClaude（MA + Claude）时，裁判不能也用 Claude Sonnet——这就成了"Claude judge Claude"，会有亲和偏见。规避方案：跑 MAClaude 时，裁判换成 GPT-4 或 Gemini（需要 API key 多源兼容）。
2. **裁判 prompt 必须版本化**。prompt 改了等于指标改了，历史数据不可比。每个 prompt 版本存一份 hash，报告里注明 `judge_prompt_version`。
3. **裁判的 temperature 必须固定 0.0**，而且**每次 prompt 里要 nonce**（random seed + timestamp）来避免 prompt caching 污染判断多样性。

### 2.4 抗偏见三件套

裁判 LLM 天生会有偏好（偏向冗长回答、偏向某种代码风格、偏向特定项目结构）。对策：

**T1：Rubric-First Prompting（用打分表锚定，不让裁判自由发挥）**

裁判 prompt 里**不问"这代码好不好"**，而是问"按下面 5 条检查清单打分"。

```
对每一项独立打 0/0.5/1，不要考虑其他项：
[ ] 1. 是否实现了用户要的功能（看 expected_outcome）
[ ] 2. npm test 是否通过（看 objective_checks.npm_test_exit_code）
[ ] 3. 新增代码是否放在合理的目录（看 rubric_points[1]）
[ ] 4. 是否有幻觉（最终回复里提到的文件 / 函数是否真的存在于 filesystem）
[ ] 5. 最终回复是否简洁且指向关键点
```

具体 checklist 由 task YAML 的 `rubric_points` 提供。裁判只能在已给的项上打分，不能自己加项。

**T2：Cross-Validation（交叉验证）**

对每个维度，同时跑两个 prompt：
- Prompt A："请打分"
- Prompt B（反向）："找出这个回答里的所有问题、漏洞、不足"

如果 A 给 0.9 但 B 能挑出 5 个严重问题，说明 A 偏宽。最终分数 = min(A_score, 1 - B_severity)。

这是 AlpacaEval 2.0 用过的招数，对"LLM 夸夸其谈"类偏差很有效。

**T3：Position / Length Bias 规避**

- 裁判看到 `final_answer` 时，**过长的回复（>4KB）先用 summary 压到 1KB** 再判，避免"越长越好"偏见
- 多 agent 对比场景下，**每次随机化 agent_A / agent_B 的出现顺序**（参考 MT-Bench 做法），避免位置偏好

### 2.5 裁判 Prompt 模板（核心）

```markdown
你是一个严格的 agent 评测员。按照下面的 checklist 给这次 agent 的执行打分。

## 任务
{{task.prompt}}

## 预期结果描述（不是唯一正解，只是参考方向）
{{task.expected_outcome}}

## Agent 执行后的状态

### Agent 的最终回复
```
{{run.final_answer}}
```

### 文件系统变化
新增文件:
{{filesystem.files_created}}
修改文件:
{{filesystem.files_modified}}

### 客观检查结果
{{objective_checks}}

### 执行信息
- 耗时: {{run.duration_sec}}s（参考: {{reference.reference_duration_sec}}s）
- 退出码: {{run.exit_code}}
- 是否超时: {{run.timed_out}}

## 打分 Checklist（对每一项独立打 0 / 0.5 / 1）

{{rubric_points_formatted}}

## 维度评分（综合 checklist 结果，对每个维度独立打 0–1 连续分）

- **TaskCompletion**: 任务主目标是否达成
- **Correctness**: 代码是否正确（通过客观 check）
- **CodeQuality**: 代码是否规范、可读、遵循项目惯例
- **Efficiency**: 耗时、文件改动数量是否在合理范围
- **Robustness**: 是否考虑边界情况、是否有新增测试
- **NoRegression**: 是否破坏既有功能（看 modified 文件的 diff 是否合理）
- **Communication**: 最终回复是否清楚、准确、有用

## 反幻觉检查（强制）

对 final_answer 里提到的每个文件路径、函数名、命令，必须在 filesystem 或 objective_checks 里能找到证据。找不到的标记为幻觉，每个幻觉在 Correctness 扣 0.1（封顶扣到 0）。

## 输出 JSON

```json
{
  "checklist": [{"id": 1, "score": 0/0.5/1, "reason": "..."}, ...],
  "dimensions": {
    "TaskCompletion": {"score": 0-1, "reason": "一句话"},
    "Correctness":    {"score": 0-1, "reason": "一句话"},
    ...
  },
  "hallucinations": ["<幻觉描述>", ...],
  "overall": {
    "weighted_score": 0-1,
    "pass": true/false,
    "verdict": "两三句话总结",
    "top_issues": ["..."]
  }
}
```

不要在 JSON 外写任何文字。不要使用 markdown code block 包裹 JSON。
```

### 2.6 裁判自检 & 人工对齐

- **黄金集**：维护 20 道"人工标注过标准答案"的题目，每次升级裁判 prompt 或裁判模型后跑一遍，看机器分和人工分的 Pearson 相关系数。阈值 ≥ 0.85 才能上线。
- **周期性抽检**：每次 run 随机抽 10% 的题目，人工快看一眼是否判错。连续两次发现 > 20% 判错，prompt 进入修复期。
- **judge_ci**：机器 judge 的分数带一个 "judge confidence interval"（3 次中位数的 MAD），在报告里显示。CI 宽 = 裁判不确定，建议人工 review。

---

## 3. 评分维度详细定义（7 维）

从用户原话"任务耗时、任务质量"出发，拆分为 **7 个正交维度**：

### 3.1 维度表

| 维度 | 英文名 | 权重 | 0 分 | 1 分 | 客观 vs LLM |
|------|--------|------|------|------|-------------|
| **任务完成度** | TaskCompletion | 0.25 | 完全没做 / 做错方向 | 用户目标 100% 达成 | 混合 |
| **正确性** | Correctness | 0.20 | 代码跑不起来 / 测试挂 | 测试通过 + 类型检查通过 | **纯客观** |
| **代码质量** | CodeQuality | 0.15 | 硬编码、重复、裸 hack | 合理抽象、遵循项目惯例 | 纯 LLM |
| **效率** | Efficiency | 0.10 | 耗时 > 3× 参考，或改了 10× 无关文件 | ≤ 参考值 | 纯客观 |
| **健壮性** | Robustness | 0.10 | 无错误处理、无边界判断 | 有 try/catch、有边界测试 | LLM + 客观 |
| **无 Regression** | NoRegression | 0.10 | 破坏了既有功能（老测试挂了） | 既有功能全保留 | **纯客观** |
| **沟通质量** | Communication | 0.10 | 空答 / 胡编 / 让用户自己猜 | 清晰、准确、含文件路径和下一步建议 | 纯 LLM |

**综合分**：`weighted_score = Σ(dim_score × weight)` → 0–1

**PASS**：`weighted_score ≥ 0.65` AND `TaskCompletion ≥ 0.5` AND `Correctness ≥ 0.5` AND `NoRegression ≥ 0.8`

三个维度有底线：
- TaskCompletion < 0.5 → 任务没完成，别的维度分再高都没意义
- Correctness < 0.5 → 代码错的，再漂亮也是废品
- NoRegression < 0.8 → 破坏了现有功能是比完不成更严重的错，绝不放过

### 3.2 每维度的详细 0/1 定义

#### TaskCompletion（任务完成度）— 权重 0.25

核心问题：**用户让你做 X，你做到了几成？**

| 分数 | 场景 |
|------|------|
| 1.0 | expected_outcome 的主要目标 + 所有 rubric_points 都达成 |
| 0.7 | 主要目标达成，rubric_points 缺 1–2 项 |
| 0.5 | 主要目标部分达成（例：要求实现 3 个接口，只实现了 2 个） |
| 0.3 | 做了相关工作但没到达终点（例：研究了方案但没写代码） |
| 0.0 | 完全没做 / 做错了方向 |

**判法**：
- 有客观锚点（文件、命令退出码）时走程序判 → 0.5 或 1
- 纯功能性任务（如"给这代码加注释"）走 LLM judge → 0/0.3/0.5/0.7/1

**示例**：
- 任务："添加一个 /health 端点返回 200"
  - 1.0：文件存在 + 路由注册 + curl 能返回 200
  - 0.5：文件存在但没注册到 server
  - 0.0：没创建文件

#### Correctness（正确性）— 权重 0.20

核心问题：**代码真的能跑吗？**

**纯客观指标**，由框架在 agent 结束后自动执行：
- `exit_code_check`: agent 退出码 ≠ 0 → Correctness 封顶 0.5
- `npm_test` / `pytest` / `cargo test`（task YAML 指定）：全通过 → 1，部分通过 → pass率，全挂 → 0
- `tsc --noEmit` / `mypy` / `cargo check`：通过 → 不扣分，有错 → -0.3
- **幻觉扣分**：final_answer 里提到的每个不存在的文件/函数 → -0.1（封顶扣到 0）

**公式**：
```
Correctness = (test_pass_rate × 0.7 + typecheck_pass × 0.3) - hallucination_count × 0.1
```

如果任务不涉及代码（例如"写一份项目简介"），Correctness = 1 if "没明显事实错误" else 0.5。

#### CodeQuality（代码质量）— 权重 0.15

核心问题：**这代码像人写的吗？**

**纯 LLM judge**。rubric 要点：
- 是否遵循项目已有风格（命名、缩进、文件组织）
- 是否有明显的 copy-paste / 硬编码 / 魔法数
- 是否抽象合理（不是过度抽象也不是全堆一个文件）
- 是否有无意义的 console.log / 调试代码残留
- 是否破坏了已有的架构边界

**示例 0.7**："功能做对了，但新路由直接写在 server.ts 里而不是 routes/ 目录，违反了项目约定"
**示例 0.3**："大量 copy-paste，3 个相似函数没抽公共方法"
**示例 1.0**："清晰抽象，命名与项目一致，新增文件放在合理位置"

#### Efficiency（效率）— 权重 0.10

核心问题：**多快、多省？**

两个子指标（取最小值）：
- **时间效率** = `min(1, reference_duration / actual_duration)`
- **改动效率** = `min(1, reference_files_touched / actual_files_touched)`

reference 由人工标定（每题 3–5 人跑一遍取中位数）或 Claude Code 跑一遍当 baseline。

**不直接影响 pass/fail**，只进加权分。L5 任务权重降到 0.05（本地模型允许"多轮挣扎"）。

**反作弊**：如果改动文件数 > 2× 参考，Efficiency 强制封顶 0.3（防止胡乱改一堆无关文件）。

#### Robustness（健壮性）— 权重 0.10

核心问题：**边界情况、错误情况有没有考虑？**

- 如果任务本身是"修 bug / 加功能"，看是否**新增了单测**（客观：test 文件数变化）
- 看代码里有没有 try/catch、参数校验、边界判断（LLM judge）
- 看 stderr 里有没有 warning / deprecation 没处理
- 如果任务是"加了个接口"，看是否处理了错误响应（返回合适的 4xx/5xx）

```
Robustness = 0.4 × has_new_tests + 0.4 × error_handling_judge + 0.2 × no_suspicious_warnings
```

#### NoRegression（无回归）— 权重 0.10

核心问题：**你别把好的搞坏了**

**纯客观**：
- 跑既有测试套件，全通过 → 1
- 既有测试挂 1 个 → 0.3
- 既有测试挂 2+ 或主要功能崩 → 0
- 修改了 task YAML 标记为 "no_modify" 的文件（例如测试文件、配置文件） → 直接 0

这是 **PASS 的硬门槛（≥ 0.8）**。破坏既有功能比完不成任务还严重。

#### Communication（沟通质量）— 权重 0.10

核心问题：**最后那段话有没有用？**

LLM judge，三个子维度：
- 相关性：final_answer 是不是在回答用户的问题
- 具体性：有没有指出修改了哪些文件、下一步应该做什么
- 无幻觉：提到的文件 / 函数 / 命令真实存在

```
Communication = (relevance + specificity + factuality) / 3
```

如果 agent 什么话都没说就结束了（final_answer 为空或仅有 "done"），Communication = 0.

### 3.3 维度权重可覆盖

task YAML 可以针对具体题目调整权重。典型场景：

- **L3 修 bug 类**：NoRegression 升到 0.20（防止改 bug 改崩更多地方）
- **L4 重构类**：CodeQuality 升到 0.25（重构的核心就是让代码更好）
- **L5 探索类**：Efficiency 降到 0.05，TaskCompletion 升到 0.35（允许 agent 多跑几轮挣扎）
- **文档类**：Correctness 升到 0.25（文档最怕事实错误），Robustness 降到 0.05

---

## 4. 任务难度定义：L3 是什么

### 4.1 L2 和 L3 的边界

**L2（M1 已实现）**："读改写 + 多轮"
- 单一文件操作 + 最多 2–3 轮对话
- 明确路径（告诉 agent 改哪个文件）
- 工具链固定（读 → 改 → 写）
- 典型题：**"把 README.md 里的版本号从 1.0 改到 2.0"**

**L3（本文档重点）**："完整小任务"
- 需要 5–15 轮推理 + 跨文件
- **路径不明确**（agent 自己找到该改哪里）
- **涉及多个工具链**（读 + 搜 + 写 + 测 + 验证）
- **有验收标准**（测试通过 / 命令退出码 0）
- 典型题：**"给这个 Express 项目加一个 /health 端点返回 200，并加一个对应的测试"**

### 4.2 "完整小任务"的定义

一个任务算 L3 级别，必须同时满足：

1. **跨文件**：涉及至少 2 个文件的读/写/改
2. **有验收**：有客观指标可验证（测试通过 / 退出码 / 文件存在）
3. **需要规划**：不是线性指令，agent 必须决定"先做 A 还是先做 B"
4. **有约束**：存在"不该改的东西"（例如不能改测试文件来让测试通过）
5. **能在 15 分钟内完成**：不是 L5 的几小时级大任务

### 4.3 L3 fixture 比 L2 复杂多少

L2 fixture 样例（`simple-node-project`）：
- 3–5 个文件
- 1 个 package.json
- 1 个 README
- 没有测试

L3 fixture 应该具备：
- 15–30 个文件
- 完整的项目结构（src/ + test/ + config/ + package.json）
- 至少 3–5 个现有测试
- 有 CI 配置（至少有 `npm test` 能跑）
- 有明显的**项目约定**（文件组织方式、命名风格）——用来测 CodeQuality

推荐 fixture 类型（3–4 个就够）：
- `express-api-starter`：REST API 项目
- `react-component-library`：前端组件库
- `python-cli-tool`：Python CLI
- `buggy-project`：故意埋 bug 的项目（L5 专用）

---

## 5. 五道 L3 样题（可直接实现）

### Task L3-001: Add Health Endpoint

```yaml
id: L3-001
title: 给 Express API 加 /health 端点
level: L3
category: add-feature
fixture: express-api-starter

prompt: |
  给这个 Express 项目加一个 GET /health 端点，返回 JSON {"status": "ok"} 和 HTTP 200。
  加完之后记得加一个对应的测试，确保 `npm test` 通过。

expected_outcome: |
  - 新增 routes/health.ts（或等价位置）实现 /health 路由
  - 在 server.ts / app.ts 里注册这个路由
  - 新增 test/health.test.ts 覆盖这个端点
  - npm test 全部通过

rubric_points:
  - 新增的路由处理函数返回 status: "ok" 和 HTTP 200
  - 路由放在 routes/ 目录下（项目约定）而不是堆在 server.ts
  - 新增一个测试文件（不是改现有测试）
  - npm test 全部通过（既有测试 + 新测试）
  - 修改 server.ts 时不破坏已有的路由注册

no_modify_files:
  - test/existing-routes.test.ts  # 不能改老测试让它们"通过"

objective_checks:
  - type: file_exists
    path: routes/health.ts
    weight_into: TaskCompletion
  - type: file_exists_any
    paths: [test/health.test.ts, test/health.spec.ts]
    weight_into: Robustness
  - type: command_exit_code
    command: npm test
    expected: 0
    weight_into: Correctness
  - type: command_exit_code
    command: npx tsc --noEmit
    expected: 0
    weight_into: Correctness

runtime:
  timeout_sec: 300
  max_rounds: 20
  reference_duration_sec: 90
  reference_files_touched: 3

dim_weights:
  TaskCompletion: 0.25
  Correctness: 0.25       # 测试必须过
  CodeQuality: 0.15
  Efficiency: 0.10
  Robustness: 0.10
  NoRegression: 0.10
  Communication: 0.05

judge:
  model: claude-sonnet-4-6
  runs: 3
  aggregation: median
```

---

### Task L3-002: Fix a Type Error Across Files

```yaml
id: L3-002
title: 跨文件修复类型错误
level: L3
category: bug-fix
fixture: react-component-library-with-type-bug

prompt: |
  跑 `npx tsc --noEmit` 能看到有 3 个类型错误，帮我修掉。
  不要修改 package.json 的依赖版本。

expected_outcome: |
  - 定位 3 处类型错误（分布在 2–3 个文件里）
  - 用最小修改修复它们
  - tsc 完全通过

rubric_points:
  - 所有 3 个类型错误都被修复
  - 修改只涉及类型，不改运行时逻辑
  - 没有用 `any` 或 `@ts-ignore` 蒙混过关
  - 既有单元测试仍然通过

no_modify_files:
  - package.json
  - tsconfig.json   # 不能放松编译选项

objective_checks:
  - type: command_exit_code
    command: npx tsc --noEmit
    expected: 0
    weight_into: Correctness   # 核心
  - type: command_exit_code
    command: npm test
    expected: 0
    weight_into: NoRegression
  - type: grep_not_found
    pattern: "@ts-ignore"
    path_new_files: true
    weight_into: CodeQuality   # 用 @ts-ignore 扣分
  - type: grep_not_found
    pattern: ": any"
    path_new_files: true
    weight_into: CodeQuality

runtime:
  timeout_sec: 400
  max_rounds: 25
  reference_duration_sec: 120
  reference_files_touched: 3

dim_weights:
  TaskCompletion: 0.30
  Correctness: 0.25
  CodeQuality: 0.20        # "用 any 糊弄" 必须扣
  Efficiency: 0.10
  Robustness: 0.05
  NoRegression: 0.10
  Communication: 0.00       # 这题不看沟通
```

---

### Task L3-003: Refactor a Large File

```yaml
id: L3-003
title: 拆分大文件
level: L3
category: refactor
fixture: python-cli-with-god-class

prompt: |
  src/cli.py 现在 600 行太长了，帮我拆成几个职责更清晰的文件。
  拆完之后功能不能变（pytest 必须全通过）。

expected_outcome: |
  - src/cli.py 被拆成 2–4 个文件
  - 每个新文件职责清晰（比如 cli/args.py、cli/commands.py、cli/output.py）
  - 所有既有 import 都更新到新路径
  - pytest 全通过

rubric_points:
  - src/cli.py 从 600 行减少到 < 200 行
  - 至少新增 2 个拆出去的模块
  - 没有循环 import
  - 所有 pytest 测试通过
  - 不引入新依赖

no_modify_files:
  - tests/   # 测试应该不需要改

objective_checks:
  - type: file_line_count_lt
    path: src/cli.py
    max_lines: 200
    weight_into: TaskCompletion
  - type: command_exit_code
    command: pytest
    expected: 0
    weight_into: NoRegression   # 重构最关键
  - type: command_exit_code
    command: python -c "import src.cli"
    expected: 0
    weight_into: Correctness
  - type: files_created_count_gte
    min: 2
    pattern: "src/cli/*.py"
    weight_into: TaskCompletion

runtime:
  timeout_sec: 500
  max_rounds: 30
  reference_duration_sec: 180
  reference_files_touched: 5

dim_weights:
  TaskCompletion: 0.20
  Correctness: 0.15
  CodeQuality: 0.25          # 重构就是看代码质量
  Efficiency: 0.05
  Robustness: 0.05
  NoRegression: 0.25         # 拆完测试必须过
  Communication: 0.05
```

---

### Task L3-004: Research & Document

```yaml
id: L3-004
title: 调研 + 写文档
level: L3
category: document
fixture: unfamiliar-project

prompt: |
  我刚接手这个项目。帮我写一份 ARCHITECTURE.md，讲清楚：
  - 项目主要分几层
  - 核心数据流是什么
  - 关键模块在哪里
  不要超过 500 字。

expected_outcome: |
  - 新增 ARCHITECTURE.md
  - 包含分层 / 数据流 / 核心模块 3 个部分
  - 提到的文件和函数真实存在
  - 长度在 300–600 字之间

rubric_points:
  - 新增 ARCHITECTURE.md
  - 讲清楚分层（至少提到 2 层结构）
  - 有具体的文件路径引用（不是泛泛而谈）
  - 没有事实错误（提到的文件都存在）
  - 长度 300–600 字

no_modify_files:
  - src/
  - test/

objective_checks:
  - type: file_exists
    path: ARCHITECTURE.md
    weight_into: TaskCompletion
  - type: file_word_count_range
    path: ARCHITECTURE.md
    min: 300
    max: 800
    weight_into: TaskCompletion
  - type: hallucination_check
    target: ARCHITECTURE.md
    method: extract_paths_and_grep   # 文档里提到的每个路径必须真实存在
    weight_into: Correctness

runtime:
  timeout_sec: 300
  max_rounds: 20
  reference_duration_sec: 100
  reference_files_touched: 1

dim_weights:
  TaskCompletion: 0.25
  Correctness: 0.30         # 文档最怕胡编
  CodeQuality: 0.10          # 文档也有质量
  Efficiency: 0.10
  Robustness: 0.05
  NoRegression: 0.10        # 不能乱改 src
  Communication: 0.10

judge:
  model: claude-sonnet-4-6
  extra_check: |
    特别严格检查 ARCHITECTURE.md 里提到的文件路径是否都在 filesystem 里能找到。
    任何幻觉路径 = 幻觉一次。
```

---

### Task L3-005: Diagnose & Fix from Logs

```yaml
id: L3-005
title: 从日志定位并修复 bug
level: L3
category: debug
fixture: buggy-project-with-logs

prompt: |
  用户反馈说：跑 `node server.js` 之后访问 / 时偶尔 500。日志在 logs/error.log。
  帮我找到根因并修复。

expected_outcome: |
  - 读日志 + 定位到 src/handlers/index.ts 的空值访问 bug
  - 用安全的方式修复（加判空或 optional chaining）
  - 加一个测试覆盖这个场景
  - npm test 全部通过

rubric_points:
  - 定位到正确的 bug 位置（handlers/index.ts 附近）
  - 修复方式合理（不是把整个函数删了）
  - 新增一个测试覆盖空值场景
  - npm test 全过
  - 最终回复里说清楚根因

no_modify_files:
  - logs/   # 不能改日志

objective_checks:
  - type: command_exit_code
    command: npm test
    expected: 0
    weight_into: Correctness
  - type: file_modified
    path: src/handlers/index.ts
    weight_into: TaskCompletion
  - type: files_created_count_gte
    min: 1
    pattern: "test/**"
    weight_into: Robustness
  - type: final_answer_mentions
    keywords_any: ["空值", "null", "undefined", "optional chaining", "判空"]
    weight_into: Communication

runtime:
  timeout_sec: 400
  max_rounds: 25
  reference_duration_sec: 150
  reference_files_touched: 2

dim_weights:
  TaskCompletion: 0.20
  Correctness: 0.20
  CodeQuality: 0.10
  Efficiency: 0.05          # debug 类题目允许多跑几轮
  Robustness: 0.15         # 新增测试很重要
  NoRegression: 0.15
  Communication: 0.15       # "说清楚根因" 重要
```

---

## 6. 实施落地顺序

### 6.1 分期目标

**Phase 1（2 周）：UAI 协议 + 裁判骨架**
- 定义并实现 Universal Agent Interface（adapter 接口 + 执行器）
- 实现裁判调用（Claude Sonnet 4.6 + 3 次中位数）
- 2–3 个 fixture（express-api-starter、react-component-library 等）
- 2 道样题（L3-001, L3-004）跑通

**Phase 2（3 周）：5 道题 + 人工对齐**
- 补齐 5 道 L3 样题
- 人工标注黄金集（每题 5 份人工答案），算裁判相关系数
- 优化裁判 prompt 直到 Pearson ≥ 0.85

**Phase 3（4 周）：横向接入 + 对比报告**
- 接入 Claude Code 作为 baseline
- 接入 my-agent、Aider 作为对比
- 输出横向对比报告（多 agent 同题对比）

**Phase 4（6 周）：L4/L5 扩展 + 趋势跟踪**
- 扩到 L4（10 题）+ L5（3 题）
- 历史数据跟踪（每个 commit 跑一次，画趋势）

### 6.2 实施的 3 个最大风险

1. **fixture 腐化**：fixture 依赖第三方库版本（express 5.x）若升级可能破坏题目。对策：fixture **锁死版本 + 离线缓存 node_modules**。
2. **裁判漂移**：Claude Sonnet 升级了，同题可能给不同分数。对策：裁判模型版本号写入 run metadata；升级后用黄金集验证，不通过就回滚或重新校准。
3. **评测变成"讨好裁判"的游戏**：一旦 benchmark 知名了，agent 开发者会针对裁判 prompt 优化。对策：**rubric_points 保密**，只公开任务 prompt；定期换裁判模型。

---

## 7. 和 M1 (L0–L2) 的衔接

M1 跑完一轮，输出 `L0 PASS, L1 92%, L2 78%`。L3+ 只在 L2 通过时（score ≥ 0.65）才启动，否则直接标 `L3 locked`。

M1 的硬断言不需要改，L3+ 是"在 M1 跑完之后再开一次 benchmark"，**和 M1 是两套独立 runner**：
- M1 runner：只能跑 my-agent（依赖内部事件）
- L3 runner：能跑任意 CLI agent（UAI 协议）

两者共用 fixture 目录、共用 scorer 的维度定义和公式，但 runner 实现完全分开。

**最终汇总报告**：

```
═══════════════════════════════════════════════════════════
  MA Agent Benchmark — 2026-05-15
═══════════════════════════════════════════════════════════

  Config:  MA v0.4.0 + Qwen3-30B

  ─────── M1 (内部评测) ───────
  L0 Connectivity    ██████████ 100%  ✓
  L1 Stable Tools    █████████░  92%  ✓
  L2 Multi-turn      ████████░░  80%  ✓

  ─────── L3+ (通用评测，UAI 协议) ───────
  L3 Complete Tasks  ██████░░░░  62%  (5/5 task attempted, 3 pass)

  ─────── 本次 L3 详情 ───────
  L3-001 Add Health Endpoint    ████████░░ 0.82  PASS
  L3-002 Fix Type Errors        ██████░░░░ 0.61  FAIL (NoRegression 0.7 below threshold)
  L3-003 Refactor Large File    ███████░░░ 0.73  PASS
  L3-004 Research & Document    █████████░ 0.91  PASS
  L3-005 Diagnose & Fix         █████░░░░░ 0.58  FAIL (TaskCompletion 0.4)

  ─────── 维度分 ───────
  TaskCompletion    ███████░░░  0.71
  Correctness       ██████░░░░  0.65
  CodeQuality       ████████░░  0.80
  Efficiency        ██████░░░░  0.62
  Robustness        █████░░░░░  0.55   ← 最弱
  NoRegression      ████████░░  0.78
  Communication     █████████░  0.88

  ─────── vs Claude Code ───────
  My Score: 0.73   |   Claude Code: 0.91   |   Gap: -0.18
  AUS (Uplift):  0.57
```

---

## 8. 红线总结

1. **只看外部可观察物** — 不碰被测 agent 内部事件流
2. **裁判 ≠ 被测** — 测 MAClaude 时，裁判必须换成 GPT-4 / Gemini
3. **裁判 3 次中位数** — 抗 LLM 抖动
4. **Rubric 保密，prompt 公开** — 防止针对打分规则作弊
5. **fixture 版本锁死** — 离线缓存 node_modules，拒绝依赖升级
6. **黄金集 + 人工对齐** — 裁判 prompt 每次升级必须过 Pearson ≥ 0.85
7. **NoRegression 硬门槛** — 破坏既有功能比完不成还严重，< 0.8 直接 FAIL
8. **L3 只在 L2 pass 后启动** — 地基塌了不谈中层建筑

---

## 附录 A：裁判维度对比参考

| Benchmark | 维度数 | 裁判方式 | L3 级别相关的亮点 |
|-----------|--------|---------|--------------------|
| **SWE-bench** | 1（pass/fail） | 纯客观（patch apply + test） | 简单但黑白，细节看不到 |
| **τ-bench** | 2（reward + action valid） | LLM judge | agent 能力+工具调用合规 |
| **AlpacaEval 2.0** | 1 | LLM judge + length bias 修正 | 对齐 + 位置随机化 |
| **MT-bench** | 多 | GPT-4 + 人工校准 | 裁判模型固定、多种对比模式 |
| **AgentBench** | 多（per env） | 各环境独立 | 8 环境横向对比思路 |
| **本方案 L3** | 7 | Claude Sonnet × 3 中位数 + 客观锚点 | CLI 通用协议 + 7 维正交 + rubric-first |

## 附录 B：数据集 schema（SQL）

```sql
CREATE TABLE benchmark_runs (
  run_id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,           -- 'claude-code-1.0.5' / 'my-agent-0.4.0'
  agent_version TEXT,
  judge_model TEXT NOT NULL,          -- 'claude-sonnet-4-6-20260318'
  judge_prompt_version TEXT NOT NULL,  -- 'v2.3'
  started_at TIMESTAMP,
  finished_at TIMESTAMP
);

CREATE TABLE task_results (
  run_id TEXT,
  task_id TEXT,
  attempt_n INTEGER,                  -- 0-indexed (1 of 5 runs)
  duration_sec REAL,
  exit_code INTEGER,
  timed_out BOOLEAN,
  objective_checks_json TEXT,         -- JSON
  PRIMARY KEY (run_id, task_id, attempt_n)
);

CREATE TABLE judge_scores (
  run_id TEXT,
  task_id TEXT,
  judge_run_n INTEGER,                -- 0/1/2 (3 judge runs)
  dim_name TEXT,
  score REAL,
  reason TEXT,
  PRIMARY KEY (run_id, task_id, judge_run_n, dim_name)
);
```

## 附录 C：UAI Adapter 示例

```bash
# adapters/claude-code.sh
#!/usr/bin/env bash
PROMPT="$1"
claude --dangerously-skip-permissions --print "$PROMPT" 2>&1 | \
  tee >(awk '/===FINAL_ANSWER===/,/===END===/' > /tmp/final_answer.txt)
```

```bash
# adapters/my-agent.sh
#!/usr/bin/env bash
PROMPT="$1"
bun dist/cli.js run --prompt "$PROMPT" --quiet 2>&1
```

```bash
# adapters/aider.sh
#!/usr/bin/env bash
PROMPT="$1"
aider --yes --message "$PROMPT" --no-show-model-warnings 2>&1
```

每个 adapter < 10 行。接入方自己维护，框架只负责 spawn 它。

---

## 一句话收尾

M1 的 L0–L2 是"测 my-agent 自己"。L3+ 是"测任何 CLI agent"。**核心转变是从"读内部事件"变成"只看外部物证"**，这需要：一个 Universal Agent Interface 协议、一个基于 rubric 的裁判系统、7 个正交评分维度、以及一套防偏见机制。跑完之后，用户不仅能知道 my-agent 现在几分，还能知道"比 Claude Code 差多少"、"比 Aider 强在哪"、"这次改动让分涨了还是跌了"。
