import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';

/** Pull every `--attach <path>` pair from argv, in argv order. Pairs without a value are skipped. */
export function parseAttachFlags(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--attach') {
      const next = argv[i + 1];
      // Values starting with '-' are usually flags. We only consume them as 
      // paths if they actually exist on disk, resolving the -file.txt edge case 
      // while preventing accidental consumption of the next flag (e.g. --auto).
      if (next !== undefined && (!next.startsWith('-') || existsSync(next))) {
        out.push(next);
        i++;
      }
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
