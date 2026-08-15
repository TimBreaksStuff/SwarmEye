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
    // not in OPTIONS: the fixed "needs your input" sound — a falling
    // two-tone, so the ear can tell a blocked agent from a finished one
    alert: (ac, t) => { tone(ac, 740, t, 0.15, 0.22); tone(ac, 554, t + 0.16, 0.22, 0.2); },
  };

  function play(name) {
    if (!name || !RECIPES[name]) return;
    try {
      const ac = getCtx();
      RECIPES[name](ac, ac.currentTime);
    } catch { /* audio unavailable — never block notifications on this */ }
  }

  /* Spoken notifications. Main hands back base64 16-bit mono PCM from the
   * local Piper voice (no audio device on its side of the WSL boundary), which
   * plays through the same AudioContext the tones use — a blob: or data: URL
   * on an <audio> would be blocked by the page's CSP, and WebAudio isn't a
   * fetch, so it isn't. */
  let voice = null; // the utterance currently playing

  async function speak(text) {
    const res = await window.swarm.ttsSpeak(text);
    if (!res || !res.ok) return res;
    try {
      const ac = getCtx();
      const bytes = Uint8Array.from(atob(res.pcm), (c) => c.charCodeAt(0));
      const pcm = new Int16Array(bytes.buffer, 0, bytes.length >> 1);
      const buf = ac.createBuffer(1, pcm.length, res.rate);
      const chan = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) chan[i] = pcm[i] / 32768;
      const src = ac.createBufferSource();
      src.buffer = buf;
      src.connect(ac.destination);
      // whoever finished last is the one worth hearing — cut the previous line
      // off rather than talking over it
      if (voice) { try { voice.stop(); } catch { /* already ended */ } }
      voice = src;
      src.onended = () => { if (voice === src) voice = null; };
      src.start();
      return { ok: true };
    } catch { return { ok: false, reason: 'audio' }; }
  }

  return { OPTIONS, play, speak };
})();
window.Sounds = Sounds;
