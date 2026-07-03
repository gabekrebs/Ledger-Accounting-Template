/**
 * Automated market value (AVM) lookup for single-family / duplex entities.
 *
 * Reality check (tested 2026-06-07): direct Zillow/Redfin scraping DOES work, but
 * only with curl_cffi impersonating **Safari** (Chrome impersonation → 403 +
 * press-&-hold captcha) AND only from a residential IP — Vercel's datacenter IPs
 * + Node's non-impersonable TLS get blocked. So the real automated refresh runs
 * LOCALLY via `scripts/refresh_valuations.py` (scrapes the entity's Zillow URL on
 * a local machine and writes market_value_cents). This in-app path is the optional
 * alternative: an AVM data API (RentCast — free tier, address-keyed) that a
 * serverless function CAN reach. Provider-shaped so HouseCanary/ATTOM can drop in.
 *
 * No key configured → fetchMarketValue throws a clear, surfaced message and the
 * manually-entered value (or the local scraper's value) stands. Manual entry
 * always works.
 */

export interface AvmResult {
  valueCents: number;
  source: string; // provenance label stored on the entity, e.g. "RentCast AVM"
  asOf: string; // YYYY-MM-DD
  low?: number; // dollars
  high?: number; // dollars
}

/** Today's date as YYYY-MM-DD, in local time (good enough for an as-of stamp). */
function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * RentCast AVM — https://developers.rentcast.io . GET /v1/avm/value?address=...
 * Header `X-Api-Key`. Returns `{ price, priceRangeLow, priceRangeHigh }` (USD).
 * Free tier: 50 calls/mo — plenty for a once-a-month portfolio refresh.
 */
async function rentcast(address: string): Promise<AvmResult> {
  const key = process.env.RENTCAST_API_KEY;
  if (!key) {
    throw new Error(
      "Automated AVM needs RENTCAST_API_KEY (free tier at rentcast.io). " +
        "Direct Zillow/Redfin scraping is bot-blocked, so enter the value manually " +
        "or add the key to enable auto-refresh."
    );
  }
  const url = `https://api.rentcast.io/v1/avm/value?address=${encodeURIComponent(address)}`;
  const res = await fetch(url, {
    headers: { "X-Api-Key": key, Accept: "application/json" },
    cache: "no-store",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`RentCast AVM ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = (await res.json()) as {
    price?: number;
    priceRangeLow?: number;
    priceRangeHigh?: number;
  };
  if (!j.price || j.price <= 0) {
    throw new Error("RentCast returned no value for that address.");
  }
  return {
    valueCents: Math.round(j.price * 100),
    source: "RentCast AVM",
    asOf: todayIso(),
    low: j.priceRangeLow,
    high: j.priceRangeHigh,
  };
}

/**
 * Pull a fresh market value for a property. `address` is what AVM APIs key on
 * (street, city, state, zip in one string). Throws a surfaced message if no
 * provider is configured or the lookup fails — callers show it; the existing
 * manual value is left untouched.
 */
export async function fetchMarketValue(opts: {
  address: string | null;
}): Promise<AvmResult> {
  const address = opts.address?.trim();
  if (!address) {
    throw new Error(
      "Add the property address first — AVM providers look up the value by address."
    );
  }
  return rentcast(address);
}

/** Is an automated provider configured? Drives the Refresh button's affordance. */
export function avmConfigured(): boolean {
  return Boolean(process.env.RENTCAST_API_KEY);
}
