/** The one link style, so every page's links look and focus the same (#8). */
export const linkClass = 'text-blue-800 underline hover:no-underline';

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
