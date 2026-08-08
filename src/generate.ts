/**
 * The engine behind the `tf-import-blocks` command: state files in, one HCL
 * document and a counts-only summary out.
 *
 * This is a thin adapter over the library half of the same package. Every
 * import id comes from the per-type rule table in `rules/`, never from this
 * file. The rule table is the point: a resource's import id is **not** its `id`
 * attribute for a large fraction of a real state (`aws_sqs_queue` imports by
 * queue URL, `aws_lambda_function` by function name, `aws_route` by
 * `<route-table>_<destination>`), and the naive reading is wrong quietly.
 *
 * It is deliberately separate from `cli.ts`. `cli.ts` owns argument parsing,
 * streams and exit codes; everything here is a pure-ish function a test can
 * call directly, and none of it writes to stdout or stderr or exits.
 *
 * Nothing here is part of the package's public API — `exports` in
 * `package.json` surfaces `index.ts` and nothing else, so these names are
 * reachable only from inside the package and from the binary. That is
 * intentional: the CLI's shape should stay free to change without a major
 * version, and `importsFromState` is already the supported way to do this from
 * code.
 *
 * Two rules govern the output plumbing, and `cli.ts` enforces them:
 *
 *   - **HCL to stdout, summary to stderr.** stdout is expected to be redirected
 *     into a `.tf` file, so a single line of prose on it corrupts the result.
 *   - **Only identifiers leave the state file** (decision 6). Rules *read*
 *     attributes to compute an import id; the emitter writes the computed id
 *     and the address, and nothing else. The summary below deliberately reports
 *     only counts, terraform types and addresses — never an attribute value,
 *     and not even an import id, because stderr is frequently the thing that
 *     ends up pasted into a ticket.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { emitBlocks } from './emit.js';
import { parseStateFile, resolveStateResource, type ParsedStateFile } from './from-state.js';
import { ruleForType } from './rules/registry.js';
import type { ResolvedImport } from './types.js';

/**
 * A state file could not be read, was not JSON, or was not a Terraform state.
 *
 * A distinct class rather than a plain `Error` so `cli.ts` can answer with exit
 * code 2 — "your input was unusable" — without matching on message text, and
 * so anything else escaping this module is recognisable as a defect in the
 * package rather than a problem with the file the user passed.
 */
export class StateFileError extends Error {}

export interface GenerateOptions {
  /** State files, relative to `cwd` or absolute. Raw v4 or `terraform show -json`. */
  readonly files: readonly string[];
  /** Emit only addresses starting with this prefix, e.g. `module.net.`. */
  readonly filter?: string | undefined;
  /** Where the user invoked the command — npm scripts run from the package dir. */
  readonly cwd: string;
}

/**
 * Counts only. Every field here is safe to print: numbers, terraform types and
 * Terraform addresses, all of which are already public in the generated HCL.
 */
export interface GenerateSummary {
  readonly files: number;
  /** Blocks actually emitted, after `--filter`. */
  readonly total: number;
  /** Blocks whose id a rule computed. */
  readonly viaRule: number;
  /** Blocks that fell back to the state id and carry `# VERIFY`. */
  readonly fallback: number;
  /**
   * Blocks for types with no documented import at all. Emitted (decision 5
   * forbids dropping a resource during a state move) but they will not apply,
   * which is a different problem from "we don't know the id" and is counted
   * separately so it can be acted on differently.
   */
  readonly notImportable: number;
  /**
   * Blocks whose source object is tainted. Emitted and counted as resolved —
   * taint is state metadata, so the id is real and the import is sound — but
   * the source configuration destroys and recreates the object on its next
   * apply, which is worth knowing before a move rather than after. Counted over
   * the blocks actually emitted, not over the parse, because unlike a skip a
   * tainted object *is* in the output and `--filter` can remove it.
   */
  readonly tainted: number;
  /** Distinct types among fallbacks that have no state rule. */
  readonly noRuleTypes: readonly string[];
  /** Distinct types whose rule ran but could not compute an id from this state. */
  readonly unresolvedTypes: readonly string[];
  /** Distinct types registered as explicitly not importable. */
  readonly notImportableTypes: readonly string[];
  /** Instances dropped as deposed — the orphan half of an interrupted replace. */
  readonly skippedDeposed: number;
  /** `mode: "data"` (decision 11). */
  readonly skippedDataSources: number;
  /** Resources from another provider (decision 11). */
  readonly skippedNonAws: number;
  /** Blocks withheld by `--filter`. */
  readonly filteredOut: number;
  /** Addresses emitted more than once — invalid HCL, so it must be shouted about. */
  readonly duplicateAddresses: readonly string[];
}

