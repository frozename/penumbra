import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

/**
 * Pull every `--attach <path>` and `--attach=<path>` from argv, in argv order.
 * Pairs without a value are skipped.
 */
export function parseAttachFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--attach') {
      const next = argv[i + 1];
      // Values starting with '-' are usually flags. To avoid accidental
      // consumption (e.g. `--attach --auto`), the space-form only accepts
      // non-hyphenated values. Use `--attach=<path>` for hyphenated filenames.
      if (next !== undefined && !next.startsWith('-')) {
        out.push(next);
        i++;
      }
      continue;
    }

    if (arg.startsWith('--attach=')) {
      const value = arg.slice('--attach='.length);
      if (value.length > 0) out.push(value);
    }
  }
  return out;
}

/**
 * Build a preamble string of attached file contents, formatted with the same
 * `--- File: <basename> ---` header template used by llama-server's webui.
 * Returns '' when the list is empty so the caller can unconditionally prepend.
 */
export function buildAttachmentPreamble(paths: string[]): string {
  if (paths.length === 0) return '';
  const parts: string[] = [];
  for (const p of paths) {
    if (!existsSync(p)) {
      throw new Error(`--attach: file not found: ${p}`);
    }
    const name = basename(p);
    const content = readFileSync(p, 'utf8');
    parts.push(`\n\n--- File: ${name} ---\n${content}`);
  }
  return parts.join('') + '\n\n';
}
