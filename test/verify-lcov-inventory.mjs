import { execFileSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAX_LCOV_BYTES = 10 * 1024 * 1024;

export function trackedSourceFiles(cwd = process.cwd()) {
  // NUL-delimited Git paths avoid quoting/whitespace ambiguities. The source
  // inventory is recursive; the Node test runner's globs must cover it all.
  const output = execFileSync('git', ['ls-files', '-z', '--', 'src/'], {
    cwd, encoding: 'utf8', maxBuffer: MAX_LCOV_BYTES
  });
  const files = output.split('\0').filter(path =>
    /^src\/.+\.(?:mjs|ts)$/.test(path) && !path.endsWith('.d.ts')
  );
  if (!files.length) throw new Error('No tracked JavaScript/TypeScript source files found');
  return files;
}

export function assertCompleteLcov(lcovText, sourceFiles) {
  const expected = new Set(sourceFiles);
  if (!expected.size) throw new Error('Source coverage inventory is empty');
  const reported = new Set();
  for (const line of lcovText.split(/\r?\n/)) {
    if (!line.startsWith('SF:')) continue;
    const source = line.slice(3);
    if (!expected.has(source)) {
      throw new Error('LCOV contains an unexpected or untracked source: ' + JSON.stringify(source));
    }
    if (reported.has(source)) {
      throw new Error('LCOV contains duplicate source records: ' + JSON.stringify(source));
    }
    reported.add(source);
  }
  const missing = [...expected].filter(source => !reported.has(source));
  if (missing.length) {
    throw new Error('LCOV omitted ' + missing.length + ' tracked source file(s): ' + missing.join(', '));
  }
  return reported.size;
}

export async function verifyLcovAndInvalidateOnFailure(lcovPath, cwd = process.cwd()) {
  try {
    const file = await readFile(lcovPath);
    if (file.byteLength > MAX_LCOV_BYTES) throw new Error('LCOV exceeds the 10 MiB file limit');
    return assertCompleteLcov(file.toString('utf8'), trackedSourceFiles(cwd));
  } catch (error) {
    // workflow upload-artifact uses if: always(): never upload a known
    // incomplete LCOV as if it were reliable coverage. Preserve JUnit output.
    try {
      await unlink(lcovPath);
    } catch (unlinkError) {
      if (unlinkError.code !== 'ENOENT') {
        throw new Error('LCOV verification failed and invalid output could not be removed: ' + unlinkError.message, { cause: error });
      }
    }
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: verify-lcov-inventory.mjs LCOV_PATH');
    const count = await verifyLcovAndInvalidateOnFailure(process.argv[2]);
    console.log('LCOV inventory complete: ' + count + ' tracked source files.');
  } catch (error) {
    console.error('Incomplete source coverage: ' + error.message);
    process.exitCode = 1;
  }
}
