import { z } from 'zod';
export const TaskClassSchema = z.enum(['BOUNDARY', 'STANDARD', 'TRIVIAL']);
export type TaskClass = z.infer<typeof TaskClassSchema>;
