/**
 * The `tf-import-blocks` command, exercised as a stranger gets it.
 *
 * Everything here spawns `dist/cli.js` as a child process rather than calling
 * `main()` in-process, because most of what can go wrong with a CLI is not in
 * its logic: a lost shebang, a `bin` pointing at a file the tarball omits, a
 * summary line on stdout that corrupts `> imports.tf`, an exit code of 0 on a
 * failure. None of those are visible to a test that imports a function.
 *
 * `pretest` runs `npm run build`, so `dist/` is current whenever `npm test`
 * is. The first test below fails loudly rather than skipping if it is not,
 * because a silently skipped end-to-end test is worse than none.
 *
 * The centrepiece is `reproduces the golden file byte for byte on stdout`.
 * `golden.test.ts` pins the *library* to `awkward.expected.tf`; this pins the
 * *command* to the same bytes, through the same annotation stripper, so the two
 * cannot drift apart without one of them saying so.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { FIXTURES, expectedGolden } from './golden-file.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist', 'cli.js');
const AWKWARD = path.join(FIXTURES, 'awkward.tfstate.json');
const TWO_ACCOUNT = path.join(FIXTURES, 'two-account.tfstate.json');

interface Run {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * `INIT_CWD` is deleted unless a test asks for it. npm sets it for every script
 * it runs, so `npm test` would otherwise leak the developer's shell directory
 * into the child and the CLI — which prefers it over `process.cwd()`, so that
 * `npm run <script>` resolves the paths a user typed — would resolve relative
 * state files somewhere the test did not choose. The one test that cares about
 * that precedence sets it explicitly.
 */
function run(args: readonly string[], opts: { cwd?: string; initCwd?: string } = {}): Run {
  const env = { ...process.env };
  delete env['INIT_CWD'];
  if (opts.initCwd !== undefined) env['INIT_CWD'] = opts.initCwd;
  const res = spawnSync(process.execPath, [CLI, ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env,
  });
  if (res.error !== undefined) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

function withTempDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), 'tf-import-blocks-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Manifest {
  readonly version: string;
  readonly bin: Record<string, string>;
  readonly files: string[];
  readonly dependencies?: Record<string, string>;
}

const manifest = (): Manifest =>
  JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as Manifest;

// ── the binary itself ──────────────────────────────────────────────────────

test('the built binary exists, is what `bin` points at, and keeps its shebang', () => {
  assert.ok(
    existsSync(CLI),
    `${CLI} is missing — run \`npm run build\`. \`pretest\` normally does it for you.`,
  );

  const pkg = manifest();
  assert.deepEqual(
    pkg.bin,
    { 'tf-import-blocks': './dist/cli.js' },
    'the command name and its target are the published contract',
  );
  assert.ok(existsSync(path.join(ROOT, pkg.bin['tf-import-blocks'] ?? '')));
  assert.ok(pkg.files.includes('dist'), '`files` must ship dist/ or the bin is not in the tarball');

  // The whole reason the shebang lives on line 1 of `src/cli.ts`: TypeScript
  // only preserves it there, nothing in the build would report its loss, and a
  // global install without it produces a file the shell runs as a shell script.
  const built = readFileSync(CLI, 'utf8');
  assert.equal(built.split('\n')[0], '#!/usr/bin/env node');
});

test('the package still declares no runtime dependencies', () => {
  // The CLI was added with `node:util`'s parseArgs rather than an argument
  // library precisely so this stays true. It is a property people choose the
  // package for, and it is one `npm install --save` away from being lost.
  assert.equal(manifest().dependencies, undefined);
});

// ── the golden, through the command ────────────────────────────────────────

test('reproduces the golden file byte for byte on stdout', () => {
  const res = run([AWKWARD]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, expectedGolden());
});

