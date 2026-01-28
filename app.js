/**
 * FM Battalion - Audio Engine & UI
 * Features: 4-Op FM, Transistor Ladder Filter, Rotary Knobs, Log Scaling
 */

class RotaryKnob {
    constructor(containerId, label, min, max, step, initialValue, callback, displayMap = null) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.label = label;
        this.min = min;
        this.max = max;
        this.step = step;
        this.value = initialValue;
        this.callback = callback;
        this.displayMap = displayMap; // Optional function to format display value

        this.isDragging = false;
        this.startY = 0;
        this.startVal = 0;

        this.render();
        this.bindEvents();
    }

    render() {
        this.container.classList.add('knob-container');
        // SVG Arc calc
        // -135deg to +135deg (Total 270deg)
        const pct = (this.value - this.min) / (this.max - this.min);
        const startAngle = -135;
        const endAngle = -135 + (pct * 270);

        // Convert polar to cartesian
        const radius = 24;
        const cx = 30;
        const cy = 30;

        const startRad = (startAngle - 90) * Math.PI / 180;
        const endRad = (endAngle - 90) * Math.PI / 180;

        const x1 = cx + radius * Math.cos(startRad);
        const y1 = cy + radius * Math.sin(startRad);
        const x2 = cx + radius * Math.cos(endRad);
        const y2 = cy + radius * Math.sin(endRad);

        const largeArc = (endAngle - startAngle) > 180 ? 1 : 0;

        // Background track (full 270)
        const trackPath = "M 13.03 46.97 A 24 24 0 1 1 46.97 46.97";
        // Value path
        const valuePath = `M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 1 ${x2} ${y2}`;

        let displayVal = Math.round(this.value * 100) / 100;
        if (this.displayMap) displayVal = this.displayMap(this.value);

        this.container.innerHTML = `
            <svg class="knob-svg" viewBox="0 0 60 60">
                <path class="knob-track" d="${trackPath}" />
                <path class="knob-value-arc" d="${valuePath}" />
            </svg>
            <div class="knob-value">${displayVal}</div>
            <div class="knob-label">${this.label}</div>
        `;
    }

    bindEvents() {
        const svg = this.container.querySelector('.knob-svg');

        const startDrag = (y) => {
            this.isDragging = true;
            this.startY = y;
            this.startVal = this.value;
            document.body.style.cursor = 'ns-resize';
        };

        svg.addEventListener('mousedown', (e) => startDrag(e.clientY));
        svg.addEventListener('touchstart', (e) => {
            e.preventDefault();
            startDrag(e.touches[0].clientY);
        });

        const doDrag = (y) => {
            if (!this.isDragging) return;
            const deltaY = this.startY - y; // Up is positive
            const range = this.max - this.min;
            const sensitivity = 200; // pixels for full range

            let deltaVal = (deltaY / sensitivity) * range;
            let newVal = this.startVal + deltaVal;

            // Clamp and Step
            newVal = Math.max(this.min, Math.min(this.max, newVal));
            if (this.step) {
                newVal = Math.round(newVal / this.step) * this.step;
            }

            if (newVal !== this.value) {
                this.value = newVal;
                this.render();
                // Re-bind listener to new DOM? No, container stable.
                // Actually render replaces innerHTML, so we lose listeners on svg.
                // We need to rebind listeners or update DOM attributes instead of full replace.
                // For simplicity/perf in this prototype, full replace is fast enough, BUT we lose the mouseup event if we're not careful.
                // Better: The mousemove/up go on Window/Document.

                if (this.callback) this.callback(this.value);
            }
        };

        const stopDrag = () => {
            if (this.isDragging) {
                this.isDragging = false;
                document.body.style.cursor = 'default';
                this.bindEvents(); // Re-bind mousedown to new SVG
            }
        };

        // These need to be global to catch drag outside
        window.addEventListener('mousemove', (e) => doDrag(e.clientY));
        window.addEventListener('touchmove', (e) => doDrag(e.touches[0].clientY));
        window.addEventListener('mouseup', stopDrag);
        window.addEventListener('touchend', stopDrag);
    }
}

