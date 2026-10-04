import { CATEGORIES, dataset } from "@/lib/data";
import TariffTable, { type Row } from "./tariff-table";

export const dynamic = "force-static";

export default function Home() {
  const { cities, tariffs, meta } = dataset();
  const byKey = new Map(cities.map((c) => [c.key, c]));

  // Compact client payload: source URLs repeat per city-year, so send each once.
  const sources: string[] = [];
  const sourceIndex = new Map<string, number>();
  const rows: Row[] = tariffs.map((t) => {
    let s = -1;
    if (t.source_url) {
      s = sourceIndex.get(t.source_url) ?? sources.push(t.source_url) - 1;
      sourceIndex.set(t.source_url, s);
    }
    const c = byKey.get(t.city_key);
    return [
      t.city_key, c?.name ?? t.city_key, c?.name_en ?? "", t.year, t.category_key, t.category_label,
      t.code ?? "", t.zone ?? "", t.building_type ?? "", t.size_from, t.size_to, t.rate_per_sqm,
      t.notes ?? "", s, t.needs_review ? (t.review_reason ?? "flagged") : "",
    ];
  });
  const years = [...new Set(tariffs.map((t) => t.year))].sort((a, b) => b - a);
  const withRates = cities.filter((c) => c.tariff_count > 0).length;

  return (
    <>
      <section className="hero">
        <h1>כל תעריפי הארנונה בישראל</h1>
        <p className="lede">
          תעריף לשנה לכל מ״ר, לפי רשות מקומית, סוג שימוש, אזור, סוג בניין וגודל — עם קישור לצו הארנונה הרשמי
          שממנו נלקח כל תעריף.
        </p>
        <p className="lede en" dir="ltr">
          Every Israeli Arnona (municipal property tax) rate per m² per year — by authority, use, zone, building
          class and size band — linked to the official order it came from. Free JSON/CSV API, no key.
        </p>
        <div className="stats">
          <div><b>{withRates}</b><span>רשויות עם תעריפים · of {cities.length}</span></div>
          <div><b>{tariffs.length.toLocaleString("en-US")}</b><span>תעריפים · rates</span></div>
          <div><b>{years.join(", ")}</b><span>שנים · years</span></div>
          <div>
            <b>{new Date(meta.synced_at).toLocaleDateString("he-IL")}</b>
            <span>עדכון אחרון · last sync</span>
          </div>
        </div>
      </section>
      <TariffTable rows={rows} sources={sources} years={years} categories={CATEGORIES} />
    </>
  );
}
