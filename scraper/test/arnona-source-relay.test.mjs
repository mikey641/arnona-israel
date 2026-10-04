import assert from "node:assert/strict";
import test from "node:test";
import {
  arnonaSourceRelayRequest,
  fetchArnonaCandidateWithRelay,
} from "../lib/arnona-source-relay.mjs";

const RELAY = "https://relay.example.org/arnona";
const city = () => ({
  key: "cbs-5545",
  last_doc_url: "https://www.alona.org.il/uploads/n/order.pdf",
  doc_url_template: null,
});

test("a configured blocked PDF can be requested through an opt-in relay", () => {
  assert.deepEqual(arnonaSourceRelayRequest({
    city: city(),
    url: "https://www.alona.org.il/uploads/n/order.pdf",
    year: 2026,
    relayUrl: RELAY,
    token: "relay-token",
  }), {
    url: "https://relay.example.org/arnona?city_key=cbs-5545&year=2026&url=https%3A%2F%2Fwww.alona.org.il%2Fuploads%2Fn%2Forder.pdf",
    headers: {
      authorization: "Bearer relay-token",
      "user-agent": "Mozilla/5.0",
      accept: "application/pdf",
    },
  });
});

test("the relay is off unless ARNONA_RELAY_URL is configured", () => {
  assert.equal(arnonaSourceRelayRequest({
    city: city(), url: city().last_doc_url, year: 2026, relayUrl: null,
  }), null);
});

test("a relay without a token sends no authorization header", () => {
  const relay = arnonaSourceRelayRequest({
    city: city(), url: city().last_doc_url, year: 2026, relayUrl: RELAY,
  });
  assert.equal(relay.headers.authorization, undefined);
});

test("an unconfigured discovery candidate never enters the relay", () => {
  assert.equal(arnonaSourceRelayRequest({
    city: city(),
    url: "https://www.alona.org.il/uploads/n/arbitrary.pdf",
    year: 2026,
    relayUrl: RELAY,
    token: "relay-token",
  }), null);
});

test("a template source for the requested year is relayable", () => {
  const relay = arnonaSourceRelayRequest({
    city: { key: "x", last_doc_url: null, doc_url_template: "https://a.muni.il/{year}.pdf" },
    url: "https://a.muni.il/2026.pdf",
    year: 2026,
    relayUrl: RELAY,
  });
  assert.ok(relay);
});

test("a token is never sent to a plain-http or malformed relay", () => {
  for (const relayUrl of ["http://relay.example.org", "not a url"]) {
    assert.equal(arnonaSourceRelayRequest({
      city: city(), url: city().last_doc_url, year: 2026, relayUrl, token: "relay-token",
    }), null);
  }
});

test("a configured source falls back to the relay and keeps the official source URL", async () => {
  const calls = [];
  const result = await fetchArnonaCandidateWithRelay({
    city: city(),
    url: "https://www.alona.org.il/uploads/n/order.pdf",
    year: 2026,
    relayUrl: RELAY,
    token: "relay-token",
    fetchBinary: async (url, options) => {
      calls.push({ url, options });
      if (calls.length === 1) return { ok: false, status: 403 };
      return { ok: true, type: "application/pdf", buf: Buffer.from("%PDF-relayed") };
    },
    isPdf: (response) => response.ok && response.buf?.subarray(0, 5).toString() === "%PDF-",
  });

  assert.equal(calls.length, 2);
  assert.ok(calls[1].url.startsWith(`${RELAY}?`));
  assert.equal(calls[1].options.headers.authorization, "Bearer relay-token");
  assert.deepEqual(result, {
    url: "https://www.alona.org.il/uploads/n/order.pdf",
    buf: Buffer.from("%PDF-relayed"),
    relayed: true,
  });
});

test("a configured blocked source without a relay reports the access failure", async () => {
  const result = await fetchArnonaCandidateWithRelay({
    city: city(),
    url: city().last_doc_url,
    year: 2026,
    fetchBinary: async () => ({ ok: false, status: 403 }),
    isPdf: () => false,
  });
  assert.deepEqual(result, {
    failure: { code: "source_access_failed", directStatus: 403, relayStatus: null },
  });
});

test("an unconfigured source is not relayed after direct retrieval fails", async () => {
  let calls = 0;
  const result = await fetchArnonaCandidateWithRelay({
    city: city(),
    url: "https://www.alona.org.il/uploads/n/other.pdf",
    year: 2026,
    relayUrl: RELAY,
    fetchBinary: async () => {
      calls += 1;
      return { ok: false, status: 403 };
    },
    isPdf: () => false,
  });

  assert.equal(calls, 1);
  assert.equal(result, null);
});

test("a configured blocked source preserves the relay 502 failure", async () => {
  let calls = 0;
  const result = await fetchArnonaCandidateWithRelay({
    city: city(),
    url: city().last_doc_url,
    year: 2026,
    relayUrl: RELAY,
    fetchBinary: async () => {
      calls += 1;
      return calls === 1
        ? { ok: false, error: "fetch failed" }
        : { ok: false, status: 502 };
    },
    isPdf: () => false,
  });

  assert.deepEqual(result, {
    failure: {
      code: "source_access_failed",
      directStatus: null,
      relayStatus: 502,
    },
  });
});
