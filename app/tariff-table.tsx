"use client";

import { useDeferredValue, useEffect, useMemo, useState } from "react";

// [city_key, city, city_en, year, category_key, label, code, zone, building_type,
//  size_from, size_to, rate, notes, source_index, review_reason]
export type Row = [
  string, string, string, number, string, string, string, string, string,
  number | null, number | null, number, string, number, string,
];

type SortKey = "city" | "year" | "category" | "label" | "zone" | "size" | "rate";

const PAGE = 100;
const ils = new Intl.NumberFormat("he-IL", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

function sizeBand(from: number | null, to: number | null) {
  if (from === null && to === null) return "";
  if (to === null) return `מעל ${from} מ״ר`;
  if (from === null || from === 0) return `עד ${to} מ״ר`;
  return `${from} עד ${to} מ״ר`;
}

export default function TariffTable(props: {
  rows: Row[];
  sources: string[];
  years: number[];
  categories: { key: string; he: string; en: string }[];
}) {
  const { rows, sources, years, categories } = props;
  const [city, setCity] = useState("");
  const [year, setYear] = useState("latest");
  const [category, setCategory] = useState("");
  const [text, setText] = useState("");
  const [showFlagged, setShowFlagged] = useState(false);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "city", dir: 1 });
  const [limit, setLimit] = useState(PAGE);

  // Shareable state: read the query string once, then mirror changes into it.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    setCity(p.get("city") ?? "");
    setYear(p.get("year") ?? "latest");
    setCategory(p.get("category") ?? "");
    setText(p.get("q") ?? "");
    setShowFlagged(p.get("flagged") === "1");
  }, []);
  useEffect(() => {
    const p = new URLSearchParams();
    if (city) p.set("city", city);
    if (year !== "latest") p.set("year", year);
    if (category) p.set("category", category);
    if (text) p.set("q", text);
    if (showFlagged) p.set("flagged", "1");
    const qs = p.toString();
    window.history.replaceState(null, "", qs ? `?${qs}` : window.location.pathname);
    setLimit(PAGE);
  }, [city, year, category, text, showFlagged]);

  const cityQ = useDeferredValue(city.trim().toLowerCase());
  const textQ = useDeferredValue(text.trim().toLowerCase());
  const catLabel = useMemo(() => new Map(categories.map((c) => [c.key, c])), [categories]);

  const cityNames = useMemo(() => {
    const m = new Map<string, [string, string]>();
    for (const r of rows) m.set(r[0], [r[1], r[2]]);
    return [...m.values()].sort((a, b) => a[0].localeCompare(b[0], "he"));
  }, [rows]);

  const latestYear = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) m.set(r[0], Math.max(m.get(r[0]) ?? 0, r[3]));
    return m;
  }, [rows]);

  const filtered = useMemo(() => {
    const out = rows.filter((r) => {
      if (!showFlagged && r[14]) return false;
      if (year === "latest" ? latestYear.get(r[0]) !== r[3] : String(r[3]) !== year) return false;
      if (category && r[4] !== category) return false;
      if (cityQ && !r[1].toLowerCase().includes(cityQ) && !r[2].toLowerCase().includes(cityQ)) return false;
      if (textQ && ![r[5], r[6], r[8], r[12]].some((v) => v.toLowerCase().includes(textQ))) return false;
      return true;
    });
    const { key, dir } = sort;
    const cmp: Record<SortKey, (a: Row, b: Row) => number> = {
      city: (a, b) => a[1].localeCompare(b[1], "he"),
      year: (a, b) => a[3] - b[3],
      category: (a, b) => a[4].localeCompare(b[4]),
      label: (a, b) => a[5].localeCompare(b[5], "he"),
      zone: (a, b) => a[7].localeCompare(b[7], "he", { numeric: true }),
      size: (a, b) => (a[9] ?? -1) - (b[9] ?? -1),
      rate: (a, b) => a[11] - b[11],
    };
    return out.sort((a, b) => dir * cmp[key](a, b) || a[1].localeCompare(b[1], "he") || a[11] - b[11]);
  }, [rows, showFlagged, year, category, cityQ, textQ, sort, latestYear]);

  const visibleCities = new Set(filtered.map((r) => r[0])).size;

  function header(key: SortKey, label: string, className?: string) {
    const active = sort.key === key;
    return (
      <th className={className}>
        <button
          type="button"
          className={active ? "sort active" : "sort"}
          onClick={() => setSort({ key, dir: active ? (sort.dir === 1 ? -1 : 1) : key === "rate" ? -1 : 1 })}
        >
          {label}
          {active ? (sort.dir === 1 ? " ↑" : " ↓") : ""}
        </button>
      </th>
    );
  }

  function downloadCsv() {
    const cols = [
      "city_key", "city_name", "city_name_en", "year", "category_key", "category_label", "code", "zone",
      "building_type", "size_from", "size_to", "rate_per_sqm", "notes", "source_url", "review_reason",
    ];
    const cell = (v: unknown) => {
      const s = v === null || v === undefined ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [cols.join(",")];
    for (const r of filtered) {
      lines.push(
        [...r.slice(0, 13), r[13] >= 0 ? sources[r[13]] : "", r[14]].map(cell).join(","),
      );
    }
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "arnona-tariffs.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  }

  const apiHref = (() => {
    const p = new URLSearchParams();
    if (city) {
      const match = cityNames.find(([he, en]) => he === city || en === city);
      p.set("city", match ? match[0] : city);
    }
    p.set("year", year);
    if (category) p.set("category", category);
    if (text) p.set("q", text);
    if (showFlagged) p.set("include_flagged", "true");
    return `/api/v1/tariffs?${p}`;
  })();

  return (
    <section className="table-card">
      <div className="filters">
        <label className="field grow">
          <span>רשות מקומית · City</span>
          <input
            list="city-list"
            value={city}
            onChange={(e) => setCity(e.target.value)}
            placeholder="הקלידו לסינון — ירושלים, Eilat…"
            autoComplete="off"
          />
          <datalist id="city-list">
            {cityNames.map(([he, en]) => (
              <option key={he} value={he}>{en}</option>
            ))}
          </datalist>
        </label>
        <label className="field">
          <span>שנה · Year</span>
          <select value={year} onChange={(e) => setYear(e.target.value)}>
            <option value="latest">העדכנית לכל רשות · latest</option>
            {years.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>סוג נכס · Use</span>
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">הכול · all</option>
            {categories.map((c) => (
              <option key={c.key} value={c.key}>{c.he} · {c.en}</option>
            ))}
          </select>
        </label>
        <label className="field grow">
          <span>חיפוש בסיווג · Classification</span>
          <input value={text} onChange={(e) => setText(e.target.value)} placeholder="בנקים, חניון, 3.1…" />
        </label>
      </div>
      <div className="toolbar">
        <span className="count">
          {filtered.length.toLocaleString("en-US")} תעריפים ב-{visibleCities} רשויות
        </span>
        <label className="check">
          <input type="checkbox" checked={showFlagged} onChange={(e) => setShowFlagged(e.target.checked)} />
          הצג גם שורות שסומנו לבדיקה
        </label>
        <span className="spacer" />
        <a className="btn ghost" href={apiHref} target="_blank" rel="noreferrer">JSON API</a>
        <button type="button" className="btn" onClick={downloadCsv} disabled={!filtered.length}>
          הורדת CSV
        </button>
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              {header("city", "רשות")}
              {header("year", "שנה")}
              {header("category", "סוג")}
              {header("label", "סיווג בצו")}
              <th>סמל</th>
              {header("zone", "אזור")}
              <th>סוג בניין</th>
              {header("size", "שטח")}
              {header("rate", "₪ למ״ר לשנה", "num")}
              <th className="num">₪ למ״ר לחודש</th>
              <th>מקור</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, limit).map((r, i) => {
              const cat = catLabel.get(r[4]);
              return (
                <tr key={i} className={r[14] ? "flagged" : undefined}>
                  <td className="city">
                    {r[1]}
                    {r[2] ? <small dir="ltr">{r[2]}</small> : null}
                  </td>
                  <td>{r[3]}</td>
                  <td><span className="chip">{cat?.he ?? r[4]}</span></td>
                  <td className="label">
                    {r[5]}
                    {r[12] ? <small>{r[12]}</small> : null}
                    {r[14] ? <small className="warn">⚠ לבדיקה: {r[14]}</small> : null}
                  </td>
                  <td>{r[6]}</td>
                  <td>{r[7] || "כל העיר"}</td>
                  <td>{r[8]}</td>
                  <td>{sizeBand(r[9], r[10])}</td>
                  <td className="num rate">{ils.format(r[11])}</td>
                  <td className="num">{ils.format(r[11] / 12)}</td>
                  <td>
                    {r[13] >= 0 ? (
                      <a href={sources[r[13]]} target="_blank" rel="noreferrer">צו {r[3]}</a>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!filtered.length ? <p className="empty">אין תעריפים שתואמים לסינון.</p> : null}
      </div>
      {filtered.length > limit ? (
        <div className="more">
          <button type="button" className="btn ghost" onClick={() => setLimit((l) => l + PAGE * 5)}>
            הצג עוד ({(filtered.length - limit).toLocaleString("en-US")} נותרו)
          </button>
        </div>
      ) : null}
    </section>
  );
}
