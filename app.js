/**
 * FM Web Synth Application
 * 4-Operator "Ableton Style" Upgrade
 */

class AudioEngine {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();
        this.masterGain = this.ctx.createGain();
        this.masterGain.connect(this.ctx.destination);
        this.masterGain.gain.value = 0.5;

        // Visualizer Analysis Nodes 
        // We will visualize the main output now, but mapped to X/Y in a creative way
        // Or keep Carrier vs Modulator concept? With 4 Ops, it's complex.
        // Let's visualize Left vs Right output for a cool stereo phase scope (since we have Spread now!)
        this.analyserL = this.ctx.createAnalyser();
        this.analyserR = this.ctx.createAnalyser();
        this.analyserL.fftSize = 2048;
        this.analyserR.fftSize = 2048;

        // Stereo Split processing for visualization
        this.splitter = this.ctx.createChannelSplitter(2);
        this.masterGain.connect(this.splitter);
        this.splitter.connect(this.analyserL, 0);
        this.splitter.connect(this.analyserR, 1);

        this.voices = {}; // Active voices

        // Params structure for 4 Ops
        this.ops = {
            'A': { wave: 'sine', coarse: 1, fine: 0, level: 1 },
            'B': { wave: 'sine', coarse: 1, fine: 0, level: 0.5 },
            'C': { wave: 'sine', coarse: 1, fine: 0, level: 0 },
            'D': { wave: 'sine', coarse: 1, fine: 0, level: 0 }
        };

        this.spread = 0; // 0 to 100%

        this.envelope = {
            attack: 0.05,
            decay: 0.3,
            sustain: 0.7,
            release: 1.0
        };
    }

    setGlobalParam(param, value) {
        if (param === 'volume') {
            this.masterGain.gain.value = value;
        } else if (param === 'spread') {
            this.spread = value; // 0-100
        } else if (this.envelope[param] !== undefined) {
            this.envelope[param] = value;
        }
    }

    setOpParam(opId, param, value) {
        if (this.ops[opId]) {
            this.ops[opId][param] = value;
            // Update active voices in real-time
            Object.values(this.voices).forEach(voice => {
                voice.updateOp(opId, param, value);
            });
        }
    }

    startNote(note, freq) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (this.voices[note]) this.voices[note].stop();

        const voice = new FMVoice(this.ctx, freq, this.ops, this.envelope, this.spread, this.masterGain);
        voice.start();
        this.voices[note] = voice;
    }

    stopNote(note) {
        if (this.voices[note]) {
            this.voices[note].release();
            // Cleanup happens inside voice
        }
    }
}

class FMVoice {
    constructor(ctx, freq, opsParams, env, spread, destination) {
        this.ctx = ctx;
        this.freq = freq;
        this.opsParams = opsParams;
        this.env = env;
        this.spread = spread;
        this.destination = destination;

        // We create TWO chains for stereo spread: Left and Right
        // If spread is 0, they are identical and center panned.
        // If spread is > 0, they are detuned and panned hard L/R.

        this.chainL = this.createChain(-1); // Pan Left
        this.chainR = this.createChain(1);  // Pan Right
    }

