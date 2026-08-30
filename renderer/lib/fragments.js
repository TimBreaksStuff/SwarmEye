/* renderer/lib/fragments.js — each area's markup, from that area's folder.
 *
 * index.html used to hold the DOM of every feature in the app: the board, the
 * skills screen, the coordinator, the notification panel and the 260-line
 * Options popover. It is a chokepoint file, so any two agents touching two
 * unrelated features collided in it. The markup now lives in
 * `features/<area>/<area>.html` next to that area's JS, CSS and README, and
 * index.html keeps only the shell and a placeholder per block.
 *
 * A fragment file is one or more `<template data-mount="name">` sections.
 * Each replaces the `<div data-fragment="name">` placeholder that carries the
 * same name — replaces, so the placeholder leaves no wrapper behind and the
 * DOM is exactly what it was when the markup was inline. That is also why a
 * fragment may hold several templates: the notification panel and its popover
 * sit in different places in the shell, and moving either would change paint
 * order between elements whose z-index ties.
 *
 * Everything must be mounted before a single feature module is evaluated,
 * since they look their elements up at import time. boot.js is what guarantees
 * that: it awaits this, then imports app.js.
 */

/* fetch over file:// works in Electron's renderer (verified on 38); this is
 * why there is no build step to inline any of it. */
async function fetchFragment(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.text();
}

/* Every area that keeps its markup in its own folder. Order is irrelevant —
 * each template names the placeholder it belongs to — so this is alphabetical
 * and a new area is one line. */
export const FRAGMENTS = [
  'features/board/board.html',
  'features/coordinator/coordinator.html',
  'features/notifications/notifications.html',
  'features/palette/palette.html',
  'features/preview/preview.html',
  'features/settings/settings.html',
  'features/skills/skills.html',
];

export async function mountFragments(urls = FRAGMENTS) {
  const texts = await Promise.all(urls.map(fetchFragment));
  const parser = new DOMParser();
  const missing = [];

  for (let i = 0; i < urls.length; i++) {
    const doc = parser.parseFromString(texts[i], 'text/html');
    const templates = doc.querySelectorAll('template[data-mount]');
    if (!templates.length) throw new Error(`${urls[i]}: no <template data-mount> in it`);
    for (const tpl of templates) {
      const name = tpl.dataset.mount;
      const slot = document.querySelector(`[data-fragment="${name}"]`);
      if (!slot) { missing.push(`${urls[i]} -> ${name}`); continue; }
      slot.replaceWith(tpl.content.cloneNode(true));
    }
  }

  /* Loud on purpose. A fragment that quietly did not mount leaves a feature
   * wiring itself to elements that are not there, and the first symptom is a
   * null dereference somewhere else entirely. */
  const orphans = [...document.querySelectorAll('[data-fragment]')].map((el) => el.dataset.fragment);
  if (missing.length || orphans.length) {
    throw new Error('fragments did not mount — '
      + (missing.length ? `no placeholder for: ${missing.join(', ')}. ` : '')
      + (orphans.length ? `no template for: ${orphans.join(', ')}.` : ''));
  }
}