export interface GenerateResult {
  readonly hcl: string;
  readonly summary: GenerateSummary;
}

/**
 * The shorter of the relative and absolute forms. A state file is routinely
 * somewhere else entirely — /tmp, a sibling repo — where the relative form is a
 * stack of `../` that is harder to read than the path the user typed. Used for
 * parse-error labels and for the `--out` confirmation.
 */
export function displayPath(abs: string, cwd: string): string {
  const rel = path.relative(cwd, abs);
  return rel === '' || rel.startsWith('..') ? abs : rel;
}

type Bucket = 'viaRule' | 'notImportable' | 'unresolved' | 'noRule';

/**
 * Which of `resolveStateResource`'s three answers produced this block.
 *
 * The branch order mirrors that function exactly: `notImportable` is checked
 * before `verified`, and a rule that exists but returned `undefined` is a
 * different report from a type no rule module claims.
 */
function classify(item: ResolvedImport): Bucket {
  const rule = ruleForType(item.type);
  if (rule?.notImportable !== undefined) return 'notImportable';
  if (item.verified) return 'viaRule';
  return rule?.fromState !== undefined ? 'unresolved' : 'noRule';
}

function sorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort();
}

/**
 * Read every state file, resolve every resource, emit one HCL document.
 *
 * Ordering is by address across the whole batch so re-running produces a stable
 * diff. That comparator must stay identical to the one inside
 * `importsFromState`, because `test/cli.test.ts` asserts the command reproduces
 * `test/fixtures/awkward.expected.tf` byte for byte and would otherwise be the
 * only thing standing between the two paths and a silent divergence.
 *
 * A file that cannot be read or parsed throws, with the path in the message.
 * `cli.ts` turns that into exit code 2.
 */