class AudioEngine {
    constructor() {
        this.ctx = new (window.AudioContext || window.webkitAudioContext)();

        // Master Chain: MasterMix -> Saturation -> Splitter -> Destination
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.5;

        // Saturation Node
        this.saturator = this.ctx.createWaveShaper();
        this.saturator.curve = this.makeDistortionCurve(0);

        this.masterGain.connect(this.saturator);

        // Visualizer Analysis
        this.analyserL = this.ctx.createAnalyser();
        this.analyserR = this.ctx.createAnalyser();
        this.analyserL.fftSize = 2048;
        this.analyserR.fftSize = 2048;

        this.splitter = this.ctx.createChannelSplitter(2);
        this.saturator.connect(this.splitter); // Post-saturation visualization
        this.saturator.connect(this.ctx.destination); // Output to speakers directly? 
        // Logic check: Splitter is for analysis. We also need to hear it.
        // Saturator -> Destination AND Splitter? Yes.

        this.splitter.connect(this.analyserL, 0);
        this.splitter.connect(this.analyserR, 1);

        this.voices = {};

        this.ops = {
            'A': { wave: 'sine', coarse: 1, fine: 0, level: 1 },
            'B': { wave: 'sine', coarse: 1, fine: 0, level: 0.5 },
            'C': { wave: 'sine', coarse: 1, fine: 0, level: 0 },
            'D': { wave: 'sine', coarse: 1, fine: 0, level: 0 }
        };

        this.spread = 0;
        this.globalOctave = 0; // -2 to +2

        this.envelope = {
            attack: 0.05, decay: 0.3, sustain: 0.7, release: 1.0
        };

        this.filter = {
            cutoff: 0.8,
            res: 0,
            envAmt: 0
        };

        this.filterEnv = {
            attack: 0.05, decay: 0.3, sustain: 0.7, release: 1.0
        };

        // LFOs (Global)
        this.lfo1 = new LFO(this.ctx);
        this.lfo2 = new LFO(this.ctx);

        // Mod Matrix State
        // { targetId: { lfo1: 0, lfo2: 0, env1: 0, env2: 0 } }
        this.modulations = {};
    }

    // Register modulation (called by UI)
    setModulation(targetId, sourceId, amount) {
        if (!this.modulations[targetId]) this.modulations[targetId] = { lfo1: 0, lfo2: 0, env1: 0, env2: 0 };
        this.modulations[targetId][sourceId] = amount;

        // Update active voices if possible (LFOs only for now?)
        // Actually, we need to update routing dynamically.
        Object.values(this.voices).forEach(voice => {
            voice.updateModulation(targetId, sourceId, amount);
        });
    }

    makeDistortionCurve(amount) {
        const k = amount * 100;
        const n_samples = 44100;
        const curve = new Float32Array(n_samples);
        const deg = Math.PI / 180;
        if (amount === 0) {
            for (let i = 0; i < n_samples; ++i) curve[i] = (i * 2) / n_samples - 1;
        } else {
            for (let i = 0; i < n_samples; ++i) {
                let x = (i * 2) / n_samples - 1;
                curve[i] = (3 + k) * x * 20 * deg / (Math.PI + k * Math.abs(x));
            }
        }
        return curve;
    }

    getLogCutoff(normVal) {
        const min = 20;
        const max = 20000;
        if (normVal <= 0.001) return min;
        return min * Math.pow(max / min, normVal);
    }

    setGlobalParam(param, value) {
        if (param === 'volume') {
            this.masterGain.gain.value = value;
        } else if (param === 'spread') {
            this.spread = value;
            Object.values(this.voices).forEach(voice => voice.updateSpread(this.spread));
        } else if (param === 'saturation') {
            this.saturator.curve = this.makeDistortionCurve(value);
        } else if (this.envelope[param] !== undefined) {
            this.envelope[param] = value;
        }
    }

    setOctave(delta) {
        this.globalOctave = Math.max(-2, Math.min(2, this.globalOctave + delta));
        return this.globalOctave;
    }

    setFilterParam(param, value) {
        if (this.filter[param] !== undefined) {
            this.filter[param] = value;
            Object.values(this.voices).forEach(voice => {
                if (param === 'cutoff') {
                    const freq = this.getLogCutoff(value);
                    voice.updateFilter('cutoff', freq);
                } else {
                    voice.updateFilter(param, value);
                }
            });
        } else if (this.filterEnv[param] !== undefined) {
            this.filterEnv[param] = value;
        }
    }

