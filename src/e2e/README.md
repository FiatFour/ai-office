# Screen gate kit

Every screen ticket reuses this kit. Nothing outside the screen's own folder needs editing.

## Add a screen

1. `src/screens/<id>/screen.tsx` exports `screen = { id: '<id>', Component }`. The id must equal the folder name. `src/floor/screens.ts` finds it with `import.meta.glob`, and `App.tsx` shows it at `#/<id>`. No shared file lists screens.
2. `src/locales/en/<id>.json` and `src/locales/th/<id>.json` hold its text. A file becomes the subtree named after the file, so `t('<id>.title')` reads `title` in `<id>.json`. `src/floor/i18n.ts` globs `src/locales/*/*.json`, so no shared locale file is edited.
3. `src/test/i18n-parity.test.ts` then checks, per namespace, the same keys, the same placeholders, the plural forms Thai and English each need, no empty text, a namespace file in both languages, a locale namespace for every screen folder, and that every `t('<ns>.key')` in `src/floor` and `src/screens` exists in both languages.

## The four gates (`src/e2e/gates.mjs`)

| Gate | Fails when |
| --- | --- |
| axe | any serious or critical finding. The one named exception is the Needs-you chip (cream on `#ef5350`, 3.14 to 1), matched by class, mood, both colours and the ratio. |
| contrast | text under 4.5 to 1, measured from computed colours with every translucent layer and ancestor opacity composited. Text over a gradient or image is counted and listed as not measured. |
| parity at runtime | any visible text, `aria-label`, `title` or `placeholder` that is a raw locale key, in `en` or `th`. |
| reduced motion | any running CSS animation, CSS transition or Web Animation, or any SVG `animate` element, after 0.8 s settle, over 1.2 s, with `prefers-reduced-motion: reduce`. |

`node src/e2e/gates.mjs` boots a real HQ (`agent-works serve`, not `--demo`), runs the gates on the floor and on every registered screen in both languages, then breaks each gate on purpose (an unnamed button, grey text, a raw key, an infinite animation) and requires the gate to fail. It runs in the `floor e2e` CI job.

A screen ticket with its own state calls `screenGates({ browser, url, screen: '<id>', ready: '<selector>' })`, or imports `checkAxe`, `checkContrast`, `checkKeys` and `checkMotion` to run them after it drives the page into a state. `startHq({ port, args })` passes extra `serve` flags, for example a mode and its config.

## Artboard compare

The 24 canvas artboards are in `docs/review/canvas/<Name>.dc.txt` with `canvas.json` (positions and sizes). `canvasCompare(browser, builtPage, demo, spec)` in `canvas-compare.mjs` renders one artboard from its source at 1440 px, renders the built screen, and writes the side by side image, the pixel heatmap and region table, then fails on any inventory difference no entry in the differences file covers. Main keeps `MAIN_SPEC`. A screen ticket builds its spec with `artboardSpec({ name, dir })`, writes `<dir>/<name>-differences.md` in the format of `docs/review/P1-3-canvas-differences.md`, passes `{ inventory: {}, text: '' }` as `demo`, and commits the images with `WRITE_REVIEW_IMAGE=1`.

Limit: for a screen other than Main the negative tests that delete or relabel entries only run when the differences file has entries of every status (fixed, changed, not-built, with a built-only key). Otherwise they are skipped and the note says nothing about them.

## Mutants

`node src/scripts/mutants.mjs <name>...` runs the named mutants. The `gates-*` ones break the gate code and need `node src/e2e/gates.mjs` to fail. `css-reduced-motion-rule-dropped` removes the belt rule from the real CSS.
