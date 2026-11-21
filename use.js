/*
 * USE — Unbound Sound Engine
 * Lightweight procedural audio dependency
 * Version: 0.2.1
 * No external dependencies
 *
 * Layer fields: noise, wave, frequency, level, filterType, filter, filterEnd,
 *   Q, attack, decay, sustain, release, duration, delay, fm, fmRate,
 *   pitchDrop (semitones; negative falls, positive rises)
 * play() options: volume, pitch, pan (-1..1), pitchJitter, volumeJitter, id
 */

const USE = (() => {
  let ctx = null;
  let master = null;
  let compressor = null;
  let sharedNoise = null;
  let masterVolume = 1;
  let maxVoices = 48;
  let initialized = false;

  const activeSounds = new Map();
  const presets = {};

  async function init() {
    if (initialized) {
      if (ctx.state === "suspended") await ctx.resume();
      return;
    }

    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error("Web Audio API is not supported.");

    ctx = new AudioContext();
    master = ctx.createGain();
    compressor = ctx.createDynamicsCompressor();

    compressor.threshold.value = -12;
    compressor.knee.value = 12;
    compressor.ratio.value = 4;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;

    master.gain.value = masterVolume;
    master.connect(compressor);
    compressor.connect(ctx.destination);

    // One shared noise buffer; layers loop it from a random offset
    const len = ctx.sampleRate * 2;
    sharedNoise = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = sharedNoise.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    initialized = true;
    if (ctx.state === "suspended") await ctx.resume();
  }

  function requireInit() {
    if (!initialized) throw new Error("Call USE.init() before playing sounds.");
  }

  function random(min, max) {
    return min + Math.random() * (max - min);
  }

  function playLayer(layer, options, onEnd) {
    const t0 = ctx.currentTime + (layer.delay || 0);
    const duration = Math.max(0.02, layer.duration || 0.3);
    const pitch = options.pitch ?? 1;

    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    const volume = (layer.level ?? 0.5) * (options.volume ?? 1);
    const attack = layer.attack ?? 0.005;
    const decay = layer.decay ?? 0.08;
    const sustain = layer.sustain ?? 0;
    const release = layer.release ?? 0.1;

    const peak = Math.max(0.0001, volume);
    const sus = Math.max(0.0001, volume * sustain);
    const decayEnd = t0 + attack + decay;
    const relStart = Math.max(decayEnd, t0 + duration);
    const total = relStart - t0 + release;

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(sus, decayEnd);
    gain.gain.setValueAtTime(sus, relStart);
    gain.gain.exponentialRampToValueAtTime(0.0001, relStart + release);

    const f0 = (layer.filter || 18000) * (layer.noise ? pitch : 1);
    filter.type = layer.filterType || "lowpass";
    filter.frequency.setValueAtTime(Math.min(f0, ctx.sampleRate / 2 - 100), t0);
    if (layer.filterEnd) {
      filter.frequency.exponentialRampToValueAtTime(
        Math.max(20, layer.filterEnd * (layer.noise ? pitch : 1)),
        relStart
      );
    }
    filter.Q.value = layer.Q || 1;

    filter.connect(gain);
    let out = gain;
    let panner = null;
    if (options.pan !== undefined && ctx.createStereoPanner) {
      panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, options.pan));
      gain.connect(panner);
      out = panner;
    }
    out.connect(master);

    let source;
    let modulator = null;

    if (layer.noise) {
      source = ctx.createBufferSource();
      source.buffer = sharedNoise;
      source.loop = true;
      source.start(t0, Math.random() * 1.5);
    } else {
      source = ctx.createOscillator();
      source.type = layer.wave || "sine";

      const base = (layer.frequency || 440) * pitch;
      source.frequency.setValueAtTime(base, t0);

      if (layer.pitchDrop) {
        source.frequency.exponentialRampToValueAtTime(
          Math.max(1, base * Math.pow(2, layer.pitchDrop / 12)),
          t0 + duration
        );
      }

      if (layer.fm) {
        modulator = ctx.createOscillator();
        const modGain = ctx.createGain();
        modulator.frequency.value = layer.fmRate || 30;
        modGain.gain.value = layer.fm;
        modulator.connect(modGain);
        modGain.connect(source.frequency);
        modulator.start(t0);
        modulator.stop(t0 + total + 0.05);
      }

      source.start(t0);
    }

    source.connect(filter);
    source.stop(t0 + total + 0.05);

    source.onended = () => {
      try { out.disconnect(); gain.disconnect(); filter.disconnect(); } catch {}
      onEnd();
    };

    return { source, gain, modulator };
  }

  function fadeStop(voice) {
    const t = ctx.currentTime;
    const g = voice.gain.gain;
    try {
      const v = g.value;
      g.cancelScheduledValues(t);
      g.setValueAtTime(Math.max(0.0001, v), t);
      g.setTargetAtTime(0.0001, t, 0.005);
      voice.source.stop(t + 0.04);
      if (voice.modulator) voice.modulator.stop(t + 0.04);
    } catch {}
  }

  function play(name, options = {}) {
    requireInit();

    const preset = presets[name];
    if (!preset) throw new Error(`Unknown USE preset: ${name}`);

    const id = options.id || `use-${Date.now()}-${Math.random()}`;

    if (activeSounds.has(id)) stop(id);
    while (activeSounds.size >= maxVoices) {
      stop(activeSounds.keys().next().value);
    }

    const pj = options.pitchJitter ?? 0;
    const vj = options.volumeJitter ?? 0;
    const o = {
      ...options,
      pitch: (options.pitch ?? 1) * (1 + random(-pj, pj)),
      volume: (options.volume ?? 1) * (1 + random(-vj, vj))
    };

    const entry = { voices: [], remaining: preset.layers.length };
    activeSounds.set(id, entry);

    const onEnd = () => {
      entry.remaining--;
      if (entry.remaining <= 0 && activeSounds.get(id) === entry) {
        activeSounds.delete(id);
      }
    };

    for (const layer of preset.layers) {
      entry.voices.push(
        playLayer({ duration: preset.duration, ...layer }, o, onEnd)
      );
    }

    return id;
  }

  function stop(id) {
    const entry = activeSounds.get(id);
    if (!entry) return;
    activeSounds.delete(id);
    for (const voice of entry.voices) fadeStop(voice);
  }

  function stopAll() {
    for (const id of [...activeSounds.keys()]) stop(id);
  }

  function registerPreset(name, preset) {
    if (!name || !preset || !Array.isArray(preset.layers)) {
      throw new Error("Invalid USE preset.");
    }
    presets[name] = preset;
  }

  function setMasterVolume(value) {
    masterVolume = Math.max(0, Math.min(1, value));
    if (master) master.gain.setTargetAtTime(masterVolume, ctx.currentTime, 0.02);
  }

  function setMaxVoices(n) {
    maxVoices = Math.max(1, Math.floor(n));
  }

  function getPresets() {
    return Object.keys(presets);
  }

  // Built-in presets

  registerPreset("footstep", {
    duration: 0.1,
    layers: [
      { noise: true, level: 0.5, filter: 600, filterEnd: 180, duration: 0.09, attack: 0.003, decay: 0.09, release: 0.03 },
      { wave: "sine", frequency: 70, level: 0.5, pitchDrop: -10, duration: 0.1, attack: 0.002, decay: 0.1, release: 0.03 }
    ]
  });

  registerPreset("gunshot", {
    duration: 0.9,
    layers: [
      { noise: true, level: 0.8, filterType: "highpass", filter: 2500, duration: 0.03, attack: 0.0005, decay: 0.03, release: 0.02 },
      { noise: true, level: 0.9, filter: 3500, filterEnd: 400, duration: 0.35, attack: 0.001, decay: 0.35, release: 0.1 },
      { wave: "sine", frequency: 110, level: 0.8, pitchDrop: -20, duration: 0.15, attack: 0.001, decay: 0.15, release: 0.05 },
      { noise: true, level: 0.25, filter: 900, filterEnd: 250, duration: 0.9, attack: 0.02, decay: 0.9, release: 0.2 }
    ]
  });

  registerPreset("explosion", {
    duration: 2.2,
    layers: [
      { noise: true, level: 1, filter: 2500, filterEnd: 120, duration: 1.6, attack: 0.004, decay: 1.6, release: 0.3 },
      { wave: "sine", frequency: 55, level: 1, pitchDrop: -24, duration: 1.2, attack: 0.002, decay: 1.2, release: 0.2 },
      { noise: true, level: 0.6, filter: 200, duration: 2.2, attack: 0.08, decay: 2.2, release: 0.4 }
    ]
  });

  registerPreset("impact", {
    duration: 0.2,
    layers: [
      { noise: true, level: 0.5, filterType: "bandpass", filter: 1800, Q: 2, duration: 0.05, attack: 0.001, decay: 0.05, release: 0.03 },
      { wave: "triangle", frequency: 220, level: 0.6, pitchDrop: -20, duration: 0.18, attack: 0.001, decay: 0.18, release: 0.05 }
    ]
  });

  registerPreset("beep", {
    duration: 0.2,
    layers: [
      { wave: "sine", frequency: 880, level: 0.35, duration: 0.2, attack: 0.01, decay: 0.02, sustain: 0.8 }
    ]
  });

  return {
    init,
    play,
    stop,
    stopAll,
    registerPreset,
    setMasterVolume,
    setMaxVoices,
    getPresets,

    get context() { return ctx; },
    get version() { return "0.2.1"; }
  };
})();

export default USE;
