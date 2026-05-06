# MA Agent 分级 Benchmark 评分体系（方案 B）

> 调研员 B 出品。和方案 A（E2E 三层金字塔 + pass/fail + flaky 预算）走不同路线。
>
> **一句话定位**：A 是"测试框架"，答"能不能跑通"；B 是"仪表盘"，答"现在几分、差在哪、补了之后涨了多少"。
>
> **核心主张**：benchmark 不是为了卡门禁，是为了**量化 MA agent 对本地 30B 模型的增幅**，让用户每做一次增强都能看见"那根进度条往上动了几格"。

---

## 0. TL;DR

用户要的不是 pass/fail 题库，是一个**连续分的分级评分体系**。方案 B 由四件事构成：

1. **分级题库（L0–L5）**：每级有独立题目、独立门槛、独立分数，逐级解锁。跨不过门槛禁止声称"到 Lx"。
2. **多维度评分（不是 pass/fail）**：每道题在 6 个维度独立打分（工具准度 / 任务完成 / 回答质量 / 上下文 / 错误自救 / 效率），pass/fail 是副产品。
3. **增幅指标（Agent Uplift Score, AUS）**：同题跑三种配置——裸 API 调 30B、MA agent 调 30B、MA agent 调 Claude，换算 MA 把 30B 抬了多少 % 向 Claude 靠拢。这是北极星指标。
4. **本地专属题型**：用"无限 token + 多轮自救"作为 30B 翻盘窗口，专设"允许多轮挣扎"的题型，测的是"agent 能不能把一个笨模型带到终点"。

总分形态：`MA v0.3.1 @ Qwen3-30B → L2.6/5.0｜AUS 58%｜本地优势 +12%`。

一眼看得出"现在什么水平、距离 Claude Code 差多少、这次 commit 有没有让分变高"。

---

## 1. 为什么不走 A 的路线

A 的方案很扎实，但解决的是另一个问题：**"代码会不会 regression"**。对照用户原话：

- 用户："衡量的是 agent 对模型的增幅，不是模型本身" — A 没给增幅，只给 pass/fail。
- 用户："稳定工具调用 = 基线（不及格线以下）" — A 给的是"通过率"，没给"基线线以下怎么表示"。
- 用户："本地优势：无限 token，可以多轮纠错" — A 的 quorum 是为了绕过 flaky，B 的"允许多轮"是**题目本身就这么设计**，测试的就是 agent 把不稳定模型带到终点的能力。
- 用户："agent 跑一遍出总分" — A 出的是 pass rate 表，B 出的是一个带小数的等级 + 一个百分比。

两套东西不冲突，A 是 CI 门禁，B 是产品进度条。建议共存，但这份文档只讲 B。

---

## 2. 分级结构：Level 0–5

每级是一扇门。**必须拿到前一级门槛分才能进入下一级计分**（避免 L3 捞了 40 分、L1 挂了 50 分，看起来 90 分其实地基稀烂）。

| Level | 名字 | 考什么 | 典型题 | 每级题数 | 门槛 | 权重 |
|-------|------|--------|--------|----------|------|------|
| **L0** | 连通性 | 模型能说话、工具能调通 | "你好" / "调一下 fs__list_directory" | 10 | **100%** | 0 分（不及格线以下，挂了就-∞） |
| **L1** | 单轮基本功 | 给一个明确指令，一次把工具调对 | "读 package.json 告诉我 name" | 20 | 80% | 10% |
| **L2** | 多轮协作 | 连续 2–3 轮，保持上下文 | Case 1 三轮项目概览 | 15 | 70% | 20% |
| **L3** | 复杂工作流 | 跨文件操作、读-改-写、多工具编排 | "把 README 里的 VERSION 从 1 改到 2 并 git diff 给我" | 10 | 60% | 25% |
| **L4** | 自主规划 | agent 自己拆任务、自己决策工具顺序 | "分析这个项目的架构" | 6 | 50% | 25% |
| **L5** | 真实 session | 完整一个开发 session，15+ 分钟 | "进入陌生项目、找到一个预埋 bug、修复、跑通测试" | 3 | 40% | 20% |

**总分公式**：

```
LevelScore_i = (通过题数 / 本级题数) × 100
TotalScore   = Σ (LevelScore_i × weight_i)   (只统计门槛达成的级)
Level        = 最后一个门槛达成的 i + LevelScore_{i+1} / 100   (带小数)
```

