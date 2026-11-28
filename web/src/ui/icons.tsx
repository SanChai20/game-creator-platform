// The line icons the shell uses. Decorative: the label beside each one carries the meaning.
import type { ReactNode } from 'react';

export type IconKind = 'store' | 'grid' | 'spark' | 'user' | 'sun' | 'moon' | 'book' | 'desk' | 'list' | 'shelf' | 'shield';
const PATHS: Record<IconKind, ReactNode> = {
  store: <><path d="M3 8.5 10 3l7 5.5V16a1 1 0 0 1-1 1h-3.5v-5h-5v5H4a1 1 0 0 1-1-1Z" /></>,
  grid: <><rect x="3" y="3" width="5.5" height="5.5" rx="1.2" /><rect x="11.5" y="3" width="5.5" height="5.5" rx="1.2" /><rect x="3" y="11.5" width="5.5" height="5.5" rx="1.2" /><rect x="11.5" y="11.5" width="5.5" height="5.5" rx="1.2" /></>,
  spark: <><path d="M10 2.5 11.8 8.2 17.5 10l-5.7 1.8L10 17.5l-1.8-5.7L2.5 10l5.7-1.8Z" /></>,
  user: <><circle cx="10" cy="7" r="3.2" /><path d="M3.5 17c.6-3.2 3.2-5 6.5-5s5.9 1.8 6.5 5" /></>,
  sun: <><circle cx="10" cy="10" r="3.4" /><path d="M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M4.3 15.7l1.4-1.4M14.3 5.7l1.4-1.4" /></>,
  moon: <><path d="M16.5 11.8A6.8 6.8 0 0 1 8.2 3.5a6.8 6.8 0 1 0 8.3 8.3Z" /></>,
  book: <><path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H16v12H5.5A1.5 1.5 0 0 0 4 16.5Z" /><path d="M4 16.5A1.5 1.5 0 0 0 5.5 18H16v-3" /></>,
  list: <><path d="M7 5h10M7 10h10M7 15h10" /><circle cx="3.6" cy="5" r=".9" /><circle cx="3.6" cy="10" r=".9" /><circle cx="3.6" cy="15" r=".9" /></>,
  shelf: <><rect x="3" y="3.5" width="3.4" height="13" rx=".8" /><rect x="7.6" y="3.5" width="3.4" height="13" rx=".8" /><path d="m12.6 4.6 3.2-.9 2.6 12.4-3.2.8Z" /></>,
  desk: <><rect x="3" y="4" width="14" height="9.5" rx="1.5" /><path d="M7 17h6M10 13.5V17" /></>,
  shield: <><path d="M10 2.8 16 5v4.6c0 3.7-2.5 6.5-6 7.6-3.5-1.1-6-3.9-6-7.6V5Z" /><path d="m7.4 10 1.8 1.8 3.4-3.6" /></>,
};
export const Icon = ({ kind }: { kind: IconKind }) => <svg className="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{PATHS[kind]}</svg>;
