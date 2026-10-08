// Private download relay for the open scraper (scraper/lib/arnona-source-relay.mjs).
//
// Some municipal hosts block residential/foreign networks with a firewall
// challenge. This route fetches ONLY documents the registry already records for
// that authority (verified_source url/extra_urls, last_doc_url), and only for a
// caller holding ARNONA_RELAY_TOKEN — it is not an open proxy.

import { readFileSync } from "node:fs";
import { join } from "node:path";

export const runtime = "nodejs";
export const maxDuration = 60;

interface RegistryRow {
  key: string;
  last_doc_url?: string | null;
  verified_source?: { url?: string; extra_urls?: string[] } | null;
}

let registry: Map<string, RegistryRow> | null = null;
function allowed(cityKey: string, url: string) {
  registry ??= new Map(
    (JSON.parse(readFileSync(join(process.cwd(), "scraper", "state", "registry.json"), "utf8")) as RegistryRow[])
      .map((row) => [row.key, row]),
  );
  const row = registry.get(cityKey);
  if (!row) return false;
  const urls = [row.last_doc_url, row.verified_source?.url, ...(row.verified_source?.extra_urls ?? [])];
  return urls.some((u) => u && u === url);
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
  + "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export async function GET(request: Request) {
  const token = process.env.ARNONA_RELAY_TOKEN;
  if (!token || request.headers.get("authorization") !== `Bearer ${token}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const p = new URL(request.url).searchParams;
  const cityKey = p.get("city_key") ?? "";
  const url = p.get("url") ?? "";
  if (!/^https?:\/\//.test(url) || !allowed(cityKey, url)) {
    return new Response("url is not a recorded source for this authority", { status: 403 });
  }
  const upstream = await fetch(url, {
    redirect: "follow",
    headers: { "user-agent": UA, "accept-language": "he-IL,he;q=0.9,en;q=0.8" },
    signal: AbortSignal.timeout(50_000),
  }).catch((e: unknown) => new Response(String(e), { status: 502 }));
  if (!upstream.ok || !upstream.body) {
    return new Response(`upstream ${upstream.status}`, { status: 502 });
  }
  return new Response(upstream.body, {
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
    },
  });
}
