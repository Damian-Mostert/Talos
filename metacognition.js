// Metacognition — decision log + self-prediction with adaptive learning
// Predicts next state before each response, scores accuracy after,
// feeds error back as dopamine, and updates sensitivity weights so
// the predictor improves over time rather than staying static.

export class Metacognition {
    // genome is optional — falls back to hardcoded defaults if not provided.
    constructor(genome = null) {
        this.log    = [];
        this.MAX    = 20;
        this.genome = genome;

        // Sensitivity weights — live values. When genome is present these are
        // kept in sync with it; genome is the single source of truth.
        this.weights = {
            emotion_cue:   genome ? genome.get('emotion_cue')  : 0.5,
            novelty_cue:   genome ? genome.get('novelty_cue')  : 0.3,
            arousal_cue:   genome ? genome.get('arousal_cue')  : 0.4,
            drive_cue:     genome ? genome.get('drive_cue')    : 0.3,
        };
    }

    // Call BEFORE generating a response.
    predict(neuralState, parsed, reafStrength) {
        this._syncWeightsFromGenome();
        const { valence, arousal, drive, norepinephrine } = neuralState;

        // Confidence per dimension — higher weight = more confident prediction
        const emotionSignal  = parsed.emotion !== 'neutral' ? this.weights.emotion_cue : 0;
        const noveltySignal  = reafStrength > 0.4 ? this.weights.novelty_cue : 0;
        const arousalSignal  = this.weights.arousal_cue;
        const driveSignal    = this.weights.drive_cue;

        const prediction = {
            ne_delta:      parsed.emotion !== 'neutral' ? +(0.1 * this.weights.emotion_cue * 2).toFixed(3) : -0.05,
            valence_delta: parsed.emotion === 'happy'   ? +(0.1 * this.weights.emotion_cue * 2).toFixed(3)
                         : parsed.emotion === 'upset'   ? -(0.1 * this.weights.emotion_cue * 2).toFixed(3) : 0,
            response_type: this._predictResponseType(parsed, neuralState),
            // Confidence: average of active signal strengths, 0–1
            confidence:    +((emotionSignal + noveltySignal + arousalSignal + driveSignal) / 4).toFixed(2),
        };

        const record = {
            turn:           Date.now(),
            state_before:   { valence, arousal, drive, norepinephrine, reaf: reafStrength },
            parsed_intent:  parsed.intent,
            parsed_emotion: parsed.emotion,
            prediction,
            state_after:    null,
            actual:         null,
            accuracy:       null,
            error:          null,   // per-dimension error magnitudes
            weight_updates: null,   // what changed after this prediction
        };

        this.log.push(record);
        if (this.log.length > this.MAX) this.log.shift();
        return record;
    }

    // Call AFTER the response is generated.
    // Returns dopamine delta: positive = accurate, negative = surprised.
    observe(record, neuralStateAfter, responseText) {
        if (!record) return 0;

        const { valence, arousal, norepinephrine } = neuralStateAfter;
        const b = record.state_before;

        record.state_after = { valence, arousal, norepinephrine };
        record.actual = {
            ne_delta:      +(norepinephrine - b.norepinephrine).toFixed(3),
            valence_delta: +(valence - b.valence).toFixed(3),
            response_type: this._classifyResponse(responseText),
        };

        // Per-dimension error magnitudes (0 = perfect, 1 = maximally wrong)
        record.error = {
            ne:            +Math.min(1, Math.abs(record.actual.ne_delta      - record.prediction.ne_delta)      / 0.3).toFixed(2),
            valence:       +Math.min(1, Math.abs(record.actual.valence_delta - record.prediction.valence_delta) / 0.3).toFixed(2),
            response_type: record.actual.response_type !== record.prediction.response_type ? 1 : 0,
        };

        const scores = [1 - record.error.ne, 1 - record.error.valence, 1 - record.error.response_type];
        record.accuracy = +(scores.reduce((a, v) => a + v, 0) / scores.length).toFixed(3);

        // Update sensitivity weights based on what went wrong
        record.weight_updates = this._updateWeights(record);

        // Dopamine delta: accuracy 1.0 → +0.3, accuracy 0.0 → -0.3
        return (record.accuracy - 0.5) * 0.6;
    }

