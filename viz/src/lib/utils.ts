import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** shadcn's canonical class combiner: conditional classes via clsx, then
 *  tailwind-merge resolves conflicting Tailwind utilities (last one wins) so a
 *  caller's `className` override actually overrides. Every shadcn component
 *  generated into src/components/ui/ imports this. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
