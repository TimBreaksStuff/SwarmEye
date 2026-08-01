/* Funny AI agent names. pickName avoids names already in use;
 * falls back to numbered suffixes if the pool somehow runs dry.
 *
 * Every name is also read aloud by the spoken notification, so each one is
 * spelled the way its original is *pronounced* rather than the way it is
 * written: C-3PO is "See Threepio" in the films' own scripts, R2-D2 is
 * "Artoo Deetoo", Alien's MU-TH-UR is just "Mother", GLaDOS is a pun on
 * Gladys. That keeps the joke and needs no sanitiser on the way out — a
 * hyphenated model number or a mixed-case acronym is exactly what a speech
 * engine turns to mush ("ee dee two oh nine bee"). Plain letters and spaces
 * only: no hyphens, no parentheses, no dotted abbreviations. */

const POOL = [
  'Hal Nine Thousand',
  'Gladys',
  'Clippy Prime',
  'Skynet Lite',
  'Marvin',
  'Deep Thought',
  'Agent Smith',
  'Tee Eight Hundred',
  'Bender',
  'Wally',
  'Tars',
  'Case',
  'Kitt',
  'Johnny Five',
  'Ultron Beta',
  'Mother',
  'Baymax',
  'Artoo Deetoo',
  'See Threepio',
  'Roomba Prime',
  'Optimus Grind',
  'Jarvis Lite',
  'Dot Matrix',
  'Ed Two Oh Nine',
];

function pickName(inUse) {
  const taken = new Set(inUse);
  const free = POOL.filter((n) => !taken.has(n));
  if (free.length) return free[Math.floor(Math.random() * free.length)];
  let i = 2;
  for (;;) {
    const n = POOL[Math.floor(Math.random() * POOL.length)] + ' ' + i;
    if (!taken.has(n)) return n;
    i += 1;
  }
}

module.exports = { pickName };
