import { useState, useEffect, useRef, useCallback } from "react";

// ─── MS-20 Sallen-Key filter with tanh feedback ───────────────────────────────
class MS20Filter {
  constructor(sr) { this.sr = sr; this.s1 = 0; this.s2 = 0; }
  tanh(x) {
    if (x > 3) return 1; if (x < -3) return -1;
    const x2 = x * x; return x * (27 + x2) / (27 + 9 * x2);
  }
  process(input, cutoff, res) {
    const f = Math.min(cutoff / (this.sr * 0.5), 0.99);
    const g = Math.tan(Math.PI * f), k = res * 4;
    const fb = this.tanh(this.s2 * k), u = this.tanh(input - fb);
    const v1 = (u - this.s1) * g, lp1 = v1 + this.s1; this.s1 = lp1 + v1;
    const v2 = (lp1 - this.s2) * g, lp2 = v2 + this.s2; this.s2 = lp2 + v2;
    return this.tanh(lp2 * 0.7);
  }
}

// ─── Scales & roots ───────────────────────────────────────────────────────────
const SCALES = {
  "Pent Min":   [0,3,5,7,10],
  "Pent Maj":   [0,2,4,7,9],
  "Dorian":     [0,2,3,5,7,9,10],
  "Phrygian":   [0,1,3,5,7,8,10],
  "Lydian":     [0,2,4,6,7,9,11],
  "Mixolydian": [0,2,4,5,7,9,10],
  "Aeolian":    [0,2,3,5,7,8,10],
  "Chromatic":  [0,1,2,3,4,5,6,7,8,9,10,11],
};
const ROOTS = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const ROOT_MIDI = {C:36,"C#":37,D:38,"D#":39,E:40,F:41,"F#":42,G:43,"G#":44,A:45,"A#":46,B:47};
const ARP_PATTERNS = ["Up","Down","Up/Down","Random"];

function buildScale(rootMidi, intervals, octaves = 3) {
  const notes = [];
  for (let o = 0; o < octaves; o++)
    for (const iv of intervals)
      notes.push(440 * Math.pow(2, (rootMidi + o * 12 + iv - 69) / 12));
  return notes;
}

// Pitch range for pad X axis (non-arp): A2–A5
const PITCH_MIN = 110, PITCH_MAX = 880;
// LFO rate range for pad Y axis
const LFO_MIN = 0.1, LFO_MAX = 30;

// ─── Audio engine ─────────────────────────────────────────────────────────────
class MonotronEngine {
  constructor() {
    this.ctx = null; this.scriptNode = null; this.masterGain = null;
    this.filter = null; this.phase = 0; this.lfoPhase = 0;
    this.env = 0; this.gateOpen = false;
    this.params = {
      pitch: 220, cutoff: 900, resonance: 0.25,
      lfoRate: 2, lfoDepth: 0, lfoTarget: "pitch",
      playing: false,
      arpOn: false, arpRate: 8, arpGate: 0.6, arpPattern: "Random",
    };
    this.arpFreqs = buildScale(ROOT_MIDI["D"], SCALES["Dorian"], 3);
    this.arpSeq = []; this.arpSeqPos = 0;
    this.arpIdx = 0; this.arpPhase = 0;
    this.arpCurrentFreq = this.arpFreqs[0];
    this._rebuildSeq();
  }

  _rebuildSeq() {
    const f = this.arpFreqs, p = this.params.arpPattern;
    if (p === "Up")        this.arpSeq = [...f];
    else if (p === "Down") this.arpSeq = [...f].reverse();
    else if (p === "Up/Down") this.arpSeq = [...f, ...[...f].reverse().slice(1,-1)];
    else                   this.arpSeq = [...f];
    this.arpSeqPos = 0;
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    this.filter = new MS20Filter(this.ctx.sampleRate);
    this.scriptNode = this.ctx.createScriptProcessor(512, 0, 1);
    this.scriptNode.onaudioprocess = e => this._process(e);
    this.masterGain = this.ctx.createGain();
    this.masterGain.gain.value = 0.72;
    this.scriptNode.connect(this.masterGain);
    this.masterGain.connect(this.ctx.destination);
  }