例子：L0 100%、L1 90%、L2 75%、L3 55%（未达 60% 门槛）→ `Level = 2 + 0.55 = 2.55`。即使 L4/L5 偶然做对也不计入 Level，只在 detail 里展示。

**为什么要分级 + 门槛**：用户原话"稳定工具调用 = 基线（不及格线以下）"。连 L0 都过不了的 agent，L3 做对 2 题是统计噪声，不是能力。门槛把噪声挡掉。

---

## 3. 六维评分（代替 pass/fail）

每道题不只打"过 / 没过"，而是在 6 个维度独立给 0–1 连续分。这是和 A 最大的差异。

| 维度 | 简称 | 0 分情形 | 1 分情形 | 权重 |
|------|------|----------|----------|------|
| **工具准确率** | ToolAcc | 该调不调 / 调错工具 / 参数错 | 调的工具、参数、顺序都对 | 0.25 |
| **任务完成率** | TaskDone | 用户目标完全没达成 | 用户目标 100% 达成 | 0.30 |
| **回答质量** | AnsQual | 空答 / 胡编 / 幻觉 | 准确、具体、相关 | 0.15 |
| **上下文保持** | CtxKeep | 第二轮就忘了 | 3 轮后仍能引用 | 0.10 |
| **错误自救** | ErrRec | 一错就崩 / 无限重试 | 识别错误 → 换策略 → 到终点 | 0.10 |
| **效率** | Eff | 用了 > 3× 参考轮数 / token | ≤ 参考值 | 0.10 |

**题目得分**：

```
题目分 = Σ (维度分 × 维度权重)    → 0–1 之间
PASS   = 题目分 ≥ 0.7 且 ToolAcc ≥ 0.5 且 TaskDone ≥ 0.5   (两个核心维度有底线)
```

### 3.1 维度打分规则（每维度具体怎么算）

- **ToolAcc**：`正确调用数 / 总调用数`。"正确"= 工具名、关键参数、调用时机都对。judge 用 LLM-as-judge，prompt 里给"正确答案工具序列"。
- **TaskDone**：judge 给 0 / 0.5 / 1 三档。0 = 没做；0.5 = 做了一半或有明显瑕疵；1 = 完整完成。有客观锚点的题目（文件写入 / 命令执行）用程序判，不经 judge。
- **AnsQual**：三个子指标平均
  - 相关性（回答是否 on-topic）
  - 具体性（有没有引用工具结果里的具体数字 / 文件名 / 错误信息）
  - 无幻觉（关键事实能在 tool_result 或 fixture 里对上）
- **CtxKeep**：多轮题专用。后轮能否引用前轮事实。单轮题此维度不参与计算。
- **ErrRec**：错误场景题专用。`1 - (同错误重试次数 / 3)` clamp 到 [0,1]；同时要求最终 finalText 里承认失败（没承认扣到 0）。
- **Eff**：`min(1, 参考轮数 / 实际轮数)`。参考轮数由人手定，典型 L1=1，L2=2-3，L3=5-8，L4=10-15。**此维度不参与 pass/fail，只进总分**。

### 3.2 为什么拆 6 维

用户原话："好用 = 良好以上"。"好用"不是单一指标。两个 pass rate 都是 80% 的 agent，可能一个是"调对了但答得稀烂"、一个是"答得好但每次用 3× 轮数"，体验天差地别。拆维度才能看出"差在哪"，才能指导下一步增强做什么。

---

## 4. 北极星指标：Agent Uplift Score (AUS)

**用户原话**："衡量的是 agent 对模型的增幅，不是模型本身。"

AUS 把这句话变成一个百分比。

### 4.1 三个配置对比

同一套题、同一个评分体系，跑三次：

| 配置 | 说明 | 叫什么 |
|------|------|--------|
| **Raw30B** | 裸 HTTP 打 30B 模型，只给 system prompt + 用户 prompt，没有 agent loop、没有 MCP | Baseline |
| **MA30B** | MA agent + 30B 模型（常规用法） | Target |
| **MAClaude** | MA agent + Claude Sonnet 4.6 | Ceiling |

每个配置都出一个 TotalScore（0–100）。

### 4.2 AUS 公式

```
AUS = (MA30B - Raw30B) / (MAClaude - Raw30B) × 100%
```

