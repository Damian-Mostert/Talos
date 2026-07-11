// genome.js — parameter genome
// Single source of truth for all tunable personality/plasticity parameters.
// Neural physics (REFRACTORY_MS, MAX_WEIGHT, etc.) are NOT here — those are substrate.
// These are the parameters the homeostasis system is allowed to adjust.

const PARAMS = {
    // ── Metacognition ─────────────────────────────────────────────────────────
    metacognition_lr:         { value: 0.05,    min: 0.01,   max: 0.15,   step: 0.005  },
    emotion_cue:              { value: 0.5,     min: 0.1,    max: 1.0,    step: 0.02   },
    novelty_cue:              { value: 0.3,     min: 0.1,    max: 1.0,    step: 0.02   },
    arousal_cue:              { value: 0.4,     min: 0.1,    max: 1.0,    step: 0.02   },
    drive_cue:                { value: 0.3,     min: 0.1,    max: 1.0,    step: 0.02   },

    // ── Salience / attention ──────────────────────────────────────────────────
    salience_emotion_bonus:   { value: 0.2,     min: 0.05,   max: 0.5,    step: 0.01   },
    salience_entity_weight:   { value: 0.06,    min: 0.02,   max: 0.15,   step: 0.005  },
    ne_interrupt_threshold:   { value: 0.75,    min: 0.5,    max: 0.95,   step: 0.02   },

    // ── Memory ────────────────────────────────────────────────────────────────
    memory_decay_rate:        { value: 0.0002,  min: 0.0001, max: 0.001,  step: 0.00005 },
    memory_consolidate_boost: { value: 0.15,    min: 0.05,   max: 0.4,    step: 0.01   },
    memory_prune_threshold:   { value: 0.05,    min: 0.01,   max: 0.15,   step: 0.005  },
};

export class Genome {
    constructor() {
        // Deep copy so mutations don't touch PARAMS defaults
        this._params = {};
        for (const [k, v] of Object.entries(PARAMS)) {
            this._params[k] = { ...v };
        }
    }

    get(key) {
        return this._params[key]?.value ?? null;
    }

    // Set a value, clamped to the parameter's allowed range.
    set(key, val) {
        const p = this._params[key];
        if (!p) return false;
        p.value = Math.max(p.min, Math.min(p.max, val));
        return true;
    }

    // Returns the parameter definition (value + bounds + step).
    meta(key) {
        return this._params[key] ? { ...this._params[key] } : null;
    }

    // Plain object snapshot of all current values — used for revert and logging.
    snapshot() {
        const out = {};
        for (const [k, v] of Object.entries(this._params)) out[k] = v.value;
        return out;
    }

    // Restore from a snapshot object (e.g. after a failed trial).
    restore(snap) {
        for (const [k, v] of Object.entries(snap)) this.set(k, v);
    }

    // All parameter keys.
    keys() {
        return Object.keys(this._params);
    }
}
