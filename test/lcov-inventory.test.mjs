import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { assertCompleteLcov } from './verify-lcov-inventory.mjs';

const validator = fileURLToPath(new URL('./verify-lcov-inventory.mjs', import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(
  ([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_V8_COVERAGE'
));

test('LCOV inventory rejects missing, duplicate, or invented source files', () => {
  assert.equal(assertCompleteLcov('SF:src/used.mjs\nend_of_record\n', ['src/used.mjs']), 1);
  assert.throws(() => assertCompleteLcov(
    'SF:src/used.mjs\nend_of_record\n', ['src/used.mjs', 'src/unused.mjs']
  ), /omitted.*src\/unused.mjs/);
  assert.throws(() => assertCompleteLcov(
    'SF:src/used.mjs\nSF:src/used.mjs\n', ['src/used.mjs']
  ), /duplicate/);
  assert.throws(() => assertCompleteLcov(
    'SF:src/used.mjs\nSF:src/ghost.mjs\n', ['src/used.mjs']
  ), /unexpected or untracked/);
});

test('CI rejects and deletes misleading LCOV when a tracked module is never imported', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'benchmark-lcov-inventory-'));
  const script = join(dir, 'test', 'loaded.test.mjs');
  const coveragePath = join(dir, 'lcov.info');
  try {
    await Promise.all([mkdir(join(dir, 'src')), mkdir(join(dir, 'test'))]);
    await writeFile(join(dir, 'src', 'used.mjs'), 'export const covered = () => 42;\n');
    await writeFile(join(dir, 'src', 'unused.mjs'), 'export const untested = () => 43;\n');
    await writeFile(script,
      'import { test } from "node:test"; import { strict as assert } from "node:assert";\n' +
      'import { covered } from "../src/used.mjs";\n' +
      'test("covered", () => assert.equal(covered(), 42));\n');
    let git = spawnSync('git', ['init', '-q'], { cwd: dir, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    git = spawnSync('git', ['add', '--', 'src/'], { cwd: dir, encoding: 'utf8' });
    assert.equal(git.status, 0, git.stderr);
    const runCoverage = () => spawnSync(process.execPath, [
      '--experimental-test-coverage', '--test-coverage-include=src/*.mjs',
      '--test', '--test-reporter=lcov', '--test-reporter-destination=lcov.info',
      'test/loaded.test.mjs'
    ], { cwd: dir, env, encoding: 'utf8', timeout: 30_000 });

    let result = runCoverage();
    assert.equal(result.status, 0, result.stderr);
    const firstOutput = await readFile(coveragePath, 'utf8');
    assert.match(firstOutput, /SF:src\/used\.mjs/);
    assert.doesNotMatch(firstOutput, /SF:src\/unused\.mjs/);

    result = spawnSync(process.execPath, [validator, 'lcov.info'], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /LCOV omitted 1 tracked source file.*src\/unused\.mjs/);
    await assert.rejects(readFile(coveragePath), { code: 'ENOENT' });

    await writeFile(script,
      'import { test } from "node:test"; import { strict as assert } from "node:assert";\n' +
      'import { covered } from "../src/used.mjs";\n' +
      'import { untested } from "../src/unused.mjs";\n' +
      'test("both", () => { assert.equal(covered(), 42); assert.equal(untested(), 43); });\n');
    result = runCoverage();
    assert.equal(result.status, 0, result.stderr);
    result = spawnSync(process.execPath, [validator, 'lcov.info'], {
      cwd: dir, env, encoding: 'utf8', timeout: 10_000
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /2 tracked source files/);
    assert.match(await readFile(coveragePath, 'utf8'), /SF:src\/unused\.mjs/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
