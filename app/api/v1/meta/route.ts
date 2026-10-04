import { CATEGORIES, dataset } from "@/lib/data";
import { json, preflight } from "@/lib/http";

export const OPTIONS = preflight;

export function GET() {
  const { meta, tariffs } = dataset();
  const years = [...new Set(tariffs.map((t) => t.year))].sort();
  return json({ ...meta, years, categories: CATEGORIES, docs: "/docs", openapi: "/api/v1/openapi.json" });
}
