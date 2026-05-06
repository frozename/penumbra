import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Writes a bootstrap projects.yaml to a temp dir and returns the path.
 * Each project's root_path comes from PENUMBRA_TEST_<ID>_ROOT if set,
 * else falls back to /tmp/<id>.
 */
export function writeBootstrapRegistry(tmpRoot?: string): string {
  const dir = tmpRoot ?? mkdtempSync(join(tmpdir(), 'penumbra-bootstrap-'));
  const path = join(dir, 'projects.yaml');
  const projectIds = ['penumbra', 'sirius', 'embersynth', 'nova', 'llamactl'];
  const lines = ['projects:'];
  for (const id of projectIds) {
    const envKey = `PENUMBRA_TEST_${id.toUpperCase()}_ROOT`;
    const root = process.env[envKey] ?? `/tmp/${id}`;
    lines.push(`  - project_id: ${id}`);
    lines.push(`    root_path: ${root}`);
  }
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}
