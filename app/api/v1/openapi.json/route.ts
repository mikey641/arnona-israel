import { CATEGORIES } from "@/lib/data";
import { json, preflight } from "@/lib/http";

export const OPTIONS = preflight;

const tariff = {
  type: "object",
  properties: {
    city_key: { type: "string", example: "tel-aviv" },
    city_name: { type: "string", example: "תל אביב-יפו" },
    city_name_en: { type: "string", nullable: true, example: "Tel Aviv - Yafo" },
    year: { type: "integer", example: 2026 },
    category_key: { type: "string", enum: CATEGORIES.map((c) => c.key) },
    category_label: { type: "string", description: "Classification exactly as printed in the order" },
    code: { type: "string", nullable: true, description: "Classification code (סמל), when printed" },
    zone: { type: "string", nullable: true, description: "Tax zone; null = all zones" },
    building_type: { type: "string", nullable: true, description: "Building class (סוג בנין), when the city uses one" },
    size_from: { type: "number", nullable: true, description: "Size band start, m² (inclusive)" },
    size_to: { type: "number", nullable: true, description: "Size band end, m²; null = unbounded" },
    rate_per_sqm: { type: "number", description: "ILS per m² per YEAR, as printed" },
    rate_per_sqm_monthly: { type: "number", description: "rate_per_sqm ÷ 12, rounded" },
    notes: { type: "string", nullable: true },
    source_url: { type: "string", nullable: true, description: "The official order this row was read from" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    needs_review: { type: "boolean", description: "Failed an automatic sanity check" },
    review_reason: { type: "string", nullable: true },
    updated_at: { type: "string", format: "date-time" },
  },
};

const spec = {
  openapi: "3.0.3",
  info: {
    title: "Arnona Israel API",
    version: "1.0.0",
    description:
      "Free, read-only API of Israeli municipal Arnona (property tax) rates extracted from each " +
      "authority's official annual tax order (צו ארנונה). No key required; CORS is open.",
    license: { name: "MIT (code), CC BY 4.0 (data)" },
  },
  paths: {
    "/api/v1/tariffs": {
      get: {
        summary: "Query tariff rows",
        parameters: [
          { name: "city", in: "query", schema: { type: "string" }, description: "City key, Hebrew or English name; comma-separated for several" },
          { name: "year", in: "query", schema: { type: "string" }, description: "Year, comma-separated years, or `latest` (newest year per city)" },
          { name: "category", in: "query", schema: { type: "string" }, description: "Category key(s), comma-separated" },
          { name: "zone", in: "query", schema: { type: "string" } },
          { name: "q", in: "query", schema: { type: "string" }, description: "Text search in classification, code, notes, building type" },
          { name: "include_flagged", in: "query", schema: { type: "boolean", default: false } },
          { name: "format", in: "query", schema: { type: "string", enum: ["json", "csv"], default: "json" } },
          { name: "limit", in: "query", schema: { type: "integer", default: 1000, maximum: 10000 } },
          { name: "offset", in: "query", schema: { type: "integer", default: 0 } },
        ],
        responses: {
          "200": {
            description: "Matching tariffs",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    total: { type: "integer" },
                    offset: { type: "integer" },
                    limit: { type: "integer" },
                    next_offset: { type: "integer", nullable: true },
                    tariffs: { type: "array", items: tariff },
                  },
                },
              },
              "text/csv": {},
            },
          },
          "404": { description: "Unknown city" },
        },
      },
    },
    "/api/v1/cities": {
      get: {
        summary: "Local authorities with rates (all=true for the full CBS registry)",
        parameters: [{ name: "all", in: "query", schema: { type: "boolean" } }],
        responses: { "200": { description: "Cities" } },
      },
    },
    "/api/v1/cities/{key}": {
      get: {
        summary: "One authority and its tariffs (latest year by default)",
        parameters: [
          { name: "key", in: "path", required: true, schema: { type: "string" } },
          { name: "year", in: "query", schema: { type: "string", default: "latest" } },
          { name: "include_flagged", in: "query", schema: { type: "boolean", default: false } },
        ],
        responses: { "200": { description: "City + tariffs" }, "404": { description: "Unknown city" } },
      },
    },
    "/api/v1/categories": { get: { summary: "Use categories", responses: { "200": { description: "Categories" } } } },
    "/api/v1/meta": { get: { summary: "Dataset coverage and sync time", responses: { "200": { description: "Meta" } } } },
  },
};

export function GET() {
  return json(spec);
}
