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
in force with the one already published and stops. On the day a new cycle
takes effect it:

1. runs the parser's tests,
2. downloads that cycle's `CIFP_YYMMDD.zip` from `aeronav.faa.gov`,
3. builds `out/v1/` and checks the result is the cycle it asked for,
4. deploys `out/` to GitHub Pages.

Only the JSON in `out/` is deployed. After a deploy it commits a one-line
`PUBLISHED` file naming the cycle — a record, and the activity that stops
GitHub switching off the schedule in a quiet public repository.

It can also be run by hand from the Actions tab, with **force** to rebuild a
cycle that is already published.

## What is published

    v1/index.json       the cycle, its dates, and every airport covered
    v1/apt/KPDX.json    one airport's approaches, SIDs and STARs

`v1` is the **format** version. An installed extension keeps asking for `v1`,
so a change that would break it must be published as `v2` beside it.

`index.json`:

| field | meaning |
|---|---|
| `cycle` | the FAA's cycle number, e.g. `"2610"` |
| `effective` | the day it came into force |
| `expires` | the day the next one does; from then these are out of date |
| `apt` | `[id, lat, lon]` for every airport with at least one procedure |

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