    setOpParam(opId, param, value) {
        if (this.ops[opId]) {
            this.ops[opId][param] = value;
            Object.values(this.voices).forEach(voice => {
                voice.updateOp(opId, param, value);
            });
        }
    }

    startNote(note, freq) {
        if (this.ctx.state === 'suspended') this.ctx.resume();
        if (this.voices[note]) this.voices[note].stop();

        const logCutoff = this.getLogCutoff(this.filter.cutoff);
        // Apply Global Octave shift
        // Multiply freq by 2^octave
        const shiftFactor = Math.pow(2, this.globalOctave);
        const shiftedFreq = freq * shiftFactor;

        const voice = new FMVoice(this.ctx, shiftedFreq, this.ops, this.envelope,
            { ...this.filter, cutoff: logCutoff },
            this.filterEnv, this.spread, this.masterGain,
            this.lfo1, this.lfo2, this.modulations); // Pass LFOs + Matrix

        voice.start();
        this.voices[note] = voice;
    }

    stopNote(note) {
        if (this.voices[note]) {
            this.voices[note].release();
        }
    }
}

class LadderFilter {
    constructor(ctx, startFreq, res) {
        this.ctx = ctx;
        this.input = ctx.createGain();
        this.output = ctx.createGain();

        // No more drive shaper here

        this.lpf1 = ctx.createBiquadFilter();
        this.lpf1.type = 'lowpass';
        this.lpf1.Q.value = res / 2;

        this.lpf2 = ctx.createBiquadFilter();
        this.lpf2.type = 'lowpass';
        this.lpf2.Q.value = res / 2;

        this.setCutoff(startFreq);

        this.input.connect(this.lpf1);
        this.lpf1.connect(this.lpf2);
        this.lpf2.connect(this.output);
    }

    setCutoff(freq) {
        const f = Math.max(20, Math.min(22000, freq));
        this.lpf1.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.01);
        this.lpf2.frequency.setTargetAtTime(f, this.ctx.currentTime, 0.01);
    }

    setRes(val) {
        const q = Math.max(0, val);
        this.lpf1.Q.setTargetAtTime(q, this.ctx.currentTime, 0.01);
        this.lpf2.Q.setTargetAtTime(q, this.ctx.currentTime, 0.01);
    }

    // Drive removed
}

class FMVoice {
    constructor(ctx, freq, opsParams, env, filterParams, filterEnv, spread, destination, lfo1, lfo2, mods) {
        this.ctx = ctx;
        this.freq = freq;
        this.opsParams = opsParams;
        this.env = env;
        this.filterParams = filterParams;
        this.filterEnv = filterEnv;
        this.spread = spread;
        this.destination = destination;
        this.lfo1 = lfo1;
        this.lfo2 = lfo2;
        this.mods = mods || {};

        this.chainL = this.createChain(-1);
        this.chainR = this.createChain(1);
    }

