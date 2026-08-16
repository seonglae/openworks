# site

The public homepage. Static, no build step, no framework: one `index.html` plus
its assets. Open the file to work on it.

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

Absolute URLs live in exactly five places, because search engines and link
unfurlers both reject relative ones:

| file                           | field                          |
| ------------------------------ | ------------------------------ |
| `index.html`                   | `<link rel="canonical">`       |
| `index.html`                   | `og:url`                       |
| `index.html`                   | `og:image` and `twitter:image` |
| `index.html`                   | the `url` in the JSON-LD block |
| `robots.txt` and `sitemap.xml` | `Sitemap:` and `<loc>`         |

Everything else is relative and moves with the site.

## Regenerating og.png

`og.png` is a 1200x630 screenshot of a standalone HTML card, so it stays
editable as markup rather than as a binary. Render it at that exact viewport
and save over the file. Both dimensions are also declared in the meta tags, so
a different size means updating `og:image:width` and `og:image:height` too.

## Theme

Light is the default even when the OS prefers dark, and the choice persists in
`localStorage` under `ow-theme`. The inline script in `<head>` applies a saved
dark preference before first paint, because reading the value after paint makes
the page flash light and then flip.
