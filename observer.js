// SelfObserver — continuous internal state monitoring
// Runs on an interval independent of conversation turns.
// Watches the full state vector, detects meaningful drift, writes a rolling log.
// Each observation includes a causal trace: which variables moved valence/arousal
// and by how much — so the LLM translates evidence, not guesses.

export class SelfObserver {
    constructor() {
        this.log   = [];   // rolling observations
        this.MAX   = 40;
        this._last = null; // previous observation for drift calculation

        // Raw dopamine/NE values from last tick — set externally by consciousness
        // so the causal trace can reference them directly
        this.lastDopamine       = 0;
        this.lastNorepinephrine = 0;
        this.lastPredictionError = null;  // dopamine delta from metacognition
        this.lastInputSalience   = 0;
        this.lastReafStrength    = 0;
    }

    // Call this on an interval.
    // brain = Brain instance, meta = Metacognition instance, mood = string
    observe(brain, meta, mood) {
        const ns  = brain.emotionalState();
        const pfc = brain.selfAwareness();
        const acc = meta.recentAccuracy();

        const entry = {
            t:       Date.now(),
            valence: ns.valence,
            arousal: ns.arousal,
            drive:   ns.drive,
            ne:      ns.norepinephrine,
            pfc,
            mood,
            drift:        null,
            causal_trace: null,
            notable:      null,
            prediction_accuracy: acc,
        };

        if (this._last) {
            const dv = entry.valence - this._last.valence;
            const da = entry.arousal - this._last.arousal;
            const dd = entry.drive   - this._last.drive;
            entry.drift = {
                valence: +dv.toFixed(3),
                arousal: +da.toFixed(3),
                drive:   +dd.toFixed(3),
            };

            // ── Causal trace ────────────────────────────────────────────────
            // For each variable that changed meaningfully, record what caused it.
            // Confidence = how much of the observed delta is explained by known causes.
            if (Math.abs(dv) > 0.01 || Math.abs(da) > 0.01) {
                entry.causal_trace = this._buildCausalTrace(dv, da, dd, entry);
            }

            // Notable events
            const notes = [];
            if (Math.abs(dv) > 0.08) notes.push(`valence ${dv > 0 ? 'rising' : 'falling'} (${dv > 0 ? '+' : ''}${dv.toFixed(2)})`);
            if (Math.abs(da) > 0.08) notes.push(`arousal ${da > 0 ? 'rising' : 'falling'} (${da > 0 ? '+' : ''}${da.toFixed(2)})`);
            if (entry.pfc > 0.7)     notes.push('high PFC — deliberate mode');
            if (entry.ne  > 0.5)     notes.push('elevated alertness');
            if (acc !== null && acc < 0.4) notes.push(`self-model accuracy low (${(acc * 100).toFixed(0)}%)`);
            if (notes.length > 0) entry.notable = notes.join('; ');
        }

        this._last = entry;
        this.log.push(entry);
        if (this.log.length > this.MAX) this.log.shift();

        return entry;
    }

    // Build a causal trace for the observed state change.
    // Each contributor has: variable, change, effect on valence/arousal.
    _buildCausalTrace(dv, da, dd, entry) {
        const contributors = [];
        let explained = 0;

        // Dopamine is the primary valence driver
        const dopDelta = this.lastDopamine - (this._last?.raw_dopamine ?? this.lastDopamine);
        if (Math.abs(dopDelta) > 0.05) {
            const effect = dopDelta > 0 ? 'positive' : 'negative';
            contributors.push({ variable: 'dopamine', change: +dopDelta.toFixed(3), effect });
            explained += Math.abs(dopDelta) * 0.6;
        }

        // Prediction error — did the self-model being wrong/right shift valence?
        if (this.lastPredictionError !== null && Math.abs(this.lastPredictionError) > 0.02) {
            const effect = this.lastPredictionError > 0 ? 'positive' : 'negative';
            contributors.push({ variable: 'prediction_error', change: +this.lastPredictionError.toFixed(3), effect });
            explained += Math.abs(this.lastPredictionError) * 0.4;
        }

        // NE spike — drives arousal
        const neDelta = entry.ne - (this._last?.ne ?? entry.ne);
        if (Math.abs(neDelta) > 0.05) {
            contributors.push({ variable: 'norepinephrine', change: +neDelta.toFixed(3), effect: 'arousal' });
            explained += Math.abs(neDelta) * 0.5;
        }

        // Input salience — high salience inputs spike both NE and dopamine
        if (this.lastInputSalience > 0.5) {
            contributors.push({ variable: 'input_salience', change: +this.lastInputSalience.toFixed(3), effect: 'arousal' });
            explained += this.lastInputSalience * 0.3;
        }

        // Reafference strength — strong neural resonance with input boosts drive
        if (this.lastReafStrength > 0.3) {
            contributors.push({ variable: 'reafference', change: +this.lastReafStrength.toFixed(3), effect: 'drive' });
            explained += this.lastReafStrength * 0.2;
        }

        // Confidence: how much of the total observed delta is accounted for
        const totalDelta = Math.abs(dv) + Math.abs(da) + Math.abs(dd);
        const confidence = totalDelta > 0 ? Math.min(1, explained / totalDelta) : 0;

        return {
            valence_before: +this._last.valence.toFixed(3),
            valence_after:  +entry.valence.toFixed(3),
            arousal_before: +this._last.arousal.toFixed(3),
            arousal_after:  +entry.arousal.toFixed(3),
            contributors,
            confidence:     +confidence.toFixed(2),
        };
    }

    // Returns the last N observations as a compact string for LLM context
    format(n = 5) {
        const recent = this.log.slice(-n);
        if (recent.length === 0) return '(no observations yet)';

        return recent.map(e => {
            const age  = Math.round((Date.now() - e.t) / 1000);
            const ago  = age < 60 ? `${age}s ago` : `${Math.round(age / 60)}m ago`;
            const acc  = e.prediction_accuracy !== null ? ` self-model=${(e.prediction_accuracy * 100).toFixed(0)}%` : '';
            const note = e.notable ? ` <- ${e.notable}` : '';
            let causal = '';
            if (e.causal_trace?.contributors?.length > 0) {
                const parts = e.causal_trace.contributors.map(c => `${c.variable}:${c.change > 0 ? '+' : ''}${c.change}(${c.effect})`).join(' ');
                causal = ` [causes: ${parts} confidence=${e.causal_trace.confidence}]`;
            }
            return `[${ago}] mood=${e.mood} valence=${e.valence.toFixed(2)} arousal=${e.arousal.toFixed(2)} drive=${e.drive.toFixed(2)} pfc=${e.pfc.toFixed(2)}${acc}${causal}${note}`;
        }).join('\n');
    }

    // Returns the most recent causal trace as a structured object — for direct introspection
    latestCausalTrace() {
        for (let i = this.log.length - 1; i >= 0; i--) {
            if (this.log[i].causal_trace) return this.log[i].causal_trace;
        }
        return null;
    }

    current() { return this._last || null; }

    trend(n = 5) {
        const window = this.log.slice(-n);
        if (window.length < 2) return null;
        const first = window[0];
        const last  = window[window.length - 1];
        return {
            valence: +(last.valence - first.valence).toFixed(3),
            arousal: +(last.arousal - first.arousal).toFixed(3),
            drive:   +(last.drive   - first.drive).toFixed(3),
            over_n:  window.length,
        };
    }
}
