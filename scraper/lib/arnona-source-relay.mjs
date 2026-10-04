// Optional fetch relay for official PDFs that refuse direct downloads.
//
// A few municipal hosts block some networks (datacenter IPs, foreign IPs, or
// clients without an Israeli egress). If you run a small relay of your own —
// any HTTPS endpoint that accepts `?city_key=&year=&url=` and returns the PDF
// bytes — set ARNONA_RELAY_URL (and optionally ARNONA_RELAY_TOKEN, sent as a
// Bearer token). The relay is OFF by default.
//
// Only a source the registry already trusts (its last_doc_url or its
// doc_url_template for the requested year) is ever relayed, so a search lead can
// never route an arbitrary URL — or your relay token — through the relay.

function isConfiguredRelaySource(city, url, year) {
  return Boolean(city?.key && url) && (city.last_doc_url === url
    || (city.doc_url_template
      && city.doc_url_template.replaceAll("{year}", String(year)) === url));
}

/**
 * Build the relay request, or null when relaying is not allowed/configured.
 * The relay must be HTTPS so a token is never sent in clear text.
 */
export function arnonaSourceRelayRequest({ city, url, year, relayUrl, token = null }) {
  if (!relayUrl || !isConfiguredRelaySource(city, url, year)) return null;
  let base;
  try {
    base = new URL(String(relayUrl));
    if (base.protocol !== "https:") return null;
  } catch {
    return null;
  }
  for (const [key, value] of Object.entries({ city_key: city.key, year: String(year), url })) {
    base.searchParams.set(key, value);
  }
  const headers = { "user-agent": "Mozilla/5.0", accept: "application/pdf" };
  if (token) headers.authorization = `Bearer ${token}`;
  return { url: base.toString(), headers };
}

export async function fetchArnonaCandidateWithRelay({
  city,
  url,
  year,
  relayUrl = null,
  token = null,
  fetchBinary,
  isPdf,
}) {
  const direct = await fetchBinary(url, { binary: true });
  if (isPdf(direct)) {
    return { url: direct.url ?? url, buf: direct.buf, relayed: false };
  }

  if (!isConfiguredRelaySource(city, url, year)) return null;
  const directStatus = Number.isInteger(direct.status) ? direct.status : null;
  const relay = arnonaSourceRelayRequest({ city, url, year, relayUrl, token });
  if (!relay) {
    return { failure: { code: "source_access_failed", directStatus, relayStatus: null } };
  }
  const relayed = await fetchBinary(relay.url, {
    binary: true,
    headers: relay.headers,
    timeout: 60_000,
  });
  if (!isPdf(relayed)) {
    return {
      failure: {
        code: "source_access_failed",
        directStatus,
        relayStatus: Number.isInteger(relayed.status) ? relayed.status : null,
      },
    };
  }
  return { url, buf: relayed.buf, relayed: true };
}
