/* renderer/sounds.js — tiny synthesized notification sounds (no audio
 * files/assets to ship). Exposes window.Sounds: { OPTIONS, play(name) }. */
const Sounds = (() => {
  const OPTIONS = [
    ['none', 'None'],
    ['chime', 'Chime'],
    ['ping', 'Ping'],
    ['pop', 'Pop'],
    ['blip', 'Blip'],
  ];

  let ctx = null;
  function getCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }

  function tone(ac, freq, start, dur, peak, type = 'sine') {
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(ac.destination);
    osc.start(start);
    osc.stop(start + dur);
  }

  const RECIPES = {
    chime: (ac, t) => { tone(ac, 880, t, 0.18, 0.2); tone(ac, 1320, t + 0.1, 0.25, 0.18); },
    ping: (ac, t) => { tone(ac, 1400, t, 0.15, 0.22); },
    pop: (ac, t) => { tone(ac, 220, t, 0.12, 0.25, 'triangle'); },
    blip: (ac, t) => { tone(ac, 660, t, 0.06, 0.2, 'square'); tone(ac, 990, t + 0.07, 0.08, 0.18, 'square'); },
  };

  function play(name) {
    if (!name || !RECIPES[name]) return;
    try {
      const ac = getCtx();
      RECIPES[name](ac, ac.currentTime);
    } catch { /* audio unavailable — never block notifications on this */ }
  }

  return { OPTIONS, play };
})();
window.Sounds = Sounds;
