import { findCity, queryTariffs } from "@/lib/data";
import { json, preflight } from "@/lib/http";

export const OPTIONS = preflight;

export async function GET(request: Request, ctx: { params: Promise<{ key: string }> }) {
  const { key } = await ctx.params;
  const city = findCity(decodeURIComponent(key));
  if (!city) return json({ error: `unknown city: ${key}` }, 404);
  const p = new URL(request.url).searchParams;
  const { tariffs } = queryTariffs({
    city: city.key,
    year: p.get("year") ?? "latest",
    include_flagged: p.get("include_flagged") === "true",
  });
  return json({ city, tariffs });
}
