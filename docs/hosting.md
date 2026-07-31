# Hosting your own IIIF server

About fifteen minutes, most of it waiting for images to upload. You need a
[Cloudflare account](https://dash.cloudflare.com/sign-up) with R2 enabled and
[Bun](https://bun.sh/). No domain name, no server, and nothing to keep running.

If you would rather see the whole thing first, the short version is: create a
bucket, deploy, upload images, done.

```bash
git clone https://github.com/mkpoli/iiif-worker
cd iiif-worker
bun install
bunx wrangler login
```

## 1. Create the bucket

Images live in R2. The name is yours; use the same one in the next step.

```bash
bunx wrangler r2 bucket create iiif-images
```

## 2. Deploy

```bash
bunx wrangler deploy
```

That is the whole step. The shipped `wrangler.jsonc` deploys as it stands, and
the service takes its address from whatever hostname the request arrived on, so
there is nothing to fill in first. Wrangler prints the URL — something like
`https://iiif-worker.yourname.workers.dev` — and that address already works.

Change `name` in `wrangler.jsonc` if you want a different one, and
`bucket_name` if you did not call your bucket `iiif-images`.

## 3. Set an upload token

Uploads go through the Worker and are refused unless this secret exists. Keep
the value; the next step needs it, and Cloudflare will not show it again.

```bash
INGEST_TOKEN=$(openssl rand -hex 24)
printf %s "$INGEST_TOKEN" | bunx wrangler secret put INGEST_TOKEN
export INGEST_TOKEN          # the ingest scripts read this
echo "$INGEST_TOKEN"         # save it: Cloudflare will not show it again
```

Generate it into a variable first. `wrangler secret put` reads the value from
standard input and never prints it, so piping `openssl` straight in leaves you
holding a token you cannot use. `printf` rather than `echo` because a trailing
newline inside a secret is a good way to spend an hour wondering why every
upload comes back 403.

## 4. Put some images in

Point it at a folder. Every file becomes an image identified by
`{collection}/{filename without extension}`.

```bash
BASE=https://iiif-worker.yourname.workers.dev

bun run ingest/cli.ts ./scans --collection my-book --base $BASE --local ./out
bun run scripts/push-tree.ts ./out $BASE --verify
```

The first command builds each image into a small pyramid on your machine. The
second uploads it. Splitting them means an interrupted upload can be resumed —
re-run the second command and `--verify` skips what is already there.

Add `--rights` to record a licence, and every image gets it:

```bash
bun run ingest/cli.ts ./scans --collection my-book --base $BASE --local ./out \
  --rights https://creativecommons.org/licenses/by-sa/4.0/
```

It must be a Creative Commons or RightsStatements.org URI — the specification
allows nothing else there — and ingest refuses anything it does not recognise
rather than letting a viewer receive a document it cannot trust.

Sources may be JPEG, PNG, WebP or TIFF, up to 12 megapixels. Larger masters are
refused with a message telling you to downsample; see
[the ceiling](#why-12-megapixels) below.

## 5. Check it

```bash
curl $BASE/iiif/3/my-book%2F0001/info.json
```

Then open a viewer. Any IIIF viewer will take the `info.json` URL — the quickest
is to paste it into [Theseus](https://theseusviewer.org/) or
[Clover](https://samvera-labs.github.io/clover-iiif/). A whole collection has a
manifest too:

```
$BASE/collections/my-book/manifest.json
```

That URL opens in [Mirador](https://projectmirador.org/embed/) or the
[Universal Viewer](https://universalviewer.io/).

## Using your own domain

Once it works, swap the `workers.dev` address for a real one. Add the domain to
Cloudflare, then add a `routes` block to `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "iiif.example.com", "custom_domain": true }
]
```

Deploy, and that is all. Requests now arrive bearing the new hostname, so the
service starts describing itself with it — `PUBLIC_BASE` stays unset. Images
already ingested keep working; only manifests generated earlier still carry the
old address, since the ingest CLI writes that in at the time.

## What will bite you

**Setting `PUBLIC_BASE` to something clients cannot reach.** You do not normally
need it at all — leave it unset and the service uses the hostname each request
arrived on. Set it only when those differ, as behind a proxy or a rewriting CDN.
Set it wrongly and `info.json` advertises an `id` nobody can fetch while
redirects send clients somewhere else.

**Re-uploading an image that viewers have already seen.** Rendered images are
cached for a year and marked immutable. Re-ingesting a prefix moves its
derivatives to a new cache key, so new requests get the new pixels — but a
browser that already holds the old one keeps it until its own copy expires. For
a correction people must see immediately, ingest under a new identifier.

**Cloudflare's bot protection and automated clients.** A zone with default bot
settings answers requests carrying no browser `User-Agent` with a 403 before
they reach the Worker. Scripts and the IIIF validator look exactly like that.
Nothing is wrong with the server; adjust the zone's settings or test locally.

**`wrangler dev` and `.dev.vars`.** Local runs read `.dev.vars`, and it is not
picked up on reload. Restart `wrangler dev` after changing it.

## Why 12 megapixels

A Cloudflare Worker gets 128 MB of memory. A decoded pixel costs four bytes, and
a full-size request holds the decoded image and the transformed copy at once, so
roughly 12 megapixels is what fits with room to work. Ingest enforces it rather
than letting requests fail later.

For scanned books, manuscripts and photographs this is rarely a constraint — a
typical book page is 7 to 8 megapixels. For gigapixel material this is the wrong
tool, and [the comparison](./comparison.md) says which servers to use instead.

## What it costs

The Worker bundle is about 640 KB compressed, and both Workers and R2 have free
tiers that cover a small collection: you pay for requests, for stored bytes, and
for the operations that read them. Cloudflare's
[Workers](https://developers.cloudflare.com/workers/platform/pricing/) and
[R2](https://developers.cloudflare.com/r2/pricing/) pricing pages have the
current numbers. There is no idle cost — nothing runs between requests.

## Running it locally

To try it without deploying:

```bash
bun run ingest/cli.ts ./scans --collection my-book --base http://localhost:8787 --local ./out
# load ./out into the local R2 simulator
find ./out -type f | while read -r f; do
  bunx wrangler r2 object put "iiif-images/${f#./out/}" --file "$f" --local
done
bunx wrangler dev
```