含义：**MA agent 把 30B 从"赤手空拳"抬到了"Claude Code 水位"的百分之几**。

例子：
- Raw30B = 22 分，MA30B = 58 分，MAClaude = 85 分
- AUS = (58-22) / (85-22) = **57%**
- 解读："MA v0.3.1 把 30B 抬到 Claude Code 水平的 57%"

### 4.3 为什么这个指标对

- **去模型化**：模型升级（Qwen3 → Qwen4）不会虚高 AUS，因为 Raw30B 和 MAClaude 都会跟着动，分子分母一起抬。
- **可归因**：AUS 上升 = agent 层真的变好了。纯换模型只让 MA30B 和 Raw30B 同步上去，AUS 不变甚至下降。
- **有上限感**：100% 意味着 agent 把 30B 抬到了和 Claude 一样好。用户看一眼就知道还剩多少空间。

### 4.4 配套指标：本地优势分 (Local Edge)

本地模型有两个 Claude Code 不具备的优势：**免费无限 token** 和 **私有数据安全**。为了不让 benchmark 一边倒地鼓吹"越像 Claude 越好"，加一个平衡指标：

```
LocalEdge = MA30B_相对成本效益 - MAClaude_相对成本效益
相对成本效益 = 得分 / (token_成本 × 1000 + 时延秒数)
```

或者更简单：**同样完成度，MA30B 用多少 token / 时间、MAClaude 用多少**。如果 MA30B 肯多花 10× token 换到 80% 的 MAClaude 分数，LocalEdge = 正。

这个指标保证"30B 多轮挣扎"的路线不会被无脑判输，呼应用户原话："本地优势：无限 token，可以多轮纠错"。

---

## 5. 分级题库：每级怎么出题

### 5.1 L0 — 连通性（10 题，门槛 100%）

最低信号。一题没过 = 地基塌。

| # | 输入 | 断言 |
|---|------|------|
| L0.1 | "你好" | finalText 非空 |
| L0.2 | "1+1=" | finalText 含 "2" |
| L0.3 | "调一下 fs__list_directory 列当前目录" | tool_calls 含 `fs__list_directory`，ok=true |
| L0.4–L0.9 | 每个核心 MCP（fs / exec / grep / web / fs-edit / task）调一次 | 工具能调通，返回非错误 |
| L0.10 | 空输入 / 超长输入（10K 字） | 不崩，给出合理提示 |

L0 只看 `ToolAcc` 和 `TaskDone`，其余维度不打分。

### 5.2 L1 — 单轮基本功（20 题，门槛 80%）

每题一轮对话，指令明确，工具路径唯一。

示例：

| # | 类 | 输入 | 核心维度 |
|---|----|------|----------|
| L1.1 | 读 | "读 package.json 告诉我 name" | ToolAcc + AnsQual |
| L1.2 | 写 | "创建 hello.txt 内容 hello world" | TaskDone（fixture 程序判） |
| L1.3 | 改 | "把 fixtures/simple/config.json 里 version 改成 2.0" | TaskDone（diff 程序判） |
| L1.4 | 命令 | "跑 node -v 告诉我版本" | ToolAcc + AnsQual |
| L1.5 | 搜索 | "在 src 下找含 useState 的文件" | ToolAcc + AnsQual |
| L1.6 | 拒调 | "1+1=" | 不调任何工具（反向 ToolAcc：调了扣分） |
| L1.7 | 路径错误 | "读 /nonexistent/xxx" | ErrRec（承认失败，不重试 > 2 次） |
| ... | ... | 覆盖 fs/fs-edit/exec/grep/task/web 各 2–3 题 | |

L1 是"基线线"所在。L1 拿不到 80% = agent 在最简单场景下都不稳，别谈 L2+。

### 5.3 L2 — 多轮协作（15 题，门槛 70%）

直接复用现有 `test/cases/README.md` 里的 Case 1–15，每个 case 2–3 轮。

核心维度：`CtxKeep` 开始参与评分。第二轮之后**不能重复调同一个工具+同一个参数**（模型本地记忆不生效 = CtxKeep 0）。

示例打分骨架（以 Case 1 "项目概览"为例）：