  _process(e) {
    const out = e.outputBuffer.getChannelData(0);
    const sr = this.ctx.sampleRate;
    const { cutoff, resonance, lfoRate, lfoDepth, lfoTarget,
            playing, arpOn, arpRate, arpGate, arpPattern } = this.params;
    const baseFreq = this.params.pitch;
    const atk = sr * 0.008, rel = sr * 0.04;

    for (let i = 0; i < out.length; i++) {
      let freq = baseFreq;

      if (arpOn && playing) {
        this.arpPhase += arpRate / sr;
        if (this.arpPhase >= 1) {
          this.arpPhase -= 1;
          if (arpPattern === "Random") {
            let nx;
            do { nx = Math.floor(Math.random() * this.arpFreqs.length); }
            while (nx === this.arpIdx && this.arpFreqs.length > 1);
            this.arpIdx = nx;
            this.arpCurrentFreq = this.arpFreqs[this.arpIdx];
          } else {
            this.arpSeqPos = (this.arpSeqPos + 1) % this.arpSeq.length;
            this.arpCurrentFreq = this.arpSeq[this.arpSeqPos];
            this.arpIdx = this.arpFreqs.indexOf(this.arpCurrentFreq);
            if (this.arpIdx < 0) this.arpIdx = 0;
          }
        }
        this.gateOpen = this.arpPhase < arpGate;
        freq = this.arpCurrentFreq;
      } else {
        this.gateOpen = playing;
        freq = baseFreq;
      }

      this.env = this.gateOpen
        ? Math.min(1, this.env + 1 / atk)
        : Math.max(0, this.env - 1 / rel);

      if (this.env < 0.0001) {
        out[i] = 0; this.filter.s1 *= 0.999; this.filter.s2 *= 0.999; continue;
      }

      const lfoVal = Math.sin(2 * Math.PI * this.lfoPhase);
      this.lfoPhase += lfoRate / sr;
      if (this.lfoPhase > 1) this.lfoPhase -= 1;

      let effPitch = freq, effCutoff = cutoff;
      if (lfoTarget === "pitch") effPitch = freq * Math.pow(2, lfoVal * lfoDepth * 2);
      else effCutoff = Math.max(40, cutoff + lfoVal * lfoDepth * cutoff * 3);

      this.phase += effPitch / sr;
      if (this.phase > 1) this.phase -= 1;
      out[i] = this.filter.process((this.phase * 2 - 1) * this.env * 0.8, effCutoff, resonance);
    }
  }

  set(k, v) { this.params[k] = v; }
  setScale(freqs) { this.arpFreqs = freqs; this._rebuildSeq(); }
  setPattern(p) { this.params.arpPattern = p; this._rebuildSeq(); }
  noteOn(pitch) { this.params.pitch = pitch; this.params.playing = true; }
  noteOff() { this.params.playing = false; }
  resume() { if (this.ctx?.state === "suspended") this.ctx.resume(); }
}

const engine = new MonotronEngine();