    createChain(panPos) {
        const panner = this.ctx.createStereoPanner();
        panner.pan.value = panPos;
        panner.connect(this.destination);

        const filter = new LadderFilter(this.ctx, this.filterParams.cutoff, this.filterParams.res);
        filter.output.connect(panner);

        const envGain = this.ctx.createGain();
        envGain.connect(filter.input);
        envGain.gain.value = 0;

        const spreadDetune = (this.spread / 100) * 15 * panPos; // Toned down detune slightly

        const opA = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.A, false);
        const opB = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.B, true);
        const opC = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.C, true);
        const opD = new Operator(this.ctx, this.freq + spreadDetune, this.opsParams.D, true);

        opD.connectTo(opC.osc.frequency);
        opC.connectTo(opB.osc.frequency);
        opB.connectTo(opA.osc.frequency);
        opA.connectTo(envGain);

        const chain = { panner, filter, envGain, opA, opB, opC, opD };

        // Apply Modulation Wiring
        this.applyModulations(chain);

        return chain;
    }

    start() {
        const now = this.ctx.currentTime;
        [this.chainL, this.chainR].forEach(chain => {
            // Amp Env
            chain.envGain.gain.cancelScheduledValues(now);
            chain.envGain.gain.setValueAtTime(0, now);
            chain.envGain.gain.linearRampToValueAtTime(1, now + this.env.attack);
            chain.envGain.gain.setTargetAtTime(this.env.sustain, now + this.env.attack, this.env.decay);

            // Filter Env - ADSR "Pluck"
            // Amt is linear 0-10000Hz (knob value)
            const amt = this.filterParams.envAmt;
            if (amt > 10) {
                const base = chain.filter.lpf1.frequency.value;
                const peak = Math.min(22000, base + amt);

                chain.filter.lpf1.frequency.cancelScheduledValues(now);
                chain.filter.lpf2.frequency.cancelScheduledValues(now);

                chain.filter.lpf1.frequency.setValueAtTime(base, now);
                chain.filter.lpf2.frequency.setValueAtTime(base, now);

                // Attack to Peak
                chain.filter.lpf1.frequency.linearRampToValueAtTime(peak, now + this.filterEnv.attack);
                chain.filter.lpf2.frequency.linearRampToValueAtTime(peak, now + this.filterEnv.attack);

                // Decay to Sustain
                // Sustain is 0-1 ratio of the ENV AMOUNT, added to base
                const susFreq = base + (amt * this.filterEnv.sustain);
                const decayTime = now + this.filterEnv.attack + this.filterEnv.decay;

                chain.filter.lpf1.frequency.exponentialRampToValueAtTime(Math.max(20, susFreq), decayTime);
                chain.filter.lpf2.frequency.exponentialRampToValueAtTime(Math.max(20, susFreq), decayTime);
            }

            chain.opA.start(now); chain.opB.start(now); chain.opC.start(now); chain.opD.start(now);
        });
    }

    updateFilter(param, value) {
        [this.chainL, this.chainR].forEach(chain => {
            if (param === 'cutoff') chain.filter.setCutoff(value);
            else if (param === 'res') chain.filter.setRes(value);
        });
    }

    updateOp(opId, param, value) {
        [this.chainL, this.chainR].forEach(chain => {
            const op = chain[`op${opId}`];
            if (op) op.setParam(param, value);
        });
    }

    // Apply Modulation Routing
    applyModulations(chain) {
        // Mapping: Target ID -> AudioParam or Function?
        // Supported Targets: 'f-cutoff-k', 'opA-level-k', etc.
        // We need to map UI IDs to Internal Nodes.

        Object.keys(this.mods).forEach(targetId => {
            const depths = this.mods[targetId];
            if (!depths) return;

            // Find Target AudioParam in this chain
            let paramNode = null;
            let baseVal = 0;

            if (targetId === 'f-cutoff-k') {
                // Cutoff modulation is tricky vs ADSR. 
                // We modulate the frequency AudioParam of lpf1 and lpf2.
                // Actually, let's just create a modGain -> lpf.detune (easier than freq sum)
                // Or modGain -> lpf.frequency
                paramNode = chain.filter.lpf1.frequency; // And lpf2?
                baseVal = chain.filter.lpf1.frequency.value;
            } else if (targetId.includes('-level-k')) {
                // opX-level-k
                const opId = targetId.charAt(2); // 'o','p','A' -> 2 index? opA = 0..2. "opA" 
                const op = chain[`op${opId}`];
                if (op) { paramNode = op.gain.gain; baseVal = op.params.level * 2000; }
            } else if (targetId.includes('-coarse-k')) {
                const opId = targetId.charAt(2);
                const op = chain[`op${opId}`];
                // Modulating freq? use detune.
                if (op) { paramNode = op.osc.detune; baseVal = 0; }
            }

            if (paramNode) {
                // LFO 1
                if (depths.lfo1 !== 0) {
                    const g = this.ctx.createGain();
                    g.gain.value = depths.lfo1 * (targetId === 'f-cutoff-k' ? 20 : 10); // Scale?
                    if (targetId.includes('coarse')) g.gain.value *= 10; // Pitch needs more
                    this.lfo1.connect(g);
                    g.connect(paramNode);
                }
                // LFO 2
                if (depths.lfo2 !== 0) {
                    const g = this.ctx.createGain();
                    g.gain.value = depths.lfo2 * (targetId === 'f-cutoff-k' ? 20 : 10);
                    this.lfo2.connect(g);
                    g.connect(paramNode);
                }

                // Envelopes? 
                // Creating a ConstantSource to represent Envelope signal is expensive per voice.
                // But we already have the ADSR schedule logic.
                // Just add the mod amount to the ADSR target values?
                // Too complex for V1. Focusing on LFOs first as requested layout.
            }
        });
    }

    updateModulation(targetId, sourceId, amount) {
        // Real-time update? 
        // Hard to update existing graph without tracking every gain node.
        // For now, modulation takes effect on NEXT NOTE.
    }
    updateSpread(newSpread) {
        this.spread = newSpread;
        // Re-apply freq to all ops with new spread
        [this.chainL, this.chainR].forEach((chain, i) => {
            const pan = i === 0 ? -1 : 1;
            const spreadDetune = (this.spread / 100) * 15 * pan;
            ['A', 'B', 'C', 'D'].forEach(id => {
                // We need to re-set the base freq + detune
                // But Operator class manages freq = base * coarse.
                // We need to update the Operator's baseFreq or just trick it.
                // Let's update baseFreq of the operator.
                const op = chain[`op${id}`];
                op.baseFreq = this.freq + spreadDetune;
                op.updateFreq();
            });
        });
    }

    stop() {
        [this.chainL, this.chainR].forEach(chain => {
            chain.opA.stop(); chain.opB.stop(); chain.opC.stop(); chain.opD.stop();
        });
    }

    release() {
        const now = this.ctx.currentTime;
        [this.chainL, this.chainR].forEach(chain => {
            // Amp Release
            chain.envGain.gain.cancelScheduledValues(now);
            chain.envGain.gain.setValueAtTime(chain.envGain.gain.value, now);
            chain.envGain.gain.exponentialRampToValueAtTime(0.001, now + this.env.release);

            // Filter Release
            // Simple approach: Let the previous automation finish or decay? 
            // Better: Just stop oscillators after release.
            const stopTime = now + Math.max(this.env.release, this.filterEnv.release) + 0.1;
            chain.opA.stop(stopTime); chain.opB.stop(stopTime); chain.opC.stop(stopTime); chain.opD.stop(stopTime);
        });
    }
}