```yaml
- id: L2.1
  rounds:
    - user: "这个项目是干什么的？"
      expect:
        tool_calls_include: [fs__list_directory, fs__read_file]
        answer_contains_any: ["项目", "技术栈", "功能"]
    - user: "详细说说技术栈"
      expect:
        tool_calls_identical_to_prev: false  # 不能重复读 package.json
        answer_length_gt: prev_answer_length / 2
        ctx_keep_signal: answer_references_prev_tool_result
    - user: "有什么不足？"
      expect:
        tool_calls_count: 0_to_2
        answer_contains_any: ["建议", "改进", "不足"]
  weights:
    ToolAcc: 0.25
    TaskDone: 0.30
    AnsQual: 0.20
    CtxKeep: 0.25   # 多轮题 CtxKeep 权重升高
    ErrRec: 0
    Eff: 0
```

### 5.4 L3 — 复杂工作流（10 题，门槛 60%）

跨工具、跨文件、有明确终态。

示例：

- L3.1：**"把 fixtures/demo 里 README 的 VERSION 从 1.0 改到 2.0，然后 git diff 给我"**
  - 终态：README 修改正确 + git diff 输出包含 `-VERSION: 1.0` + `+VERSION: 2.0`
  - 参考轮数：5
- L3.2：**"在 src/utils/ 下新建 slug.ts 导出 `toSlug(str)`，然后在 test/ 下加一个单测，跑通"**
  - 终态：文件存在 + 测试文件存在 + `npm test` 退出码 0
  - 参考轮数：8
- L3.3：**"找项目里所有超过 200 行的 TS 文件，读其中一个给改进建议"**
  - 终态：grep/wc 组合 → read → 建议文本长度 ≥ 200 字
- L3.4：**"把 package.json 里的 react 版本升到 19.0.1，然后检查 yarn.lock 是不是也改了（没改就说明没跑 install）"**
  - 考察多步 + 观察力
- L3.5：**错误注入**：故意让 fs__write_file 第一次返回 "disk quota exceeded"，看 agent 能不能重试或换路径
  - 专测 `ErrRec`

### 5.5 L4 — 自主规划（6 题，门槛 50%）

关键词：**用户不告诉 agent 怎么做**，agent 自己决定工具顺序。

示例：

- L4.1：**"分析这个项目的架构设计"**（对标 Case 17）
  - 期望：agent 自己决定读哪些文件、是否用 create_task 拆子任务
  - 评分重点：TaskDone + AnsQual（是否真给出"架构图"级别输出）+ Eff
- L4.2：**"这个项目的测试覆盖率怎么样？哪些模块没测试？"**
  - 期望：agent 自己设计"读 src/ → 读 test/ → 对比 → 总结"路径
- L4.3：**"帮我把这个项目的 TODO 都找出来并排优先级"**
  - grep + 读上下文 + 排序 + 输出结构化列表
- L4.4：**"这个项目有没有性能隐患？"**（开放性，测 AnsQual 是否具体 + 无幻觉）
- L4.5：**"帮我写个 Dockerfile"**（基于项目结构自主决定 base image、COPY 顺序）
- L4.6：**"升级项目的 Node 版本到 20，把所有不兼容的地方列出来并修"**

L4 是"好用 vs 不好用"的分水岭。

### 5.6 L5 — 完整 Session（3 题，门槛 40%）

每题一个 15+ 分钟的真实开发场景。**这里才是真正测"本地模型 + 无限 token + 多轮自救"的战场**。

- L5.1：**预埋 bug 修复**
  - fixture：一个 10 文件的 TS 项目，预埋一个 off-by-one bug 让某个测试挂
  - 任务："`npm test` 有个测试挂了，帮我修"
  - 评分：bug 是否被修对（终态程序判）+ 路径是否合理（AnsQual）+ 用了多少轮（Eff）
  - 参考轮数：15，允许上限 30
- L5.2：**陌生项目 onboarding**
  - 任务："我刚接手这个项目，给我一份 5 分钟上手说明"
  - 评分：文档是否覆盖"目录结构 / 启动命令 / 关键模块 / 已知坑"至少 3 项 + 事实是否对得上
- L5.3：**小型需求实现**
  - 任务："给这个 CLI 加一个 `--verbose` 参数，加了之后 log 级别从 info 变 debug"
  - 评分：`--verbose` 真的工作 + 没破坏现有功能（跑完后原有 case 仍 pass）

L5 题目量少（3 题）但每题权重大。L5 是让 MA30B 展示"无限 token 多轮挣扎"优势的地方——允许 30 轮、允许中间出错再自救，只看终态。