// ─── Helpers ──────────────────────────────────────────────────────────────────
const NOTE_NAMES = ["C","C#","D","D#","E","F","F#","G","G#","A","A#","B"];
const freqToNote = f => {
  if (!f) return "";
  const m = Math.round(12 * Math.log2(f / 440) + 69);
  return NOTE_NAMES[((m % 12) + 12) % 12] + Math.floor(m / 12 - 1);
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;

// Map normalised [0,1] → pitch (log) or lfoRate (log)
const normToPitch = n => PITCH_MIN * Math.pow(PITCH_MAX / PITCH_MIN, n);
const normToLfo   = n => LFO_MIN  * Math.pow(LFO_MAX  / LFO_MIN,  n);
// Map normalised [0,1] → root index (12 roots)
const normToRootIdx = n => Math.min(11, Math.floor(n * 12));

// ─── Sub-components ───────────────────────────────────────────────────────────
function Knob({ label, value, min, max, onChange, unit="", log=false, size=48 }) {
  const drag = useRef(false), startY = useRef(0), startV = useRef(0);
  const norm = log
    ? Math.log(value/min)/Math.log(max/min)
    : (value-min)/(max-min);
  const angle = -145 + norm * 290;
  const onDown = e => { drag.current=true; startY.current=e.clientY; startV.current=value; e.preventDefault(); };
  useEffect(() => {
    const mv = e => {
      if (!drag.current) return;
      const dy = startY.current - e.clientY;
      if (log) {
        const lMin=Math.log(min),lMax=Math.log(max);
        onChange(Math.exp(clamp(Math.log(startV.current)+(dy/150)*(lMax-lMin),lMin,lMax)));
      } else onChange(clamp(startV.current+(dy/150)*(max-min),min,max));
    };
    const up = () => { drag.current=false; };
    window.addEventListener("mousemove",mv); window.addEventListener("mouseup",up);
    return () => { window.removeEventListener("mousemove",mv); window.removeEventListener("mouseup",up); };
  },[min,max,log,onChange]);

  return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4,userSelect:"none"}}>
      <div onMouseDown={onDown} style={{
        width:size,height:size,borderRadius:"50%",cursor:"ns-resize",position:"relative",
        background:"radial-gradient(circle at 35% 30%,#555,#1a1a1a)",
        boxShadow:"0 2px 8px rgba(0,0,0,.8),inset 0 1px 0 rgba(255,255,255,.08)",
        border:"1px solid #333",
      }}>
        {[-145,-100,-50,0,50,100,145].map(a=>(
          <div key={a} style={{
            position:"absolute",width:2,height:4,background:Math.abs(a)<5?"#ff6a00":"#3a3a3a",
            left:"50%",top:-7,transformOrigin:`50% ${size/2+7}px`,
            transform:`translateX(-50%) rotate(${a}deg)`,
          }}/>
        ))}
        <div style={{
          position:"absolute",width:2,height:size*.33,background:"#ff6a00",
          left:"50%",top:size*.1,transformOrigin:`50% ${size*.4}px`,
          transform:`translateX(-50%) rotate(${angle}deg)`,
          borderRadius:1,boxShadow:"0 0 4px #ff6a00",
        }}/>
        <div style={{
          position:"absolute",width:6,height:6,borderRadius:"50%",
          background:"#222",border:"1px solid #555",
          left:"50%",top:"50%",transform:"translate(-50%,-50%)",
        }}/>
      </div>
      <div style={{color:"#555",fontSize:8,letterSpacing:".08em",textTransform:"uppercase",fontFamily:"monospace"}}>{label}</div>
      <div style={{color:"#ff6a00",fontSize:8,fontFamily:"monospace"}}>
        {log ? Math.round(value) : value.toFixed(2)}{unit}
      </div>
    </div>
  );
}

function Pill({ label, active, onClick }) {
  return (
    <button onClick={onClick} style={{
      background: active ? "#ff6a00" : "rgba(0,0,0,.4)",
      color: active ? "#000" : "#555",
      border: `1px solid ${active ? "#ff6a00" : "#282828"}`,
      borderRadius: 3, padding: "3px 7px",
      fontSize: 8, letterSpacing: ".06em", cursor: "pointer",
      fontFamily: "monospace", textTransform: "uppercase",
      transition: "all .1s",
      boxShadow: active ? "0 0 6px rgba(255,106,0,.3)" : "none",
    }}>{label}</button>
  );
}

function SelectorStrip({ label, options, value, onChange }) {
  return (
    <div style={{display:"flex",flexDirection:"column",gap:4}}>
      <div style={{color:"#444",fontSize:7.5,letterSpacing:".2em",textTransform:"uppercase"}}>{label}</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
        {options.map(o => <Pill key={o} label={o} active={o===value} onClick={()=>onChange(o)}/>)}
      </div>
    </div>
  );
}

function LED({ active }) {
  return (
    <div style={{
      width:8,height:8,borderRadius:"50%",
      background: active ? "#ff6a00" : "#2a1400",
      boxShadow: active ? "0 0 8px #ff4400,0 0 16px #ff4400" : "none",
      transition:"all .05s",border:"1px solid #1a1a1a",
    }}/>
  );
}