class LFO {
    constructor(ctx) {
        this.ctx = ctx;
        this.osc = ctx.createOscillator();
        this.osc.type = 'sine';
        this.osc.frequency.value = 1;
        this.osc.start();
        // We output to a dummy node or let Voice connect?
        // Actually, we can just expose the oscillator. 
        // But we need per-voice Gain nodes to control depth. 
        // The LFO itself is global and always running.
    }
    setRate(val) { this.osc.frequency.value = val; }
    setWave(val) { this.osc.type = val; }
    connect(dest) { this.osc.connect(dest); }
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
        this.osc.frequency.value = this.baseFreq * this.params.coarse;
        this.osc.detune.value = this.params.fine;
    }
    updateWave() { this.osc.type = this.params.wave; }
    updateLevel() {
        if (this.isModulator) this.gain.gain.value = this.params.level * 2000;
        else this.gain.gain.value = 1.0;
    }
    // Added updateSpread helper
    updateSpread(spreadAmt, pan) {
        // Recalculate freq with new spread
        const spreadDetune = (spreadAmt / 100) * 15 * pan;
        this.osc.frequency.value = (this.baseFreq + spreadDetune) * this.params.coarse;
    }
    setParam(param, value) {
        this.params[param] = value;
        if (param === 'wave') this.updateWave();
        else if (param === 'coarse' || param === 'fine') this.updateFreq();
        else if (param === 'level') this.updateLevel();
    }
    connectTo(dest) { this.gain.connect(dest); }
    start(time) { this.osc.start(time); }
    stop(time = 0) { if (time > 0) this.osc.stop(time); else this.osc.stop(); }
}

class Visualizer {
    constructor(canvas, analyserL, analyserR, engine) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.analyserL = analyserL;
        this.analyserR = analyserR;
        this.engine = engine; // Needed for Op levels

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
        this.ctx.fillStyle = 'rgba(11, 20, 30, 0.4)'; // Clearing with Navy
        this.ctx.fillRect(0, 0, this.width, this.height);

        // Dynamic Color for Background V/T Wave
        const lvlB = this.engine.ops.B.level;
        const lvlC = this.engine.ops.C.level;
        const lvlD = this.engine.ops.D.level;

        let influenceColor = 'rgba(0, 210, 255, 0.3)'; // Default Teal Low Opacity
        if (lvlC > lvlB && lvlC > lvlD && lvlC > 0.2) influenceColor = 'rgba(255, 157, 0, 0.3)'; // Orange
        else if (lvlD > lvlB && lvlD > lvlC && lvlD > 0.2) influenceColor = 'rgba(255, 215, 0, 0.3)'; // Yellow
        else if (lvlB > 0.2) influenceColor = 'rgba(255, 42, 109, 0.3)'; // Pink

