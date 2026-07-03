#!/usr/bin/env python3
"""
Refresh Zillow + Redfin estimates for every valuation COMPONENT that has a
listing URL, on market-method entities. Writes one estimate row per source into
bk_valuation_estimates (upsert on component_id+source), so the app shows Zillow
and Redfin side by side with provenance.

WHY local: Zillow (PerimeterX) + Redfin (CloudFront WAF) block datacenter IPs and
non-browser TLS. curl_cffi impersonating **Safari** gets through from a
residential IP (Chrome impersonation → captcha). So this runs on a local machine,
not Vercel.

It ALSO scrapes the property facts (type / beds / baths / sqft) off the same
Zillow page and writes them onto the component, so the AI-estimate form on the
Valuation tab prefills instead of starting blank. By default facts only fill
BLANKS (never clobber an owner's edit); pass --overwrite-facts to force-refresh.

Run:  python3 scripts/refresh_valuations.py            # write values + fill blank facts
      python3 scripts/refresh_valuations.py --dry      # scrape + print only
      python3 scripts/refresh_valuations.py --overwrite-facts   # also refresh existing facts
"""
import re
import sys
import datetime
from pathlib import Path

try:
    from curl_cffi import requests as creq
except ImportError:
    sys.exit("pip install curl_cffi")
try:
    import psycopg2 as pg
except ImportError:
    try:
        import psycopg as pg  # type: ignore
    except ImportError:
        sys.exit("pip install psycopg2-binary")

DRY = "--dry" in sys.argv
OVERWRITE_FACTS = "--overwrite-facts" in sys.argv
HDR = {
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.google.com/",
}


def db_url() -> str:
    env = Path(".env.local").read_text()
    m = re.search(r"^SUPABASE_DB_URL=(.*)$", env, re.M)
    if not m:
        sys.exit("SUPABASE_DB_URL not in .env.local")
    return m.group(1).strip().strip("\"'").replace("\\n", "")


def _get(url: str) -> str | None:
    r = creq.get(url, impersonate="safari", headers=HDR, timeout=30, allow_redirects=True)
    if r.status_code != 200:
        print(f"      HTTP {r.status_code}")
        return None
    return r.text


def zillow_value(t: str) -> int | None:
    for pat in (r'"zestimate":\s*"?(\d{4,})', r'\\"zestimate\\":\s*\\?"?(\d{4,})', r'"price":\s*(\d{5,})'):
        m = re.search(pat, t)
        if m:
            v = int(m.group(1))
            if 20_000 <= v <= 100_000_000:
                return v
    return None


def redfin_value(t: str) -> int | None:
    # Redfin embeds its estimate as avm predictedValue (escaped JSON varies).
    for pat in (r'"predictedValue":\s*(\d{5,})', r'\\"predictedValue\\":\s*(\d{5,})',
                r'"avmInfo".{0,80}?"value".{0,20}?(\d{5,})'):
        m = re.search(pat, t)
        if m:
            v = int(m.group(1))
            if 20_000 <= v <= 100_000_000:
                return v
    return None


# QBO-style enum → human label for the AI prompt.
_HOME_TYPE = {
    "SINGLE_FAMILY": "single-family", "TOWNHOUSE": "townhome", "CONDO": "condo",
    "MULTI_FAMILY": "multi-family", "APARTMENT": "apartment", "MANUFACTURED": "manufactured",
    "LOT": "lot", "COOP": "co-op",
}


def _first(t: str, *pats: str) -> str | None:
    for p in pats:
        m = re.search(p, t)
        if m:
            return m.group(1)
    return None