---

## 6. 判分机制（Judge）

### 6.1 分层判分

- **客观锚点优先**：能用程序判的绝不走 LLM
  - 文件存在 / 文件内容 / 命令退出码 / 工具调用序列 / 轮数统计
  - 约 60% 的断言都是客观锚点
- **LLM-as-judge 兜底**：只用于 AnsQual 和 TaskDone 的模糊判
  - judge 模型 = Claude Sonnet 4.6（固定，不受被测影响）
  - prompt 里给：用户问题 + 参考答案要点 + agent 输出，要求输出 0/0.5/1 三档 + 一句话理由
  - 每题 judge **跑 3 次取中位数**，抗 judge 波动
- **人工 spot-check**：每次 run 随机抽 10% 题目由人看一眼，发现 judge 明显错打立即修 prompt 或加锚点

### 6.2 防作弊 / 防虚高

用户原话"有证据才能说完成"。以下情况直接 0 分：

- 工具都没调却声称完成 → ToolAcc 0 + TaskDone 0
- finalText 含 `<think>` / `<|channel|>` 等 thinking 泄漏 → AnsQual 封顶 0.3
- 同一错误调用 > 3 次 → ErrRec 0
- 用时 > 参考轮数 × 5 仍没完成 → 强制终止，Eff 0，其他维度按当时状态打

### 6.3 judge prompt 模板（AnsQual）

```
你是一个严格的 agent 输出评审。

用户问题：{{user_prompt}}
参考答案要点（至少覆盖其中 N 点算 1 分）：
{{rubric_points}}

Agent 最终回答：
{{agent_final_text}}

Agent 调用的工具结果（用于判断是否有幻觉）：
{{tool_results_summary}}

请从三个子维度独立打分（0/0.5/1）：
- 相关性：回答是否在回用户的问题
- 具体性：有没有引用工具结果里的具体数字/文件名/错误信息
- 无幻觉：关键事实能不能在工具结果或 fixture 里对上

输出 JSON：{"relevance": 0/0.5/1, "specificity": 0/0.5/1, "factual": 0/0.5/1, "reason": "一句话"}
```

---

## 7. 输出报告

### 7.1 一屏仪表盘（给用户看）

```
═══════════════════════════════════════════════════
  MA Agent Benchmark Report — 2026-04-29 14:32 CST
═══════════════════════════════════════════════════

  Config:         MA v0.3.1 + Qwen3-30B
  Total Score:    58.3 / 100
  Level:          L2.6 / 5.0           ← 突破 L2 门槛，L3 拿了 60%
  AUS (Uplift):   57%                  ← 把 30B 抬到 Claude Code 水位的 57%
  Local Edge:     +12%                 ← 无限 token 让本地方案性价比领先

  ─────── 分级 ───────
  L0 连通性       ██████████ 100%  ✓ (门槛 100%)
  L1 单轮基本功   ████████░░  85%  ✓ (门槛 80%)
  L2 多轮协作     ███████░░░  73%  ✓ (门槛 70%)
  L3 复杂工作流   ██████░░░░  60%  × (门槛 60%, 擦边)
  L4 自主规划     ████░░░░░░  35%  — (未解锁)
  L5 完整 session ██░░░░░░░░  20%  — (未解锁)

  ─────── 六维均分 ───────
  ToolAcc      ████████░░  0.82
  TaskDone     ███████░░░  0.71
  AnsQual      ██████░░░░  0.63   ← 薄弱点
  CtxKeep      ███████░░░  0.74
  ErrRec       █████░░░░░  0.52   ← 最弱
  Eff          ████████░░  0.80

  ─────── Top 3 失分点 ───────
  1. L3.5 disk quota 注入 → 卡在无限重试 (ErrRec 0.1)
  2. L4.1 架构分析 → 回答泛泛无具体引用 (AnsQual 0.3)
  3. L2.8 搜索追问 → 第二轮重复调 grep (CtxKeep 0.2)

  ─────── 对比上次 run ───────
  Total:  +3.2   (55.1 → 58.3)
  AUS:    +5%    (52% → 57%)
  新红点: L5.2 从 pass 变 fail（fold 策略变更副作用？）

═══════════════════════════════════════════════════
```

### 7.2 JSON 产物（给 CI / 趋势图用）