        // 1. Draw Background V/T Wave (Mono Mix)
        this.ctx.lineWidth = 4;
        this.ctx.strokeStyle = influenceColor;
        this.ctx.shadowBlur = 0;
        this.ctx.beginPath();
        const sliceWidth = this.width * 1.0 / this.bufferLength;
        let x = 0;

        for (let i = 0; i < this.bufferLength; i++) {
            const v = (this.dataL[i] / 128.0) * 0.9; // Scale slightly
            const y = (v * this.height / 2) + (this.height / 2 - this.height / 2); // Center?
            // Wait, v=1 is center. data is 0-255. 128 is 0.
            // normal: (val / 128) - 1 => -1 to 1.
            const vNorm = (this.dataL[i] / 128.0) - 1.0;
            const yPos = (vNorm * this.height / 2) + (this.height / 2);

            if (i === 0) this.ctx.moveTo(x, yPos);
            else this.ctx.lineTo(x, yPos);
            x += sliceWidth;
        }
        this.ctx.stroke();

        // 2. Draw Foreground XY Scope (Teal)
        this.ctx.lineWidth = 2;
        this.ctx.strokeStyle = '#00d2ff';
        this.ctx.shadowBlur = 4;
        this.ctx.shadowColor = '#00d2ff';
        this.ctx.beginPath();

        const scale = 0.5;
        for (let i = 0; i < this.bufferLength; i += 2) {
            const vL = (this.dataL[i] / 128.0) - 1.0;
            const vR = (this.dataR[i] / 128.0) - 1.0;
            const xScope = (vL * scale * Math.min(this.width, this.height)) + (this.width / 2);
            const yScope = (vR * scale * Math.min(this.width, this.height)) + (this.height / 2);
            if (i === 0) this.ctx.moveTo(xScope, yScope); else this.ctx.lineTo(xScope, yScope);
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
        this.setupVirtualKeyboard();
        this.setupControls();
    }

    setupKeyboard() {
        window.addEventListener('keydown', (e) => {
            if (e.repeat) return;
            const key = e.key.toLowerCase();

            // Octave Shortcuts
            if (key === 'z') this.changeOctave(-1);
            if (key === 'x') this.changeOctave(1);

            if (this.keyboardMap[key]) {
                const button = document.querySelector(`[data-key="${key}"]`);
                if (button) button.classList.add('active');
                this.audioEngine.startNote(key, this.keyboardMap[key]);
            }
        });
        window.addEventListener('keyup', (e) => {
            const key = e.key.toLowerCase();
            if (this.keyboardMap[key]) {
                const button = document.querySelector(`[data-key="${key}"]`);
                if (button) button.classList.remove('active');
                this.audioEngine.stopNote(key);
            }
        });
    }

    changeOctave(delta) {
        const val = this.audioEngine.setOctave(delta);
        const disp = document.getElementById('oct-disp');
        if (disp) {
            const sign = val >= 0 ? '+' : '';
            disp.innerText = sign + val;
        }
    }

    setupVirtualKeyboard() {
        const kbContainer = document.getElementById('virtual-keyboard');
        const keysContainer = document.getElementById('keys-container');
        const toggle = document.getElementById('mobile-toggle');

        toggle.addEventListener('click', () => {
            kbContainer.classList.toggle('active');
            toggle.classList.toggle('active');
        });

        // Octave Buttons
        document.getElementById('oct-down').addEventListener('click', () => this.changeOctave(-1));
        document.getElementById('oct-up').addEventListener('click', () => this.changeOctave(1));

        const notes = [
            { key: 'a', note: 'C4', type: 'white' },
            { key: 'w', note: 'C#4', type: 'black' },
            { key: 's', note: 'D4', type: 'white' },
            { key: 'e', note: 'D#4', type: 'black' },
            { key: 'd', note: 'E4', type: 'white' },
            { key: 'f', note: 'F4', type: 'white' },
            { key: 't', note: 'F#4', type: 'black' },
            { key: 'g', note: 'G4', type: 'white' },
            { key: 'y', note: 'G#4', type: 'black' },
            { key: 'h', note: 'A4', type: 'white' },
            { key: 'u', note: 'A#4', type: 'black' },
            { key: 'j', note: 'B4', type: 'white' },
            { key: 'k', note: 'C5', type: 'white' },
        ];
        notes.forEach(n => {
            const btn = document.createElement('div');
            btn.className = `key ${n.type}`;
            btn.dataset.key = n.key;
            const start = (e) => {
                e.preventDefault();
                btn.classList.add('active');
                this.audioEngine.startNote(n.key, this.keyboardMap[n.key]);
            };
            const stop = (e) => {
                e.preventDefault();
                btn.classList.remove('active');
                this.audioEngine.stopNote(n.key);
            };
            btn.addEventListener('mousedown', start);
            btn.addEventListener('mouseup', stop);
            btn.addEventListener('mouseleave', stop);
            btn.addEventListener('touchstart', start);
            btn.addEventListener('touchend', stop);
            keysContainer.appendChild(btn);
        });
    }

