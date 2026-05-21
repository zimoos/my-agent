import fs from 'node:fs';

export const VERSION = readPackageVersion();

function readPackageVersion(): string {
  for (const packageUrl of [
    new URL('../../package.json', import.meta.url),
    new URL('../../../package.json', import.meta.url),
  ]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageUrl, 'utf-8')) as { version?: unknown };
      if (typeof pkg.version === 'string' && pkg.version.length > 0) {
        return pkg.version;
      }
    } catch {
      // Source execution and compiled execution need different relative package paths.
    }
  }
  return '0.0.0-unknown';
}
