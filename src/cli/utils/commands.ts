import type { Agent, AgentConfig, McpConnection } from '../../mcp/types.js';
import * as path from 'node:path';
import { loadSkillsFromDirectory, createSkillCommand } from '../../skills/loadSkills.js';
import {
  listModelChoices,
  type ModelChoice,
} from './modelProfiles.js';

interface CommandContext {
  agent: Agent;
  connections: McpConnection[];
  config: AgentConfig;
  exit: () => void;
  setModel?: (model: string) => void;
  openModelPicker?: () => Promise<void> | void;
  switchModelChoice?: (choice: ModelChoice) => void;
  revertLastTurn?: () => boolean;
}

export interface Command {
  description: string;
  suggest?: boolean;
  handler: (args: string, ctx: CommandContext) => Promise<string | null> | string | null;
}

const commands = new Map<string, Command>();
let skillsLoaded = false;

// Load skills from .ma/skills directory
async function loadSkills() {
  if (skillsLoaded) return;

  const skillsDir = path.join(process.cwd(), '.ma', 'skills');
  try {
    const skills = await loadSkillsFromDirectory(skillsDir);
    for (const skill of skills) {
      const command = createSkillCommand(skill);
      const name = `/${skill.name}`;
      if (commands.has(name)) continue;
      commands.set(name, command);
    }
    skillsLoaded = true;
  } catch (err) {
    console.warn(`Failed to load skills: ${err}`);
  }
}

commands.set('/quit', {
  description: 'Exit',
  handler: (_, ctx) => { ctx.exit(); return null; },
});

commands.set('/exit', {
  description: 'Exit',
  suggest: true,
  handler: (_, ctx) => { ctx.exit(); return null; },
});

commands.set('/tools', {
  description: 'List tools',
  handler: (_, ctx) => {
    return ctx.connections
      .map(c => `${c.name} (${c.tools.length} tools)\n${c.tools.map(t => `  - ${t.name}${t.description ? ': ' + t.description : ''}`).join('\n')}`)
      .join('\n\n');
  },
});

commands.set('/stack', {
  description: 'Show task stack',
  handler: (_, ctx) => {
    const stack = ctx.agent.getTaskStack();
    const cur = stack.current();
    const pending = stack.pending();
    const history = stack.history(5);
    if (!cur && pending.length === 0 && history.length === 0) return 'Task stack is empty';
    let out = '';
    if (cur) out += `current: ${cur.id} ${cur.prompt}\n`;
    if (pending.length > 0) out += `pending (${pending.length}):\n${pending.reverse().map(t => `  ${t.id} ${t.prompt}`).join('\n')}\n`;
    if (history.length > 0) out += `completed:\n${history.reverse().map(t => `  ${t.id} ${t.prompt}`).join('\n')}`;
    return out.trim();
  },
});

commands.set('/abort', {
  description: 'Clear pending tasks',
  handler: (_, ctx) => { const n = ctx.agent.abortAll(); return `Aborted ${n} pending tasks`; },
});

commands.set('/archive', {
  description: 'Show task archive',
  handler: (args, ctx) => {
    const id = args.trim();
    if (!id) return 'usage: /archive <id>';
    const archive = ctx.agent.getArchive(id);
    if (!archive) return `No archive for task ${id}`;
    return JSON.stringify(archive, null, 2);
  },
});

commands.set('/context', {
  description: 'Inspect/search/recall context index (debug/compat)',
  handler: (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) return ctx.agent.inspectContext();

    if (trimmed === 'active') {
      const items = ctx.agent.activeContext();
      if (items.length === 0) return 'Context sidecar is empty';
      return items
        .map((item) => {
          const text = (item.content || item.reason || '').replace(/\s+/g, ' ').slice(0, 200);
          return `i=${item.i} [${item.role}/${item.mode}]${text ? ` ${text}` : ''}`;
        })
        .join('\n');
    }

    if (trimmed === 'pool') {
      const results = ctx.agent.poolContext(20);
      if (results.length === 0) return 'Context pool is empty';
      return results
        .map((entry, idx) => {
          const text = (entry.summary || entry.text).replace(/\s+/g, ' ').slice(0, 240);
          const label = typeof entry.i === 'number' ? `i=${entry.i}` : entry.id;
          return `${idx + 1}. ${label} [${entry.role}] ${text}`;
        })
        .join('\n');
    }

    if (trimmed === 'clear') {
      return ctx.agent.clearActiveContext();
    }

    const dropMatch = trimmed.match(/^drop\s+(\d+)$/);
    if (dropMatch) {
      return ctx.agent.dropContext(Number(dropMatch[1]));
    }

    const searchMatch = trimmed.match(/^search\s+(.+)$/);
    if (searchMatch) {
      const query = searchMatch[1].trim();
      const results = ctx.agent.searchContext(query);
      if (results.length === 0) return `No context results for: ${query}`;
      return results
        .map((entry, idx) => {
          const text = (entry.summary || entry.text).replace(/\s+/g, ' ').slice(0, 240);
          const label = typeof entry.i === 'number' ? `i=${entry.i}` : entry.id;
          return `${idx + 1}. ${label} [${entry.role}] ${text}`;
        })
        .join('\n');
    }

    const recallMatch = trimmed.match(/^recall\s+(\S+)/);
    if (recallMatch) {
      return ctx.agent.recallContext(recallMatch[1]);
    }

    const pinMatch = trimmed.match(/^pin\s+(.+)$/);
    if (pinMatch) {
      return ctx.agent.pinContext(pinMatch[1]);
    }

    return 'usage: /context | /context active | /context pool | /context search <q> | /context recall <id> | /context pin <text> | /context drop <i> | /context clear';
  },
});

