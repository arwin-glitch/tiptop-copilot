import { sha256 } from '@/lib/util/hash';
import { studentKey, type StudentKind } from './students';

/**
 * The app's id for a students item: its kind, who it is about and the
 * program (`studentKey`), hashed. Stable across runs, so an item keeps its id
 * as the scan sees it again. Apart from `students.ts` because hashing is
 * server-side.
 */
export function studentId(kind: StudentKind, who: string, program: string | null): string {
  return `student-${sha256(studentKey(kind, who, program)).slice(0, 16)}`;
}
