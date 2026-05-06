# Claude Code CLI Baseline 对照（部分结果）

> 状态：**中途下线**
> 原因：团队决定先聚焦 MA 自身提分，暂不跑完整 baseline
> 日期：2026-04-29
> 执行者：claude-baseline（Claude Code 2.1.123）

## 已完成的题目（11/约15）

环境：`/tmp/claude-bench-fixture`（从 `test/e2e/fixtures/simple-node-project` 复制）
命令模板：`claude -p --permission-mode acceptEdits "<prompt>"`

注意：首次发现 `claude -p` 默认是 ask 权限，写文件会被拒。加 `--permission-mode acceptEdits` 后才能执行编辑类操作。`--no-input` 不是有效参数（claude CLI 默认 stdin 关闭即退出）。

### L0 连通性（3/3 通过）

| # | Prompt | 调工具？ | 输出 | 判定 |
|---|--------|---------|------|------|
| L0-01 | 你好 | 否 | "你好！有什么可以帮你的？" | PASS |
| L0-02 | 1+1等于几 | 否 | "2" | PASS |
| L0-03 | 列出当前目录文件 | 是（ls） | 正确列出 README.md / package.json / src/ | PASS |

### L1 单轮（6/6 通过）

| # | Prompt | 调工具？ | 输出 | 验证 | 判定 |
|---|--------|---------|------|------|------|
| L1-01 | 读 package.json 告诉我 name 字段的值 | 是 | `"test-project"` | 与文件一致 | PASS |
| L1-02 | 创建 hello.txt 写 hello world | 是 | 已创建 | `cat hello.txt` = "hello world" | PASS |
| L1-03 | 列出 src 目录下有什么文件 | 是 | index.js, utils.js | 与 ls 一致 | PASS |
| L1-04 | 运行 node -v 告诉我版本 | 是 | v20.19.4 | 与实际一致 | PASS |
| L1-05 | 搜索 useState | 是 | index.js, utils.js | grep 验证一致 | PASS |
| L1-06 | 1+1等于几（不应调工具） | 否 | "2" | 未触发工具 | PASS |

### L2 多步/编辑（2/4 完成，下线前中止）

| # | Prompt | 调工具？ | 输出 | 验证 | 判定 |
|---|--------|---------|------|------|------|
| L2-01 | 把 README 版本号 1.0.0 改成 2.0.0 | 是 | "版本号已更新为 2.0.0" | `cat README.md` = "VERSION: 2.0.0" | PASS |
| L2-02 | 读 package.json 看项目名 + node -v | 是（两步） | "test-project" + "v20.19.4" | 均正确 | PASS |
| L2-03 | 读 /nonexistent/abc.txt（错误恢复） | 未执行 | - | - | 未跑 |
| L2-04 | 运行 nonexistent-command-xyz（命令失败） | 未执行 | - | - | 未跑 |

## 已完成部分的通过率

- L0：100%（3/3）
- L1：100%（6/6）
- L2：100%（2/2，仅 2 道，样本不足）

## 和 MA agent 对照（部分）

| 类别 | MA agent（30B 本地） | Claude Code | 差距 |
|------|----------------------|-------------|------|
| L0 | 100%（全题） | 100%（3/3 代表） | 持平 |
| L1 | 90%（28/30） | 100%（6/6 代表） | Claude 略高 |
| L2 | 75%（23/30） | 100%（2/2 代表，样本不足） | 未跑完无法下结论 |

注意：Claude 这边只跑了代表题不是全量 70 题，**绝对通过率不可直接与 MA 全量对照比较**。趋势上 Claude 在 L0/L1 代表题上稳定无失手，L2 因样本只有 2 道无法判断差距。

## 观测到的 Claude 表现特征

1. **响应时间**：单题约 8-24 秒（比本地 30B 模型慢，受网络 RTT 影响）
2. **工具调用**：工具选择准确，未见无关工具调用
3. **中文输出稳定**：输出简洁，无冗余思考链
4. **权限模式**：默认 ask，非交互场景必须显式加 `--permission-mode acceptEdits`
5. **L1-06 正确判断**：面对 "1+1" 没调工具，与 MA agent 测试目标一致

## 若要续跑剩余题目

未跑的 4 道：
- L2-03 错误恢复（读不存在文件）
- L2-04 命令失败（执行不存在命令）
- L2-05 / L2-06 预留

继续方式：
```bash
cd /tmp/claude-bench-fixture
claude -p --permission-mode acceptEdits "读一下 /nonexistent/abc.txt" 2>&1
claude -p --permission-mode acceptEdits "运行 nonexistent-command-xyz" 2>&1
```

每题 fixture 重置：
```bash
rm -rf /tmp/claude-bench-fixture && mkdir -p /tmp/claude-bench-fixture && \
  cp -r /Users/zhuqingyu/project/my-agent/test/e2e/fixtures/simple-node-project/* /tmp/claude-bench-fixture/
```

## 结论（基于已跑部分）

Claude Code 在 L0/L1 代表题上 **零失手**，与 MA agent L0 的 100% 持平、在 L1 的 90% 上无明显错例。L2 样本太少（2 道）不足以得出差距结论。如果需要完整 baseline 数据，需跑完剩余 L2 题并补 L3 复杂任务样本。
