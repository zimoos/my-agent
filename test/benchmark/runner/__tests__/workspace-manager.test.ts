import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { prepareWorkspace, collectDiff } from '../workspace-manager.js';

function makeFixture(files: Record<string, string>): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ma-bench-fixture-src-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
}

test('prepareWorkspace: 复制 fixture + git init 建立基线 commit', async () => {
  const fx = makeFixture({
    'package.json': '{"name":"demo"}\n',
    'src/index.js': 'console.log(1);\n',
  });
  try {
    const { workdir, cleanup } = await prepareWorkspace(fx.dir);
    try {
      assert.ok(workdir.startsWith(tmpdir()), 'workdir 应在 tmpdir 下');
      assert.ok(existsSync(join(workdir, '.git')), '.git 目录应存在');
      assert.equal(
        readFileSync(join(workdir, 'package.json'), 'utf-8'),
        '{"name":"demo"}\n',
      );

      // 基线 commit 存在
      const log = git(['log', '--oneline'], workdir).trim();
      assert.match(log, /initial/, '应有 initial commit');

      // 无任何未提交改动
      const status = git(['status', '--porcelain'], workdir);
      assert.equal(status.trim(), '', '基线建立后工作区应干净');
    } finally {
      await cleanup();
      assert.ok(!existsSync(workdir), 'cleanup 后目录应被删除');
    }
  } finally {
    fx.cleanup();
  }
});

test('prepareWorkspace: setup 命令产物进入基线，后续 diff 不包含它', async () => {
  const fx = makeFixture({ 'README.md': 'hi\n' });
  try {
    const { workdir, cleanup } = await prepareWorkspace(fx.dir, [
      "node -e \"require('fs').writeFileSync('generated.txt', 'from-setup')\"",
    ]);
    try {
      assert.equal(readFileSync(join(workdir, 'generated.txt'), 'utf-8'), 'from-setup');
      const status = git(['status', '--porcelain'], workdir);
      assert.equal(status.trim(), '', 'setup 产物应已 commit');

      const diff = await collectDiff(workdir);
      assert.deepEqual(diff.files, [], '无 agent 改动 → diff 为空');
      assert.equal(diff.summary, '');
    } finally {
      await cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('collectDiff: 正确识别 added / modified / deleted 三种状态', async () => {
  const fx = makeFixture({
    'keep.txt': 'keep\n',
    'edit.txt': 'original\n',
    'remove.txt': 'doomed\n',
  });
  try {
    const { workdir, cleanup } = await prepareWorkspace(fx.dir);
    try {
      // agent 的改动：新增 + 修改 + 删除
      writeFileSync(join(workdir, 'new.txt'), 'brand new\n');
      writeFileSync(join(workdir, 'edit.txt'), 'changed\n');
      rmSync(join(workdir, 'remove.txt'));

      const diff = await collectDiff(workdir);
      const byPath = new Map(diff.files.map((f) => [f.path, f]));

      assert.equal(byPath.size, 3, `应有 3 个改动文件，实际 ${diff.files.map((f) => f.path).join(',')}`);
      assert.equal(byPath.get('new.txt')?.status, 'added');
      assert.equal(byPath.get('edit.txt')?.status, 'modified');
      assert.equal(byPath.get('remove.txt')?.status, 'deleted');

      // 每个文件的 diff 字段里都应包含自己的路径（git 标头）
      for (const [p, f] of byPath) {
        assert.ok(f.diff.includes(p), `diff 片段应引用路径 ${p}`);
        assert.ok(f.diff.startsWith('diff --git '), `diff 片段应以 git 标头开头: ${p}`);
      }

      // 具体内容校验
      assert.match(byPath.get('new.txt')!.diff, /\+brand new/);
      assert.match(byPath.get('edit.txt')!.diff, /-original/);
      assert.match(byPath.get('edit.txt')!.diff, /\+changed/);
      assert.match(byPath.get('remove.txt')!.diff, /-doomed/);

      // summary 是 git diff --stat，应提到三个文件
      assert.match(diff.summary, /new\.txt/);
      assert.match(diff.summary, /edit\.txt/);
      assert.match(diff.summary, /remove\.txt/);
    } finally {
      await cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('collectDiff: 无改动时返回空数组 + 空 summary', async () => {
  const fx = makeFixture({ 'a.txt': 'a\n' });
  try {
    const { workdir, cleanup } = await prepareWorkspace(fx.dir);
    try {
      const diff = await collectDiff(workdir);
      assert.deepEqual(diff.files, []);
      assert.equal(diff.summary, '');
    } finally {
      await cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('collectDiff: 嵌套目录新增文件', async () => {
  const fx = makeFixture({ 'package.json': '{}\n' });
  try {
    const { workdir, cleanup } = await prepareWorkspace(fx.dir);
    try {
      mkdirSync(join(workdir, 'src/lib'), { recursive: true });
      writeFileSync(join(workdir, 'src/lib/util.js'), 'export const x = 1;\n');

      const diff = await collectDiff(workdir);
      assert.equal(diff.files.length, 1);
      assert.equal(diff.files[0].path, 'src/lib/util.js');
      assert.equal(diff.files[0].status, 'added');
      assert.match(diff.files[0].diff, /\+export const x = 1/);
    } finally {
      await cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('prepareWorkspace: fixture 目录不存在时抛错', async () => {
  await assert.rejects(
    () => prepareWorkspace(join(tmpdir(), `__no_such_fixture_${Date.now()}__`)),
    /fixture dir not found/,
  );
});

test('prepareWorkspace: setup 命令失败时抛错向上传播', async () => {
  const fx = makeFixture({ 'a.txt': 'a\n' });
  try {
    await assert.rejects(
      () => prepareWorkspace(fx.dir, ['node -e "process.exit(3)"']),
    );
  } finally {
    fx.cleanup();
  }
});

test('prepareWorkspace: 多次调用返回互相独立的 workdir', async () => {
  const fx = makeFixture({ 'shared.txt': 'base\n' });
  try {
    const a = await prepareWorkspace(fx.dir);
    const b = await prepareWorkspace(fx.dir);
    try {
      assert.notEqual(a.workdir, b.workdir);
      writeFileSync(join(a.workdir, 'only-a.txt'), '1');
      assert.ok(!existsSync(join(b.workdir, 'only-a.txt')));
    } finally {
      await a.cleanup();
      await b.cleanup();
    }
  } finally {
    fx.cleanup();
  }
});

test('collectDiff: workdir 不存在时抛错', async () => {
  await assert.rejects(
    () => collectDiff(join(tmpdir(), `__no_such_workdir_${Date.now()}__`)),
    /workdir not found/,
  );
});
