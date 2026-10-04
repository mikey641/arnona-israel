import { dataset } from "@/lib/data";
import { json, preflight } from "@/lib/http";

export const OPTIONS = preflight;

export function GET(request: Request) {
  const all = new URL(request.url).searchParams.get("all") === "true";
  const cities = dataset().cities.filter((c) => all || c.tariff_count > 0);
  return json({ total: cities.length, cities });
}
