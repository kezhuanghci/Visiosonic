/* =========================================================================
   Visiosonic — turn a photograph into music (musical engine v2).

   From wall-of-tones to an actual arrangement:
     • The dominant HUE of the photo chooses the KEY.
     • The tempo slider chooses the BPM; the image is read left→right in BARS.
     • Each bar's average color picks a DIATONIC TRIAD → a consonant chord
       progression (any diminished chord is nudged to a stable one).
     • Four instrument layers, not 200 raw oscillators:
         BASS   – rounded sine+triangle root on the downbeats
         PAD    – warm detuned-saw strings holding the chord
         MELODY – FM electric-piano that follows the brightest / most vivid
                  spot in each beat, snapping to chord tones on strong beats
         BELL   – FM sparkles on bright highlights
   Meaning is preserved: lightness→loudness+register, saturation→presence,
   hue→note+timbre, vertical position→pitch, shadows→rests(rhythm).
   ========================================================================= */

(() => {
  "use strict";

  // ---------- DOM ----------
  const $ = (id) => document.getElementById(id);
  const dropStage = $("dropStage");
  const dropzone = $("dropzone");
  const fileInput = $("fileInput");
  const studio = $("studio");
  const imageCanvas = $("imageCanvas");
  const overlay = $("overlayCanvas");
  const scanline = $("scanline");
  const paletteStrip = $("paletteStrip");
  const backBtn = $("backBtn");
  const generateBtn = $("generateBtn");
  const progressWrap = $("progressWrap");
  const progressBar = $("progressBar");
  const progressLabel = $("progressLabel");
  const player = $("player");
  const playBtn = $("playBtn");
  const downloadBtn = $("downloadBtn");
  const seek = document.querySelector(".seek");
  const seekFill = $("seekFill");
  const curTime = $("curTime");
  const totTime = $("totTime");
  const vizCanvas = $("vizCanvas");

  // ---------- State ----------
  const state = {
    img: null,
    analysis: null,        // {data, w, h}
    scale: "pentatonic",
    instrument: "piano",   // single timbre for the whole piece
    duration: 14,          // target length (slider)
    playDuration: 14,      // actual composed length (whole number of bars)
    steps: 36,             // tempo slider / overlay columns
    bands: 6,
    reverb: true,
    renderedBuffer: null,
    wavBlob: null,
    events: null,
    // playback
    ctx: null,
    source: null,
    analyser: null,
    startedAt: 0,
    offset: 0,
    playing: false,
    raf: 0,
  };

  // Scales: `chord` (7 diatonic degrees for harmony) + `mel` (melody palette).
  const SCALES = {
    pentatonic: { chord: [0, 2, 4, 5, 7, 9, 11], mel: [0, 2, 4, 7, 9] },       // Dreamy
    major:      { chord: [0, 2, 4, 5, 7, 9, 11], mel: [0, 2, 4, 5, 7, 9, 11] }, // Bright
    minor:      { chord: [0, 2, 3, 5, 7, 8, 10], mel: [0, 2, 3, 5, 7, 8, 10] }, // Melancholy
    lydian:     { chord: [0, 2, 4, 6, 7, 9, 11], mel: [0, 2, 4, 6, 7, 9, 11] }, // Ethereal
  };

  const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

  /* ======================================================================
     Particle background
     ==================================================================== */
  (function particles() {
    const cv = $("particles");
    const g = cv.getContext("2d");
    let w, h, dots;
    function resize() {
      w = cv.width = innerWidth;
      h = cv.height = innerHeight;
      const n = Math.min(90, Math.floor((w * h) / 26000));
      dots = Array.from({ length: n }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: Math.random() * 1.8 + 0.4,
        vx: (Math.random() - 0.5) * 0.25, vy: (Math.random() - 0.5) * 0.25,
        a: Math.random() * 0.5 + 0.1,
      }));
    }
    function tick() {
      g.clearRect(0, 0, w, h);
      for (const d of dots) {
        d.x += d.vx; d.y += d.vy;
        if (d.x < 0) d.x = w; if (d.x > w) d.x = 0;
        if (d.y < 0) d.y = h; if (d.y > h) d.y = 0;
        g.beginPath(); g.arc(d.x, d.y, d.r, 0, Math.PI * 2);
        g.fillStyle = `rgba(200,190,255,${d.a})`; g.fill();
      }
      requestAnimationFrame(tick);
    }
    addEventListener("resize", resize);
    resize(); tick();
  })();

  /* ======================================================================
     Color helpers
     ==================================================================== */
  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0; const l = (max + min) / 2; const d = max - min;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = (g - b) / d + (g < b ? 6 : 0); break;
        case g: h = (b - r) / d + 2; break;
        default: h = (r - g) / d + 4;
      }
      h *= 60;
    }
    return [h, s, l];
  }

  /* ======================================================================
     Image handling
     ==================================================================== */
  function loadImageFromSrc(src) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => { state.img = img; enterStudio(img); };
    img.onerror = () => toast("Couldn't load that image.");
    img.src = src;
  }

  function handleFile(file) {
    if (!file || !file.type.startsWith("image/")) { toast("Please choose an image file."); return; }
    const reader = new FileReader();
    reader.onload = (e) => loadImageFromSrc(e.target.result);
    reader.readAsDataURL(file);
  }

  function enterStudio(img) {
    dropStage.classList.add("hidden");
    studio.classList.remove("hidden");

    // Fit the display box to the photo's real aspect ratio — never pad with black.
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const ar = img.width / img.height;
    const wrapEl = imageCanvas.parentElement;
    const availW = wrapEl.getBoundingClientRect().width || (wrapEl.parentElement.clientWidth - 32);
    const maxH = Math.max(220, Math.min(innerHeight * 0.72, 760));
    let dispW = availW;
    let dispH = dispW / ar;
    if (dispH > maxH) { dispH = maxH; dispW = dispH * ar; }   // tall images: clamp height
    if (dispW > availW) { dispW = availW; dispH = dispW / ar; } // wide images: clamp width
    wrapEl.style.width = dispW + "px";
    wrapEl.style.height = dispH + "px";

    for (const cv of [imageCanvas, overlay]) {
      cv.width = Math.round(dispW * dpr);
      cv.height = Math.round(dispH * dpr);
    }
    const ictx = imageCanvas.getContext("2d");
    ictx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ictx.clearRect(0, 0, dispW, dispH);
    ictx.drawImage(img, 0, 0, dispW, dispH); // fill the box with only the photo

    const aw = 240, ah = Math.max(1, Math.round(240 / ar));
    const off = document.createElement("canvas");
    off.width = aw; off.height = ah;
    const octx = off.getContext("2d", { willReadFrequently: true });
    octx.drawImage(img, 0, 0, aw, ah);
    state.analysis = { data: octx.getImageData(0, 0, aw, ah), w: aw, h: ah };

    buildPalette();
    drawOverlayGrid(-1);

    player.classList.add("hidden");
    progressWrap.classList.add("hidden");
    resetPlayer();
    studio.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function avgColor(x0, y0, x1, y1) {
    const { data, w } = state.analysis;
    let r = 0, g = 0, b = 0, n = 0;
    const stepX = Math.max(1, Math.floor((x1 - x0) / 6));
    const stepY = Math.max(1, Math.floor((y1 - y0) / 6));
    for (let y = y0; y < y1; y += stepY) {
      for (let x = x0; x < x1; x += stepX) {
        const i = (y * w + x) * 4;
        r += data.data[i]; g += data.data[i + 1]; b += data.data[i + 2]; n++;
      }
    }
    if (!n) return [0, 0, 0];
    return [r / n, g / n, b / n];
  }

  // The most salient band (brightest × most saturated) in a vertical slice.
  function focalOfColumn(x0, x1) {
    const { h } = state.analysis;
    const bands = state.bands;
    let best = null, bestScore = -1, maxLight = 0;
    for (let bnd = 0; bnd < bands; bnd++) {
      const y0 = Math.floor((bnd / bands) * h);
      const y1 = Math.max(y0 + 1, Math.floor(((bnd + 1) / bands) * h));
      const [r, g, b] = avgColor(x0, y0, x1, y1);
      const [hue, sat, light] = rgbToHsl(r, g, b);
      maxLight = Math.max(maxLight, light);
      const score = light * (0.4 + 0.6 * sat);
      if (score > bestScore) {
        bestScore = score;
        best = { hue, sat, light, topness: (bands - 1 - bnd) / (bands - 1) };
      }
    }
    best.maxLight = maxLight;
    return best;
  }

  function buildPalette() {
    const { w, h } = state.analysis;
    const cols = 14;
    paletteStrip.innerHTML = "";
    for (let c = 0; c < cols; c++) {
      const [r, g, b] = avgColor(Math.floor((c / cols) * w), 0, Math.floor(((c + 1) / cols) * w), h);
      const s = document.createElement("span");
      s.style.background = `rgb(${r | 0},${g | 0},${b | 0})`;
      paletteStrip.appendChild(s);
    }
  }

  function drawOverlayGrid(activeCol) {
    const octx = overlay.getContext("2d");
    const dpr = Math.min(devicePixelRatio || 1, 2);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = overlay.width / dpr, H = overlay.height / dpr;
    octx.clearRect(0, 0, W, H);
    if (activeCol < 0) return;
    const colW = W / state.steps;
    const grd = octx.createLinearGradient(activeCol * colW, 0, (activeCol + 1) * colW, 0);
    grd.addColorStop(0, "rgba(255,255,255,0)");
    grd.addColorStop(0.5, "rgba(255,255,255,0.14)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    octx.fillStyle = grd;
    octx.fillRect(activeCol * colW, 0, colW, H);
  }

  // deterministic pseudo-random so a given image always plays the same
  function pseudo(n) { const x = Math.sin(n * 127.1 + 0.7) * 43758.5453; return x - Math.floor(x); }

  /* ======================================================================
     Composition builder — image → arrangement of note events
     Returns { events, duration }.
     ==================================================================== */
  function buildTriad(S, d) {
    const out = [];
    for (const step of [0, 2, 4]) {
      const i = d + step;
      out.push(S[i % 7] + 12 * Math.floor(i / 7));
    }
    // fix diminished fifth → perfect fifth so every chord is stable
    if (out[2] - out[0] === 6) out[2] = out[0] + 7;
    return out;
  }

  function nearest(target, pool) {
    let best = pool[0], bd = Infinity;
    for (const c of pool) { const d = Math.abs(c - target); if (d < bd) { bd = d; best = c; } }
    return best;
  }

  function buildComposition() {
    const { w, h } = state.analysis;
    const sc = SCALES[state.scale];
    const Schord = sc.chord, Smel = sc.mel;

    // --- Key from the image's dominant hue ---
    const [ar, ag, ab] = avgColor(0, 0, w, h);
    const [wholeHue] = rgbToHsl(ar, ag, ab);
    const pitchClass = Math.round(wholeHue / 30) % 12;
    const keyRoot = 48 + pitchClass; // around C3

    // --- Tempo / bar grid ---
    const bpm = Math.round(66 + ((state.steps - 16) / (64 - 16)) * (126 - 66));
    const spb = 60 / bpm;                 // seconds per beat
    const beatsPerBar = 4;
    const barDur = spb * beatsPerBar;
    const bars = Math.max(3, Math.round(state.duration / barDur));
    const duration = +(bars * barDur).toFixed(3);

    const events = [];
    const push = (e) => events.push(e);
    const panAt = (t) => (t / duration) * 1.2 - 0.6;

    let prevMel = keyRoot + 12;

    for (let b = 0; b < bars; b++) {
      const t0 = b * barDur;
      const x0 = Math.floor((b / bars) * w);
      const x1 = Math.max(x0 + 1, Math.floor(((b + 1) / bars) * w));

      // Bar's overall color → chord
      const [rr, rg, rb] = avgColor(x0, 0, x1, h);
      const [rhue, rsat, rlight] = rgbToHsl(rr, rg, rb);
      let degree = Math.floor((rhue / 360) * 7) % 7;
      if (degree === 6) degree = 4;                 // sidestep the leading-tone dim chord
      const tri = buildTriad(Schord, degree);        // offsets from keyRoot
      const chordMidis = tri.map((o) => keyRoot + o);
      const rootOff = Schord[degree];

      // Chord tones spanning the melody register, for snapping
      const melChordPool = [];
      for (const m of chordMidis) { melChordPool.push(m + 12, m + 24); }

      // Orchestra assigns a different instrument per layer; otherwise one timbre.
      const instFor = (role) => state.instrument === "orchestra"
        ? ({ bass: "guitar", pad: "strings", mel: "flute", bell: "musicbox" }[role])
        : state.instrument;

      // --- BASS: root on beat 1, and beat 3 when the bar has energy ---
      const bassGain = 0.20 + rlight * 0.08;
      push({ t: t0, dur: barDur * 0.92, freq: mtof(keyRoot - 12 + rootOff),
             gain: bassGain, pan: 0, inst: instFor("bass"), role: "bass" });
      if (rlight > 0.35 || rsat > 0.4) {
        push({ t: t0 + 2 * spb, dur: barDur * 0.42, freq: mtof(keyRoot - 12 + rootOff),
               gain: bassGain * 0.85, pan: 0, inst: instFor("bass"), role: "bass" });
      }

      // --- CHORD: triad across the bar ---
      const padGain = 0.05 + rsat * 0.06;
      for (const m of chordMidis) {
        push({ t: t0, dur: barDur * 1.02, freq: mtof(m),
               gain: padGain, pan: 0, inst: instFor("pad"), role: "pad" });
      }

      // --- MELODY: eighth-note grid, driven by image salience ---
      const subdiv = 8;
      for (let s = 0; s < subdiv; s++) {
        const t = t0 + s * (barDur / subdiv);
        const sx0 = Math.floor(x0 + (s / subdiv) * (x1 - x0));
        const sx1 = Math.max(sx0 + 1, Math.floor(x0 + ((s + 1) / subdiv) * (x1 - x0)));
        const f = focalOfColumn(sx0, sx1);
        const strong = s % 2 === 0;

        // shadows rest; weak beats only fire on bright/vivid content
        if (f.light < 0.14) continue;
        if (!strong && (f.light < 0.42 || pseudo(b * 97 + s * 13) > f.light * 0.95)) continue;

        // pitch: hue → scale degree, top of frame → up an octave
        const mdeg = Math.min(Smel.length - 1, Math.floor((f.hue / 360) * Smel.length));
        let midi = keyRoot + 12 + Smel[mdeg] + (f.topness > 0.5 ? 12 : 0);
        if (strong) midi = nearest(midi, melChordPool); // consonant on strong beats
        // avoid big leaps for a singable line
        while (midi - prevMel > 12) midi -= 12;
        while (prevMel - midi > 12) midi += 12;
        prevMel = midi;

        const dur = (barDur / subdiv) * 1.55;
        const gain = (0.10 + 0.16 * f.light) * (0.5 + 0.5 * f.sat) * (strong ? 1 : 0.8);
        push({ t, dur, freq: mtof(midi), gain, pan: panAt(t), inst: instFor("mel"), role: "mel" });

        // --- sparkle on bright highlights ---
        if (f.maxLight > 0.82 && strong && pseudo(b * 31 + s * 7) < 0.5) {
          const top = nearest(midi + 12, melChordPool.map((m) => m + 12));
          push({ t: t + 0.01, dur: spb * 1.4, freq: mtof(top),
                 gain: 0.05 + f.maxLight * 0.05, pan: panAt(t) * 0.7, inst: instFor("bell"), role: "bell" });
        }
      }
    }

    return { events, duration };
  }

  /* ======================================================================
     Audio graph — shared between live playback (online) and WAV (offline).
     Instruments are built with FM / additive synthesis + ADSR + chorus/reverb.
     ==================================================================== */
  function makeImpulse(ctx, seconds = 2.6, decay = 3) {
    const rate = ctx.sampleRate;
    const len = rate * seconds;
    const buf = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  function renderGraph(ctx, events, useReverb) {
    // ---- master chain ----
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -12; limiter.knee.value = 24; limiter.ratio.value = 12;
    limiter.attack.value = 0.004; limiter.release.value = 0.25;
    const master = ctx.createGain(); master.gain.value = 0.9;

    const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 36;
    const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 11500;
    hp.connect(lp).connect(limiter).connect(master).connect(ctx.destination);

    const preMaster = hp;               // everything sums into here
    const dryBus = ctx.createGain(); dryBus.connect(preMaster);

    let revConv = null;
    if (useReverb) {
      revConv = ctx.createConvolver(); revConv.buffer = makeImpulse(ctx);
      const revReturn = ctx.createGain(); revReturn.gain.value = 0.9;
      revConv.connect(revReturn).connect(preMaster);
    }

    // ---- pad bus with chorus (width + lushness) ----
    const padBus = ctx.createGain();
    const chorusOut = ctx.createGain();
    { // chorus: dry + two modulated delay voices
      const dry = ctx.createGain(); dry.gain.value = 0.7;
      padBus.connect(dry).connect(chorusOut);
      for (const cfg of [{ t: 0.021, r: 0.13, d: 0.004 }, { t: 0.027, r: 0.19, d: 0.005 }]) {
        const dl = ctx.createDelay(); dl.delayTime.value = cfg.t;
        const lfo = ctx.createOscillator(); lfo.frequency.value = cfg.r;
        const lg = ctx.createGain(); lg.gain.value = cfg.d;
        lfo.connect(lg).connect(dl.delayTime);
        const wet = ctx.createGain(); wet.gain.value = 0.5;
        padBus.connect(dl).connect(wet).connect(chorusOut);
        lfo.start(0);
      }
    }
    chorusOut.connect(dryBus);
    if (revConv) { const s = ctx.createGain(); s.gain.value = 0.6; chorusOut.connect(s).connect(revConv); }

    // Reverb send per spatial role (the timbre itself is chosen by the user).
    const REV = { bass: 0.10, pad: 0.18, mel: 0.28, bell: 0.5 };

    function route(outNode, role) {
      if (role === "pad") { outNode.connect(padBus); return; } // chords → chorus + reverb
      outNode.connect(dryBus);
      if (revConv && REV[role] > 0) {
        const s = ctx.createGain(); s.gain.value = REV[role];
        outNode.connect(s).connect(revConv);
      }
    }

    // ---- shared buffers / physical models ----
    const noiseBuf = (() => {
      const n = Math.floor(ctx.sampleRate * 0.12);
      const b = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      return b;
    })();

    // Karplus–Strong plucked string: noise burst → tuned, low-pass-damped feedback loop.
    const ksBuffer = (freq, dur, decay, bright) => {
      const sr = ctx.sampleRate;
      const N = Math.max(2, Math.round(sr / freq));
      const total = Math.ceil(sr * dur);
      const buf = ctx.createBuffer(1, total, sr);
      const out = buf.getChannelData(0);
      const line = new Float32Array(N);
      let prev = 0;                          // one-pole LP to shape the pick brightness
      const a = bright;                       // 0..1, higher = brighter excitation
      for (let i = 0; i < N; i++) {
        const white = Math.random() * 2 - 1;
        prev = a * white + (1 - a) * prev;
        line[i] = prev;
      }
      let idx = 0;
      for (let i = 0; i < total; i++) {
        const cur = line[idx];
        const nxt = line[(idx + 1) % N];
        out[i] = cur;
        line[idx] = (cur + nxt) * 0.5 * decay; // averaging = string damping
        idx = (idx + 1) % N;
      }
      return buf;
    };

    // ---- amp envelopes ----
    const envPerc = (amp, t0, end, e, atk, decLvl, decT, rel) => {
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.linearRampToValueAtTime(e.gain, t0 + atk);
      const dt = t0 + Math.min(decT, Math.max(0.03, e.dur * 0.6));
      amp.gain.exponentialRampToValueAtTime(Math.max(0.0002, e.gain * decLvl), dt);
      amp.gain.exponentialRampToValueAtTime(0.0001, end + rel);
    };
    const envSustain = (amp, t0, end, e, atk, rel) => {
      amp.gain.setValueAtTime(0.0001, t0);
      amp.gain.linearRampToValueAtTime(e.gain, t0 + Math.min(atk, e.dur * 0.5));
      amp.gain.setValueAtTime(e.gain, Math.max(t0 + atk, end - 0.05));
      amp.gain.exponentialRampToValueAtTime(0.0001, end + rel);
    };

    for (const e of events) {
      const t0 = e.t, end = t0 + e.dur;
      const amp = ctx.createGain();
      const pan = ctx.createStereoPanner ? ctx.createStereoPanner() : null;
      if (pan) pan.pan.value = e.pan || 0;
      const outNode = pan ? (amp.connect(pan), pan) : amp;

      // ---- reusable oscillator builders (closing over this note's timing) ----
      const fmInto = (dest, freq, ratio, idxStart, idxEnd, idxDec, waveC) => {
        const c = ctx.createOscillator(); c.type = waveC || "sine"; c.frequency.value = freq;
        const m = ctx.createOscillator(); m.type = "sine"; m.frequency.value = freq * ratio;
        const mg = ctx.createGain();
        mg.gain.setValueAtTime(freq * idxStart, t0);
        mg.gain.exponentialRampToValueAtTime(Math.max(1, freq * idxEnd), t0 + idxDec);
        m.connect(mg).connect(c.frequency);
        c.connect(dest);
        c.start(t0); m.start(t0); c.stop(end + 1); m.stop(end + 1);
      };
      const additive = (dest, freq, partials, stretch) => {
        const flt = ctx.createBiquadFilter(); flt.type = "lowpass";
        flt.frequency.value = Math.min(11000, freq * 8 + 1800); flt.Q.value = 0.3;
        for (const [r, a] of partials) {
          const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = freq * r;
          if (r > 1 && stretch) o.detune.value = (r - 1) * stretch; // gentle inharmonicity
          const g = ctx.createGain(); g.gain.value = a;
          o.connect(g).connect(flt); o.start(t0); o.stop(end + 0.8);
        }
        flt.connect(dest);
      };
      const vibrato = (oscs, rate, cents) => {
        const lfo = ctx.createOscillator(); lfo.frequency.value = rate;
        const lg = ctx.createGain(); lg.gain.value = cents;
        lfo.connect(lg); oscs.forEach((o) => lg.connect(o.detune));
        lfo.start(t0); lfo.stop(end + 0.3);
      };

      // ---- one voice per user-selected instrument ----
      switch (e.inst) {
        case "epiano":
          fmInto(amp, e.freq, 1.0, 0.9, 0.05, e.dur * 0.5);
          envPerc(amp, t0, end, e, 0.006, 0.35, 0.4, 0.3);
          break;
        case "musicbox":
          fmInto(amp, e.freq, 3.5, 1.6, 0.02, e.dur * 0.5);
          envPerc(amp, t0, end, e, 0.002, 0.25, 0.25, 0.7);
          break;
        case "marimba":
          additive(amp, e.freq, [[1, 1], [3.9, 0.55], [10, 0.12]], 3);
          envPerc(amp, t0, end, e, 0.002, 0.12, 0.14, 0.2);
          break;
        case "guitar": {
          // Karplus–Strong: naturally plucked, string-like decay.
          const ringDecay = e.freq < 160 ? 0.992 : 0.996;   // pizz-ish low, singing high
          const buf = ksBuffer(e.freq, e.dur + 0.4, ringDecay, 0.55);
          const src = ctx.createBufferSource(); src.buffer = buf;
          const body = ctx.createBiquadFilter(); body.type = "lowpass";
          body.frequency.value = 3800; body.Q.value = 0.5;    // guitar "body" tone
          src.connect(body).connect(amp);
          src.start(t0); src.stop(t0 + buf.duration + 0.05);
          const rel = Math.max(t0 + 0.01, end - 0.02);
          amp.gain.setValueAtTime(0.0001, t0);
          amp.gain.linearRampToValueAtTime(e.gain, t0 + 0.002);
          amp.gain.setValueAtTime(e.gain, rel);
          amp.gain.exponentialRampToValueAtTime(0.0001, end + 0.25);
          break;
        }
        case "strings": {
          const flt = ctx.createBiquadFilter(); flt.type = "lowpass"; flt.frequency.value = 2800; flt.Q.value = 0.4;
          const oscs = [];
          for (const det of [-8, 0, 7]) {
            const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = e.freq; o.detune.value = det;
            o.connect(flt); o.start(t0); o.stop(end + 0.7); oscs.push(o);
          }
          vibrato(oscs, 5.2, 5);
          flt.connect(amp);
          envSustain(amp, t0, end, e, 0.28, 0.5);
          break;
        }
        case "flute": {
          const flt = ctx.createBiquadFilter(); flt.type = "lowpass"; flt.frequency.value = 3600;
          const o1 = ctx.createOscillator(); o1.type = "triangle"; o1.frequency.value = e.freq;
          const o2 = ctx.createOscillator(); o2.type = "sine"; o2.frequency.value = e.freq;
          const g2 = ctx.createGain(); g2.gain.value = 0.5;
          o1.connect(flt); o2.connect(g2).connect(flt); flt.connect(amp);
          o1.start(t0); o2.start(t0); o1.stop(end + 0.4); o2.stop(end + 0.4);
          vibrato([o1, o2], 5.5, 7);
          envSustain(amp, t0, end, e, 0.09, 0.22);
          break;
        }
        case "synth": {
          const flt = ctx.createBiquadFilter(); flt.type = "lowpass"; flt.Q.value = 0.6;
          flt.frequency.setValueAtTime(500, t0);
          flt.frequency.linearRampToValueAtTime(3200, t0 + Math.min(0.4, e.dur * 0.5));
          for (const det of [-6, 6]) {
            const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = e.freq; o.detune.value = det;
            o.connect(flt); o.start(t0); o.stop(end + 0.5);
          }
          flt.connect(amp);
          envSustain(amp, t0, end, e, 0.06, 0.4);
          break;
        }
        default: { // piano — struck string: hammer transient + per-harmonic decay
          amp.gain.value = 1; // partials carry their own envelopes
          // hammer-noise transient (the percussive "knock" at onset)
          const nz = ctx.createBufferSource(); nz.buffer = noiseBuf;
          const nf = ctx.createBiquadFilter(); nf.type = "bandpass";
          nf.frequency.value = Math.min(5000, e.freq * 3 + 700); nf.Q.value = 0.8;
          const ng = ctx.createGain();
          ng.gain.setValueAtTime(e.gain * 0.35, t0);
          ng.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.05);
          nz.connect(nf).connect(ng).connect(amp);
          nz.start(t0); nz.stop(t0 + 0.09);
          // partials: higher harmonics quieter AND shorter — plus inharmonic stretch
          const B = 0.0005;
          for (let n = 1; n <= 9; n++) {
            const f = e.freq * n * Math.sqrt(1 + B * n * n);
            if (f > 15000) break;
            const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f;
            const g = ctx.createGain();
            const a0 = e.gain * 0.6 * Math.pow(0.55, n - 1);
            const decEnd = t0 + Math.min(e.dur * (2.4 / n) + 0.12, e.dur + 0.9);
            g.gain.setValueAtTime(0.0001, t0);
            g.gain.linearRampToValueAtTime(a0, t0 + 0.004);
            g.gain.exponentialRampToValueAtTime(0.0001, decEnd);
            o.connect(g).connect(amp);
            o.start(t0); o.stop(decEnd + 0.05);
          }
        }
      }

      route(outNode, e.role);
    }
  }

  /* ======================================================================
     Generate → render offline into a buffer + WAV blob
     ==================================================================== */
  async function generate() {
    generateBtn.disabled = true;
    player.classList.add("hidden");
    progressWrap.classList.remove("hidden");
    stopPlayback();

    const msgs = ["Choosing a key from your colors…", "Writing the chord progression…",
                  "Playing the instruments…", "Adding space & shimmer…"];
    let p = 0;
    setProgress(4, msgs[0]);
    await frame();

    const comp = buildComposition();
    state.events = comp.events;
    state.playDuration = comp.duration;
    setProgress(30, msgs[1]);
    await frame();

    const T = comp.duration + 2.5; // tail for release/reverb
    const rate = 44100;
    const offline = new OfflineAudioContext(2, Math.ceil(rate * T), rate);
    renderGraph(offline, state.events, state.reverb);

    setProgress(55, msgs[2]);
    const ticker = setInterval(() => {
      p = Math.min(92, p + 6);
      setProgress(Math.max(55, p), msgs[Math.floor(p / 25) % msgs.length]);
    }, 120);

    let buffer;
    try {
      buffer = await offline.startRendering();
    } catch (err) {
      clearInterval(ticker);
      toast("Rendering failed: " + err.message);
      generateBtn.disabled = false; progressWrap.classList.add("hidden");
      return;
    }
    clearInterval(ticker);

    state.renderedBuffer = buffer;
    setProgress(97, "Encoding audio…");
    await frame();
    state.wavBlob = new Blob([encodeWav(buffer)], { type: "audio/wav" });

    setProgress(100, "Ready to play ✦");
    await wait(350);
    progressWrap.classList.add("hidden");
    generateBtn.disabled = false;

    player.classList.remove("hidden");
    totTime.textContent = fmt(state.playDuration);
    curTime.textContent = "0:00";
    seekFill.style.width = "0%";
    resetPlayer();
    burst();
    autoPlay();
  }

  function setProgress(pct, label) {
    progressBar.style.width = pct + "%";
    if (label) progressLabel.textContent = label;
  }

  /* ======================================================================
     Playback (from rendered buffer → matches the download exactly)
     ==================================================================== */
  function ensureCtx() {
    if (!state.ctx || state.ctx.state === "closed") {
      state.ctx = new (window.AudioContext || window.webkitAudioContext)();
      state.analyser = state.ctx.createAnalyser();
      state.analyser.fftSize = 256;
      state.analyser.connect(state.ctx.destination);
    }
    return state.ctx;
  }

  function startSource(offset) {
    const ctx = ensureCtx();
    const src = ctx.createBufferSource();
    src.buffer = state.renderedBuffer;
    src.connect(state.analyser);
    src.onended = () => {
      if (state.playing && ctx.currentTime - state.startedAt + state.offset >= state.playDuration - 0.05) {
        stopPlayback();
        state.offset = 0;
        seekFill.style.width = "0%";
        curTime.textContent = "0:00";
        drawOverlayGrid(-1);
        scanline.classList.add("hidden");
      }
    };
    src.start(0, offset);
    state.source = src;
    state.startedAt = ctx.currentTime;
    state.offset = offset;
    state.playing = true;
    setPlayIcon(true);
    scanline.classList.remove("hidden");
    loopViz();
  }

  function togglePlay() {
    if (!state.renderedBuffer) return;
    if (state.playing) {
      const ctx = state.ctx;
      const elapsed = ctx.currentTime - state.startedAt + state.offset;
      state.offset = Math.min(elapsed, state.playDuration);
      stopPlayback();
    } else {
      const off = state.offset >= state.playDuration ? 0 : state.offset;
      startSource(off);
    }
  }

  function autoPlay() { state.offset = 0; startSource(0); }

  function stopPlayback() {
    if (state.source) {
      try { state.source.onended = null; state.source.stop(); } catch (e) {}
      state.source.disconnect();
      state.source = null;
    }
    state.playing = false;
    setPlayIcon(false);
    cancelAnimationFrame(state.raf);
  }

  function setPlayIcon(playing) {
    playBtn.querySelector(".ic-play").classList.toggle("hidden", playing);
    playBtn.querySelector(".ic-pause").classList.toggle("hidden", !playing);
  }

  function currentElapsed() {
    if (!state.ctx) return state.offset;
    return state.playing
      ? Math.min(state.playDuration, state.ctx.currentTime - state.startedAt + state.offset)
      : state.offset;
  }

  /* ======================================================================
     Visualizer + playhead
     ==================================================================== */
  function loopViz() {
    const g = vizCanvas.getContext("2d");
    const dpr = Math.min(devicePixelRatio || 1, 2);
    if (vizCanvas.width !== vizCanvas.clientWidth * dpr) {
      vizCanvas.width = vizCanvas.clientWidth * dpr;
      vizCanvas.height = vizCanvas.clientHeight * dpr;
    }
    const W = vizCanvas.width, H = vizCanvas.height;
    const data = new Uint8Array(state.analyser.frequencyBinCount);

    const draw = () => {
      state.analyser.getByteFrequencyData(data);
      g.clearRect(0, 0, W, H);
      const bars = 48, bw = W / bars;
      for (let i = 0; i < bars; i++) {
        const v = data[Math.floor((i / bars) * data.length)] / 255;
        const bh = Math.max(2, v * H * 0.92);
        const hue = 200 + (i / bars) * 140;
        const grd = g.createLinearGradient(0, H, 0, H - bh);
        grd.addColorStop(0, `hsla(${hue},90%,60%,0.95)`);
        grd.addColorStop(1, `hsla(${hue + 40},95%,72%,0.95)`);
        g.fillStyle = grd;
        roundRect(g, i * bw + 1, H - bh, bw - 2, bh, Math.min(4 * dpr, bw / 2));
        g.fill();
      }
      const el = currentElapsed();
      const prog = el / state.playDuration;
      seekFill.style.width = (prog * 100).toFixed(2) + "%";
      curTime.textContent = fmt(el);
      const wrap = imageCanvas.parentElement.getBoundingClientRect();
      scanline.style.left = (prog * wrap.width) + "px";
      drawOverlayGrid(Math.min(state.steps - 1, Math.floor(prog * state.steps)));
      if (state.playing) state.raf = requestAnimationFrame(draw);
    };
    draw();
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function resetPlayer() {
    stopPlayback();
    state.offset = 0;
    scanline.classList.add("hidden");
    drawOverlayGrid(-1);
  }

  /* ======================================================================
     WAV encoder (16-bit PCM, interleaved stereo)
     ==================================================================== */
  function encodeWav(buffer) {
    const numCh = buffer.numberOfChannels, len = buffer.length, rate = buffer.sampleRate;
    const blockAlign = numCh * 2, dataSize = len * blockAlign;
    const out = new ArrayBuffer(44 + dataSize);
    const view = new DataView(out);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, "RIFF"); view.setUint32(4, 36 + dataSize, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true);
    view.setUint16(22, numCh, true); view.setUint32(24, rate, true);
    view.setUint32(28, rate * blockAlign, true); view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, dataSize, true);
    const chans = [];
    for (let ch = 0; ch < numCh; ch++) chans.push(buffer.getChannelData(ch));
    let off = 44;
    for (let i = 0; i < len; i++) {
      for (let ch = 0; ch < numCh; ch++) {
        let s = Math.max(-1, Math.min(1, chans[ch][i]));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      }
    }
    return view;
  }

  function download() {
    if (!state.wavBlob) return;
    const url = URL.createObjectURL(state.wavBlob);
    const a = document.createElement("a");
    a.href = url; a.download = `visiosonic-${state.scale}-${Date.now()}.wav`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast("Saved your composition ✦");
  }

  /* ======================================================================
     Sample texture generator ("no photo?" swatches)
     ==================================================================== */
  function generateSample(kind) {
    const cv = document.createElement("canvas");
    cv.width = 800; cv.height = 600;
    const g = cv.getContext("2d");
    const palettes = {
      sunset: ["#2c0703", "#ff6b6b", "#feca57", "#ff9ff3", "#48466d"],
      ocean:  ["#012a4a", "#0abde3", "#48dbfb", "#1dd1a1", "#c7ecee"],
      forest: ["#0b3d2e", "#10ac84", "#1dd1a1", "#feca57", "#4a3f35"],
      nebula: ["#0b0620", "#5f27cd", "#ee5253", "#48dbfb", "#f472b6"],
    };
    const cols = palettes[kind] || palettes.nebula;
    g.fillStyle = cols[0]; g.fillRect(0, 0, cv.width, cv.height);
    for (let i = 0; i < 26; i++) {
      const x = pseudo(i * 3 + 1) * cv.width, y = pseudo(i * 5 + 2) * cv.height;
      const r = 80 + pseudo(i * 7 + 3) * 260;
      const c = cols[1 + (i % (cols.length - 1))];
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      grd.addColorStop(0, c); grd.addColorStop(1, "transparent");
      g.globalAlpha = 0.55; g.fillStyle = grd;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.globalAlpha = 1;
    loadImageFromSrc(cv.toDataURL());
  }

  /* ======================================================================
     Small utilities
     ==================================================================== */
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  function fmt(sec) { sec = Math.max(0, Math.floor(sec)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`; }
  let toastTimer;
  function toast(msg) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; document.body.appendChild(el); }
    el.textContent = msg;
    requestAnimationFrame(() => el.classList.add("show"));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 2600);
  }
  function burst() {
    const rect = generateBtn.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    for (let i = 0; i < 26; i++) {
      const s = document.createElement("span");
      s.style.cssText = `position:fixed;left:${cx}px;top:${cy}px;width:8px;height:8px;border-radius:50%;pointer-events:none;z-index:60;`;
      s.style.background = `hsl(${200 + Math.random() * 160},90%,65%)`;
      document.body.appendChild(s);
      const ang = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 120;
      s.animate(
        [{ transform: "translate(0,0) scale(1)", opacity: 1 },
         { transform: `translate(${Math.cos(ang) * dist}px,${Math.sin(ang) * dist}px) scale(0)`, opacity: 0 }],
        { duration: 700 + Math.random() * 400, easing: "cubic-bezier(.2,.8,.2,1)" }
      ).onfinish = () => s.remove();
    }
  }

  /* ======================================================================
     Event wiring
     ==================================================================== */
  dropzone.addEventListener("click", () => fileInput.click());
  dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  fileInput.addEventListener("change", (e) => handleFile(e.target.files[0]));

  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
  ["dragleave", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => { e.preventDefault(); if (ev === "dragleave" && dropzone.contains(e.relatedTarget)) return; dropzone.classList.remove("dragover"); }));
  dropzone.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) handleFile(f); });
  dropzone.addEventListener("mousemove", (e) => {
    const r = dropzone.getBoundingClientRect();
    dropzone.style.setProperty("--mx", (e.clientX - r.left) + "px");
    dropzone.style.setProperty("--my", (e.clientY - r.top) + "px");
  });

  addEventListener("paste", (e) => {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) handleFile(item.getAsFile());
  });

  $("sampleSwatches").addEventListener("click", (e) => {
    const btn = e.target.closest(".swatch");
    if (btn) generateSample(btn.dataset.gen);
  });

  backBtn.addEventListener("click", () => {
    stopPlayback();
    studio.classList.add("hidden");
    dropStage.classList.remove("hidden");
    dropStage.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  $("duration").addEventListener("input", (e) => {
    state.duration = +e.target.value; $("durVal").textContent = state.duration + "s"; rangeFill(e.target);
  });
  $("steps").addEventListener("input", (e) => {
    state.steps = +e.target.value; const v = state.steps;
    $("stepsVal").textContent = v < 28 ? "slow" : v < 44 ? "medium" : v < 56 ? "lively" : "frantic";
    rangeFill(e.target);
  });
  $("scaleSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button"); if (!b) return;
    [...e.currentTarget.children].forEach((c) => c.classList.remove("active"));
    b.classList.add("active"); state.scale = b.dataset.scale;
  });
  $("instrument").addEventListener("change", (e) => { state.instrument = e.target.value; });
  $("reverbToggle").addEventListener("change", (e) => { state.reverb = e.target.checked; });

  generateBtn.addEventListener("click", generate);
  playBtn.addEventListener("click", () => { ensureCtx().resume(); togglePlay(); });
  downloadBtn.addEventListener("click", download);

  seek.addEventListener("click", (e) => {
    if (!state.renderedBuffer) return;
    const r = seek.getBoundingClientRect();
    const prog = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    const wasPlaying = state.playing;
    stopPlayback();
    state.offset = prog * state.playDuration;
    seekFill.style.width = (prog * 100) + "%";
    curTime.textContent = fmt(state.offset);
    if (wasPlaying) startSource(state.offset);
  });

  function rangeFill(el) {
    const pct = ((el.value - el.min) / (el.max - el.min)) * 100;
    el.style.backgroundSize = pct + "% 100%";
  }
  document.querySelectorAll('input[type="range"]').forEach(rangeFill);

  addEventListener("keydown", (e) => {
    if (e.code === "Space" && !studio.classList.contains("hidden") && state.renderedBuffer && e.target.tagName !== "INPUT") {
      e.preventDefault(); ensureCtx().resume(); togglePlay();
    }
  });
})();
