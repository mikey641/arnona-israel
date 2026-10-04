import { citiesByKey, queryTariffs, toCsv } from "@/lib/data";
import { CACHE, json, preflight } from "@/lib/http";

export const OPTIONS = preflight;

export function GET(request: Request) {
  const p = new URL(request.url).searchParams;
  const { tariffs, error } = queryTariffs({
    city: p.get("city"),
    year: p.get("year"),
    category: p.get("category"),
    zone: p.get("zone"),
    q: p.get("q"),
    include_flagged: p.get("include_flagged") === "true",
  });
  if (error) return json({ error }, 404);

  if (p.get("format") === "csv") {
    return new Response(toCsv(tariffs), {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": 'attachment; filename="arnona-tariffs.csv"',
        "cache-control": CACHE,
        "access-control-allow-origin": "*",
      },
    });
  }

  const limit = Math.min(Math.max(Number(p.get("limit") ?? 1000) || 1000, 1), 10000);
  const offset = Math.max(Number(p.get("offset") ?? 0) || 0, 0);
  const cities = citiesByKey();
  const page = tariffs.slice(offset, offset + limit).map((t) => ({
    ...t,
    city_name: cities.get(t.city_key)?.name ?? null,
    city_name_en: cities.get(t.city_key)?.name_en ?? null,
    rate_per_sqm_monthly: Math.round((t.rate_per_sqm / 12) * 100) / 100,
  }));
  return json({
    total: tariffs.length,
    offset,
    limit,
    next_offset: offset + limit < tariffs.length ? offset + limit : null,
    unit: "ILS per square metre per year (as printed in the municipal order)",
    tariffs: page,
  });
}
