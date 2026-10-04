import { CATEGORIES } from "@/lib/data";
import { json, preflight } from "@/lib/http";

export const OPTIONS = preflight;

export function GET() {
  return json({ categories: CATEGORIES });
}
