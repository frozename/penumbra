import type { FilterContrib } from './index.js';
export function fileFilter(file: string | undefined, col = 'file_paths'): FilterContrib | null {
  return file ? { sql: `${col} LIKE '%' || ? || '%'`, params: [file] } : null;
}
