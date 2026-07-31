<div align="center">

# iiif-worker

**A IIIF image server on a Cloudflare Worker you own.**

[![MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/runs%20on-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workers/)
[![IIIF Image API 3.0](https://img.shields.io/badge/IIIF-Image_API_3.0_Level_2-1a3b5d)](https://iiif.io/api/image/3.0/)
[![tests](https://img.shields.io/badge/tests-115_passing-success?logo=bun&logoColor=white)](#how-it-was-tested)

</div>

**iiif-worker** serves the [IIIF Image API 3.0](https://iiif.io/api/image/3.0/) from a
single Cloudflare Worker backed by R2. It answers arbitrary region, size, rotation,
quality, and format requests — `.../314,2173,1674,249/max/0/default.jpg`,
`.../square/512,512/!90/gray.webp` — computing each one on demand and caching the
result at the edge. It also serves `info.json` for each image and a IIIF Presentation 3
manifest for each collection, so viewers like [OpenSeadragon](https://openseadragon.github.io/),
[Mirador](https://projectmirador.org/), and the [Universal Viewer](https://universalviewer.io/)
work against it directly.

Two things bring people here. Hosted IIIF at [archive.org](https://iiif.archive.org/)
and elsewhere goes down or slows to a crawl, and when it does, every image URL in every
citation and every viewer breaks at once. Running your own image server usually means a
Java or C++ daemon (Cantaloupe, IIPImage) on a box you keep patched. This runs on
Workers, so there is no server to keep alive — the deployment is a `wrangler deploy`, the
images live in your R2 bucket, and the same endpoint answers from anywhere.

As far as the [IIIF community wiki](https://iiif.io/get-started/image-servers/) and a
2026 search show, this is the first IIIF Image API server for Cloudflare Workers. The
Lambda-based [serverless-iiif](https://github.com/samvera/serverless-iiif) does the same
job on AWS, but its image work is native libvips, which a Workers isolate cannot load.

---

## What it does

- **IIIF Image API 3.0, Level 2**, plus most of the optional features:
  - **region** — `full`, `square`, `x,y,w,h`, `pct:x,y,w,h`
  - **size** — `max`, `w,`, `,h`, `w,h`, `pct:n`, `!w,h` (confined), and the `^`
    prefix for upscaling
  - **rotation** — any degree, plus `!` mirroring
  - **quality** — `default`, `color`, `gray`, `bitonal`
  - **format** — `jpg`, `png`, `webp`; `tif`, `gif`, `pdf` and `jp2` are answered
    501, which tells a client the request was understood and the format is not
    produced here
  - canonical-URI redirects, a `profile` link header, CORS, and long-lived immutable
    caching
- **`info.json`** as an `ImageService3` document with `sizes`, `tiles`, and the
  `extraFeatures` list a viewer reads to know what it can ask for.
- **Presentation 3 manifests**, one per collection, generated at ingest time and served
  as static JSON.
- **On-demand, from a small pyramid.** Ingest stores each image at a few scales (full,
  ½, ¼, ⅛). A request for a thumbnail or a tile decodes the smallest level that still
  covers the output, so cost tracks the size asked for rather than the size of the
  master.

Image decoding, cropping, resizing, and encoding run in WebAssembly
([@cf-wasm/photon](https://github.com/fineshopdesign/cf-wasm), a Workers build of
[photon-rs](https://github.com/silvia-odwyer/photon)) inside the isolate. Rotation is the
exception and runs on the raw pixel buffer; see the design notes. Nothing leaves
Cloudflare between the R2 read and the response.

## How it compares

| | **iiif-worker** | [Cantaloupe](https://cantaloupe-project.github.io/) | [IIPImage](https://iipimage.sourceforge.io/) | [go-iiif](https://github.com/go-iiif/go-iiif) | [serverless-iiif](https://github.com/samvera/serverless-iiif) | static Level 0 |
| :-- | :-: | :-: | :-: | :-: | :-: | :-: |
| Runs on | Cloudflare Workers | your JVM host | your C++ host | your host / Lambda | AWS Lambda | any static host |
| Image API version | 3.0 | 1.0–3.0 | 1–3, defaults 3 | 2.1 | 2.1 + 3.0 | 1.1–3.0 output |
| Compliance level | 2 | 2 | 2 | 0 and 2 | 2 | 0 |
| Arbitrary region / size / rotation | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ fixed tiles |
| Server to keep running | none | JVM | daemon | daemon / Lambda | Lambda | none |
| Source formats | JPEG · PNG · WebP | + TIFF · JP2 | + TIFF · JP2 | + TIFF, no JP2 | + TIFF · JP2 | pre-rendered |
| One tile out of a pyramidal master | ❌ decodes a whole level | ✅ | ✅ | ❌ | ✅ | n/a |
| Large masters (12 MP+) | ❌ 128 MB isolate cap | ✅ | ✅ | ✅ | ✅ | ✅ |
| Per-request cost | Workers CPU-ms | fixed host | fixed host | host / CPU-ms | Lambda ms | none |
| Setup | `wrangler deploy` | install + tune JVM | build + configure | build / package | AWS stack | run a tiler |
| License | MIT | custom (BSD-like) | GPL | BSD-3 | Apache-2.0 | — |

A wider comparison covering SIPI, Loris, RAIS, digilib, Hymir, Wolpi, iiiris and the
static tilers, with licences, release dates and colour handling, is in
[docs/comparison.md](./docs/comparison.md).

Where each other server wins: Cantaloupe, IIPImage, and serverless-iiif read JPEG 2000
and multi-hundred-megapixel TIFFs directly, which iiif-worker cannot — the isolate has
128 MB of memory, so the master has to fit decoded within that. For scanned books and
photographs (a leaf here is 2155×3452, about 7.4 MP and ~30 MB decoded) that ceiling is
far off; for gigapixel masters it is the wrong tool. Static Level-0 tiling stays the
cheapest option when you never need an arbitrary crop and can pre-render every tile a
viewer will request.

## Deploy it

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/mkpoli/iiif-worker)

One click. Cloudflare forks the repository, creates the R2 bucket, and deploys.
Nothing needs configuring first: the service takes its address from the request,
so it answers correctly on whatever `workers.dev` hostname it is given. Add
images, and it serves them.

Or from a checkout:

```bash
git clone https://github.com/mkpoli/iiif-worker && cd iiif-worker
bun install
bunx wrangler login
bunx wrangler r2 bucket create iiif-images && bunx wrangler deploy
```

Wrangler prints the address it deployed to. Nothing in `wrangler.jsonc` needs
editing first — change `name` if you want a different one.

## Add images

Set the upload token the Worker checks, then point the ingest CLI at a folder.
Each file becomes an image identified by `{collection}/{filename}`.

```bash
openssl rand -hex 24 | bunx wrangler secret put INGEST_TOKEN

export INGEST_TOKEN=<the token you just generated>
BASE=https://iiif-worker.yourname.workers.dev

bun run ingest/cli.ts ./scans --collection my-book --base $BASE --local ./out
bun run scripts/push-tree.ts ./out $BASE --verify
```

The first command builds each image into a small pyramid locally; the second
uploads it, and `--verify` on a re-run skips whatever is already there.

Now `$BASE/iiif/3/my-book%2F0001/info.json` answers, and a viewer pointed at
`$BASE/collections/my-book/manifest.json` can pan and zoom the whole book.

For your own domain and the mistakes that cost an afternoon, see
[docs/hosting.md](./docs/hosting.md).

## Layout in R2

One prefix per image; the ingest CLI writes this and the Worker reads it.

```
{collection}/{id}/meta.json            {"width","height","levels":[1,2,4,8],"format":"jpeg"}
{collection}/{id}/L1.jpg               full-resolution level (L1), then L2, L4, L8
collections/{collection}/manifest.json IIIF Presentation 3 manifest
```

`meta.json` is the only lookup on the hot path; the rest is decided from it.

## How it was tested

- **115 unit tests** (`bun test`) over the request parser, the region/size math, the
  pyramid level mapping and rotation, built from the IIIF 3.0 syntax tables — the
  malformed-input cases the spec calls out, the canonical-form rewrites, and the
  upscaling rules.
- **The official [IIIF Image API validator](https://pypi.org/project/iiif-validator/)**
  at Image API 3.0 level 2: **33 tests, 0 failures**. Reproduce it with
  `bun run validation-image`, which builds the validator's own reference image and
  loads it into the local R2 simulator; the commands are in
  [`scripts/validation-image.ts`](./scripts/validation-image.ts).

  Run it against a local `wrangler dev` rather than a deployed instance. The validator
  sends bare `urllib` requests with no browser `User-Agent`, and a Cloudflare zone with
  default bot protection answers those with a 403 before they reach the Worker, which
  shows up as `baseurl_redirect` and `jsonld` failing for reasons that have nothing to
  do with the server.

## Timing

Against a deployed instance (a 2155×3452 leaf, 15 warm runs each, measured with
`bun run bench/bench.ts`):

| Request | Cold | Warm p50 | Warm p90 |
| :-- | --: | --: | --: |
| `info.json` | 288 ms | 76 ms | 85 ms |
| 512×512 tile | 200 ms | 92 ms | 98 ms |
| region scaled to 800×200 | 204 ms | 92 ms | 104 ms |
| full page confined to 600 | 486 ms | 320 ms | 448 ms |

Cold is the first request for a given URL, before the edge cache holds it; warm is a
repeat, served from cache. The full-page numbers are higher because that response
decodes and re-encodes the whole leaf; region and tile requests read a smaller pyramid
level. Numbers depend on the colo and the source image — reproduce them with the harness
rather than trusting these.

## Design notes

**One backend, not two.** An early plan kept a second path that used the Cloudflare
Images binding for the resize and encode. The binding crops by gravity and fit-box, not
by the explicit `x,y,w,h` rectangle IIIF addresses, so a region request still needs a
pixel crop in the Worker first — which is the part photon already does. The binding
would have added a dependency and a second code path without removing the wasm decode,
so the server does all image work through photon.

**Memory is the ceiling, ahead of CPU.** A Workers isolate has 128 MB and decoding a
JPEG to RGBA costs about four bytes per pixel. A full-size request holds the decoded
level and the transformed copy at once, which puts the practical top end near 12 MP; the
ingest CLI refuses larger sources and asks you to downsample first, and `MAX_AREA`
applies the same ceiling to the output side so no request can ask for more than the
isolate can hold. Reading from a small pyramid level keeps most requests well under
that, and keeps them fast.

**Rotation is not photon's.** `@cf-wasm/photon` 0.3.7 ships a `rotate` that corrupts the
buffer: a 60×40 solid fill comes back with 2399 of its 2400 pixels altered, at every
angle, and the canvas it returns is far larger than the rotated content needs. Rotation
therefore runs over the raw RGBA bytes — right angles as an exact reindexing, other
angles bilinear onto the minimal bounding box, with the uncovered corners transparent
for PNG and WebP and white for JPEG. The area ceiling applies to that bounding box
rather than to the pre-rotation size, so a tilted full-page request cannot outgrow the
isolate.

**Caching.** Every rendered response is stored in the Workers Cache API under its
canonical URL and carries `Cache-Control: public, max-age=31536000, immutable`.
Non-canonical request forms (say `pct:` regions, or `w,` sizes) 303-redirect to the
canonical URL first, so the cache stays single-keyed per distinct image; those redirects
carry the same long lifetime, so a viewer that speaks its own dialect pays the hop once
instead of once per tile. An explicit `w,h` is served as written even when it equals the
region — collapsing it to `max` would redirect every tile a viewer requests at native
resolution, which is the most common request there is.

## License

[MIT](./LICENSE). Third-party components are listed in [THIRD-PARTY.md](./THIRD-PARTY.md).