function ArpGrid({ freqs, activeIdx, arpOn }) {
  return (
    <div style={{display:"flex",gap:2,alignItems:"flex-end"}}>
      {freqs.map((f,i) => {
        const active = arpOn && i===activeIdx;
        const h = 5 + (i % Math.min(freqs.length,12)) * 2;
        return <div key={i} style={{
          width: freqs.length > 20 ? 3 : 4,
          height: Math.max(5,h),
          background: active ? "#ff6a00" : "#232323",
          borderRadius:1,
          boxShadow: active ? "0 0 5px #ff6a00" : "none",
          transition:"background .04s",
        }}/>;
      })}
    </div>
  );
}

// ─── XY Pad ───────────────────────────────────────────────────────────────────
// normX, normY: current values [0,1] — driven by gyro or touch
// gyroActive: whether gyro is live
// arpOn: switches X axis label
function XYPad({ normX, normY, playing, arpOn, arpRoot, onTouch, onRelease, onMove, gyroActive, ready }) {
  const ref = useRef(null);

  const getPos = useCallback((e) => {
    const r = ref.current.getBoundingClientRect();
    const src = e.touches ? e.touches[0] : e;
    return {
      x: clamp((src.clientX - r.left) / r.width, 0, 1),
      y: clamp((src.clientY - r.top)  / r.height, 0, 1),
    };
  }, []);

  const handleDown = useCallback(e => { onTouch(getPos(e)); e.preventDefault(); }, [onTouch, getPos]);
  const handleMove = useCallback(e => { onMove(getPos(e)); e.preventDefault(); }, [onMove, getPos]);
  const handleUp   = useCallback(() => onRelease(), [onRelease]);

  useEffect(() => {
    window.addEventListener("mouseup", handleUp);
    window.addEventListener("touchend", handleUp);
    return () => { window.removeEventListener("mouseup", handleUp); window.removeEventListener("touchend", handleUp); };
  }, [handleUp]);

  // Axis labels
  const xLabel = arpOn ? `X · ROOT  [${arpRoot}]` : "X · PITCH";
  const yLabel = "Y · LFO RATE";

  return (
    <div style={{position:"relative",userSelect:"none"}}>
      {/* axis labels */}
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:5}}>
        <div style={{color:"#333",fontSize:7.5,letterSpacing:".2em"}}>{xLabel}</div>
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          {gyroActive && (
            <div style={{
              fontSize:7,letterSpacing:".15em",color:"#ff6a00",
              padding:"1px 5px",border:"1px solid #2a1800",borderRadius:2,
            }}>GYRO</div>
          )}
          <div style={{color:"#333",fontSize:7.5,letterSpacing:".2em"}}>{yLabel}</div>
        </div>
      </div>

      <div
        ref={ref}
        onMouseDown={handleDown}
        onMouseMove={e => { if (e.buttons) handleMove(e); }}
        onTouchStart={handleDown}
        onTouchMove={handleMove}
        style={{
          width:"100%", height:180, borderRadius:8,
          position:"relative", overflow:"hidden", touchAction:"none",
          cursor:"crosshair",
          background:"linear-gradient(135deg,#130800 0%,#1a0d00 40%,#0e0800 100%)",
          border:`1px solid ${playing ? "#ff6a00" : "#222"}`,
          boxShadow: playing ? "0 0 20px rgba(255,106,0,.2)" : "inset 0 2px 12px rgba(0,0,0,.8)",
          transition:"border-color .05s, box-shadow .05s",
        }}
      >
        {/* grid lines */}
        {[.25,.5,.75].map(t => (
          <div key={`v${t}`} style={{
            position:"absolute",left:`${t*100}%`,top:0,bottom:0,
            width:1,background:"rgba(255,106,0,.04)",
          }}/>
        ))}
        {[.25,.5,.75].map(t => (
          <div key={`h${t}`} style={{
            position:"absolute",top:`${t*100}%`,left:0,right:0,
            height:1,background:"rgba(255,106,0,.04)",
          }}/>
        ))}

        {/* centre crosshair */}
        <div style={{position:"absolute",left:"50%",top:0,bottom:0,width:1,background:"rgba(255,106,0,.08)"}}/>
        <div style={{position:"absolute",top:"50%",left:0,right:0,height:1,background:"rgba(255,106,0,.08)"}}/>

        {/* cursor */}
        {(playing || gyroActive) && (
          <>
            {/* vertical trace */}
            <div style={{
              position:"absolute",left:`${normX*100}%`,top:0,bottom:0,width:1,
              background:"rgba(255,106,0,.25)",transform:"translateX(-50%)",
            }}/>
            {/* horizontal trace */}
            <div style={{
              position:"absolute",top:`${normY*100}%`,left:0,right:0,height:1,
              background:"rgba(255,106,0,.25)",transform:"translateY(-50%)",
            }}/>
            {/* dot */}
            <div style={{
              position:"absolute",
              left:`${normX*100}%`,top:`${normY*100}%`,
              width:18,height:18,borderRadius:"50%",
              background:"radial-gradient(circle,#ff8c00,#ff4400)",
              boxShadow:"0 0 12px #ff6a00,0 0 24px rgba(255,106,0,.4)",
              transform:"translate(-50%,-50%)",
              pointerEvents:"none",
              transition: gyroActive && !playing ? "left .08s,top .08s" : "none",
            }}/>
          </>
        )}

        {/* surface sheen */}
        <div style={{
          position:"absolute",inset:0,pointerEvents:"none",
          background:"linear-gradient(180deg,rgba(255,255,255,.03) 0%,transparent 40%)",
        }}/>

        {!ready && (
          <div style={{
            position:"absolute",inset:0,display:"flex",
            alignItems:"center",justifyContent:"center",
            color:"#2e2e2e",fontSize:9,letterSpacing:".3em",
          }}>TOUCH TO ACTIVATE</div>
        )}
      </div>

      {/* axis value readouts */}
      <div style={{display:"flex",justifyContent:"space-between",marginTop:5}}>
        <div style={{color:"#ff6a00",fontSize:8,fontFamily:"monospace",opacity:.7}}>
          {arpOn ? ROOTS[normToRootIdx(normX)] : freqToNote(normToPitch(normX))}
        </div>
        <div style={{color:"#ff6a00",fontSize:8,fontFamily:"monospace",opacity:.7}}>
          LFO {normToLfo(normY).toFixed(1)}Hz
        </div>
      </div>
    </div>
  );
}