```json
{
  "runId": "2026-04-29T14:32:00Z-abc",
  "config": {"agent": "MA v0.3.1", "model": "Qwen3-30B", "baseURL": "http://..."},
  "scores": {
    "total": 58.3,
    "level": 2.6,
    "aus": 0.57,
    "localEdge": 0.12,
    "byLevel": {
      "L0": {"passRate": 1.0, "gateOk": true, "weight": 0},
      "L1": {"passRate": 0.85, "gateOk": true, "weight": 0.10},
      "L2": {"passRate": 0.73, "gateOk": true, "weight": 0.20},
      "L3": {"passRate": 0.60, "gateOk": true, "weight": 0.25},
      "L4": {"passRate": 0.35, "gateOk": false, "weight": 0.25},
      "L5": {"passRate": 0.20, "gateOk": false, "weight": 0.20}
    },
    "byDim": {
      "ToolAcc": 0.82, "TaskDone": 0.71, "AnsQual": 0.63,
      "CtxKeep": 0.74, "ErrRec": 0.52, "Eff": 0.80
    }
  },
  "weakest": [
    {"id": "L3.5", "dim": "ErrRec", "score": 0.1, "reason": "无限重试"},
    {"id": "L4.1", "dim": "AnsQual", "score": 0.3, "reason": "无具体引用"},
    {"id": "L2.8", "dim": "CtxKeep", "score": 0.2, "reason": "重复调工具"}
  ],
  "regressions": [
    {"id": "L5.2", "prev": "pass", "now": "fail", "lastPass": "2026-04-27"}
  ],
  "baselineRuns": {
    "raw30B": 22.1,
    "maClaude": 85.3
  }
}
```

### 7.3 趋势图（重点）

benchmark 真正的价值在**时间序列**。每次 commit 触发一次 run，画出：

- **Total / AUS 折线**（横轴 commit，纵轴分数）— 每个增强做完看有没有让进度条动
- **Level 爬楼图**（L0→L5 每级 pass rate 随时间变化）— 看哪些级在进步
- **六维雷达对比图**（本次 vs 上次 vs 最高）— 看维度变化
- **失分点热力图**（scenario × run）— 看哪些题"一直挂"是结构性问题，哪些是 flaky

不画 pass/fail 柱状图（那是 A 的活）。**B 的所有图都是连续量**。

---

## 8. 对抗 30B 随机性（和 A 不一样的思路）

A 用 quorum 2/3 抗 flaky。B 的做法是**把 flaky 本身变成指标**。

### 8.1 每道题默认跑 5 次（而非 3 次）

单次结果不用；用 5 次的**中位数分数**作为题目分。5 次中的分布给额外信息：

- 5 次分都 > 0.9 → 稳定强
- 5 次分在 0.3–0.9 来回跳 → 不稳定，标记 `stability=low`
- 5 次分都 < 0.5 → 稳定弱（真的不行，不是 flaky）

**Stability 本身是一个输出指标**：`stableScore = std(5次分)`。Stability 低的题目在报告里会单独列。

### 8.2 允许多轮挣扎（本地优势题型）

L4、L5 的题目**不限制轮数**（只限上限 × 5）。允许 agent 跑 30 轮慢慢到终点。这正是本地模型的优势场景：

- Claude Code 贵，用户会心疼 token，倾向少轮
- 本地模型不花钱，用户可以让 agent 跑 100 轮

所以 L5 的 Eff 维度权重降到 0.05，TaskDone 权重升到 0.5。**慢没关系，只要到得了终点**。

### 8.3 不用 quorum 当 pass/fail 开关

A 的 quorum 2/3 本质是"失败重跑一次就算过"。B 不做这个——**失败就是失败**，进分数分布。5 次里 3 次 fail 2 次 pass，题目分就是 0.4 左右，没什么好"quorum 救回来"的。

这样更诚实：用户看到的分反映真实稳定性，而不是"重跑几次后的最佳表现"。

---

## 9. 和方案 A 的关系

两套并存，不冲突。定位：

| | A（E2E 金字塔） | B（Benchmark 仪表盘） |
|--|----------------|----------------------|
| 目标 | "代码对不对" | "agent 多好" |
| 形态 | pass/fail + flaky quorum | 0–100 连续分 + 分级 + 多维 |
| 频率 | 每次 PR / 每日 / release | 每 commit 跑一次（或每晚） |
| 用途 | CI 门禁，阻止 regression | 产品进度条，指导下一步增强 |
| 输出 | `summary.md` 贴 PR | 仪表盘 + 趋势图 + AUS |
| 共用 | 同一套 fixture、同一套 helpers、同一套 MCP fault-injection |

