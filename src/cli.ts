#!/usr/bin/env node
/**
 * The `tf-import-blocks` command.
 *
 * The shebang above is load-bearing and must stay on line 1: TypeScript
 * preserves a shebang only when it is the very first thing in the file, and
 * `package.json`'s `bin` points at the *emitted* `dist/cli.js`. Move it, add a
 * blank line above it, or convert this file to something that does not emit a
 * shebang, and a global install produces a file the shell tries to run as a
 * shell script. `test/cli.test.ts` asserts the shebang survives into `dist/`,
 * because nothing else in the build would notice.
 *
 * This file owns argument parsing, the two output streams and the exit codes.
 * All of the actual work is in `generate.ts`, which never writes to a stream
 * and never exits, so it can be called from a test without spawning anything.
 *
 * **stdout is HCL and nothing else.** The headline invocation is
 * `tf-import-blocks prod.tfstate > imports.tf`, and one line of prose on stdout
 * silently produces a `.tf` file Terraform will not parse. So the summary, the
 * warnings, the `--out` confirmation and every error go to stderr — including
 * in the `--out` case, where stdout is unused and it would have been free to
 * put the summary there. Keeping it unconditional makes the rule statable in
 * one sentence with no exceptions, which is the only form of this rule anyone
 * will remember at the point they are piping the output somewhere.
 *
 * `--help` and `--version` are the exception that proves it: they are the
 * requested output rather than a commentary on it, they never coexist with
 * HCL, and every command-line convention puts them on stdout so that
 * `tf-import-blocks --help | less` works. A *usage error*, by contrast, prints
 * to stderr, because there the user asked for HCL and is not getting any.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

import { StateFileError, displayPath, formatSummary, generate, writeBlocks } from './generate.js';

const HELP = `tf-import-blocks — Terraform \`import\` blocks for the resources in a state file

Usage:
  tf-import-blocks [--out <file>] [--filter <prefix>] <statefile>...

Generates a Terraform \`import\` block for every resource in the given state
file(s), so a subtree can be adopted into another configuration. HCL goes to
stdout — redirect it straight into a .tf — and the summary goes to stderr.

Import ids come from a per-type rule table, not from the state id:
aws_sqs_queue imports by queue URL, aws_lambda_function by function name,
aws_route by <route-table>_<destination>. A type with no rule is still
emitted, flagged \`# VERIFY\`, because a silently dropped resource is the worst
outcome of a state move. Nothing but identifiers leaves the state file: rules
read attributes to compute an import id, and only that id and the resource's
address are written.

Accepts raw *.tfstate / \`terraform state pull\` output and \`terraform show
-json\` output. Data sources and resources from other providers are skipped, as
are deposed instances (the orphan half of an interrupted replace); tainted
objects are emitted, and the summary says so.

Options:
  --out <file>       Write the HCL to this file instead of stdout.
  --filter <prefix>  Emit only addresses starting with this prefix
                     (e.g. --filter module.net.) — moving one subtree out of a
                     larger state is the common case.
  -h, --help         Show this help and exit.
  -v, --version      Print the version and exit.

Exit codes:
  0  Blocks were generated. Blocks flagged \`# VERIFY\` are still a 0 — they are
     a normal, expected outcome and the whole point of flagging them.
  1  Usage error: an unknown flag, or no state file given. Also the code for an
     unexpected internal failure, which prints a stack trace rather than this.
  2  A state file could not be read, was not JSON, or was not a state file.
  3  Blocks were generated and written, but two state files supplied the same
     Terraform address, so the output is not valid HCL until one is removed.
     The addresses are listed on stderr.

Examples:
  terraform state pull > /tmp/prod-network.tfstate
  npx tf-import-blocks /tmp/prod-network.tfstate > imports.tf
  tf-import-blocks --filter module.net. --out imports.tf /tmp/prod-network.tfstate
  tf-import-blocks states/*.tfstate > imports.tf
`;

/**
 * Read from the manifest rather than hard-coding a literal that a release
 * would have to remember to update in two places. `../package.json` resolves
 * from `dist/cli.js` in an installed package and from `src/cli.ts` under
 * `tsx`, which are the only two ways this file ever runs.
 */
function version(): string {
  const manifest = JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version?: unknown };
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0-unknown';
}

/**
 * npm sets `INIT_CWD` to the directory the user typed the command in, while
 * `process.cwd()` is the package root once a `scripts` entry is running. They
 * agree for a direct or `npx` invocation and differ for
 * `npm run <script-that-calls-this>` from a subdirectory, where the paths the
 * user typed are relative to `INIT_CWD`.
 */
function invocationDir(): string {
  return process.env['INIT_CWD'] ?? process.cwd();
}

/** Exit codes, named so the reasoning is visible at the throw site. */
const EXIT_USAGE = 1;
const EXIT_UNREADABLE_STATE = 2;
const EXIT_DUPLICATE_ADDRESSES = 3;

/** A bad flag or a missing argument: help to stderr, exit 1. */
class UsageError extends Error {}

async function main(): Promise<number> {
  let values: { out?: string; filter?: string; help?: boolean; version?: boolean };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        out: { type: 'string' },
        filter: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
      },
    }));
  } catch (err) {
    // parseArgs' own message ("Unknown option '--ouput'. To specify an option
    // argument, use …") is better than anything written here, so keep it and
    // only supply the help it does not know about.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }

  const files = positionals;
  if (files.length === 0) {
    throw new UsageError('pass at least one Terraform state file');
  }

  const cwd = invocationDir();
  // Unusable input surfaces as `StateFileError` and is answered with exit 2 by
  // the handler below. Nothing is caught here, so anything else this raises
  // keeps its stack all the way out — a defect in the package should look like
  // one rather than like a bad state file.
  const { hcl, summary } = await generate({ files, filter: values.filter, cwd });

  if (values.out !== undefined) {
    const abs = await writeBlocks(hcl, values.out, cwd);
    process.stderr.write(`tf-import-blocks: wrote ${displayPath(abs, cwd)}\n`);
  } else {
    process.stdout.write(hcl);
  }
  for (const line of formatSummary(summary)) process.stderr.write(`${line}\n`);

  // The blocks are real and were written; the file just is not usable until a
  // human picks which of the colliding states owns the address. Exiting
  // non-zero is what makes `set -e` and CI catch it, and the alternative —
  // a warning on stderr and a 0 — is exactly the silent-corruption failure
  // this package exists to prevent.
  return summary.duplicateAddresses.length > 0 ? EXIT_DUPLICATE_ADDRESSES : 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    if (err instanceof UsageError) {
      // The full help, not a one-line "try --help": the user is already at a
      // stop and the thing they need is one screen long.
      process.stderr.write(`tf-import-blocks: ${err.message}\n\n${HELP}`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    if (err instanceof StateFileError) {
      process.stderr.write(`tf-import-blocks: ${err.message}\n`);
      process.exitCode = EXIT_UNREADABLE_STATE;
      return;
    }
    // Not something the user did. Print the stack: a bug here should be
    // reportable, and the message alone rarely is.
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = EXIT_USAGE;
  },
);
