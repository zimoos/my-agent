# MA E2E 对话测试 Case 库

每套 case 是一个连续多轮对话流程。所有 case 必须在真实模型上通过才能交付。

## 验收标准
- 每轮必须有实质性回答（不是空输出）
- 不能出现 500 错误
- 工具调用成功率 > 80%
- 连续对话不丢上下文

---

## Case 1: 项目概览
```
用户: 这个项目是干什么的？
期望: 调 list_directory + read_file，输出项目名称、技术栈、功能
用户: 详细说说技术栈
期望: 基于上一轮信息展开，不重复调工具
用户: 有什么不足？
期望: 给出改进建议
```

## Case 2: 项目评价
```
用户: 这个项目怎么样？
期望: 调工具收集信息后给出评价
用户: 给个评分
期望: 基于上文给分，不重新调工具
```

## Case 3: 代码阅读
```
用户: 看下 src 目录结构
期望: 调 list_directory src/
用户: 读下入口文件
期望: 调 read_file 读 index/main/app 文件
用户: 这个文件做了什么？
期望: 基于已读内容分析，不重复读
```

## Case 4: 文件修改
```
用户: 帮我在 README 末尾加一行 "Built with MA"
期望: 先 read_file README，再 file_edit 追加
用户: 改好了？确认下
期望: 再次 read_file 验证
```

## Case 5: 命令执行
```
用户: 跑一下测试
期望: 调 execute_command npm test
用户: 有几个测试通过了？
期望: 基于上一轮输出回答，不重跑
```

## Case 6: Git 状态
```
用户: 当前分支是什么？
期望: 调 execute_command git branch --show-current
用户: 有没有未提交的改动？
期望: 调 execute_command git status
用户: 最近几次提交是什么？
期望: 调 execute_command git log --oneline -5
```

## Case 7: 依赖分析
```
用户: 这个项目用了哪些依赖？
期望: 读 package.json 列出 dependencies
用户: 有没有过时的依赖？
期望: 分析版本号或调 execute_command npm outdated
```

## Case 8: 搜索代码
```
用户: 找一下项目里哪里用了 useState
期望: 调 grep 搜索
用户: 第一个结果在哪个文件？
期望: 基于上一轮结果回答
```

## Case 9: 创建文件
```
用户: 创建一个 hello.ts 文件，内容是 console.log('hello')
期望: 调 write_file 创建
用户: 确认下文件创建成功了
期望: 调 read_file 或 list_directory 验证
```

## Case 10: 多步任务
```
用户: 帮我看下这个项目的测试覆盖率怎么样
期望: 先 list_directory test/，再读几个测试文件，最后总结
用户: 哪些模块没有测试？
期望: 对比 src/ 和 test/ 找缺失
```

## Case 11: 错误恢复
```
用户: 读一下 /nonexistent/file.txt
期望: 报文件不存在的友好错误
用户: 那读 package.json 吧
期望: 正常读取，不受上一轮错误影响
```

## Case 12: 纯聊天
```
用户: 你好
期望: 简单问候，不调工具
用户: 你能做什么？
期望: 列出能力，不调工具
用户: 1+1等于几？
期望: 直接回答，不调工具
```

## Case 13: 项目初始化建议
```
用户: 我想用 React + Vite 新建一个项目，你觉得需要哪些配置？
期望: 不调工具，直接给建议
用户: 帮我创建 vite.config.ts
期望: 调 write_file 创建配置文件
```

## Case 14: 代码审查
```
用户: 看下 src/ 下最大的文件是哪个
期望: 调 list_directory + 可能调 execute_command wc -l
用户: 读一下那个文件，有什么问题？
期望: 读文件后给出代码质量意见
```

## Case 15: 环境信息
```
用户: 当前在哪个目录？
期望: 直接回答 cwd（从 system prompt 知道）
用户: Node 版本是多少？
期望: 调 execute_command node -v
用户: npm 版本呢？
期望: 调 execute_command npm -v
```

## Case 16: 网络查询
```
用户: 搜一下 React 19 有什么新特性
期望: 调 web_search
用户: 打开第一个链接看看
期望: 调 web_fetch
```

## Case 17: 复杂分析
```
用户: 分析下这个项目的架构设计
期望: 多轮工具调用（list_directory 多层 + read 关键文件），最后给架构图
用户: 有什么改进建议？
期望: 基于上文分析给建议
```

## Case 18: 图片分析（需要多模态模型）
```
用户: [Ctrl+V 粘贴截图] 这个界面有什么问题？
期望: 分析图片内容给意见
```

## Case 19: 会话管理
```
用户: /tools
期望: 列出所有工具
用户: /stack
期望: 显示 task 栈
用户: /clear
期望: 清空对话
用户: 你好
期望: 正常回答（上下文已清空）
```

## Case 20: 持续工作流
```
用户: 帮我做三件事：1. 看项目结构 2. 读 README 3. 总结
期望: 用 task 栈拆解，依次执行
用户: 第二步的结果是什么？
期望: 回忆之前的 task 结果
用户: 继续深入看 src/
期望: 基于之前上下文继续
```
