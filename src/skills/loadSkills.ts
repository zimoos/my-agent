import * as fs from 'node:fs';
import * as path from 'node:path';
import yaml from 'js-yaml';
import type { Command } from '../cli/utils/commands.js';

export interface SkillFrontmatter {
  name: string;
  description: string;
  arguments?: Array<{
    name: string;
    description: string;
    required?: boolean;
    type?: 'string' | 'boolean';
    default?: string | boolean;
  }>;
}

export interface ParsedSkill {
  name: string;
  description: string;
  content: string;
  frontmatter: SkillFrontmatter;
  filePath: string;
}

// Runtime resource loading reuses parsing/rendering without the legacy auto-create/discovery path.
export { parseFrontmatter as parseSkillDocument, substituteTemplate as renderSkillTemplate };

function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
  const match = content.match(frontmatterRegex);

  if (!match) {
    throw new Error('Skill file must have YAML frontmatter');
  }

  try {
    const frontmatter = yaml.load(match[1]) as Partial<SkillFrontmatter> | null;
    if (!frontmatter || typeof frontmatter !== 'object') {
      throw new Error('frontmatter must be an object');
    }
    if (typeof frontmatter.name !== 'string' || frontmatter.name.trim().length === 0) {
      throw new Error('frontmatter.name is required');
    }
    if (typeof frontmatter.description !== 'string' || frontmatter.description.trim().length === 0) {
      throw new Error('frontmatter.description is required');
    }
    if (frontmatter.arguments !== undefined && !Array.isArray(frontmatter.arguments)) {
      throw new Error('frontmatter.arguments must be an array');
    }

    return {
      frontmatter: frontmatter as SkillFrontmatter,
      body: match[2].trim()
    };
  } catch (err) {
    throw new Error(`Invalid frontmatter: ${err}`);
  }
}

function substituteTemplate(content: string, args: Record<string, any>): string {
  return content
    .replace(/\{\{(\w+)\}\}/g, (match, key) => args[key]?.toString() || match)
    .replace(/\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (match, key, content) => {
      return args[key] ? content : '';
    })
    .replace(/\{\{#unless (\w+)\}\}([\s\S]*?)\{\{\/unless\}\}/g, (match, key, content) => {
      return !args[key] ? content : '';
    });
}

export async function createDefaultSkills(skillsDir: string): Promise<void> {
  // 创建示例技能文件
  const deploySkill = `---
name: deploy
description: 部署项目到生产环境
arguments:
  - name: environment
    description: 部署环境 (dev/staging/prod)
    required: false
    default: staging
---

请帮我部署项目到 {{environment}} 环境。

执行步骤：
1. 检查当前分支状态
2. 运行测试
3. 构建项目
4. 部署到 {{environment}} 环境
5. 验证部署结果`;

  const gitStatusSkill = `---
name: git-status
description: 检查 Git 仓库状态
---

检查当前 Git 仓库的状态，包括分支信息、修改的文件、提交历史等。

请显示：
1. 当前分支和最新提交信息
2. 工作区状态（已修改、已暂存、未跟踪的文件）
3. 是否有需要提交的更改
4. 远程分支同步状态`;

  const helpSkill = `---
name: help
description: 显示帮助信息
---

## 内置指令
- \`/quit\` \`/exit\` - 退出程序
- \`/tools\` - 列出所有可用工具
- \`/stack\` - 显示任务栈状态
- \`/abort\` - 清空待办任务
- \`/archive <id>\` - 查看任务归档
- \`/clear\` - 清空对话历史
- \`/models\` - 列出可用模型
- \`/model <name>\` - 切换模型
- \`/skills\` - 列出所有自定义技能

## 自定义技能
使用 \`/skills\` 查看当前项目中的自定义技能。

## 使用方法
- 输入指令名称执行对应功能
- 技能支持参数传递，格式：\`/skillname param1=value1\`
- 布尔参数使用 \`true\`/\`false\``;

  // 写入示例技能文件
  fs.writeFileSync(path.join(skillsDir, 'deploy.md'), deploySkill);
  fs.writeFileSync(path.join(skillsDir, 'git-status.md'), gitStatusSkill);
  fs.writeFileSync(path.join(skillsDir, 'help.md'), helpSkill);

  // 创建 README
  const readme = `# .ma 技能目录

这是 my-agent 的自定义技能目录。

## 使用方法

1. 在此目录创建 \`.md\` 技能文件
2. 使用 YAML 前置元数据定义技能信息
3. 在 agent 中输入 \`/skill-name\` 使用技能

## 示例

\`\`\`bash
/deploy environment=production
/git-status
\`\`\`

更多文档请参考项目根目录的 README.md`;

  fs.writeFileSync(path.join(skillsDir, '..', 'README.md'), readme);
}

export async function loadSkillsFromDirectory(skillsDir: string): Promise<ParsedSkill[]> {
  if (!fs.existsSync(skillsDir)) {
    // 自动创建目录和示例技能
    fs.mkdirSync(skillsDir, { recursive: true });
    await createDefaultSkills(skillsDir);
    console.log(`📁 Created .ma/skills/ directory with example skills`);
  }

  const skills: ParsedSkill[] = [];

  function scanDirectory(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        scanDirectory(fullPath);
      } else if (entry.name.endsWith('.md')) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const { frontmatter, body } = parseFrontmatter(content);

          skills.push({
            name: frontmatter.name,
            description: frontmatter.description,
            content: body,
            frontmatter,
            filePath: fullPath
          });
        } catch (err) {
          console.warn(`Failed to load skill ${fullPath}: ${err}`);
        }
      }
    }
  }

  scanDirectory(skillsDir);
  return skills;
}

export function createSkillCommand(skill: ParsedSkill): Command {
  return {
    description: skill.description,
    suggest: true,
    handler: async (args: string) => {
      try {
        // Parse arguments (simple key=value format)
        const parsedArgs: Record<string, any> = {};
        if (args.trim()) {
          const argPairs = args.split(/\s+/);
          for (const pair of argPairs) {
            const [key, value] = pair.split('=');
            if (key && value) {
              // Handle boolean values
              if (value === 'true') parsedArgs[key] = true;
              else if (value === 'false') parsedArgs[key] = false;
              else parsedArgs[key] = value;
            }
          }
        }

        // Apply default values
        if (skill.frontmatter.arguments) {
          for (const arg of skill.frontmatter.arguments) {
            if (arg.default !== undefined && parsedArgs[arg.name] === undefined) {
              parsedArgs[arg.name] = arg.default;
            }
          }
        }

        // Check required arguments
        if (skill.frontmatter.arguments) {
          for (const arg of skill.frontmatter.arguments) {
            if (arg.required && parsedArgs[arg.name] === undefined) {
              return `Error: Required argument '${arg.name}' is missing\n\nUsage: /${skill.name} ${arg.name}=<value>`;
            }
          }
        }

        // Substitute template variables
        const processedContent = substituteTemplate(skill.content, parsedArgs);

        return processedContent;
      } catch (err) {
        return `Error executing skill: ${err}`;
      }
    }
  };
}
