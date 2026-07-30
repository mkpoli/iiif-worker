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

## 2. Point the config at it

Open `wrangler.jsonc` and change two things:

- `name` — what the Worker is called, which also becomes part of its URL.
- `bucket_name` — the bucket you just made.

Then **delete the `routes` block**. That block is for a custom domain; without
it the Worker gets a free `workers.dev` address, which is all you need to start.

## 3. Deploy, then tell it its own address

```bash
bunx wrangler deploy
```

Wrangler prints the URL it deployed to, something like
`https://iiif-worker.yourname.workers.dev`.

The server needs to know that address, because IIIF documents contain absolute
URLs — `info.json` states its own `id`, and non-canonical requests redirect to a
full URL. So set `PUBLIC_BASE` in `wrangler.jsonc` to that address with
`/iiif/3` on the end, and deploy once more:

```jsonc
"PUBLIC_BASE": "https://iiif-worker.yourname.workers.dev/iiif/3"
```

```bash
bunx wrangler deploy
```

Two deploys the first time, one from then on. If you already know your
`workers.dev` subdomain you can fill it in before the first deploy and skip the
second.

## 4. Set an upload token

Uploads go through the Worker and are refused unless this secret exists. Keep
the value; the next step needs it.

```bash
openssl rand -hex 24 | bunx wrangler secret put INGEST_TOKEN
```

## 5. Put some images in

Point it at a folder. Every file becomes an image identified by
`{collection}/{filename without extension}`.

```bash
export INGEST_TOKEN=<the value from step 4>
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

## 6. Check it

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
Cloudflare, then put the `routes` block back in `wrangler.jsonc`:

```jsonc
"routes": [
  { "pattern": "iiif.example.com", "custom_domain": true }
]
```

Change `PUBLIC_BASE` to `https://iiif.example.com/iiif/3` to match, and deploy.
The two must always agree.

## What will bite you

**`PUBLIC_BASE` not matching how clients actually reach the server.** This is
the one that wastes an afternoon. If they disagree, `info.json` advertises an
`id` nobody can fetch and redirects send clients somewhere else. Whenever you
change the address, change both.

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
echo 'PUBLIC_BASE = "http://localhost:8787/iiif/3"' > .dev.vars
bun run ingest/cli.ts ./scans --collection my-book --base http://localhost:8787 --local ./out
# load ./out into the local R2 simulator
find ./out -type f | while read -r f; do
  bunx wrangler r2 object put "iiif-images/${f#./out/}" --file "$f" --local
done
bunx wrangler dev
```
