/* renderer/speech.js — local dictation. Chromium's SpeechRecognition doesn't
 * work in Electron (its cloud backend needs Google API keys Electron doesn't
 * ship — every session dies with error:network), so the mic is captured here
 * via getUserMedia, downsampled to 16 kHz 16-bit mono PCM and streamed over
 * IPC to a Whisper (faster-whisper) recognizer in WSL (install:
 * scripts/setup-stt.sh). Fully
 * offline — audio never leaves the machine. Exposes window.Speech:
 * { supported, start(opts), stop() }. Only one dictation session
 * runs app-wide at a time. */
const Speech = (() => {
  const supported = !!(window.swarm && window.swarm.speechStart && navigator.mediaDevices);
  let active = null; // { id, opts, stream, ctx }
  let nextId = 1;

  function teardownAudio(a) {
    if (a.stream) a.stream.getTracks().forEach((t) => t.stop());
    if (a.ctx && a.ctx.state !== 'closed') a.ctx.close();
    a.stream = null;
    a.ctx = null;
  }

  // finish `active` locally without waiting for the backend's speech:end —
  // used when a new session supersedes it; late events are dropped by id
  function finishActive() {
    const a = active;
    if (!a) return;
    active = null;
    teardownAudio(a);
    window.swarm.speechStop();
    a.opts.onEnd && a.opts.onEnd();
  }

  function stop() {
    if (!active) return;
    teardownAudio(active); // release the mic immediately, don't wait for the backend
    window.swarm.speechStop(); // backend flushes the final phrase, then speech:end fires
  }

  if (supported) {
    window.swarm.onSpeechResult(({ id, text, isFinal }) => {
      if (!active || active.id !== id || !text) return;
      if (!isFinal && !active.opts.interim) return;
      active.opts.onResult(text, !!isFinal);
    });
    window.swarm.onSpeechError(({ id, code }) => {
      if (active && active.id === id && active.opts.onError) active.opts.onError(code);
    });
    window.swarm.onSpeechEnd(({ id }) => {
      if (!active || active.id !== id) return;
      const a = active;
      active = null;
      teardownAudio(a);
      a.opts.onEnd && a.opts.onEnd();
    });
  }

  /**
   * @param {object} opts
   *   interim: boolean — fire onResult for non-final text too
   *   onResult: (text, isFinal) => void
   *   onEnd: () => void
   *   onError: (code) => void   // 'not-allowed', 'not-installed', 'backend'
   */
  async function start(opts) {
    if (!supported) return null;
    finishActive();
    const session = { id: nextId++, opts, stream: null, ctx: null };
    active = session;

    const res = await window.swarm.speechStart(session.id);
    if (session !== active) return null; // superseded while starting
    if (!res.ok) {
      active = null;
      opts.onError && opts.onError(res.reason === 'not-installed' ? 'not-installed' : 'backend');
      opts.onEnd && opts.onEnd();
      return null;
    }
    try {
      session.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch {
      if (session === active) {
        active = null;
        window.swarm.speechStop();
        opts.onError && opts.onError('not-allowed');
        opts.onEnd && opts.onEnd();
      }
      return null;
    }
    if (session !== active) { teardownAudio(session); return null; }

    // AudioContext resamples the mic to the recognizer's 16 kHz for us
    session.ctx = new AudioContext({ sampleRate: 16000 });
    const src = session.ctx.createMediaStreamSource(session.stream);
    const node = session.ctx.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = (e) => {
      if (session !== active) return;
      const f = e.inputBuffer.getChannelData(0);
      const pcm = new Int16Array(f.length);
      for (let i = 0; i < f.length; i++) {
        const s = Math.max(-1, Math.min(1, f[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      window.swarm.speechAudio(new Uint8Array(pcm.buffer).toBase64());
    };
    src.connect(node);
    node.connect(session.ctx.destination); // keeps the graph pulling; output stays silent
    return session;
  }

  return { supported, start, stop };
})();
window.Speech = Speech;
