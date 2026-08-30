/* renderer/features/pane/index.js — the pane's front door.
 *
 * `Pane` is a class in pane.js plus three prototype mixins in pane-status.js,
 * pane-usage.js and pane-git.js. Those three have to run after the class
 * exists, which used to be a matter of getting the <script> order right in
 * index.html — the comment there said so, and nothing enforced it.
 *
 * Importing them here does enforce it: a module's imports are evaluated before
 * its body, in source order, so by the time this file re-exports Pane the
 * mixins are on it. Import Pane from *here*, never from pane.js — that is the
 * half-built one. The three mixin files import pane.js directly on purpose,
 * since importing this file would be a cycle. */

import { Pane } from './pane.js';
import './pane-status.js';
import './pane-usage.js';
import './pane-git.js';

export { Pane };
