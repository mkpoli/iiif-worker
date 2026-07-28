# Third-party components

iiif-worker depends on the following at runtime:

| Component | Purpose | License |
| :-- | :-- | :-- |
| [@cf-wasm/photon](https://github.com/fineshopdesign/cf-wasm) | WebAssembly image decode, crop, resize, rotate, encode | Apache-2.0 |
| [photon-rs](https://github.com/silvia-odwyer/photon) | the image library @cf-wasm/photon wraps | Apache-2.0 |
| [Hono](https://hono.dev/) | routing | MIT |

Development and ingest also use:

| Component | Purpose | License |
| :-- | :-- | :-- |
| [sharp](https://sharp.pixelplumbing.com/) | pyramid rendering in the ingest CLI (runs locally, not on the Worker) | Apache-2.0 |
| [Wrangler](https://developers.cloudflare.com/workers/wrangler/) | build and deploy | MIT / Apache-2.0 |
| [Biome](https://biomejs.dev/) | format and lint | MIT |

The [IIIF Image API validator](https://pypi.org/project/iiif-validator/) (Simplified BSD)
is used to check conformance but is not a dependency of the server.