export async function generate(opts: GenerateOptions): Promise<GenerateResult> {
  const resolved: ResolvedImport[] = [];
  // `ResolvedImport` carries no tainted flag — the state parser exposes the
  // count as `ParsedStateFile.tainted` and the taint itself only reaches the
  // output as a comment. Identity is the honest join: `resolveStateResource`
  // returns a fresh object per resource, so this set survives the sort and the
  // filter without matching on comment text or on an address that two states
  // can share.
  const taintedItems = new Set<ResolvedImport>();
  let skippedDeposed = 0;
  let skippedDataSources = 0;
  let skippedNonAws = 0;

  for (const file of opts.files) {
    const abs = path.resolve(opts.cwd, file);
    const label = displayPath(abs, opts.cwd);
    const parsed = await loadState(abs, label);
    skippedDeposed += parsed.skipped.deposed;
    skippedDataSources += parsed.skipped.dataSources;
    skippedNonAws += parsed.skipped.nonAws;
    for (const res of parsed.resources) {
      const item = resolveStateResource(res);
      if (res.tainted === true) taintedItems.add(item);
      resolved.push(item);
    }
  }
  resolved.sort((a, b) => a.address.localeCompare(b.address));

  const prefix = opts.filter;
  const kept =
    prefix === undefined ? resolved : resolved.filter((i) => i.address.startsWith(prefix));

  const counts: Record<Bucket, number> = { viaRule: 0, notImportable: 0, unresolved: 0, noRule: 0 };
  const noRuleTypes: string[] = [];
  const unresolvedTypes: string[] = [];
  const notImportableTypes: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];
  let tainted = 0;
  for (const item of kept) {
    const bucket = classify(item);
    counts[bucket] += 1;
    if (taintedItems.has(item)) tainted += 1;
    if (bucket === 'noRule') noRuleTypes.push(item.type);
    else if (bucket === 'unresolved') unresolvedTypes.push(item.type);
    else if (bucket === 'notImportable') notImportableTypes.push(item.type);
    // A state address is authoritative and the emitter never renames it, so two
    // states contributing the same address produce HCL Terraform will reject.
    if (seen.has(item.address)) duplicates.push(item.address);
    seen.add(item.address);
  }

  return {
    hcl: emitBlocks(kept),
    summary: {
      files: opts.files.length,
      total: kept.length,
      viaRule: counts.viaRule,
      fallback: counts.noRule + counts.unresolved,
      notImportable: counts.notImportable,
      tainted,
      noRuleTypes: sorted(noRuleTypes),
      unresolvedTypes: sorted(unresolvedTypes),
      notImportableTypes: sorted(notImportableTypes),
      skippedDeposed,
      skippedDataSources,
      skippedNonAws,
      filteredOut: resolved.length - kept.length,
      duplicateAddresses: sorted(duplicates),
    },
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Read, parse and validate one state file, naming the file in every failure.
 *
 * Node's own messages are nearly right and not quite: `ENOENT: no such file or
 * directory, open '/long/abs/path'` buries the path the user typed, and
 * `JSON.parse`'s `Unexpected token } in JSON at position 4211` names no file at
 * all — which, given the command takes several, is the difference between a
 * fixable error and a hunt. The parse case is the one that actually happens:
 * `terraform state pull > f.tfstate` in a shell that also wrote something to
 * stdout produces a file that is very nearly JSON.
 */
async function loadState(abs: string, label: string): Promise<ParsedStateFile> {
  let text: string;
  try {
    text = await readFile(abs, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new StateFileError(`${label}: no such file`);
    if (code === 'EISDIR') throw new StateFileError(`${label}: is a directory, not a state file`);
    throw new StateFileError(`${label}: ${message(err)}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new StateFileError(
      `${label}: not valid JSON — ${message(err)}\n` +
        '  a state file is JSON; pass a *.tfstate, `terraform state pull` output or ' +
        '`terraform show -json` output',
    );
  }

  try {
    return parseStateFile(json, label);
  } catch (err) {
    // Every message `parseStateFile` raises already begins with the label, so
    // this only changes the class.
    throw new StateFileError(message(err));
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * The stderr summary, as lines. Zero-valued lines are omitted — except the
 * headline and the rule-coverage line, which are the two numbers a reader needs
 * even when they are boring.
 */
export function formatSummary(s: GenerateSummary): string[] {
  const lines = [
    `tf-import-blocks: ${plural(s.total, 'block')} from ${plural(s.files, 'state file')}`,
    `  ${s.viaRule} resolved by a rule`,
  ];
  if (s.fallback > 0) {
    lines.push(`  ${s.fallback} fell back to the state id, flagged # VERIFY`);
    if (s.noRuleTypes.length > 0) lines.push(`    no rule: ${s.noRuleTypes.join(', ')}`);
    if (s.unresolvedTypes.length > 0) {
      lines.push(`    rule could not compute an id: ${s.unresolvedTypes.join(', ')}`);
    }
  }
  if (s.notImportable > 0) {
    // Not a fallback: we know the id is unusable, rather than not knowing the
    // id. The block is emitted so the resource is not lost from a state move,
    // but it will not apply and the operator has to recreate it by hand.
    lines.push(
      `  ${s.notImportable} not importable at all — emitted but will not apply: ` +
        s.notImportableTypes.join(', '),
    );
  }
  if (s.tainted > 0) {
    // The opposite conclusion to the deposed line below, and they read as a
    // pair when a state has both: deposed is skipped because the object is
    // already doomed and duplicated, tainted is emitted because it is the only
    // object at its address and its id is real.
    lines.push(
      `  ${plural(s.tainted, 'tainted object')} in the source state — emitted, not skipped`,
      '    taint is state metadata and does not travel with the resource, so the id is',
      '    real and the import is sound; the source configuration will still destroy',
      '    and recreate the object on its next apply unless it is removed there first',
    );
  }
  if (s.filteredOut > 0) lines.push(`  ${s.filteredOut} withheld by --filter`);

  const skips: string[] = [];
  if (s.skippedDeposed > 0) skips.push(plural(s.skippedDeposed, 'deposed instance'));
  if (s.skippedDataSources > 0) skips.push(plural(s.skippedDataSources, 'data source'));
  if (s.skippedNonAws > 0) skips.push(plural(s.skippedNonAws, 'non-aws resource'));
  if (skips.length > 0) lines.push(`  skipped: ${skips.join(', ')}`);
  if (s.skippedDeposed > 0) {
    lines.push(
      '    a deposed instance is the orphan of an interrupted create-before-destroy;',
      '    it shares its address with the live object and is scheduled for destruction',
    );
  }
  if (s.duplicateAddresses.length > 0) {
    lines.push(
      `  WARNING: ${plural(s.duplicateAddresses.length, 'address')} emitted more than once — ` +
        'the output is not valid HCL as it stands:',
      ...s.duplicateAddresses.map((a) => `    ${a}`),
    );
  }
  return lines;
}

/** Write the HCL where the user asked, creating the parent directory if needed. */
export async function writeBlocks(hcl: string, out: string, cwd: string): Promise<string> {
  const abs = path.resolve(cwd, out);
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, hcl, 'utf8');
  return abs;
}
