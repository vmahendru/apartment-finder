# Sidewalk

A map of what Seattle reports about its own streets, and a Zillow overlay that
puts it behind the listings.

This is step one of the apartment-finder spec: the street-feel layer, which the
spec calls the riskiest piece and says to build before any UI.

## The problem it fixes

Seattle publishes encampment reports and 311 complaints with coordinates, daily,
free. Mapping them is easy. The trouble is what Dave Peck flagged in
[Unsheltered Seattle](https://davepeck.org/2025/08/22/unsheltered-seattle/):

> Different neighborhoods have different levels of engagement with the Find It,
> Fix It app, and some encampments are more visible or in more pedestrian-heavy
> areas than others.

That is the same reporting bias the spec rejects crime statistics for, pointed
the other way. Measured on a year of data, the raw map is **rho = 0.67**
rank-correlated with how many *unrelated* complaints a neighbourhood files —
graffiti, dumping, litter, abandoned vehicles, broken streetlights. Two thirds
of what a naive map shows you is civic engagement, not street conditions.

So the map carries two readings and their difference:

| View | What it shows |
|---|---|
| **Reported** | Raw recency- and severity-weighted density. What Peck's map shows. |
| **Adjusted** | Encampment reports as a share of *all* reports from the same area, so reporting propensity divides out. `rho = -0.12` against other-complaint volume — effectively independent of it. |
| **Disagreement** | Where the two part company. This is the interesting one. |

Cells with too little evidence are **outlined, never filled**. A street nobody
reports is unknown, not clean.

### Does it survive the calibration case?

The spec says Ballard should score worse than Capitol Hill north / Volunteer
Park, despite similar raw crime numbers.

```
                      RAW   ADJUSTED
  Ballard              88         88
  Capitol Hill         94         69
  Volunteer Park       69         75
```

Raw counts rank Capitol Hill *worse* than Ballard, contradicting the ground
truth: it has the highest total report volume in the city but only 26%
encampment share. Adjusted puts Ballard back on top, matching. Ballard itself
does not move — its encampment share is 34% against a city baseline of 18%, so
it is genuinely encampment-heavy rather than merely vocal.

Run `npm run neighbourhoods` to reproduce, `npm run check` for the correlations.

### Known weakness

The adjusted metric has the opposite bias: quiet residential areas file few
*other* complaints, so a thin denominator inflates their encampment share.
Green Lake and Lake City both jump under adjustment for partly this reason.
Neither reading is correct alone, which is why both ship with a toggle rather
than being blended into one number that pretends to be the truth.

## Running it

```sh
npm install
npm run ingest      # ~425k reports -> public/data/cells.geojson, then syncs extension/
npm run serve       # http://localhost:8790
npm test
```

Raw API responses cache in `data/raw/` keyed by window start, so re-runs are
free. Delete that directory to force a refetch.

## The Zillow overlay

`extension/` is an unpacked MV3 extension. Load it via `chrome://extensions`
-> Developer mode -> Load unpacked.

It reads Zillow's map rectangle out of **Zillow's own URL** (`searchQueryState`
-> `mapBounds`) rather than reaching into page internals or parsing listing
markup. The URL scheme is far more stable than class names, and nothing about
the listings is read or stored.

Over Zillow's light basemap, value drives *opacity* rather than only colour, so
quiet areas show Zillow's map through and hot spots glow.

### What is verified, and what is not

Verified: the projection is exact. `public/fixture.html` makes MapLibre stand in
for Zillow — publishing its bounds into an identical `searchQueryState` — and
compares the overlay's maths against MapLibre's own `project()` across a 25-point
grid. **Worst error 0.000 px** at zooms 11.2, 12.0 and 13.4.

Not verified: that Zillow still writes `mapBounds` into `searchQueryState`, and
that `findMap()` picks the right container on the live site. Both are guesses
against a site this repo deliberately does not scrape. If the overlay lands in
the wrong place, those two functions are where to look.

Zillow's terms prohibit automated access. A personal, client-side overlay that
reads your own address bar is a quieter thing than scraping, but it is a
judgement call, and this is not meant to be published to the Web Store.

## Layout

```
src/score.mjs        pure scoring: severity, recency, shrinkage, ranks. No I/O.
scripts/ingest.mjs   Socrata -> H3 res 9 -> GeoJSON
scripts/check.mjs    is the correction adding information, or renaming volume?
scripts/neighborhoods.mjs   rolls cells up to named places for blind ranking
public/              the standalone map (vanilla JS, vendored MapLibre)
public/shared.js     ramps + Mercator projection, shared with the extension
extension/           MV3 overlay; shared.js and data/ are copied in by the build
```

## Sources

Seattle Open Data: [Unauthorized Encampment Reports](https://data.seattle.gov/resource/k7ra-jqqe)
(`k7ra-jqqe`) and [Customer Service Requests](https://data.seattle.gov/resource/43nw-pkdq)
(`43nw-pkdq`). Both keyless. Basemap: Esri dark canvas, also keyless.

No API keys, no paid services, nothing stored from Google or Zillow.

## Verifying the overlay after a change

The alignment harness needs a browser driver, installed only when used so it is
never shipped:

```sh
npm install --no-save playwright-core
npm run serve &
node scripts/verify-alignment.mjs     # expects "worst error 0.000 px"
npm uninstall playwright-core
```

On this Pi, Chromium is at `/usr/bin/chromium` and the script passes that as
`executablePath`.
