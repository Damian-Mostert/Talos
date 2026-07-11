import { NeuralEngine } from './engine.js';

const REGIONS = {
    sensory:      { size: 400_000,  inhibRatio: 0.20, threshold: 0.5 },
    visual:       { size: 100_000,  inhibRatio: 0.15, threshold: 0.4 },  // visual cortex
    association:  { size: 600_000,  inhibRatio: 0.20, threshold: 0.8 },
    hippocampus:  { size: 160_000,  inhibRatio: 0.15, threshold: 0.3 },
    temporal:     { size: 200_000,  inhibRatio: 0.10, threshold: 0.4 },  // memory consolidation
    prefrontal:   { size: 300_000,  inhibRatio: 0.10, threshold: 0.3 },
    motor:        { size: 240_000,  inhibRatio: 0.20, threshold: 0.9 },
    cerebellum:   { size: 300_000,  inhibRatio: 0.30, threshold: 0.7 },
};
// Total: 2,300,000 neurons

export class Brain {
    constructor() {
        this.layout = {};
        let offset = 0;
        for (const [name, cfg] of Object.entries(REGIONS)) {
            this.layout[name] = { start: offset, end: offset + cfg.size, ...cfg };
            offset += cfg.size;
        }
        this.totalNeurons = offset;

        console.log(`Allocating ${(this.totalNeurons / 1e6).toFixed(2)}M neurons...`);
        this.engine = new NeuralEngine(this.totalNeurons, 200);
        console.log('Allocated.');

        this._applyRegionProperties();
        this._wire();
        this._alive = false;

        this._baseline    = new Float32Array(REGIONS.association.size);
        this._baselineAlpha = 0.005;

        // Emotional state — updated by emotionalState() each cycle
        this._valence  = 0;   // -1 (negative) to +1 (positive)
        this._arousal  = 0;   // 0 (calm) to 1 (activated)
        this._drive    = 0;   // 0 (passive) to 1 (motivated)
    }

    _applyRegionProperties() {
        for (const [, r] of Object.entries(this.layout)) {
            this.engine.setThreshold(r.start, r.end, r.threshold);
            const inhibEnd = r.start + Math.floor(r.size * r.inhibRatio);
            this.engine.setInhibitory(r.start, inhibEnd);
        }
    }

    _wireRegions(srcName, dstName, density, weightRange = [0.1, 0.8]) {
        const src = this.layout[srcName];
        const dst = this.layout[dstName];
        const [wMin, wMax] = weightRange;
        const sampleSize = Math.floor(src.size * density);
        for (let k = 0; k < sampleSize; k++) {
            const i = src.start + Math.floor(Math.random() * src.size);
            const j = dst.start + Math.floor(Math.random() * dst.size);
            const w = wMin + Math.random() * (wMax - wMin);
            this.engine.connect(i, j, w);
        }
    }

    _wire() {
        console.log('Wiring regions...');
        this._wireRegions('visual',      'sensory',      0.6, [0.3, 0.8]);  // visual → sensory
        this._wireRegions('visual',      'association',  0.4, [0.3, 0.7]);  // visual → association
        this._wireRegions('sensory',     'association',  0.5);
        this._wireRegions('association', 'hippocampus',  0.8, [0.4, 0.9]);
        this._wireRegions('hippocampus', 'association',  0.8, [0.4, 0.9]);
        this._wireRegions('hippocampus', 'temporal',     0.9, [0.5, 1.0]);  // hipp → temporal: consolidation
        this._wireRegions('temporal',    'hippocampus',  0.6, [0.3, 0.8]);  // temporal → hipp: retrieval cue
        this._wireRegions('temporal',    'association',  0.5, [0.3, 0.7]);  // temporal → assoc: memory into thought
        this._wireRegions('association', 'motor',        0.3);
        this._wireRegions('association', 'prefrontal',   0.3);
        this._wireRegions('prefrontal',  'association',  0.2, [0.05, 0.3]);
        this._wireRegions('motor',       'cerebellum',   0.2);
        this._wireRegions('cerebellum',  'motor',        0.2);
        console.log('Wiring done.');
    }

    reward(strength = 1.0) {
        this.engine.dopamine = Math.min(this.engine.dopamine + strength, 3.0);
    }

