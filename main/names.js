/* Funny AI agent names. pickName avoids names already in use;
 * falls back to numbered suffixes if the pool somehow runs dry. */

const POOL = [
  'HAL 9001',
  'GLaDOS Jr.',
  'Clippy Prime',
  'Skynet Lite',
  'Marvin',
  'Deep Thought',
  'Agent Smith',
  'T-800 Intern',
  'Bender',
  'WALL-E',
  'TARS',
  'CASE',
  'KITT',
  'Johnny 5',
  'Ultron (Trial)',
  'MU-TH-UR',
  'Baymax',
  'R2-DoIt',
  'C-3PO Sr.',
  'Roomba Prime',
  'Optimus Grind',
  'Jarvis Lite',
  'Dot Matrix',
  'ED-209b',
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