    createChain(panPos) {
        // Panner
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = panPos;
        panner.connect(this.destination);

        // Calculate Detune based on Spread and Pan
        // Spread 0-100. Max detune say +/- 50 cents?
        // Left = Flat, Right = Sharp
        const spreadDetune = (this.spread / 100) * 25 * panPos; // +/- 25 cents at max

        // Envelope Gain (Global ADSR applied to Carrier A output)
        const envGain = this.ctx.createGain();
        envGain.connect(panner);
        envGain.gain.value = 0;

        // Operators
        // D -> C -> B -> A -> Env -> Panner

        const opA = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.A, false); // Carrier
        const opB = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.B, true);
        const opC = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.C, true);
        const opD = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.D, true);

        // Chain them
        // Modulators connect to frequency of next op
        opD.connectTo(opC.osc.frequency);
        opC.connectTo(opB.osc.frequency);
        opB.connectTo(opA.osc.frequency);

        // Carrier A connects to Envelope
        opA.connectTo(envGain);

        return {
            panner, envGain, opA, opB, opC, opD
        };
    }

    start() {
        const now = this.ctx.currentTime;

        [this.chainL, this.chainR].forEach(chain => {
            // Start Ops
            chain.opA.start(now);
            chain.opB.start(now);
            chain.opC.start(now);
            chain.opD.start(now);

            // ADSR
            chain.envGain.gain.cancelScheduledValues(now);
            chain.envGain.gain.setValueAtTime(0, now);
            chain.envGain.gain.linearRampToValueAtTime(1, now + this.env.attack);
            chain.envGain.gain.setTargetAtTime(this.env.sustain, now + this.env.attack, this.env.decay);
        });
    }

    updateOp(opId, param, value) {
        // Update both chains
        [this.chainL, this.chainR].forEach(chain => {
            const op = chain[`op${opId}`];
            if (op) op.setParam(param, value);
        });
    }

    stop() {
        [this.chainL, this.chainR].forEach(chain => {
            chain.opA.stop();
            chain.opB.stop();
            chain.opC.stop();
            chain.opD.stop();
        });
    }

    release() {
        const now = this.ctx.currentTime;
        [this.chainL, this.chainR].forEach(chain => {
            chain.envGain.gain.cancelScheduledValues(now);
            chain.envGain.gain.setValueAtTime(chain.envGain.gain.value, now);
            chain.envGain.gain.exponentialRampToValueAtTime(0.001, now + this.env.release);

            const stopTime = now + this.env.release + 0.1;
            chain.opA.stop(stopTime);
            chain.opB.stop(stopTime);
            chain.opC.stop(stopTime);
            chain.opD.stop(stopTime);
        });
    }
}

class Operator {
    constructor(ctx, baseFreq, params, isModulator) {
        this.ctx = ctx;
        this.baseFreq = baseFreq;
        this.params = params;
        this.isModulator = isModulator;

        this.osc = ctx.createOscillator();
        this.gain = ctx.createGain();

        this.updateFreq();
        this.updateWave();
        this.updateLevel();

        this.osc.connect(this.gain);
    }

    updateFreq() {
        // F = base * coarse + fine
        // Actually, normally: F = base * CoarseRatio
        // Fine is usually cents detune. 
        // Let's do: freq = base * coarse
        // osc.detune = fine
        this.osc.frequency.value = this.baseFreq * this.params.coarse;
        this.osc.detune.value = this.params.fine;
    }

    updateWave() {
        this.osc.type = this.params.wave;
    }

    updateLevel() {
        // If Modulator: Gain is Modulation Index * Frequency (approx logic, or just a multiplier)
        // Standard FM: Gain output is directly added to Frequency.
        // So Gain Value of 100 means +/- 100Hz deviation.
        // "Level" 0-1. Let's map this to a useful range.
        // For Carrier A: Fixed at 1 usually (passed to Env). But here we can attenuate it if we want.
        // But in our Voice code, A connects to Envelope directly.

        if (this.isModulator) {
            // Arbitrary scaling for "Deep FM" sound. 
            // Level 1.0 -> 2000Hz deviation?
            this.gain.gain.value = this.params.level * 2000;
        } else {
            // Carrier A
            this.gain.gain.value = 1.0; // Fixed full output to envelope
        }
    }

    setParam(param, value) {
        this.params[param] = value;
        if (param === 'wave') this.updateWave();
        else if (param === 'coarse' || param === 'fine') this.updateFreq();
        else if (param === 'level') this.updateLevel();
    }

    connectTo(dest) {
        this.gain.connect(dest);
    }

    start(time) {
        this.osc.start(time);
    }

    stop(time = 0) {
        if (time > 0) this.osc.stop(time);
        else this.osc.stop();
    }
}

class Visualizer {
    constructor(canvas, analyserL, analyserR) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.analyserL = analyserL;
        this.analyserR = analyserR;

        this.width = canvas.width;
        this.height = canvas.height;
        this.resize();
        window.addEventListener('resize', () => this.resize());

        this.bufferLength = analyserL.frequencyBinCount;
        this.dataL = new Uint8Array(this.bufferLength);
        this.dataR = new Uint8Array(this.bufferLength);

