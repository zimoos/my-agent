import { createExtensionRuntime, type Extension, type ExtensionAPI, type LoadExtensionsResult } from '@earendil-works/pi-coding-agent';

/** MA-owned hooks may register handlers; this is not an executable plugin discovery API. */
export type ControlledExtension = (api: Pick<ExtensionAPI, 'on'>) => void | Promise<void>;

export async function loadControlledExtensions(registrations: ControlledExtension[]): Promise<LoadExtensionsResult> {
  const extensions: Extension[] = [];
  for (const [index, register] of registrations.entries()) {
    const path = `<ma-controlled:${index}>`;
    const extension: Extension = {
      path, resolvedPath: path, hidden: true,
      sourceInfo: { path, source: 'ma-builtin', scope: 'temporary', origin: 'top-level' },
      handlers: new Map(), tools: new Map(), messageRenderers: new Map(),
      commands: new Map(), flags: new Map(), shortcuts: new Map(),
    };
    const on = ((name: string, handler: (...args: unknown[]) => unknown) => {
      const handlers = extension.handlers.get(name) ?? [];
      handlers.push(async (...args: unknown[]) => handler(...args));
      extension.handlers.set(name, handlers);
    }) as ExtensionAPI['on'];
    await register({ on });
    extensions.push(extension);
  }
  return { extensions, errors: [], runtime: createExtensionRuntime() };
}