commands.set('/clear', {
  description: 'Clear conversation',
  suggest: true,
  handler: (_, ctx) => { ctx.agent.reset(); return '[cleared]'; },
});

commands.set('/help', {
  description: 'Show commands',
  suggest: true,
  handler: async () => {
    return Array.from(await getSuggestedCommands())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, command]) => `${name}  ${command.description}`)
      .join('\n');
  },
});

commands.set('/revert', {
  description: 'Revert last visible conversation turn',
  handler: (_, ctx) => {
    const reverted = ctx.revertLastTurn?.() ?? false;
    return reverted ? '[已回退上一轮对话，文件未回退]' : '[没有可回退的对话]';
  },
});

commands.set('/undo', {
  description: 'Alias for /revert',
  handler: (_, ctx) => {
    const reverted = ctx.revertLastTurn?.() ?? false;
    return reverted ? '[已回退上一轮对话，文件未回退]' : '[没有可回退的对话]';
  },
});

commands.set('/models', {
  description: 'List available models',
  handler: async (_, ctx) => {
    try {
      const choices = await listModelChoices(ctx.config);
      return choices
        .map((m) => `${m.current ? '*' : ' '} ${m.id}${m.source === 'cache' ? ' (cache)' : ''}`)
        .join('\n');
    } catch (err) {
      return `Failed to fetch models: ${(err as Error).message}`;
    }
  },
});

commands.set('/model', {
  description: 'Open model switcher or use /model list|use <profile>',
  suggest: true,
  handler: async (args, ctx) => {
    const trimmed = args.trim();
    if (!trimmed) {
      await ctx.openModelPicker?.();
      return ctx.openModelPicker
        ? null
        : `Current model: ${ctx.config.model.model}\nUsage: /model list | /model use <profile>`;
    }

    if (trimmed === 'list') {
      try {
        const choices = await listModelChoices(ctx.config);
        return choices
          .map((m) => `${m.current ? '*' : ' '} ${m.id}${m.source === 'cache' ? ' (cache)' : ''}`)
          .join('\n');
      } catch (err) {
        return `Failed to fetch models: ${(err as Error).message}`;
      }
    }

    const useMatch = trimmed.match(/^use\s+(.+)$/);
    if (useMatch) {
      const id = useMatch[1].trim();
      const choices = await listModelChoices(ctx.config);
      const choice = choices.find((m) => m.id === id || m.label === id || m.model === id);
      if (!choice) return `Model profile not found: ${id}\nUse /model list to see available models.`;
      ctx.switchModelChoice?.(choice);
      return ctx.switchModelChoice
        ? null
        : `Selected model profile: ${choice.id}`;
    }

    return `Usage: /model | /model list | /model use <profile>`;
  },
});

commands.set('/skills', {
  description: 'List all available skills',
  handler: async (_, ctx) => {
    await loadSkills();
    const skillCommands = Array.from(commands.entries())
      .filter(([name, cmd]) => name.startsWith('/') && !['/quit', '/exit', '/tools', '/stack', '/abort', '/archive', '/context', '/clear', '/help', '/revert', '/undo', '/models', '/model', '/skills'].includes(name));

    if (skillCommands.length === 0) {
      return 'No custom skills found. Create skills in .ma/skills/ directory.';
    }

    return 'Available skills:\n' +
      skillCommands
        .map(([name, cmd]) => `  ${name} - ${cmd.description}`)
        .join('\n');
  },
});

export function isCommand(input: string): boolean {
  return input.startsWith('/');
}

export async function executeCommand(input: string, ctx: CommandContext): Promise<string | null> {
  // Load skills on first command execution
  await loadSkills();

  const spaceIdx = input.indexOf(' ');
  const name = spaceIdx > 0 ? input.slice(0, spaceIdx) : input;
  const args = spaceIdx > 0 ? input.slice(spaceIdx + 1) : '';
  const cmd = commands.get(name);
  if (!cmd) return `Unknown command: ${name}`;
  return cmd.handler(args, ctx);
}

export { commands };

// Export function to get all available commands (including skills)
export async function getAllCommands(): Promise<Map<string, Command>> {
  await loadSkills();
  return new Map(commands);
}

export async function getSuggestedCommands(): Promise<Map<string, Command>> {
  await loadSkills();
  return new Map(
    Array.from(commands.entries()).filter(([, command]) => command.suggest)
  );
}