def property_facts(t: str) -> dict[str, str]:
    """Beds / baths / sqft / type off an embedded listing JSON (Zillow or Redfin).

    Zillow's embedded JSON is backslash-escaped (e.g. `livingAreaValue\\":1687`),
    so every key pattern tolerates an optional `\\` before the closing quote.
    """
    facts: dict[str, str] = {}
    beds = _first(t, r'bedrooms\\?":\s*(\d+(?:\.\d+)?)', r'"beds\\?":\s*(\d+(?:\.\d+)?)')
    baths = _first(t, r'bathrooms\\?":\s*(\d+(?:\.\d+)?)', r'"baths\\?":\s*(\d+(?:\.\d+)?)')
    sqft = _first(t, r'livingAreaValue\\?":\s*(\d{3,6})', r'livingArea\\?":\s*(\d{3,6})',
                  r'sqFt\\?"[^}]{0,40}?value\\?":\s*(\d{3,6})')
    # Prefer Zillow's already-human "Single Family" / "Townhouse" dimension; fall
    # back to the homeType enum (SINGLE_FAMILY → single-family).
    dim = _first(t, r'propertyTypeDimension\\?":\s*\\?"([^"\\]+)')
    htype = _first(t, r'homeType\\?":\s*\\?"([A-Z_]+)\\?"')
    if beds:
        b = beds.rstrip("0").rstrip(".")
        facts["beds"] = b or beds
    if baths:
        b = baths.rstrip("0").rstrip(".")
        facts["baths"] = b or baths
    if sqft and 100 <= int(sqft) <= 100_000:
        facts["sqft"] = sqft
    if dim:
        facts["property_type"] = dim.strip()
    elif htype:
        facts["property_type"] = _HOME_TYPE.get(htype, htype.lower().replace("_", " "))
    return facts


def main() -> None:
    conn = pg.connect(db_url())
    cur = conn.cursor()
    cur.execute(
        """SELECT c.id, e.name, c.label, c.zillow_url, c.redfin_url
             FROM bk_valuation_components c
             JOIN bk_ledger_entities e ON e.id = c.entity_id
            WHERE e.valuation_method = 'market'
              AND (c.zillow_url IS NOT NULL OR c.redfin_url IS NOT NULL)
            ORDER BY e.name, c.sort_order"""
    )
    rows = cur.fetchall()
    if not rows:
        print("No market components with a listing URL.")
        return
    today = datetime.date.today().isoformat()
    wrote = 0
    facts_wrote = 0
    for cid, name, label, zurl, rurl in rows:
        print(f"\n{name} :: {label}")
        merged_facts: dict[str, str] = {}
        # Zillow first so its facts win; Redfin only fills what Zillow missed.
        for source, value_of, url in (("zillow", zillow_value, zurl), ("redfin", redfin_value, rurl)):
            if not url:
                continue
            t = _get(url)
            if not t:
                print(f"   {source}: —")
                continue
            for k, v in property_facts(t).items():
                merged_facts.setdefault(k, v)
            v = value_of(t)
            if v is None:
                print(f"   {source}: —")
                continue
            print(f"   {source}: ${v:,}")
            if DRY:
                continue
            cur.execute(
                """INSERT INTO bk_valuation_estimates (component_id, source, value_cents, as_of, url, updated_at)
                   VALUES (%s, %s, %s, %s, %s, now())
                   ON CONFLICT (component_id, source)
                   DO UPDATE SET value_cents=EXCLUDED.value_cents, as_of=EXCLUDED.as_of,
                                 url=EXCLUDED.url, updated_at=now()""",
                (cid, source, v * 100, today, url),
            )
            conn.commit()
            wrote += 1
        if merged_facts:
            print(f"   facts: {', '.join(f'{k}={v}' for k, v in merged_facts.items())}")
            if not DRY:
                # Column names come from a fixed whitelist in property_facts(), so
                # the f-string is safe; values are still parameterized.
                for col, val in merged_facts.items():
                    guard = "" if OVERWRITE_FACTS else f" AND ({col} IS NULL OR {col}='')"
                    cur.execute(
                        f"UPDATE bk_valuation_components SET {col}=%s WHERE id=%s{guard}",
                        (val, cid),
                    )
                    if cur.rowcount:
                        facts_wrote += 1
                conn.commit()
    print(f"\n{'(dry) ' if DRY else ''}{wrote} estimate(s), {facts_wrote} fact field(s) written.")
    conn.close()


if __name__ == "__main__":
    main()