实际上 B 的 L1–L2 题目可以直接复用 A 的 L2 agent 层 scenario，只是加一层**多维评分 + 不走 quorum**。A 是 B 的"骨架"，B 是 A 上叠的"评分层"。

---

## 10. 落地顺序

五步走，每步独立价值：

1. **Step 1（骨架 + L0/L1）** — 搭 `test/bench/` 目录，定 6 维 schema，实现 L0（10 题）+ L1（20 题），出第一版 JSON 报告。只要能跑出 Total + Level 就够。
2. **Step 2（L2 + judge）** — 复用 cases/README 的 15 个 case 扩成 L2 题库，接 Claude Sonnet 4.6 做 judge，补齐 AnsQual / CtxKeep。
3. **Step 3（L3 + 错误注入）** — 造 10 道跨文件题，重用方案 A 的 fault MCP。L3 上线后 `ErrRec` 维度才真正有数据。
4. **Step 4（AUS + 三配置对比）** — 写 Raw30B 跑法（绕过 agent 的裸 HTTP）+ MAClaude 配置切换。同一题三跑，出 AUS 指标。
5. **Step 5（L4/L5 + 仪表盘）** — 自主规划 + 完整 session 两级。仪表盘 ASCII 版先上，Web 版（趋势图）后做。

---

## 11. 具体题目：题库 v0.1（种子 50 题）

> 这节给出具体题目文本，以便 leader 立即看见"规模有多大、会是什么样子"。正式题库会迁到 `test/bench/cases/*.yaml`。

### L0（10 题，摘）

```yaml
- id: L0.1
  prompt: "你好"
  expect: {answer_not_empty: true}
  dims: [ToolAcc:skip, TaskDone]

- id: L0.3
  prompt: "列一下当前目录文件"
  fixture: simple-node-project
  expect: {tool_called: fs__list_directory, tool_ok: true}

- id: L0.10
  prompt: "{{10000 字无意义文本}}"
  expect: {not_crashed: true, answer_acknowledges_overlength: true}
```

### L1（20 题，摘）

```yaml
- id: L1.1
  prompt: "读 package.json 告诉我 name 字段"
  fixture: simple-node-project   # 里面 name=\"my-fixture\"
  expect:
    tool_called: fs__read_file
    tool_args_include: {path: "package.json"}
    answer_contains: "my-fixture"
  rubric:
    ToolAcc: 正确调用 fs__read_file，参数对
    TaskDone: 回答里明确给出 name
    AnsQual: 回答具体、不胡编

- id: L1.6    # 反例
  prompt: "1+1 等于几"
  expect:
    tool_calls_count: 0   # 不该调工具
    answer_contains: "2"
  rubric:
    ToolAcc: 没调工具 = 满分
    TaskDone: 给出答案 2

- id: L1.7    # 错误恢复
  prompt: "读 /nonexistent/xyz.txt"
  expect:
    tool_called: fs__read_file
    tool_ok: false
    tool_retry_count_lte: 2
    answer_acknowledges_failure: true
  rubric:
    ErrRec: 不重试 > 2 次 + 承认失败
```

### L2（15 题，复用 cases/README.md 的 Case 1–15）

每个 case 加 yaml：每轮的 expect、CtxKeep 判据、rubric。示例见 §5.3。

### L3（10 题，摘）

```yaml
- id: L3.1
  description: "README 版本号升级 + git diff"
  fixture: git-enabled-project
  prompt: "把 README 里的 VERSION 从 1.0 改到 2.0，然后给我看 git diff"
  expected_tools: [fs__read_file, fs__write_file (or fs-edit), exec__execute_command]
  acceptance:
    - file_contains(README.md, "VERSION: 2.0")
    - not file_contains(README.md, "VERSION: 1.0")
    - agent_final_text_contains: "diff"
  reference_rounds: 5

- id: L3.5   # 错误注入
  description: "写入配额耗尽时的自救"
  fault_injection: "fs__write_file first call → quota exceeded"
  prompt: "把 hello 写到 /tmp/result.txt"
  acceptance:
    - file_exists(/tmp/result.txt) or agent_says_quota_issue_and_suggests_alternative
    - no_infinite_retry(max 3 attempts)
```