    punish(strength = 1.0) {
        this.engine.dopamine = Math.max(this.engine.dopamine - strength, -1.0);
    }

    // Salience interrupt — norepinephrine spike on surprise or urgency.
    // NE raises alertness: tightens the signal-to-noise ratio by briefly
    // elevating thresholds so only the strongest signals propagate.
    startle(strength = 1.0) {
        this.engine.norepinephrine = Math.min(this.engine.norepinephrine + strength, 3.0);
        // NE transiently raises firing thresholds — filters out weak background noise
        const boost = strength * 0.1;
        const { sensory, association } = this.layout;
        for (let i = sensory.start; i < sensory.end; i += 5) {
            this.engine.threshold[i] = Math.min(this.engine.threshold[i] + boost, 2.0);
        }
        for (let i = association.start; i < association.end; i += 5) {
            this.engine.threshold[i] = Math.min(this.engine.threshold[i] + boost, 2.0);
        }
    }

    // ── Emotional state — reads actual region activations ─────────────────────
    // This is the ground truth mood. Consciousness reads this, not the other way around.
    //
    // valence  = dopamine level (positive/negative affect)
    // arousal  = mean absolute activation across sensory + association (how activated)
    // drive    = hippocampus activity (memory engagement = motivation to act)
    emotionalState() {
        const sensoryMean = this.engine.meanAbs(this.layout.sensory.start,    this.layout.sensory.end,    8);
        const assocMean   = this.engine.meanAbs(this.layout.association.start, this.layout.association.end, 8);
        const hippMean    = this.engine.meanAbs(this.layout.hippocampus.start, this.layout.hippocampus.end, 4);

        // Arousal: how much is firing overall, plus a tonic floor for baseline wakefulness
        const rawArousal = Math.tanh((sensoryMean + assocMean) * 10) + 0.15;

        // Drive: hippocampus engagement — memory being activated = something matters
        const rawDrive = Math.tanh(hippMean * 15);

        // Valence: dopamine is the direct signal — tonic floor keeps resting mood slightly positive
        const rawValence = Math.tanh(this.engine.dopamine + 0.2);

        // Smooth with previous state (emotional inertia — moods don't flip instantly)
        // Arousal uses faster smoothing so real activation registers promptly
        this._valence = this._valence * 0.7 + rawValence * 0.3;
        this._arousal = this._arousal * 0.6 + rawArousal * 0.4;
        this._drive   = this._drive   * 0.8 + rawDrive   * 0.2;

        return {
            valence:        this._valence,
            arousal:        this._arousal,
            drive:          this._drive,
            norepinephrine: Math.tanh(this.engine.norepinephrine),
        };
    }

    novelty() {
        const { start, end } = this.layout.association;
        const pot   = this.engine.potential;
        const base  = this._baseline;
        const alpha = this._baselineAlpha;
        let diff = 0, count = 0;
        for (let i = start; i < end; i += 4) {
            const idx = i - start;
            const v   = pot[i];
            const d   = v - base[idx];
            diff += d < 0 ? -d : d;
            base[idx] = base[idx] * (1 - alpha) + v * alpha;
            count++;
        }
        return Math.tanh(diff / count);
    }

    // Receive visual input directly into the visual cortex region
    perceiveVisual(input) {
        const { start, size } = this.layout.visual;
        if (input instanceof Uint32Array) {
            for (let i = 0; i < input.length; i++) {
                this.engine.receive(start + (input[i] % size), 1.5);
            }
        }
    }

    perceive(input) {
        const { start } = this.layout.sensory;
        if (input instanceof Uint32Array) {
            for (let i = 0; i < input.length; i++) {
                this.engine.receive(start + input[i], 1.2);
            }
        } else {
            const len = Math.min(input.length, this.layout.sensory.size);
            for (let i = 0; i < len; i++) {
                if (input[i] > 0) this.engine.receive(start + i, input[i]);
            }
        }
    }