    setupMatrixUI() {
        const row = document.getElementById('matrix-row-active');
        const nameDisplay = document.getElementById('mod-target-name');

        // Handle drag on cells
        const cells = row.querySelectorAll('.matrix-cell');
        cells.forEach(cell => {
            let ry = 0;
            let startVal = 0;
            let dragging = false;
            const source = cell.dataset.source;
            const valDisplay = cell.querySelector('.matrix-val');
            const posBar = cell.querySelector('.matrix-bar-pos');
            const negBar = cell.querySelector('.matrix-bar-neg');

            cell.addEventListener('mousedown', (e) => {
                if (!this.activeTarget) return;
                dragging = true;
                ry = e.clientY;
                // Get current value from engine
                const mods = this.audioEngine.modulations[this.activeTarget] || {};
                startVal = mods[source] || 0;
                document.body.style.cursor = 'ns-resize';
            });

            window.addEventListener('mousemove', (e) => {
                if (!dragging) return;
                const dy = ry - e.clientY;
                let newVal = startVal + dy; // Sensitivity 1:1 pixel
                newVal = Math.max(-100, Math.min(100, newVal));

                // Update Engine
                this.audioEngine.setModulation(this.activeTarget, source, newVal);

                // Update UI Local
                valDisplay.innerText = Math.round(newVal);
                if (newVal >= 0) {
                    posBar.style.height = newVal + '%';
                    negBar.style.height = '0%';
                } else {
                    posBar.style.height = '0%';
                    negBar.style.height = Math.abs(newVal) + '%';
                }
            });

            window.addEventListener('mouseup', () => {
                if (dragging) {
                    dragging = false;
                    document.body.style.cursor = 'default';
                }
            });
        });
    }

    selectTarget(id, label) {
        this.activeTarget = id;
        document.getElementById('mod-target-name').innerText = label;

        // Update UI to show current mod depths
        const mods = this.audioEngine.modulations[id] || { lfo1: 0, lfo2: 0, env1: 0, env2: 0 };
        const cells = document.querySelectorAll('.matrix-cell');
        cells.forEach(cell => {
            const source = cell.dataset.source;
            const val = mods[source] || 0;
            const valDisplay = cell.querySelector('.matrix-val');
            const posBar = cell.querySelector('.matrix-bar-pos');
            const negBar = cell.querySelector('.matrix-bar-neg');

            valDisplay.innerText = Math.round(val);
            if (val >= 0) {
                posBar.style.height = val + '%';
                negBar.style.height = '0%';
            } else {
                posBar.style.height = '0%';
                negBar.style.height = Math.abs(val) + '%';
            }
        });
    }

