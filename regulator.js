// StateRegulator — internal state as an action space.
// The system can decide to modify its own state, predict the consequence,
// execute the change, and record what actually happened.
// This is the difference between describing a self and maintaining one.

const ACTIONS = {
    increase_drive:    { target: 'dopamine',       delta: +0.4, label: 'drive↑' },
    decrease_drive:    { target: 'dopamine',       delta: -0.3, label: 'drive↓' },
    increase_calm:     { target: 'norepinephrine', delta: -0.4, label: 'calm↑'  },
    increase_focus:    { target: 'norepinephrine', delta: +0.3, label: 'focus↑' },
    increase_valence:  { target: 'dopamine',       delta: +0.6, label: 'valence↑' },
    decrease_valence:  { target: 'dopamine',       delta: -0.5, label: 'valence↓' },
};

export class StateRegulator {
    constructor() {
        this.history = [];   // causal history of all state changes
        this.MAX     = 50;
    }

    // Execute a self-modification decision.
    // Returns a causal record — what was intended, what changed, and the outcome.
    act(actionName, brain, reason = null) {
        const action = ACTIONS[actionName];
        if (!action) return null;

        const before = brain.emotionalState();

        // Apply the delta to the appropriate neuromodulator
        if (action.target === 'dopamine') {
            brain.engine.dopamine = Math.max(-1, Math.min(3, brain.engine.dopamine + action.delta));
        } else if (action.target === 'norepinephrine') {
            brain.engine.norepinephrine = Math.max(0, Math.min(3, brain.engine.norepinephrine + action.delta));
        }

        // Let the change propagate
        for (let t = 0; t < 2; t++) brain.engine.tick();

        const after = brain.emotionalState();

        const record = {
            time:    Date.now(),
            action:  actionName,
            label:   action.label,
            reason,
            before:  { valence: +before.valence.toFixed(3), arousal: +before.arousal.toFixed(3), drive: +before.drive.toFixed(3) },
            after:   { valence: +after.valence.toFixed(3),  arousal: +after.arousal.toFixed(3),  drive: +after.drive.toFixed(3)  },
            delta:   {
                valence: +(after.valence - before.valence).toFixed(3),
                arousal: +(after.arousal - before.arousal).toFixed(3),
                drive:   +(after.drive   - before.drive).toFixed(3),
            },
            // Did the change move in the intended direction?
            effective: this._wasEffective(action, before, after),
        };

        this.history.push(record);
        if (this.history.length > this.MAX) this.history.shift();

        return record;
    }

    _wasEffective(action, before, after) {
        if (action.target === 'dopamine') {
            const expected = action.delta > 0 ? 'up' : 'down';
            const actual   = after.valence > before.valence ? 'up' : after.valence < before.valence ? 'down' : 'flat';
            return actual === expected;
        }
        if (action.target === 'norepinephrine') {
            const expected = action.delta > 0 ? 'up' : 'down';
            const actual   = after.arousal > before.arousal ? 'up' : after.arousal < before.arousal ? 'down' : 'flat';
            return actual === expected;
        }
        return false;
    }

    // Format recent history for LLM context — so it knows what it has tried
    format(n = 3) {
        return this.history.slice(-n).map(r => {
            const age = Math.round((Date.now() - r.time) / 1000);
            return `[${age}s ago] ${r.label} (${r.action}) → valence ${r.delta.valence > 0 ? '+' : ''}${r.delta.valence} arousal ${r.delta.arousal > 0 ? '+' : ''}${r.delta.arousal} [${r.effective ? 'effective' : 'weak'}]${r.reason ? ` reason: "${r.reason}"` : ''}`;
        }).join('\n') || '(no self-modifications yet)';
    }

    validActions() { return Object.keys(ACTIONS); }
}