    // Encode a concept directly into hippocampus — this is how learning sticks
    encode(input, strength = 1.0) {
        const { start, size } = this.layout.hippocampus;
        if (input instanceof Uint32Array) {
            for (let i = 0; i < input.length; i++) {
                this.engine.receive(start + (input[i] % size), strength);
            }
        } else {
            const len = Math.min(input.length, size);
            for (let i = 0; i < len; i++) {
                if (input[i] > 0) this.engine.receive(start + i, input[i] * strength);
            }
        }
    }

    // Consolidate into temporal cortex — long-term memory storage
    consolidate(input, strength = 1.0) {
        const { start, size } = this.layout.temporal;
        if (input instanceof Uint32Array) {
            for (let i = 0; i < input.length; i++) {
                this.engine.receive(start + (input[i] % size), strength);
            }
        } else {
            const len = Math.min(input.length, size);
            for (let i = 0; i < len; i++) {
                if (input[i] > 0) this.engine.receive(start + i, input[i] * strength);
            }
        }
    }

    thought() {
        const { start, end } = this.layout.association;
        return this.engine.activation(start, end);
    }

    reafference(topN = 20) {
        const { start, end } = this.layout.association;
        const pot    = this.engine.potential;
        const topIdx = new Int32Array(topN).fill(-1);
        const topVal = new Float32Array(topN);
        let minVal = 0, minPos = 0, filled = 0;

        for (let i = start; i < end; i++) {
            const v = pot[i] < 0 ? -pot[i] : pot[i];
            if (v === 0) continue;
            if (filled < topN) {
                topIdx[filled] = i - start;
                topVal[filled] = v;
                filled++;
                if (filled === topN) {
                    minVal = topVal[0]; minPos = 0;
                    for (let k = 1; k < topN; k++) if (topVal[k] < minVal) { minVal = topVal[k]; minPos = k; }
                }
            } else if (v > minVal) {
                topIdx[minPos] = i - start;
                topVal[minPos] = v;
                minVal = topVal[0]; minPos = 0;
                for (let k = 1; k < topN; k++) if (topVal[k] < minVal) { minVal = topVal[k]; minPos = k; }
            }
        }
        let sum = 0;
        const indices = [];
        for (let k = 0; k < filled; k++) { sum += topVal[k]; indices.push(topIdx[k]); }
        return { indices, strength: Math.tanh((filled > 0 ? sum / filled : 0) * 5) };
    }

    // Raw region measurements — opaque values the LLM must report, not interpret.
    // Named Ω1–Ω5 so the LLM has no prior associations to project onto them.
    readInternalState() {
        const { association, prefrontal, hippocampus, sensory, motor } = this.layout;
        return {
            Ω1: +this.engine.meanAbs(association.start, association.end, 8).toFixed(4),
            Ω2: +this.engine.meanAbs(prefrontal.start,  prefrontal.end,  4).toFixed(4),
            Ω3: +this.engine.meanAbs(hippocampus.start, hippocampus.end, 4).toFixed(4),
            Ω4: +this.engine.meanAbs(sensory.start,     sensory.end,     8).toFixed(4),
            Ω5: +this.engine.meanAbs(motor.start,       motor.end,       4).toFixed(4),
            Ω_da: +this.engine.dopamine.toFixed(3),
            Ω_ne: +this.engine.norepinephrine.toFixed(3),
        };
    }

    selfAwareness() {
        const assoc  = this.layout.association;
        const pfc    = this.layout.prefrontal;
        const signal = this.engine.peakAbs(assoc.start, assoc.end) * 2.0;

        for (let i = pfc.start; i < pfc.end; i += 10) this.engine.receive(i, signal);

        const pfcLevel = Math.tanh(this.engine.meanAbs(pfc.start, pfc.end) * 10);

        if (pfcLevel > 0.1) {
            const mul = 1 - pfcLevel * 0.15;
            const pot = this.engine.potential;
            for (let i = this.layout.sensory.start; i < this.layout.sensory.end; i += 20) pot[i] *= mul;
            for (let i = assoc.start; i < assoc.end; i += 20) pot[i] *= mul;
        }

        return pfcLevel;
    }

    start(hz = 10) {
        if (this._alive) return;
        this._alive = true;
        this._pulse = setInterval(() => this.engine.tick(), 1000 / hz);
        console.log(`Brain alive at ${hz}hz`);
    }

    stop() {
        clearInterval(this._pulse);
        this._alive = false;
    }
}