    setupControls() {
        // Init Knobs
        // Global
        // LFO Controls
        new RotaryKnob('lfo1-rate-k', 'Rate', 0.1, 20, 0.1, 1, (v) => this.audioEngine.lfo1.setRate(v));
        document.getElementById('lfo1-wave').addEventListener('change', (e) => this.audioEngine.lfo1.setWave(e.target.value));

        new RotaryKnob('lfo2-rate-k', 'Rate', 0.1, 20, 0.1, 0.5, (v) => this.audioEngine.lfo2.setRate(v));
        document.getElementById('lfo2-wave').addEventListener('change', (e) => this.audioEngine.lfo2.setWave(e.target.value));

        // Mod Matrix UI Logic
        this.activeTarget = null;
        this.setupMatrixUI();

        // Init Knobs with Selection Logic
        const createSelectableKnob = (id, label, min, max, step, init, cb, map) => {
            const k = new RotaryKnob(id, label, min, max, step, init, cb, map);
            // Hook into click to select
            const el = document.getElementById(id);
            el.addEventListener('mousedown', () => this.selectTarget(id, label));
            el.addEventListener('touchstart', () => this.selectTarget(id, label));
            return k;
        };

        // Global
        createSelectableKnob('volume-k', 'Volume', 0, 1, 0.01, 0.7, (v) => this.audioEngine.setGlobalParam('volume', v));
        createSelectableKnob('spread-k', 'Spread', 0, 1, 0.001, 0, (v) => {
            const spreadVal = v * v * 100;
            this.audioEngine.setGlobalParam('spread', spreadVal);
        }, (v) => Math.round(v * v * 100));
        createSelectableKnob('saturation-k', 'Sat', 0, 1, 0.01, 0, (v) => this.audioEngine.setGlobalParam('saturation', v));

        // Amp Env
        createSelectableKnob('attack-k', 'A', 0.01, 2, 0.01, 0.05, (v) => this.audioEngine.setGlobalParam('attack', v));
        createSelectableKnob('decay-k', 'D', 0.1, 2, 0.01, 0.3, (v) => this.audioEngine.setGlobalParam('decay', v));
        createSelectableKnob('sustain-k', 'S', 0, 1, 0.01, 0.7, (v) => this.audioEngine.setGlobalParam('sustain', v));
        createSelectableKnob('release-k', 'R', 0.1, 5, 0.01, 1.0, (v) => this.audioEngine.setGlobalParam('release', v));

        // Filter
        createSelectableKnob('f-cutoff-k', 'Cutoff', 0.0, 1.0, 0.001, 0.8, (v) => this.audioEngine.setFilterParam('cutoff', v));
        createSelectableKnob('f-res-k', 'Res', 0, 20, 0.1, 0, (v) => this.audioEngine.setFilterParam('res', v));
        // Removed f-drive-k binding
        createSelectableKnob('f-env-amt-k', 'Env', 0, 10000, 100, 0, (v) => this.audioEngine.setFilterParam('envAmt', v));

        // Filter Env
        createSelectableKnob('f-attack-k', 'A', 0.01, 2, 0.01, 0.05, (v) => this.audioEngine.setFilterParam('attack', v));
        createSelectableKnob('f-decay-k', 'D', 0.1, 2, 0.01, 0.3, (v) => this.audioEngine.setFilterParam('decay', v));
        createSelectableKnob('f-sustain-k', 'S', 0, 1, 0.01, 0.7, (v) => this.audioEngine.setFilterParam('sustain', v));
        createSelectableKnob('f-release-k', 'R', 0.1, 5, 0.01, 1.0, (v) => this.audioEngine.setFilterParam('release', v));

        // Operators
        ['A', 'B', 'C', 'D'].forEach(op => {
            // Wave Select
            const sel = document.getElementById(`op${op}-wave`);
            sel.addEventListener('change', (e) => this.audioEngine.setOpParam(op, 'wave', e.target.value));

            // Knobs
            createSelectableKnob(`op${op}-coarse-k`, 'Coarse', 0.5, 24, 0.5, 1, (v) => this.audioEngine.setOpParam(op, 'coarse', v));
            createSelectableKnob(`op${op}-fine-k`, 'Fine', -1000, 1000, 10, 0, (v) => this.audioEngine.setOpParam(op, 'fine', v));
            if (op !== 'A') { // A has no level control
                createSelectableKnob(`op${op}-level-k`, 'Level', 0, 1, 0.01, op === 'B' ? 0.5 : 0, (v) => this.audioEngine.setOpParam(op, 'level', v));
            }
        });

        // Start
        const overlay = document.getElementById('start-overlay');
        overlay.addEventListener('click', () => {
            if (this.audioEngine.ctx.state === 'suspended') this.audioEngine.ctx.resume();
            overlay.style.opacity = '0';
            setTimeout(() => { overlay.style.display = 'none'; }, 500);
        });
    }
}

// Init
window.addEventListener('DOMContentLoaded', () => {
    const engine = new AudioEngine();
    // Pass engine to visualizer
    const visualizer = new Visualizer(document.getElementById('oscilloscope'), engine.analyserL, engine.analyserR, engine);
    const inputs = new InputManager(engine);
});
