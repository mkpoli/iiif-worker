# Changelog

## v0.1.0

First release. A IIIF Image API 3.0 server, level 2, on a Cloudflare Worker with
its images in R2. Passes the official IIIF validator: 33 tests, 0 failures.

### Deploying

Deploys as it stands, with nothing to configure first. The service takes its
address from the request, so a fresh deployment answers correctly on whatever
hostname it is given — including a `workers.dev` one nobody knew in advance. Set
`PUBLIC_BASE` only when clients reach the Worker under a different host than it
sees, as behind a proxy.

That covers serving. Uploading needs one thing configured: the `INGEST_TOKEN`
secret, without which the `/ingest` route stays closed and answers 404. A
deployment with no token is a perfectly good read-only server for images placed
in the bucket by other means.

There is a deploy button in the README, and `docs/hosting.md` walks through the
rest: uploading images, using your own domain, and the mistakes that cost an
afternoon.

### Serving

- Region `full`, `square`, `x,y,w,h`, `pct:x,y,w,h`; size `max`, `w,`, `,h`,
  `w,h`, `pct:n`, `!w,h`, each with the `^` upscaling prefix; rotation by any
  angle with `!` mirroring; qualities `default`, `color`, `gray`, `bitonal`;
  formats `jpg`, `png`, `webp`.
- `tif`, `gif`, `pdf` and `jp2` are answered 501 rather than 400, which tells a
  client the request was understood and the format is not produced here.
- Canonical URI redirects, `canonical` and `profile` link headers, CORS with
  `Link` exposed to browser scripts.
- Conditional requests: entity tags on images and on `info.json`, so a client
  that revalidates receives 304 rather than the bytes again.
- Content negotiation on `info.json` between `application/ld+json` and
  `application/json`.
- `rights` and `partOf` published when recorded at ingest, so an image can carry
  its licence and a link back to the manifest it belongs to.
- Rendered responses cached at the edge under the canonical URL, keyed by the
  stored metadata version so a re-ingest supersedes them. Image metadata cached
  for a minute, which keeps an R2 read off most requests.

### Ingesting

`ingest/cli.ts` builds a small pyramid (full, ½, ¼, ⅛) from JPEG, PNG, WebP or
TIFF sources and writes a Presentation 3 manifest per collection. EXIF
orientation is applied. `--rights` records a licence URI, validated against what
the specification permits. `scripts/push-tree.ts` uploads through the Worker and
resumes; `scripts/verify-r2.ts` checks every pyramid level rather than only the
metadata.

### What it deliberately does not do

- **No JPEG 2000, and no single-tile reads out of a pyramidal TIFF.** No
  production decoder for either exists in WebAssembly. Requests are served from
  a pyramid built at ingest instead.
- **Sources are capped at 12 megapixels.** A Worker has 128 MB, a decoded pixel
  costs four bytes, and a full-size request holds the decoded level and the
  transformed copy at once. For gigapixel material this is the wrong tool;
  `docs/comparison.md` says which server to use instead.
- **No IIIF Authorization Flow**, so restricted material cannot be represented.
- **No ICC colour management.**

### Verification

157 unit tests over the request parser, the region and size arithmetic, pyramid
level mapping, rotation, and the HTTP layer.

The validator run is reproducible in three steps. `bun run validation-image`
only prepares the fixture — it builds the validator's own reference image and
loads it into the local R2 simulator — and does not run the validator itself:

```bash
bun run validation-image
bunx wrangler dev --port 8791
uvx --from iiif-validator iiif-validate.py \
  -s localhost:8791 -p iiif/3 -i refimg --version 3.0 --level 2
```

Run it against a local server rather than a deployed one. The validator sends
bare `urllib` requests, and a Cloudflare zone with default bot protection
answers those with 403 before they reach the Worker.

One thing worth knowing about this codebase: `@cf-wasm/photon` 0.3.7 ships a
`rotate` that corrupts the buffer at every angle — a 60×40 solid fill returns
with 2399 of its 2400 pixels altered — so rotation is done here over the raw
RGBA bytes instead. Every other photon operation was checked the same way and
only `rotate` was affected.
