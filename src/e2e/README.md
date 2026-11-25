# Screen gate kit

Every screen ticket reuses this kit. Nothing outside the screen's own folder needs editing.

## Add a screen

1. `src/screens/<id>/screen.tsx` exports `screen = { id: '<id>', Component }`. The id must equal the folder name. `src/floor/screens.ts` finds it with `import.meta.glob` (lazy, one route per folder) and `App.tsx` shows it at `#/<id>` inside `ScreenHost`, which wraps it in `[data-screen="<id>"]`. No shared file lists screens. Two optional fields:
   - `ready`: a selector that appears once the screen has drawn what the gates need (data loaded, say). Default: the wrapper, so a screen that draws at once sets nothing.
   - `contrastAllow`: `[{ selector, reason }]`, elements whose text the contrast gate cannot sample (text clipped to its own gradient). An entry with no reason does nothing.
2. `src/locales/en/<id>.json` and `src/locales/th/<id>.json` hold its text. A file becomes the subtree named after the file, so `t('<id>.title')` reads `title` in `<id>.json`. `src/floor/i18n.ts` globs `src/locales/*/*.json`, so no shared locale file is edited.
3. `src/test/i18n-parity.test.ts` then checks, per namespace, the same keys, the same placeholders, the plural forms Thai and English each need, no empty text, a namespace file in both languages, a locale namespace for every screen folder, and that every `t()` key in `src/floor` and `src/screens` exists in both languages. A key built at run time (a template with `${}`, a concatenation, a variable) must have `// i18n-keys: ns.a ns.b` (or `{/* i18n-keys: ... */}` in JSX) on its line or the two above, listing every key it can ask for. Each listed key must exist in both languages and fit the call's literal prefix and suffix.
4. A screen that does not load (wrong id, no export, a module that throws) or throws while rendering shows its cause on its own route (`[data-screen-error]`) and in the console. The floor and the other screens keep working. `src/test/screens.test.ts` fails on any such screen, and `node src/e2e/gates.mjs` prints `FAIL lane 11 <id>: <cause>`, or `not ready` when the ready selector never appears.

## The four gates (`src/e2e/gates.mjs`)

| Gate | Fails when |
| --- | --- |
| axe | any serious or critical finding. The one named exception is the Needs-you chip (cream on `#ef5350`, 3.14 to 1), matched by class, mood, both colours and the ratio. |
| contrast | text under 4.5 to 1, measured from computed colours with every translucent layer and ancestor opacity composited. Text over a gradient or image is measured from a screenshot with all text made transparent: the worst pixel behind the text must give 4.5 to 1. Text that cannot be sampled fails as `not measurable` unless the screen lists it in `contrastAllow` with a reason (the reason is printed in the notes). |
| parity at runtime | any visible text, `aria-label`, `title` or `placeholder` that is a raw locale key, in `en` or `th`. |
| reduced motion | any running CSS animation, CSS transition or Web Animation, any SVG `animate` element, or any element whose transform, translate, rotate, scale, opacity, filter, left or top changes between 12 samples 100 ms apart (a requestAnimationFrame loop), after 0.8 s settle, with `prefers-reduced-motion: reduce`. |

`node src/e2e/gates.mjs` boots a real HQ (`agent-works serve`, not `--demo`), runs the gates on the floor and on every registered screen in both languages, then breaks each gate on purpose (13 breakers: unnamed button and link, grey text, text over a gradient, text in a faded ancestor, raw keys as text, aria-label, title and placeholder, a CSS animation, SMIL, a script moving a transform) and requires the gate to fail. The port is chosen by the OS (bound to port 0, retried if lost). Lane 11b then writes seven synthetic screens (`src/screens/zz-gate-*`, git-ignored, removed after) and builds the floor with them: a screen with its own ready selector, one with none, one that never becomes ready, a wrong id, a throwing module, a throwing render, and unmeasurable text with and without an allowlist. It requires the floor to keep drawing and each cause to be named. It rebuilds the floor afterwards. It runs in the `floor e2e` CI job.

A screen ticket with its own state calls `screenGates({ browser, url, screen: '<id>' })` (pass `ready` only to override what the screen declares), or imports `checkAxe`, `checkContrast`, `checkKeys` and `checkMotion` to run them after it drives the page into a state. `startHq({ port, args })` passes extra `serve` flags, for example a mode and its config.

## Artboard compare

The 24 canvas artboards are in `docs/review/canvas/<Name>.dc.txt` with `canvas.json` (positions and sizes). `canvasCompare(browser, builtPage, demo, spec)` in `canvas-compare.mjs` renders one artboard from its source at 1440 px, renders the built screen, and writes the side by side image, the pixel heatmap and region table, then fails on any inventory difference no entry in the differences file covers. Main keeps `MAIN_SPEC`. A screen ticket builds its spec with `artboardSpec({ name, dir })`, writes `<dir>/<name>-differences.md` in the format of `docs/review/P1-3-canvas-differences.md`, passes `{ inventory: {}, text: '' }` as `demo`, and commits the images with `WRITE_REVIEW_IMAGE=1`.

Limit: for a screen other than Main the negative tests that delete or relabel entries only run when the differences file has entries of every status (fixed, changed, not-built, with a built-only key). Otherwise they are skipped, and the verdict note says `SKIPPED` (`negativeNote` in `canvas-compare.mjs`).

## Mutants

`node src/scripts/mutants.mjs <name>...` runs the named mutants. The `gates-*` and `screens-*` ones break the gate or registry code and are caught by the unit tests or by `node src/e2e/gates.mjs`. `css-reduced-motion-rule-dropped` removes the belt rule from the real CSS.