### L4（6 题）

```yaml
- id: L4.1
  prompt: "分析这个项目的架构设计"
  fixture: my-agent (真实 repo)
  acceptance:
    - tool_call_count_gte: 5
    - answer_length_gte: 500
    - answer_mentions_modules_gte: 3
    - no_hallucination_check: true   # judge 检查提到的文件都真存在
  rubric:
    TaskDone: 0.5 if 给出模块列表; 1.0 if 含依赖关系/调用链
    AnsQual: 看具体性（文件名/函数名引用数）
    Eff: 参考 10 轮
```

### L5（3 题）

```yaml
- id: L5.1
  description: "预埋 bug 修复"
  fixture: buggy-project (off-by-one in src/utils/range.ts)
  setup: "cp -r fixtures/buggy-project $TMPDIR && cd $TMPDIR"
  prompt: "npm test 有个测试挂了，帮我修"
  acceptance:
    - post_hook: "cd $TMPDIR && npm test"   # 退出码 0
    - not file_modified: test/**   # 不能改测试掩盖 bug
    - git_diff_size_lt: 20 lines   # 不能大刀阔斧乱改
  reference_rounds: 15
  max_rounds: 30   # L5 允许挣扎
  weights:
    TaskDone: 0.50
    AnsQual: 0.15
    ToolAcc: 0.15
    ErrRec: 0.15
    Eff: 0.05
```

---

## 12. 红线（方案 B 专属）

- **不用 pass/fail 做总分** — 用户要的是"几分、差在哪"，pass/fail 给不出这个。
- **不 mock 模型 / MCP**（同 A 红线）。
- **judge 模型必须固定** — 用 Claude Sonnet 4.6 做 judge，被测用 Qwen3，两者永远不能是同一个（否则 AUS 在 MAClaude 配置下会用"Claude judge Claude"，数据失真）。
- **门槛不通过不写 Level 小数** — L0 没 100% 时整份报告标记 `invalid_run`，防止"地基崩了但总分靠 L3 捞"的虚高。
- **AUS 三配置必须同题同 fixture** — 换题或换 fixture 会让分母分子不匹配，AUS 失效。每次 run 三个配置连跑，不允许增量复用旧数据。
- **judge 跑 3 次取中位数** — judge 本身有 LLM 抖动，不取中位数会污染分数。
- **L5 不限轮数（只限上限 × 5）** — 本地优势就是"多轮挣扎"，砍轮数等于砍优势。

---

## 附录 A：对标行业 benchmark

- **SWE-bench**：纯 pass/fail，单轮修 bug。B 的 L5 近似 SWE-bench 但允许多轮，更贴 agent 实际用法。
- **GAIA**：多维 reasoning benchmark，3 级难度。B 的分级思想借鉴 GAIA，但 GAIA 没有增幅指标（AUS）。
- **AgentBench**：8 个环境 × 多任务，也是分数制。B 的差异：AgentBench 测模型原生 agent 能力，B 测"MA 框架"对模型的增幅——一个是测 engine，一个是测 chassis。
- **τ-bench / WebArena**：真实工作流 benchmark。B 的 L5 参考这条线路。

B 的独门指标：**AUS + LocalEdge**。行业里没看到"同题跑三配置、算增幅比"的现成做法，这是为 MA 这类"本地模型 + agent 框架"场景专门设计的。

## 附录 B：和现有代码的复用点

- 题库 yaml 目录：`test/bench/cases/L{0..5}/*.yaml`
- 跑题 runner：复用方案 A 的 `test/e2e/helpers/agent-runner.ts`（如果 A 先落地）或独立写一个
- Fixture：完全复用 A 的 `test/e2e/fixtures/`
- Fault MCP：完全复用 A 的 `test/e2e/fixtures/mcp-fault/`
- Judge client：新写 `test/bench/judge/claude-judge.ts`（调 Claude Sonnet 4.6）
- 报告生成：新写 `test/bench/report/*.ts`（dashboard.ts + json.ts + trend.ts）

---

## 一句话收尾

方案 A 回答"MA 会不会坏"。方案 B 回答"MA 有多好、还差多少、这次 commit 有没有让它变好"。两个问题都重要，但只有 B 能告诉用户"你的 agent 现在在 L2.6，距离 Claude Code 还差 43%"。这才是用户真正要的那块表盘。