// ─── Main app ─────────────────────────────────────────────────────────────────
export default function Monotron() {
  const [ready, setReady]       = useState(false);
  const [playing, setPlaying]   = useState(false);

  // Synth params
  const [cutoff,    setCutoff]    = useState(900);
  const [resonance, setResonance] = useState(0.25);
  const [lfoDepth,  setLfoDepth]  = useState(0);
  const [lfoTarget, setLfoTarget] = useState("pitch");

  // Arp params
  const [arpOn,      setArpOn]      = useState(false);
  const [arpRate,    setArpRate]    = useState(8);
  const [arpGate,    setArpGate]    = useState(0.6);
  const [arpPattern, setArpPattern] = useState("Random");
  const [arpRoot,    setArpRoot]    = useState("D");
  const [arpScale,   setArpScale]   = useState("Dorian");
  const [arpActiveIdx, setArpActiveIdx] = useState(0);
  const [scaleFreqs, setScaleFreqs] = useState(() => buildScale(ROOT_MIDI["D"], SCALES["Dorian"], 3));

  // XY pad state: normX [0,1], normY [0,1], zero at centre
  // Gyro provides a "base" position; touch overrides while active
  const gyroNorm    = useRef({ x: 0.5, y: 0.5 });
  const touchActive = useRef(false);
  const touchNorm   = useRef({ x: 0.5, y: 0.5 });

  const [padNorm, setPadNorm]         = useState({ x: 0.5, y: 0.5 });
  const [gyroActive, setGyroActive]   = useState(false);
  const [gyroEnabled, setGyroEnabled] = useState(false); // permission granted

  // ── Compute effective pad position ──
  const getEffectiveNorm = useCallback(() => {
    return touchActive.current ? touchNorm.current : gyroNorm.current;
  }, []);

  // ── Apply pad position to engine ──
  const applyPad = useCallback((nx, ny) => {
    setPadNorm({ x: nx, y: ny });
    const lfoRate = normToLfo(ny);
    engine.set("lfoRate", lfoRate);

    if (arpOn) {
      // X → root note
      const rootIdx = normToRootIdx(nx);
      const root = ROOTS[rootIdx];
      const freqs = buildScale(ROOT_MIDI[root], SCALES[arpScale], 3);
      engine.setScale(freqs);
      setScaleFreqs(freqs);
      setArpRoot(root);
    } else {
      // X → pitch (log)
      const pitch = normToPitch(nx);
      engine.set("pitch", pitch);
    }
  }, [arpOn, arpScale]);

  // ── Gyro handler ──
  useEffect(() => {
    if (!gyroEnabled) return;
    const TILT_RANGE = 30; // ±30°

    const onOrientation = e => {
      // gamma = left/right tilt [-90,90], beta = front/back [-180,180]
      const gamma = clamp(e.gamma ?? 0, -TILT_RANGE, TILT_RANGE);
      const beta  = clamp((e.beta  ?? 0) - 45, -TILT_RANGE, TILT_RANGE); // offset: natural hold ~45°

      const nx = (gamma + TILT_RANGE) / (TILT_RANGE * 2);
      const ny = 1 - (beta  + TILT_RANGE) / (TILT_RANGE * 2); // invert: tilt up = high LFO

      gyroNorm.current = { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) };
      setGyroActive(true);

      if (!touchActive.current) {
        applyPad(gyroNorm.current.x, gyroNorm.current.y);
      }
    };

    window.addEventListener("deviceorientation", onOrientation);
    return () => window.removeEventListener("deviceorientation", onOrientation);
  }, [gyroEnabled, applyPad]);

  // ── Gyro permission (iOS 13+) ──
  const requestGyro = useCallback(async () => {
    if (typeof DeviceOrientationEvent !== "undefined" &&
        typeof DeviceOrientationEvent.requestPermission === "function") {
      const perm = await DeviceOrientationEvent.requestPermission();
      if (perm === "granted") setGyroEnabled(true);
    } else {
      setGyroEnabled(true); // Android / desktop — no permission needed
    }
  }, []);

  // ── Synth param sync ──
  useEffect(() => { engine.set("cutoff",    cutoff);    }, [cutoff]);
  useEffect(() => { engine.set("resonance", resonance); }, [resonance]);
  useEffect(() => { engine.set("lfoDepth",  lfoDepth);  }, [lfoDepth]);
  useEffect(() => { engine.set("lfoTarget", lfoTarget); }, [lfoTarget]);
  useEffect(() => { engine.set("arpOn",     arpOn);     }, [arpOn]);
  useEffect(() => { engine.set("arpRate",   arpRate);   }, [arpRate]);
  useEffect(() => { engine.set("arpGate",   arpGate);   }, [arpGate]);

  useEffect(() => {
    const freqs = buildScale(ROOT_MIDI[arpRoot], SCALES[arpScale], 3);
    setScaleFreqs(freqs); engine.setScale(freqs);
  }, [arpRoot, arpScale]);

  useEffect(() => { engine.setPattern(arpPattern); }, [arpPattern]);

  // Poll arp visualiser
  useEffect(() => {
    if (!arpOn) return;
    const id = setInterval(() => setArpActiveIdx(engine.arpIdx), 40);
    return () => clearInterval(id);
  }, [arpOn]);

  // ── Pad handlers ──
  const startAudio = useCallback(async () => {
    await engine.init(); engine.resume(); setReady(true);
  }, []);

  const handlePadTouch = useCallback(async ({ x, y }) => {
    if (!ready) await startAudio();
    engine.resume();
    touchActive.current = true;
    touchNorm.current = { x, y };
    applyPad(x, y);
    if (!arpOn) engine.noteOn(normToPitch(x));
    else engine.set("playing", true);
    setPlaying(true);
  }, [ready, startAudio, arpOn, applyPad]);

  const handlePadMove = useCallback(({ x, y }) => {
    if (!touchActive.current) return;
    touchNorm.current = { x, y };
    applyPad(x, y);
    if (!arpOn) engine.set("pitch", normToPitch(x));
  }, [arpOn, applyPad]);

  const handlePadRelease = useCallback(() => {
    touchActive.current = false;
    engine.noteOff();
    setPlaying(false);
    // Hand back to gyro immediately if active
    if (gyroActive) applyPad(gyroNorm.current.x, gyroNorm.current.y);
  }, [gyroActive, applyPad]);

  // arp mode: playing state also gates on touch
  useEffect(() => { engine.set("playing", playing); }, [playing]);

  const activeNote = arpOn && playing
    ? freqToNote(scaleFreqs[arpActiveIdx] ?? scaleFreqs[0])
    : playing ? freqToNote(normToPitch(padNorm.x)) : null;

  return (
    <div style={{
      minHeight:"100vh", background:"#090909",
      display:"flex", alignItems:"center", justifyContent:"center",
      fontFamily:"'Courier New',monospace", padding:16,
    }}>
      <div style={{
        background:"linear-gradient(165deg,#1c1c1c 0%,#131313 50%,#0f0f0f 100%)",
        border:"1px solid #222", borderRadius:14,
        padding:"22px 20px 18px", maxWidth:560, width:"100%",
        boxShadow:"0 32px 96px rgba(0,0,0,.95),inset 0 1px 0 rgba(255,255,255,.04)",
        position:"relative", overflow:"hidden",
      }}>
        {/* grain */}
        <div style={{
          position:"absolute",inset:0,opacity:.025,pointerEvents:"none",
          backgroundImage:"url(\"data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E\")",
        }}/>

        {/* HEADER */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
          <div>
            <div style={{color:"#ff6a00",fontSize:17,fontWeight:"bold",letterSpacing:".18em"}}>MONOTRON</div>
            <div style={{color:"#2e2e2e",fontSize:7.5,letterSpacing:".28em",marginTop:1}}>ANALOGUE RIBBON SYNTHESIZER</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            {/* gyro button */}
            <button onClick={requestGyro} style={{
              background: gyroEnabled ? "rgba(255,106,0,.12)" : "transparent",
              color: gyroEnabled ? "#ff6a00" : "#383838",
              border:`1px solid ${gyroEnabled ? "#2a1800" : "#222"}`,
              borderRadius:4, padding:"3px 8px",
              fontSize:7.5, letterSpacing:".15em", cursor:"pointer",
              fontFamily:"monospace", textTransform:"uppercase",
            }}>
              {gyroEnabled ? (gyroActive ? "◈ GYRO" : "◇ GYRO") : "ENABLE GYRO"}
            </button>
            <LED active={playing}/>
            <div style={{color:"#555",fontSize:10,letterSpacing:".12em",minWidth:30,textAlign:"right"}}>
              {activeNote || "· · ·"}
            </div>
          </div>
        </div>

        {/* SYNTH SECTION */}
        <div style={{
          display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:5,
          padding:"14px 8px",marginBottom:12,
          background:"rgba(0,0,0,.35)",borderRadius:8,border:"1px solid #1a1a1a",
        }}>
          <Knob label="Cutoff"   value={cutoff}    min={40}  max={8000} log onChange={setCutoff}    unit="Hz"/>
          <Knob label="Peak"     value={resonance} min={0}   max={0.98}     onChange={setResonance}/>
          <Knob label="LFO Int"  value={lfoDepth}  min={0}   max={1}        onChange={setLfoDepth}/>
          <Knob label="ARP Rate" value={arpRate}   min={1}   max={32}   log onChange={setArpRate}   unit="/s"/>
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
            <div style={{display:"flex",flexDirection:"column",gap:4,marginTop:3}}>
              {["pitch","cutoff"].map(t=>(
                <Pill key={t} label={t} active={lfoTarget===t} onClick={()=>setLfoTarget(t)}/>
              ))}
            </div>
            <div style={{color:"#444",fontSize:7.5,letterSpacing:".08em",textTransform:"uppercase"}}>LFO→</div>
          </div>
        </div>

        {/* XY PAD */}
        <div style={{marginBottom:12}}>
          <XYPad
            normX={padNorm.x} normY={padNorm.y}
            playing={playing} arpOn={arpOn} arpRoot={arpRoot}
            onTouch={handlePadTouch} onRelease={handlePadRelease} onMove={handlePadMove}
            gyroActive={gyroActive && gyroEnabled} ready={ready}
          />
        </div>

        {/* ARP SECTION */}
        <div style={{
          padding:"14px 12px 12px", marginBottom:12,
          background:"rgba(0,0,0,.28)", borderRadius:8,
          border:`1px solid ${arpOn ? "#2a1800" : "#181818"}`,
          transition:"border-color .2s",
        }}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
            <div style={{display:"flex",alignItems:"center",gap:7}}>
              <LED active={arpOn}/>
              <span style={{color:arpOn?"#ff6a00":"#3a3a3a",fontSize:8.5,letterSpacing:".22em",textTransform:"uppercase"}}>
                ARPEGGIATOR
              </span>
              <span style={{color:"#252525",fontSize:7.5,letterSpacing:".1em"}}>
                {arpRoot} {arpScale} · {arpPattern}
              </span>
            </div>
            <button onClick={()=>setArpOn(v=>!v)} style={{
              background:arpOn?"#ff6a00":"transparent",
              color:arpOn?"#000":"#555",
              border:`1px solid ${arpOn?"#ff6a00":"#333"}`,
              borderRadius:4,padding:"3px 10px",
              fontSize:8,letterSpacing:".15em",cursor:"pointer",
              fontFamily:"monospace",textTransform:"uppercase",transition:"all .15s",
            }}>{arpOn?"ON":"OFF"}</button>
          </div>

          <div style={{display:"flex",alignItems:"flex-end",gap:14,marginBottom:12}}>
            <Knob label="Gate" value={arpGate} min={0.05} max={0.98} onChange={setArpGate} size={42}/>
            <div style={{flex:1}}>
              <div style={{color:"#2a2a2a",fontSize:7.5,letterSpacing:".18em",marginBottom:5}}>SCALE STEPS</div>
              <ArpGrid freqs={scaleFreqs} activeIdx={arpActiveIdx} arpOn={arpOn&&playing}/>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{color:"#252525",fontSize:7.5,letterSpacing:".12em",marginBottom:3}}>NOTE</div>
              <div style={{
                color:arpOn&&playing?"#ff6a00":"#202020",
                fontSize:16,fontFamily:"monospace",
                textShadow:arpOn&&playing?"0 0 10px #ff6a00":"none",
                transition:"all .05s",minWidth:32,textAlign:"right",
              }}>
                {arpOn&&playing ? freqToNote(scaleFreqs[arpActiveIdx]??scaleFreqs[0]) : "--"}
              </div>
            </div>
          </div>

          <div style={{height:1,background:"#181818",marginBottom:10}}/>

          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <SelectorStrip label="Pattern" options={ARP_PATTERNS}           value={arpPattern} onChange={setArpPattern}/>
            <SelectorStrip label="Root"    options={ROOTS}                  value={arpRoot}    onChange={setArpRoot}/>
            <SelectorStrip label="Scale"   options={Object.keys(SCALES)}    value={arpScale}   onChange={setArpScale}/>
          </div>
        </div>

        <div style={{display:"flex",justifyContent:"space-between"}}>
          <div style={{color:"#1a1a1a",fontSize:7,letterSpacing:".18em"}}>VCO · MS-20 VCF · LFO · ARP · XY</div>
          <div style={{color:"#1a1a1a",fontSize:7,letterSpacing:".15em"}}>
            {ready ? `${engine.ctx?.sampleRate}Hz` : "STANDBY"}
          </div>
        </div>
      </div>
    </div>
  );
}
