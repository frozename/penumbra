import { homedir } from 'node:os';
import { join } from 'node:path';

export const Branding = {
  name: 'Penumbra',
  slug: 'penumbra',
  envPrefix: 'PENUMBRA',
  storageRoot: join(homedir(), '.penumbra'),
} as const;
