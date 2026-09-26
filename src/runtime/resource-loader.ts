import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import type { ResourceLoader, Skill } from '@earendil-works/pi-coding-agent';
import { parseSkillDocument, renderSkillTemplate, type ParsedSkill } from '../skills/loadSkills.js';
import type { MaResourcePolicy } from './public-types.js';
import { loadControlledExtensions, type ControlledExtension } from './extensions.js';

export interface ControlledResources {
  loader: ResourceLoader;
  skills: readonly ParsedSkill[];
  expandPrompt(text: string): string;
}

/** Only explicitly selected Markdown resources are read; no project code is auto-discovered. */
export async function createControlledResources(options: {
  cwd: string;
  agentDirectory: string;
  systemPrompt: string;
  policy: MaResourcePolicy;
  extensions: ControlledExtension[];
}): Promise<ControlledResources> {
  const allowedExtensions = new Set(['ma-tools', 'ma-model-purpose', 'ma-frame', 'ma-resources']);
  if (options.policy.extensions.some(name => !allowedExtensions.has(name))) throw new Error('MA_EXTENSION_NOT_AUTHORIZED');
  const parsed: ParsedSkill[] = [];
  const names = new Set<string>();
  const paths = new Set<string>();
  for (const selectedDirectory of options.policy.skillDirectories) {
    const root = await realpath(selectedDirectory);
    if (root !== resolve(selectedDirectory)) throw new Error('MA_SKILL_SYMLINK_NOT_AUTHORIZED');
    if (!(await lstat(root)).isDirectory()) throw new Error('MA_SKILL_DIRECTORY_INVALID');
    const visit = async (directory: string): Promise<void> => {
      const entries = await readdir(directory, { withFileTypes: true });
      const skillRoot = entries.find(entry => entry.name === 'SKILL.md' && entry.isFile());
      const selected = skillRoot ? [skillRoot] : entries;
      for (const entry of selected) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('MA_SKILL_SYMLINK_NOT_AUTHORIZED');
        if (entry.isDirectory()) { await visit(path); continue; }
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const canonical = await realpath(path);
        if (relative(root, canonical).startsWith('..')) throw new Error('MA_SKILL_PATH_ESCAPE');
        if (paths.has(canonical)) continue;
        const document = parseSkillDocument(await readFile(canonical, 'utf8'));
        const name = document.frontmatter.name;
        if (!/^[A-Za-z0-9_-]+$/.test(name) || names.has(name)) throw new Error('MA_SKILL_NAME_COLLISION');
        names.add(name); paths.add(canonical);
        parsed.push({ name, description: document.frontmatter.description,
          content: document.body, frontmatter: document.frontmatter, filePath: canonical });
      }
    };
    await visit(root);
  }
  const agentsFiles = await Promise.all(options.policy.instructionFiles.map(async path => {
    const canonical = await realpath(path);
    if (canonical !== resolve(path)) throw new Error('MA_INSTRUCTION_SYMLINK_NOT_AUTHORIZED');
    const stat = await lstat(canonical);
    if (!stat.isFile()) throw new Error('MA_INSTRUCTION_FILE_INVALID');
    return { path: canonical, content: await readFile(canonical, 'utf8') };
  }));
  const skills: Skill[] = parsed.map(skill => ({
    name: skill.name, description: skill.description, filePath: skill.filePath,
    baseDir: dirname(skill.filePath), disableModelInvocation: false,
    sourceInfo: { path: skill.filePath, source: 'ma-approved', scope: 'project', origin: 'top-level', baseDir: dirname(skill.filePath) },
  }));
  const extensions = await loadControlledExtensions(options.extensions);
  // An explicit snapshot avoids DefaultResourceLoader's additional filesystem discovery.
  const loader: ResourceLoader = {
    getExtensions: () => extensions,
    getSkills: () => ({ skills, diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles }),
    getSystemPrompt: () => options.systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => { throw new Error('MA_RESOURCE_DISCOVERY_NOT_AUTHORIZED'); },
    reload: async () => {},
  };
  return {
    loader, skills: parsed,
    expandPrompt(text) {
      const match = /^\/(?:skill:)?([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
      if (!match) return text;
      const skill = parsed.find(item => item.name === match[1]);
      if (!skill) return text;
      const tokens = (match[2] ?? '').match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
      const args: Record<string, string | boolean> = Object.create(null);
      for (const token of tokens) {
        const pair = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(token);
        if (!pair) throw new Error('MA_SKILL_ARGUMENTS_INVALID');
        let value = pair[2];
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
        args[pair[1]] = value === 'true' ? true : value === 'false' ? false : value;
      }
      for (const argument of skill.frontmatter.arguments ?? []) {
        if (!Object.hasOwn(args, argument.name) && argument.default !== undefined) args[argument.name] = argument.default;
        if (argument.required && !Object.hasOwn(args, argument.name)) throw new Error('MA_SKILL_ARGUMENT_REQUIRED');
        if (Object.hasOwn(args, argument.name) && argument.type && typeof args[argument.name] !== argument.type) {
          throw new Error('MA_SKILL_ARGUMENT_TYPE');
        }
      }
      return `<ma-skill name="${skill.name}" source="${basename(skill.filePath)}">\n${renderSkillTemplate(skill.content, args)}\n</ma-skill>`;
    },
  };
}