        this.loop();
    }

    resize() {
        this.canvas.width = this.canvas.clientWidth;
        this.canvas.height = this.canvas.clientHeight;
        this.width = this.canvas.width;
        this.height = this.canvas.height;
    }

    loop() {
        requestAnimationFrame(() => this.loop());

        this.analyserL.getByteTimeDomainData(this.dataL);
        this.analyserR.getByteTimeDomainData(this.dataR);

        // Clear / Trail
        this.ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
        this.ctx.fillRect(0, 0, this.width, this.height);

        this.ctx.lineWidth = 1.5;
        this.ctx.strokeStyle = '#00f3ff';
        this.ctx.shadowBlur = 4;
        this.ctx.shadowColor = '#00f3ff';

        this.ctx.beginPath();

        // Visualize Stereo Phase (L vs R)
        // If Spread is 0, L == R, so it's a diagonal line (Mono)
        // If Spread > 0, it opens up into shapes.

        // Scale down to 50% as requested so it fits in frame
        const scale = 0.5;

        for (let i = 0; i < this.bufferLength; i += 2) { // Skip every other for perf
            const vL = (this.dataL[i] / 128.0) - 1.0; // -1 to 1
            const vR = (this.dataR[i] / 128.0) - 1.0; // -1 to 1

            // Map L to X, R to Y? Or just X/Y oscilloscope of Master?
            // "XY Oscilloscope in XY mode is the core" -> usually Carrier vs Modulator.
            // But now we have 4 Ops.
            // Let's stick to L vs R for the "Output" visualization, which implicitly shows the complexity of the sound.
            // With Spread, this will look great.

            const x = (vL * scale * Math.min(this.width, this.height)) + (this.width / 2);
            const y = (vR * scale * Math.min(this.width, this.height)) + (this.height / 2); // Inverted Y?

            if (i === 0) this.ctx.moveTo(x, y);
            else this.ctx.lineTo(x, y);
        }

        this.ctx.stroke();
    }
}

class InputManager {
    constructor(audioEngine) {
        this.audioEngine = audioEngine;
        this.keyboardMap = {
            'a': 261.63, 'w': 277.18, 's': 293.66, 'e': 311.13, 'd': 329.63, 'f': 349.23,
            't': 369.99, 'g': 392.00, 'y': 415.30, 'h': 440.00, 'u': 466.16, 'j': 493.88, 'k': 523.25
        };
        this.setupKeyboard();
        this.setupControls();
    }

    setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            const key = e.key.toLowerCase();
            if (this.keyboardMap[key]) {
                this.audioEngine.startNote(key, this.keyboardMap[key]);
            }
        });

        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (this.keyboardMap[key]) {
                this.audioEngine.stopNote(key);
            }
        });
    }

    setupControls() {
        // Global
        this.bind('spread', 'spread', false);
        this.bind('volume', 'volume');

        this.bind('attack', 'attack');
        this.bind('decay', 'decay');
        this.bind('sustain', 'sustain');
        this.bind('release', 'release');

        // Operators A-D
        ['A', 'B', 'C', 'D'].forEach(op => {
            this.bindOp(op, 'wave', false); // string
            this.bindOp(op, 'coarse');
            this.bindOp(op, 'fine');
            this.bindOp(op, 'level');
        });

        // Start Overlay
        const overlay = document.getElementById('start-overlay');
        overlay.addEventListener('click', () => {
            if (this.audioEngine.ctx.state === 'suspended') {
                this.audioEngine.ctx.resume();
            }
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 500);
        });
    }

    bind(id, param, isFloat = true) {
        const el = document.getElementById(id);
        const disp = document.getElementById('val-' + id);
        if (!el) return;
        el.addEventListener('input', (e) => {
            const val = isFloat ? parseFloat(e.target.value) : parseInt(e.target.value);
            this.audioEngine.setGlobalParam(param, val);
            if (disp) disp.innerText = param === 'spread' ? val + '%' : val;
        });
    }

    bindOp(op, param, isNum = true) {
        const id = `op${op}-${param}`;
        const el = document.getElementById(id);
        const disp = document.getElementById(`val-${id}`);
        if (!el) return;
        el.addEventListener('input', (e) => {
            let val = e.target.value;
            if (isNum) val = parseFloat(val);
            this.audioEngine.setOpParam(op, param, val);
            if (disp) disp.innerText = val;
        });
    }
}

// Init
window.addEventListener('DOMContentLoaded', () => {
    const engine = new AudioEngine();
    const visualizer = new Visualizer(document.getElementById('oscilloscope'), engine.analyserL, engine.analyserR);
    const inputs = new InputManager(engine);
});
