import { sha256 } from '@/lib/util/hash';
import { jobKey } from './jobs';

/**
 * The app's id for a role: its company and normalized title (`jobKey`),
 * hashed. Stable across runs, so a role keeps its id as founders mention it
 * month after month. Apart from `jobs.ts` because hashing is server-side.
 */
export function jobId(company: string, title: string): string {
  return `job-${sha256(jobKey(company, title)).slice(0, 16)}`;
}