    // Adjust weights toward cues that would have predicted better.
    // Learning rate is read from genome when available — homeostasis can tune it.
    _updateWeights(record) {
        const LR      = this.genome ? this.genome.get('metacognition_lr') : 0.05;
        const updates = {};
        const { parsed_emotion, state_before } = record;

        if (parsed_emotion !== 'neutral' && record.error.valence > 0.4) {
            this.weights.emotion_cue = Math.min(1, this.weights.emotion_cue + LR);
            updates.emotion_cue = `+${LR} (valence miss)`;
        }

        if (state_before.reaf > 0.4 && record.error.response_type === 1) {
            this.weights.novelty_cue = Math.min(1, this.weights.novelty_cue + LR);
            updates.novelty_cue = `+${LR} (response_type miss with high reaf)`;
        }

        if (state_before.arousal > 0.4 && record.error.ne > 0.4) {
            this.weights.arousal_cue = Math.min(1, this.weights.arousal_cue + LR);
            updates.arousal_cue = `+${LR} (NE miss with high arousal)`;
        }

        if (record.accuracy > 0.7) {
            for (const k of Object.keys(this.weights)) {
                this.weights[k] = Math.max(0.1, this.weights[k] - LR * 0.3);
            }
            updates._decay = `-${(LR * 0.3).toFixed(3)} (accurate prediction)`;
        }

        // Keep genome in sync — genome is the source of truth for homeostasis
        if (this.genome) {
            for (const k of Object.keys(this.weights)) {
                if (this.genome.get(k) !== null) this.genome.set(k, this.weights[k]);
            }
        }

        return Object.keys(updates).length > 0 ? updates : null;
    }

    recentAccuracy() {
        const scored = this.log.filter(r => r.accuracy !== null);
        if (scored.length === 0) return null;
        return +(scored.reduce((a, r) => a + r.accuracy, 0) / scored.length).toFixed(3);
    }

    // Pull weights from genome before reading — homeostasis may have changed them
    _syncWeightsFromGenome() {
        if (!this.genome) return;
        for (const k of Object.keys(this.weights)) {
            const v = this.genome.get(k);
            if (v !== null) this.weights[k] = v;
        }
    }

    summary() {
        this._syncWeightsFromGenome();
        const last = this.log.filter(r => r.accuracy !== null).slice(-3);
        if (last.length === 0) return null;
        return {
            recent_accuracy: this.recentAccuracy(),
            weights: { ...this.weights },
            last_decisions: last.map(r => ({
                intent:     r.parsed_intent,
                predicted:  r.prediction.response_type,
                confidence: r.prediction.confidence,
                actual:     r.actual?.response_type,
                accuracy:   r.accuracy,
                error:      r.error,
            })),
        };
    }

    _predictResponseType(parsed, { arousal, drive }) {
        if (parsed.intent === 'question')  return 'answer';
        if (parsed.intent === 'teaching')  return 'integrate';
        if (parsed.intent === 'greeting')  return 'social';
        // Novelty + drive → explore; otherwise reflect
        if (arousal > 0.5 * (1 / this.weights.arousal_cue) && drive > 0.4 * (1 / this.weights.drive_cue)) return 'explore';
        return 'reflect';
    }

    _classifyResponse(text) {
        if (!text) return 'none';
        const t = text.toLowerCase();
        if (/\?/.test(t))                             return 'explore';
        if (/^(hey|hi|hello|good|thanks)/.test(t))   return 'social';
        if (/(because|therefore|means that)/.test(t)) return 'answer';
        if (/(i think|i feel|i notice)/.test(t))      return 'reflect';
        return 'integrate';
    }
}
