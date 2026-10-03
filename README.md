# pfd-cifp

Turns the FAA's Coded Instrument Flight Procedures (CIFP) into one small JSON
file per airport, for the **tar1090 PFD** Firefox extension to fetch.

The extension shows where an aircraft is against the approach it appears to be
flying. To do that it needs the approach, leg by leg. The CIFP has that for
every US procedure, but as a single 53 MB fixed-width file reissued every 28
days — nothing a browser extension should ship or parse. This repository does
the reduction once, on GitHub's machines, and publishes the result.

**Not for navigation.** The source is the FAA's public-domain CIFP; what is
published here is a reduction of it for a display that watches other people's
aircraft.

## What runs, and when

`.github/workflows/update.yml` runs daily. On most days it compares the cycle
in force with the one already published and stops. It also runs when the
build itself is changed. On the day a new cycle
takes effect it:

1. runs the parser's tests,
2. downloads that cycle's `CIFP_YYMMDD.zip` from `aeronav.faa.gov`,
3. builds `out/v1/` and checks the result is the cycle it asked for,
4. places the charts that carry no georeferencing (below); if that fails the
   rest is still published, and the next day's run tries again,
5. deploys `out/` to GitHub Pages.

Only the JSON in `out/` is deployed. After a deploy it commits a one-line
`PUBLISHED` file naming the cycle — a record, and the activity that stops
GitHub switching off the schedule in a quiet public repository.

It can also be run by hand from the Actions tab, with **force** to rebuild a
cycle that is already published.

## Charts with no georeferencing

The FAA's own approach plates say where they belong on the earth. The plates
the Department of Defense draws, and the charted visual procedures, do not, so
the extension cannot lay them on the map. `build/place/` works out where they
go, in the same run, and publishes the answer as `v1/place/index.json`.

**Only those charts are touched.** `dtpp.js` picks them from the FAA's chart
list — a military field, a chart not marked civil, a visual — and `place.js`
looks inside each and leaves it alone if it is georeferenced after all. About
1,200 charts a cycle; the other 10,000 are never fetched.

How: read the fix names on the page (the PDF's text, and Tesseract), find what
marks each fix — a waypoint symbol, a tick across the track (`snap.js`) — and
fit the page to the fixes' positions in the CIFP (`plate-fix.js`).

A placement is published only when it is sure:

- four fixes agreeing within a point, with breadth across the chart that does
  not hang on any one of them; or five along one line if four are marked by
  symbols rather than ticks (a row of ticks can be slid along the track);
- a navaid never counts toward the number;
- the chart north-up within 0.6 degrees;
- and the airport, where the fit puts it, inside the plan view (an inset is a
  little map of its own and agrees with itself perfectly).

Measured on FAA plates whose true position is known, by pretending they were
not georeferenced (`node build/place/run.js --validate KDEN,KORD ...`): 1,106
plates at 54 airports, 461 placed (42%), median 0.03 nm out at the airport,
none more than 0.25 nm. The last 290 of those were never looked at while the
rules were being settled: 147 placed, worst 0.13 nm. What is not placed is
mostly straight-in approaches whose few fixes lie along the final.

`index.json` under `place/`:

| field | meaning |
|---|---|
| `cycle` | the chart cycle these were made from, e.g. `"2610"`; a placement is for that cycle's drawing only |
| `charts` | by PDF file name, lower case |
| `c` | latitude and longitude of the PAGE's corners: top-left, top-right, bottom-right, bottom-left |
| `w`, `h` | the page's size in points |
| `box` | the plan view, `[x0, y0, x1, y1]` in points from the top left |
| `n` | how many fixes agreed |

Needs `tesseract` on the path and `npm ci` (pdf.js and a canvas). The parser
and its tests need neither.

## What is published

    v1/index.json       the cycle, its dates, and every airport covered
    v1/apt/KPDX.json    one airport's approaches, SIDs and STARs
    v1/seg/45_-123.json every procedure leg crossing one one-degree cell

`v1` is the **format** version. An installed extension keeps asking for `v1`,
so a change that would break it must be published as `v2` beside it.

`index.json`:

| field | meaning |
|---|---|
| `cycle` | the FAA's cycle number, e.g. `"2610"` |
| `effective` | the day it came into force |
| `expires` | the day the next one does; from then these are out of date |
| `built` | when this build ran; cell files carry the same stamp as `b`, so a rebuild within a cycle is noticed |
| `apt` | `[id, lat, lon]` for every airport with at least one procedure |
| `cells` | the cells that have a file under `seg/`, as `"lat_lon"` of the south-west corner |

A cell file answers one question: which airports have a procedure passing
through here. An arrival starts two hundred miles from the airport it serves,
so "the airports nearby" is the wrong list to search.

| field | meaning |
|---|---|
| `a` | the airports with a leg in or beside this cell |
| `s` | legs as `[index into a, lat, lon, lat, lon]`, start to end, in the direction flown |
| `w` | en-route airway legs as `[name, n, lat, lon, lat, lon, fix, fix, level]` — `n` is the leg's place along its airway, so neighbouring legs can be joined; `level` is `H`, `L` or `B` |

These are straight chords between fixes — a net to catch candidates with, not
geometry to measure against. Curved legs appear as their chord.

An airport file:

| field | meaning |
|---|---|
| `c` | the cycle this file was built from |
| `lat`, `lon`, `el`, `mv` | position, elevation (ft), magnetic variation (east positive) |
| `x` | every position the procedures refer to, as `[id, lat, lon]` |
| `rw` | runways by designator: threshold `la`, `lo`, elevation `el`, crossing height `tch`, magnetic bearing `b` |
| `app`, `sid`, `star` | procedures, each `{ id, rt: [{ t, tr, l }] }` — route type, transition, legs |

A leg carries only the fields it has:

| field | meaning |
|---|---|
| `p` | path terminator (`TF`, `RF`, `CF`, `CA`, ...) |
| `f`, `cf`, `n` | fix, arc centre, recommended navaid — indices into `x` |
| `t` | turn direction, `L` or `R` |
| `ad`, `a1`, `a2` | altitude description (`+` at or above, `-` at or below, `@` at, `B` between) and altitudes in feet |
| `s`, `sl` | speed limit in knots and its sense |
| `c`, `ct` | course in degrees, magnetic unless `ct` is set |
| `d`, `tm` | distance in nm, or holding time in minutes |
| `rad`, `rho`, `th` | arc radius, DME distance, radial |
| `va` | vertical angle in degrees, negative for descent |
| `r` | the fix's role: `A` initial, `B` intermediate, `F` final approach fix, `M` missed approach point |
| `m` | first leg of the missed approach |
| `fo` | fly-over |
| `sd` | step-down fix |

## Running it here

No dependencies beyond Node 18 or later.

    node test/parse.test.js
    node build/cycle.js                       # which cycle, and its URL
    node build/build.js path/to/FAACIFP18 out

## One-time setup

In the repository's **Settings → Pages**, set **Source** to **GitHub Actions**.
Then run the workflow once from the Actions tab.

## If it stops

- **The FAA changes the file's address.** `build/cycle.js` holds the URL
  pattern. The download step fails loudly rather than publishing nothing.
- **A cycle is skipped or shifted.** `EPOCH` in `build/cycle.js` is a known
  effective date; every other date is counted from it in 28-day steps. The
  build step refuses to publish a file whose own header disagrees.
- **The parse comes out short.** `build.js` refuses to publish fewer than
  2,000 airports, so a truncated download cannot replace a whole cycle.

In every one of those cases the site keeps serving the last good cycle, and
the extension marks it as out of date once it passes its `expires` day.
