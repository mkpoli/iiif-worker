# IIIF Image API servers compared

Every fact below was checked against the project's own documentation, source, or
the GitHub API on 2026-07-30, and every release row was re-checked against the
releases endpoint on 2026-07-31 — none had moved. Where a claim could not be established from a
primary source it says so; nothing here is filled in from reputation.

Read the second section first if you are choosing a server. iiif-worker wins on
one narrow axis and loses badly on several others, and which of those matters
depends entirely on your masters.

## The table

`pTIFF/JP2` is the property that decides whether a server scales to very large
images: can it read one tile out of a pyramidal TIFF or JPEG 2000 master without
decoding the whole thing. A server without it must hold an entire image in
memory for every request.

| | Runtime — what you operate | Image API | Level | pTIFF / JP2 random access | Practical source ceiling | Derivative cache | IIIF Auth | Presentation API |
| :-- | :-- | :-: | :-: | :-: | :-- | :-- | :-- | :-: |
| **iiif-worker** | Cloudflare Worker — nothing | 3.0 | 2 | ✗ / ✗ | ~12 MP, isolate memory | Workers Cache API, etag-versioned | ✗ | static P3 manifests |
| [Cantaloupe](https://cantaloupe-project.github.io/) | JVM daemon | 1.0–3.0 | 2 | ✓ / ✓ | none documented | pluggable, off by default | delegate hooks, Auth 1.0-style | ✗ |
| [IIPImage](https://iipimage.sourceforge.io/) | C++ FastCGI daemon | 1–3, defaults 3 | 2 | ✓ / ✓ | terabyte-scale claimed | RAM tile cache + Memcached | ✗ | ✗ |
| [SIPI](https://github.com/dasch-swiss/sipi) | C++ daemon | 3.0 | 2 | ✓ / ✓ | memory-budget governed | file LRU with eviction | Auth 1.0 | ✗, separate tool |
| [Loris](https://github.com/loris-imageserver/loris) | Python WSGI | 2.0 | 2 | ✗ / ✓ | RAM, for TIFF | filesystem, manual cleanup | Auth 1.0 | ✗ |
| [RAIS](https://github.com/uoregon-libraries/rais-image-server) | Go daemon | 2.1 | 2 | ✗ / ✓ | 400–800 MP tested | info LRU; tile cache opt-in | ✗ | ✗ |
| [go-iiif](https://github.com/go-iiif/go-iiif) | Go binary or Lambda | 2.1 | 0 and 2 | ✗ / no JP2 at all | RAM, whole-file decode | pluggable | ✗ | ✗ |
| [serverless-iiif](https://github.com/samvera/serverless-iiif) | AWS Lambda | 2.1 + 3.0 | 2 | ✓ via libvips | configured Lambda memory | none, expects a CDN | ✗ | ✗ |
| [digilib](https://github.com/robcast/digilib) | Java servlet | 1–3 | 2 | ✓ / not established | JVM heap | optional disk, off by default | OIDC, not IIIF Auth | ✓ P2 and P3 |
| [Hymir](https://github.com/dbmdz/iiif-server-hymir) | Java Spring Boot | 2.1 | not stated | opt-in native libs only | JVM heap | none by design | custom hook | ✓ |
| [Wolpi](https://github.com/dbmdz/wolpi) | Java 25 + host libvips | 2.1 + 3.0 | not stated | ✓ / ✓ | per-format axis caps | none; HTTP caching for a CDN | extension point | ✗ |
| [iiiris](https://gitlab.com/iiiris-org/iiiris) | Go + libvips/OpenJPEG | 2.x + 3.0 | 2 | libvips streaming | not established | three pluggable slots | **Auth Flow 2.0, full** | ✓ |
| [riiif](https://github.com/sul-dlss/riiif) | Rails engine, in your app | 2.x | **1** | backend-dependent | backend-dependent | Rails.cache + unmanaged disk | custom boolean hook | ✗ |
| [express-iiif](https://github.com/tvanbeek/express-iiif) | Node/Express middleware | 3.0 "compatible" | not stated | sharp; JP2 not established | not established | not established | ✗ | ✗ |
| [TremendousIIIF](https://github.com/britishlibrary/TremendousIIIF) | .NET daemon | 2.1 | 2 | ✓ JP2 via Kakadu | not established | not established | partial, branch only | ✗ |
| static Level 0 | nothing, after generation | 1.1–3.0 output | 0 | build-time full decode | tool-dependent | CDN only | n/a | biiif emits P3 |

Licence, maintenance and colour handling:

| | Licence | Latest release | Colour: ICC / CMYK / EXIF orientation |
| :-- | :-- | :-- | :-- |
| **iiif-worker** | MIT | v0.1.0, 2026-07-31 | ✗ / ✓ at ingest / applied at ingest |
| Cantaloupe | NCSA | v5.0.7, 2025-03-13 | transformed by some processors / unsupported in Java2d / exposed, auto-rotate unconfirmed |
| IIPImage | GPL-3.0 | 1.3, 2025-05-28 | carried through, no transform found / not established / read on JPEG input |
| SIPI | AGPL-3.0 | v6.3.0, 2026-07-29 | **transform via littlecms / ✓ / ✓ via exiv2** |
| Loris | BSD-3-Clause | v3.2.1, 2020-12-16 — **dormant** | Pillow defaults |
| RAIS | CC0-1.0 | v4.2.4, 2026-06-16 | documented broken / ✗ / not established |
| go-iiif | BSD-3-Clause | v8.1.8, 2026-07-23 | detect only / not established / ✓ auto-rotate |
| serverless-iiif | Apache-2.0 | v8.0.2, 2026-06-08 | sharp defaults / sharp defaults / ✓ autoOrient |
| digilib | LGPL-3.0-or-later | 2.13.0, 2025-10-09 | preserved for 16-bit / not established / read for dimensions |
| Hymir | MIT | 5.1.13, 2024-07-16 — **being retired** | none documented |
| Wolpi | MIT | 0.3.0, 2026-06-30 — pre-1.0 | libvips defaults |
| iiiris | Apache-2.0 | v0.9.1, 2026-07-17 — pre-1.0 | **normalizes to sRGB / ✓ / ✓ baked into pixels** |
| riiif | Apache-2.0 | gem 2.8.1 | backend defaults |
| express-iiif | BSD-3-Clause | 1.8.0, 2026-07-20 | sharp defaults |
| TremendousIIIF | AGPL-3.0 | none ever cut — dormant | not established |

## Where iiif-worker stands

**What it is better at.** Nothing else here runs without a process somebody
keeps alive. serverless-iiif comes closest and still leaves you owning a Lambda
function, a layer for the sharp binaries, and an IAM role. Static Level-0
tiling needs no process either, and gives up arbitrary regions and sizes to get
there. Deployment is `wrangler deploy`, there is no idle cost, and requests are
answered from wherever the client is without configuring a CDN.

As of 2026-07-30 no other IIIF Image API server was found on any V8-isolate or
WASM edge platform. Searching GitHub for IIIF against Cloudflare Workers, Deno
Deploy, Vercel Edge, Fastly Compute and Netlify Edge Functions returns no
third-party implementation, and neither the IIIF community's server list nor
awesome-iiif names one. Lambda is a microVM with native binaries available, so
serverless-iiif is not the same category. Absence of a public repository is not
proof that nothing exists privately.

**What it is worse at today.** Cantaloupe, IIPImage, SIPI and Wolpi read one
tile out of a pyramidal TIFF or JPEG 2000 master. iiif-worker decodes a whole
pyramid level per request. The pyramid keeps that cost proportional to the
output for zoomed-out views, and at native resolution every tile still decodes
the master. Ingest refuses sources over 12 megapixels, because a Workers isolate
has 128 MB, a decoded pixel costs four bytes, and a full-size request holds the
decoded level and the transformed copy at once.

An earlier version of this document called that ceiling architectural and said
no amount of work on this codebase would change it. **That was wrong**, and the
correction matters more than the original claim did. R2 serves HTTP range
requests, and a tiled pyramidal TIFF carries per-tile offsets and byte counts in
its IFDs. Tested against an 8000×8000 master — five times the current cap — the
whole pyramid structure was read in 43 range reads totalling 1 388 bytes, and a
single 256×256 tile was fetched and decoded by the existing photon build in 11
range reads totalling 10 057 bytes, 0.68% of the file, with a peak of 0.26 MB of
decoded pixels rather than 256 MB for the master. Nothing new had to be
compiled: a JPEG-compressed tile decodes once the shared `JPEGTables` blob is
spliced in front of it.

**None of that is shipped.** The measurements above come from a standalone
experiment, not from the request path: ingest still refuses anything over 12
megapixels, and the server still reads whole pyramid levels. The comparison
table above describes what this server does today, and its `pTIFF / JP2` and
large-master entries stay as they are until a tile-reading path exists.

What changes is the reason given. **Output** dimensions must stay capped — no
isolate renders a gigapixel canvas, which is why every server in this table has
a `maxArea`. **Master** dimensions need not be, so deep zoom over a very large
master belongs on a roadmap rather than in a list of things the platform
forbids.

JPEG 2000 is the one that holds. A JP2 has no fixed tile index like a TIFF IFD,
so random access means parsing TLM and PLT markers and driving a decoder that
does not exist in production WASM form. Masters can be transcoded to pyramidal
TIFF at ingest, where native codecs are available, which reaches the same place
for far less work; decoding JP2 inside the isolate is not a near-term gap to
close.

Beyond the pixels: no IIIF Authorization Flow. Restricted material can be
described — a `rights` statement is published in `info.json` when ingest records
one — but nothing is enforced, so there is no way to serve a degraded version to
anonymous callers and the full one to authenticated ones. No ICC colour
management, which matters for reproduction-grade imaging. And the Presentation
surface is one static manifest per collection, with no Collection resource and
no `thumbnail`.

**Features common elsewhere that are missing here.** A derivative cache with an
eviction policy and a purge endpoint. Watermarking and redaction, which
Cantaloupe has and almost nothing else does. Auth — and note that full
Authorization Flow 2.0 is rare enough across the whole field that iiiris having
it is a genuine differentiator. Colour management, where several long-established
servers also have gaps, so "not implemented" is closer to the norm than the
exception — and where normalising to sRGB at ingest, which is what iiiris does,
reaches most of the benefit without a colour engine in the request path.

**A fair summary.** For a collection of scanned pages or photographs where you
want IIIF without running anything, this is a reasonable choice and unusually
cheap. For a digitisation programme with JP2 masters or gigapixel sources,
choose Cantaloupe, IIPImage or SIPI today; for colour fidelity, SIPI. If access
control is the requirement, note from the table above that none of those three
implements the Authorization Flow as specified — Cantaloupe offers
delegate-script hooks and SIPI Auth 1.0, and only iiiris has the full
Authorization Flow 2.0. Cantaloupe, IIPImage and SIPI are the ones with a decade
of institutional deployment behind them — Bayerische
Staatsbibliothek serves roughly 8 million newspaper pages through Hymir, the
Internet Archive put 9.3 million items behind Cantaloupe, the Qatar Digital
Library runs 500,000 JP2s on IIPImage.

## Notes on individual projects

**Loris** has not had a substantive commit since 2021-06-23 and its last release
was 2020-12-16. It is not archived, and it is not maintained.

**Hymir** carries a caution in its own README: it "is going to be retired soon in
favour of our new, highly-extensible and easy to use IIIF image server Wolpi."
Wolpi is four months old and pre-1.0, and no confirmation was found that any
Bavarian State Library platform has cut over yet.

**riiif** advertises Level 1, not Level 2 — confirmed in its source, where the
profile link header is built from `http://iiif.io/api/image/2/level1.json`. It
is also a Rails engine mounted into a host application, not a standalone server.

**go-iiif** has no JPEG 2000 support of any kind, and since v2.0 its default
decoder rasterizes the whole file; the libvips driver that would avoid this is
documented as broken.

**RAIS** documents its own ICC handling as broken and supports only RGB and
grayscale JP2.

**iiiris** and **Wolpi** are both promising and both very young — created in May
2026, single-digit contributors, pre-1.0. Judge them on that basis.

**TremendousIIIF** has never cut a release and no branch has been touched in
about three years.

## Method

Project documentation and source were read directly; versions and dates come
from `GET /repos/{owner}/{repo}/releases/latest`. The starting lists were the
[IIIF community's image server page](https://iiif.io/get-started/image-servers/)
and [awesome-iiif](https://github.com/IIIF/awesome-iiif), neither of which is
complete — several actively developed servers here appear on neither.

Deployment figures are cited where a primary source gave both the server name
and a number. Many widely repeated pairings could not be confirmed on both
halves and were left out rather than guessed.
