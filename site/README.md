# site

`openworksai.app`: the homepage and the docs. Astro, static output, no adapter,
because nothing on it is dynamic.

```bash
pnpm --filter openworks-site dev        # localhost:6002
pnpm --filter openworks-site typecheck  # astro check
pnpm site:build                         # into site/dist
```

| path               | what                                                                   |
| ------------------ | ---------------------------------------------------------------------- |
| `src/pages`        | `index.astro` is the homepage; `docs/[slug].astro` renders one doc     |
| `src/layouts`      | `Base.astro` is head, JSON-LD and theme; `Docs.astro` adds the sidebar |
| `src/data/docs.ts` | the sidebar, which is also the allow-list of what gets a page          |
| `src/styles`       | one stylesheet, inlined into every page by `build.inlineStylesheets`   |
| `public`           | images, favicon, `robots.txt`, copied through untouched                |

The docs pages are the markdown in the repo's `docs/`, read as a content
collection, so a feature and its page change in the same commit. `docs/` also
holds runbooks that are notes to ourselves; a page is published only once it is
listed in `src/data/docs.ts`. Listing one whose file does not exist fails the
build rather than shipping a link to a 404.

## The screenshots

`product.png` and `product-dark.png` come from the demo build, never from a
deployment:

```bash
pnpm --filter openworks-browser demo    # http://localhost:6009/demo/index.html
```

That build swaps `convex/react` for a fixture stub, so the real app runs with
invented data in it and a screenshot publishes nobody's reading list. The whole
dataset is `browser/demo/fixtures.ts`. Shoot at 1360x880 at 2x, downscale to
1720 wide, and keep both names: light is the intake queue, dark is the research
board.

Keep the names even if the images change. Cloudflare's edge serves a cached
asset by its own URL, so an image withdrawn from the deployment keeps being
answered from cache rather than 404ing. Publishing over the name is what
replaces it; deleting the file hands the URL back to the cache.

## Deploying

`openworksai.app` is a Cloudflare Pages project named `openworks`, with no git
provider attached: it is published from here and nowhere else, so a push that
is never deployed leaves the live site on the previous version.

```bash
pnpm site:deploy
```

The repo's `vercel.json` builds the app, not this. Running `vercel deploy site`
does not deploy the homepage; it creates a stray Vercel project, fails for want
of an output directory, and leaves `openworksai.app` untouched.

## Changing the domain

Two places, because search engines and link unfurlers both reject relative
URLs and a static file cannot read the config:

| file                | field                                                    |
| ------------------- | -------------------------------------------------------- |
| `astro.config.mjs`  | `site`, which canonical, og, JSON-LD and sitemap all use |
| `public/robots.txt` | the `Sitemap:` line                                      |

Everything else is relative or derived from `Astro.site`.

## Regenerating og.png and the icons

`og.png` is a 1200x630 screenshot of [`og-card.html`](og-card.html), which sits
outside `src/pages` and `public/` so nothing builds or serves it. Open it at
exactly that viewport and save over the png. Both dimensions are declared in
the meta tags too, so a different size means updating `og:image:width` and
`og:image:height`.

`icon-180.png` is `favicon.svg` rendered on white at 180. The app's copies
(`browser/public/`) are the same mark at 180, 192 and 512, and the four move
together: a product with two colourways of its own mark reads as two products.

## Theme

Light is the default even when the OS prefers dark, and the choice persists in
`localStorage` under `ow-theme`. The inline script in `<head>` applies a saved
dark preference before first paint, because reading the value after paint makes
the page flash light and then flip.