test('a # VERIFY block is not a failure', () => {
  // awkward.tfstate.json contains aws_s3_object, which has no rule on purpose.
  // Flagging it is the designed behaviour, so exiting non-zero would make every
  // realistic state file look like an error.
  const res = run([AWKWARD]);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /# VERIFY: no rule for aws_s3_object/);
  assert.match(res.stderr, /fell back to the state id, flagged # VERIFY/);
});

test('stdout carries HCL and nothing else; the summary is on stderr', () => {
  const res = run([AWKWARD]);
  assert.doesNotMatch(res.stdout, /^tf-import-blocks:/m);
  assert.doesNotMatch(res.stdout, /resolved by a rule/);
  assert.match(res.stderr, /^tf-import-blocks: 15 blocks from 1 state file$/m);
  assert.match(res.stderr, /^ {2}14 resolved by a rule$/m);
});

test('`terraform show -json` input is accepted too', () => {
  const res = run([path.join(FIXTURES, 'awkward-show.json')]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /^import \{$/m);
});

// ── flags ──────────────────────────────────────────────────────────────────

test('--out writes the same bytes to a file and leaves stdout empty', () => {
  withTempDir((dir) => {
    const res = run([AWKWARD, '--out', 'imports.tf'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.equal(res.stdout, '', '--out means nothing at all reaches stdout');
    assert.equal(readFileSync(path.join(dir, 'imports.tf'), 'utf8'), expectedGolden());
    assert.match(res.stderr, /^tf-import-blocks: wrote imports\.tf$/m);
    // The summary is still on stderr even though stdout is free. One rule with
    // no exceptions is the only version of it anyone remembers under a pipe.
    assert.match(res.stderr, /^ {2}14 resolved by a rule$/m);
  });
});

test('--out creates the parent directory', () => {
  withTempDir((dir) => {
    const res = run([AWKWARD, '--out', 'generated/imports.tf'], { cwd: dir });
    assert.equal(res.status, 0, res.stderr);
    assert.ok(existsSync(path.join(dir, 'generated', 'imports.tf')));
  });
});

test('--filter emits only the matching subtree and counts the rest as withheld', () => {
  const res = run(['--filter', 'module.net.', AWKWARD]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.match(/^import \{$/gm)?.length, 1);
  assert.match(res.stdout, /to = module\.net\.aws_subnet\.private\["eu-west-1a"\]/);
  assert.match(res.stderr, /^tf-import-blocks: 1 block from 1 state file$/m);
  assert.match(res.stderr, /^ {2}14 withheld by --filter$/m);
});

test('--filter matching nothing is an empty document, not an error', () => {
  const res = run(['--filter', 'module.nothing.', AWKWARD]);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^tf-import-blocks: 0 blocks from 1 state file$/m);
});

test('--help goes to stdout and exits 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.equal(res.stderr, '');
  assert.match(res.stdout, /^tf-import-blocks — Terraform `import` blocks/);
  // The help is the only documentation a `npx` user has. Each flag must be in it.
  for (const flag of ['--out', '--filter', '--help', '--version']) {
    assert.ok(res.stdout.includes(flag), `--help does not mention ${flag}`);
  }
  assert.match(res.stdout, /Exit codes:/);
  assert.equal(run(['-h']).stdout, res.stdout);
});

test('--version prints the manifest version and nothing else', () => {
  const res = run(['--version']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout, `${manifest().version}\n`);
  assert.equal(res.stderr, '');
  assert.equal(run(['-v']).stdout, res.stdout);
});

test('the invocation directory comes from INIT_CWD when npm sets it', () => {
  // `npm run <script>` runs from the package root but sets INIT_CWD to where
  // the user typed the command, and the paths they typed are relative to that.
  const res = run(['awkward.tfstate.json'], { cwd: ROOT, initCwd: FIXTURES });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout, expectedGolden());
});

// ── several state files ────────────────────────────────────────────────────

test('several state files merge into one document sorted by address', () => {
  const res = run(['--filter', 'module.', AWKWARD, TWO_ACCOUNT]);
  assert.equal(res.status, 0, res.stderr);
  const addresses = [...res.stdout.matchAll(/^ {2}to = (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(addresses, [
    'module.dr.aws_route.dr_default',
    'module.legacy.aws_s3_bucket.logs',
    'module.net.aws_subnet.private["eu-west-1a"]',
  ]);
  assert.match(res.stderr, /^tf-import-blocks: 3 blocks from 2 state files$/m);
});

test('an address supplied by two states exits 3, and still writes the blocks', () => {
  // Both fixtures hold `aws_vpc.main`. The output is real and complete; it is
  // just not valid HCL until a human decides which state owns that address, so
  // it is written and the exit code is what makes CI notice.
  const res = run([AWKWARD, TWO_ACCOUNT]);
  assert.equal(res.status, 3);
  assert.equal(res.stdout.match(/^import \{$/gm)?.length, 23);
  assert.match(res.stderr, /WARNING: 1 address emitted more than once/);
  assert.match(res.stderr, /^ {4}aws_vpc\.main$/m);
});

// ── failures ───────────────────────────────────────────────────────────────

test('no state file is a usage error, with the help on stderr', () => {
  const res = run([]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '', 'a usage error must not put prose where the HCL goes');
  assert.match(res.stderr, /pass at least one Terraform state file/);
  assert.match(res.stderr, /Usage:\n {2}tf-import-blocks/);
});

test('an unknown flag is a usage error and keeps parseArgs own message', () => {
  const res = run(['--ouput', 'imports.tf', AWKWARD]);
  assert.equal(res.status, 1);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /Unknown option '--ouput'/);
});

test('a missing state file exits 2 and names the path the user typed', () => {
  const res = run(['nope.tfstate']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
  assert.match(res.stderr, /^tf-import-blocks: nope\.tfstate: no such file$/m);
});

test('a state file that is not JSON exits 2 and says what a state file is', () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, 'bad.tfstate'), 'Acquiring state lock...\n{"version": 4}\n');
    const res = run(['bad.tfstate'], { cwd: dir });
    assert.equal(res.status, 2);
    assert.equal(res.stdout, '');
    assert.match(res.stderr, /bad\.tfstate: not valid JSON/);
    assert.match(res.stderr, /terraform state pull/);
  });
});

test('valid JSON that is not a state file exits 2', () => {
  withTempDir((dir) => {
    writeFileSync(path.join(dir, 'wrong.json'), '{"hello": "world"}');
    const res = run(['wrong.json'], { cwd: dir });
    assert.equal(res.status, 2);
    assert.match(res.stderr, /wrong\.json: unrecognized format/);
  });
});

test('a state file the tool cannot read is reported before anything is emitted', () => {
  // The second file is unreadable, so nothing at all should reach stdout — a
  // half-written imports.tf from a batch that failed is the worst outcome.
  const res = run([AWKWARD, 'nope.tfstate']);
  assert.equal(res.status, 2);
  assert.equal(res.stdout, '');
});
