/**
 * How to read `test/fixtures/awkward.expected.tf`.
 *
 * Not a `*.test.ts`, so the test glob does not run it. It exists because two
 * tests now assert against that one golden — `golden.test.ts` through the
 * library and `cli.test.ts` through the built binary — and the annotation rule
 * below is a property of the *file*, not of either test. A second copy of it
 * would be a second thing to keep in step, and the failure if they drifted
 * would be one test passing and the other failing on identical output.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export const readFixture = (name: string): string =>
  readFileSync(path.join(FIXTURES, name), 'utf8');

/**
 * `##` lines in the golden are annotations — provider doc citations and notes
 * for whoever reads it next — and are not part of the expected output. Nothing
 * else is touched: blank lines and single-`#` comments are compared.
 */
export function stripAnnotations(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.startsWith('##'))
    .join('\n');
}

/** The golden output, as the generators are expected to produce it. */
export const expectedGolden = (): string => stripAnnotations(readFixture('awkward.expected.tf'));
