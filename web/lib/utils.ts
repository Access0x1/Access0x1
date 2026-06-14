/**
 * utils.ts — the shadcn/ui `cn` class-name helper.
 *
 * `cn` merges conditional class lists (clsx) and de-conflicts Tailwind utilities
 * (tailwind-merge) so a later class wins over an earlier one in the same group
 * (e.g. `cn('px-2', 'px-4')` -> `px-4`). Every shadcn component composes through
 * this so callers can override styles by passing `className`.
 */
import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/** Merge + de-conflict Tailwind class names (shadcn standard). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}
