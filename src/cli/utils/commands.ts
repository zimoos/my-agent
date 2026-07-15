import type { Agent, AgentConfig, McpConnection } from '../../mcp/types.js';
import * as path from 'node:path';
import { loadSkillsFromDirectory, createSkillCommand } from '../../skills/loadSkills.js';
import {
  listModelChoices,
  type ModelChoice,
} from './modelProfiles.js';
import { agoraProjectProfileId, type AgoraMemoryIntakeTarget } from '../../provider/agora.js';

interface CommandContext {
  agent: Agent;
  connections: McpConnection[];
  config: AgentConfig;
  exit: () => void;
  setModel?: (model: string) => void;
  openModelPicker?: () => Promise<void> | void;
  openMemoryConsole?: () => Promise<void> | void;
  startMemoryIntake?: (targets: AgoraMemoryIntakeTarget[]) => Promise<void> | void;
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

commands.set('/memory', {
  description: 'Open Agora Memory console or manage named Memories',
  suggest: true,
  handler: async (args, ctx) => {
    const controller = ctx.agent.getMemoryController?.();
    if (!controller) return 'Agora memory requires the Agora provider.';
    const trimmed = args.trim();
    if (!trimmed) {
      await ctx.openMemoryConsole?.();
      return ctx.openMemoryConsole ? null : 'Memory console is unavailable in this UI.';
    }
    try {
      const capabilities = controller.getCapabilities();
      if (!capabilities.memoryV2) {
        if (trimmed === 'status') return (await controller.status()).content;
        const legacyIntake = trimmed.match(/^internalize(?:\s+--into\s+(\S+))?$/);
        if (legacyIntake) {
          const profileId = ctx.agent.getProviderState?.()?.memory?.profile_id;
          if (!profileId) return 'Legacy Memory 需要先选择一个 Profile。';
          const result = await controller.startIntake({ profile_id: profileId, into: legacyIntake[1] });
          return `Legacy Memory intake queued: ${result.job_id ?? result.job?.id}`;
        }
        return `当前 Agora 仅支持 ${capabilities.runtimeMode} Memory；基础对话可用，具名 Memory v2 命令已禁用。`;
      }
      const [memories, patches] = await Promise.all([controller.listMemories(), controller.listPatches(true)]);
      const profileId = ctx.agent.getProviderState?.()?.memory?.profile_id ?? agoraProjectProfileId(process.cwd());
      const profiles = await controller.listProfiles();
      const profile = profiles.find((item) => item.id === profileId);
      const resolveMemories = (raw: string) => {
        const exact = memories.find((memory) => memory.name === raw.trim() || memory.id === raw.trim());
        if (exact) return [exact];
        const names = raw.includes(',') ? raw.split(',').map((name) => name.trim()).filter(Boolean) : [];
        if (names.length > 0) return names.map((name) => {
          const found = memories.find((item) => item.name === name || item.id === name);
          if (!found) throw new Error(`Memory 不存在: ${name}`);
          return found;
        });
        const selected: typeof memories = [];
        let rest = raw.trim();
        const candidates = [...memories].sort((left, right) => right.name.length - left.name.length);
        while (rest) {
          const found = candidates.find((item) => rest === item.name || rest.startsWith(`${item.name} `) || rest === item.id || rest.startsWith(`${item.id} `));
          if (!found) throw new Error(`无法识别 Memory 列表: ${rest}（名称含空格时也可用逗号分隔）`);
          selected.push(found);
          rest = rest.slice(rest.startsWith(found.name) ? found.name.length : found.id.length).trim();
        }
        return selected;
      };
      if (trimmed === 'list') {
        if (memories.length === 0) return '还没有 Agora Memory。';
        return memories.map((memory) => {
          const head = patches.find((patch) => patch.id === memory.head_patch_id);
          const mounted = head && profile?.active_memory_patch_ids.includes(head.id) ? ' · mounted/pending' : '';
          return `${memory.name} · ${head?.version ?? '尚无版本'}${mounted}`;
        }).join('\n');
      }
      if (trimmed === 'status') return (await controller.status()).content;
      const newMatch = trimmed.match(/^new\s+(.+)$/);
      if (newMatch) {
        return JSON.stringify(await controller.createMemory(newMatch[1].trim()), null, 2);
      }
      const renameInput = trimmed.match(/^rename\s+(.+)$/)?.[1];
      if (renameInput) {
        const explicit = renameInput.match(/^(.+?)\s+--to\s+(.+)$/);
        const candidate = explicit
          ? resolveMemories(explicit[1])[0]
          : [...memories].sort((left, right) => right.name.length - left.name.length)
            .find((item) => renameInput.startsWith(`${item.name} `) || renameInput.startsWith(`${item.id} `));
        if (!candidate) throw new Error('重命名格式: /memory rename <name> <new-name>');
        const prefix = explicit ? explicit[1] : renameInput.startsWith(candidate.name) ? candidate.name : candidate.id;
        const nextName = explicit ? explicit[2].trim() : renameInput.slice(prefix.length).trim();
        return JSON.stringify(await controller.renameMemory(candidate.id, nextName), null, 2);
      }
      const mountMatch = trimmed.match(/^mount\s+(.+?)(?:\s+(--session|--user))?$/);
      if (mountMatch) {
        const selected = resolveMemories(mountMatch[1]);
        const scope = mountMatch[2] === '--session' ? 'conversation' : mountMatch[2] === '--user' ? 'user' : 'project';
        return JSON.stringify(await controller.mountMemories(profileId, selected.map((memory) => memory.id), scope), null, 2);
      }
      const unmountMatch = trimmed.match(/^unmount\s+(.+)$/);
      if (unmountMatch) {
        const remaining = unmountMatch[1].trim() === 'all'
          ? []
          : memories.filter((memory) => {
            const head = patches.find((patch) => patch.id === memory.head_patch_id);
            return Boolean(head && profile?.active_memory_patch_ids.includes(head.id)) &&
              !resolveMemories(unmountMatch[1]).some((remove) => remove.id === memory.id);
          }).map((memory) => memory.id);
        return JSON.stringify(await controller.mountMemories(profileId, remaining), null, 2);
      }
      if (trimmed === 'internalize') {
        await ctx.openMemoryConsole?.();
        return ctx.openMemoryConsole ? null : '请使用 /memory internalize --new <name> 或 --into <name1,name2>。';
      }
      const newIntake = trimmed.match(/^internalize\s+--new\s+(.+)$/);
      const intoIntake = trimmed.match(/^internalize\s+--into\s+(.+)$/);
      if (newIntake || intoIntake) {
        if (!profile) return '请先挂载一个 Memory 组合并完成一次 Agora 对话。';
        const targets = newIntake
          ? [{ mode: 'create' as const, name: newIntake[1].trim(), output_name: `${newIntake[1].trim()}@v1` }]
          : resolveMemories(intoIntake![1]).map((memory) => ({
            mode: 'increment' as const,
            memory_id: memory.id,
            expected_parent_patch_id: memory.head_patch_id ?? undefined,
            output_name: `${memory.name}@v${patches.filter((patch) => patch.memory_id === memory.id).length + 1}`,
          }));
        if (ctx.startMemoryIntake) {
          await ctx.startMemoryIntake(targets);
          return `Memory intake queued · ${targets.length} targets`;
        }
        const result = await controller.startBatchIntake({ targets });
        return `Memory intake queued: ${result.batch_id} · ${targets.length} targets`;
      }
      const autoMatch = trimmed.match(/^auto\s+(on|off)(?:\s+--targets\s+(.+))?$/);
      if (autoMatch) {
        if (!profile) return '请先挂载一个 Memory 组合。';
        const targets = autoMatch[2] ? resolveMemories(autoMatch[2]).map((memory) => memory.id) : profile.auto_intake_target_memory_ids ?? [];
        if (autoMatch[1] === 'on' && targets.length === 0) return '开启自动内化必须指定 --targets <name1,name2>。';
        return JSON.stringify(await controller.setAutoPolicy(profileId, autoMatch[1] === 'on', targets), null, 2);
      }
      const historyMatch = trimmed.match(/^history\s+(.+)$/);
      if (historyMatch) {
        const memory = resolveMemories(historyMatch[1])[0];
        return patches
          .filter((patch) => patch.memory_id === memory.id)
          .map((patch) => `${patch.id}  ${patch.name} · ${patch.version} · ${patch.status}`)
          .join('\n') || 'No versions found.';
      }
      const rollbackInput = trimmed.match(/^rollback\s+(.+)$/)?.[1];
      if (rollbackInput) {
        const memory = [...memories].sort((left, right) => right.name.length - left.name.length)
          .find((item) => rollbackInput.startsWith(`${item.name} `) || rollbackInput.startsWith(`${item.id} `));
        if (!memory) return '回滚格式: /memory rollback <name> <version>';
        const prefix = rollbackInput.startsWith(memory.name) ? memory.name : memory.id;
        const version = rollbackInput.slice(prefix.length).trim();
        if (!memory.head_patch_id) return '该 Memory 还没有版本。';
        const target = patches.find((patch) => patch.memory_id === memory.id &&
          [patch.id, patch.name, patch.version].includes(version));
        if (!target) return `找不到版本: ${version}`;
        return JSON.stringify(await controller.rollbackMemory(memory.id, memory.head_patch_id, target.id), null, 2);
      }
      if (trimmed === 'disable') {
        if (!profile) return '当前没有 Memory 组合。';
        return (await controller.disable({ profile_id: profileId })).content;
      }
      return 'usage: /memory | list | mount <name1,name2> [--session|--user] | unmount <name...|all> | new <name> | rename <name> --to <new-name> | internalize [--new <name>|--into <name1,name2>] | auto on --targets <name1,name2> | auto off | history <name> | rollback <name> <version> | status | disable';
    } catch (err) {
      return `Memory error: ${(err as Error).message}`;
    }
  },
});

commands.set('/skills', {
  description: 'List all available skills',
  handler: async (_, ctx) => {
    await loadSkills();
    const skillCommands = Array.from(commands.entries())
      .filter(([name, cmd]) => name.startsWith('/') && !['/quit', '/exit', '/tools', '/stack', '/abort', '/archive', '/context', '/clear', '/help', '/revert', '/undo', '/models', '/model', '/memory', '/skills'].includes(name));

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
