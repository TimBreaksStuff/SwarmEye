/* renderer/boot.js — the renderer's entry point, and the only reason there is
 * one beyond app.js.
 *
 * Feature modules do their work when they are evaluated: they look their
 * elements up and build their selects there and then. Two things have to be
 * true before the first one runs, and neither can be waited for by a static
 * `import` at the top of a file:
 *
 *   - the markup has to be in the document — most of it arrives from
 *     `features/<area>/<area>.html` (lib/fragments.js);
 *   - the model and effort tables have to be filled — main/models.js owns
 *     them and hands them over `models:list` (features/pane/pane-const.js).
 *
 * A dynamic import can wait. This file does both, then imports app.js, which
 * pulls the whole feature graph in against a document and a vocabulary that
 * are already complete.
 *
 * Both awaits are unguarded on purpose. Neither has a sensible fallback — a
 * half-mounted DOM or an empty model list is a broken app, not a degraded one
 * — and a rejection here stops the boot loudly, which `scripts/boot-check.js`
 * reports by name.
 */

import { mountFragments } from './lib/fragments.js';
import { installModels } from './features/pane/pane-const.js';

await mountFragments();
installModels(await window.swarm.listModels());
await import('./app.js');
