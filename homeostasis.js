// homeostasis.js — adaptive parameter tuning
// Watches performance metrics over a rolling window.
// Every EVAL_INTERVAL turns it asks: "is something underperforming?"
// If yes, it proposes a single small parameter mutation, runs a TRIAL_WINDOW trial,
// then accepts or reverts based on whether the target metric actually improved.
// Every decision — accept or revert — is written to the ledger.
// The ledger is passed to the LLM so the AI can reason about its own history.

const EVAL_INTERVAL  = 20;  // turns between evaluations
const TRIAL_WINDOW   = 10;  // turns to run a trial before scoring
const MIN_IMPROVEMENT = 0.02; // minimum metric delta to accept a change
const MAX_DEGRADATION = 0.05; // maximum allowed degradation in any other metric

// Target ranges for each metric — homeostasis, not maximisation.
// The system tries to stay inside these bands, not push to extremes.
const METRIC_TARGETS = {
    prediction_accuracy:  { min: 0.55, max: 1.0  },
    interrupt_rate:       { min: 0.0,  max: 0.3  },
    memory_usefulness:    { min: 0.3,  max: 1.0  },
    goal_resolution_rate: { min: 0.4,  max: 1.0  },
};

// Which parameters to try when a metric is out of range.
// Each entry: { metric, condition, param, direction }
// direction: +1 = increase, -1 = decrease
const MUTATION_MAP = [
    { metric: 'prediction_accuracy',  condition: 'low',  param: 'emotion_cue',              direction:  1 },
    { metric: 'prediction_accuracy',  condition: 'low',  param: 'novelty_cue',              direction:  1 },
    { metric: 'prediction_accuracy',  condition: 'low',  param: 'arousal_cue',              direction:  1 },
    { metric: 'prediction_accuracy',  condition: 'low',  param: 'drive_cue',                direction:  1 },
    { metric: 'interrupt_rate',       condition: 'high', param: 'ne_interrupt_threshold',   direction:  1 },
    { metric: 'interrupt_rate',       condition: 'high', param: 'salience_emotion_bonus',   direction: -1 },
    { metric: 'interrupt_rate',       condition: 'low',  param: 'ne_interrupt_threshold',   direction: -1 },
    { metric: 'memory_usefulness',    condition: 'low',  param: 'memory_consolidate_boost', direction:  1 },
    { metric: 'memory_usefulness',    condition: 'low',  param: 'memory_decay_rate',        direction: -1 },
    { metric: 'goal_resolution_rate', condition: 'low',  param: 'salience_entity_weight',   direction:  1 },
];

export class Homeostasis {
    constructor(genome, meta, cortex) {
        this.genome  = genome;
        this.meta    = meta;
        this.cortex  = cortex;

        this.ledger       = [];   // full history of proposed changes
        this.MAX_LEDGER   = 50;

        this._window      = [];   // per-turn metric samples
        this._activeTrial = null; // { entry, snapshot, startTurn } or null
        this._turnCount   = 0;
    }

    // ── Called every turn from consciousness._respondToHuman ─────────────────
    // metrics: { interrupted: bool, recalledSalience: number, goalPushed: bool, goalResolved: bool }
    recordTurn(metrics) {
        this._turnCount++;
        this._window.push({
            turn:          this._turnCount,
            interrupted:   metrics.interrupted   ?? false,
            recalledSal:   metrics.recalledSalience ?? 0,
            goalPushed:    metrics.goalPushed    ?? false,
            goalResolved:  metrics.goalResolved  ?? false,
        });
        // Keep window bounded — we only need the last EVAL_INTERVAL * 2 samples
        if (this._window.length > EVAL_INTERVAL * 2) this._window.shift();
    }

    // ── Called every EVAL_INTERVAL turns ─────────────────────────────────────
    // Returns a log string for ui.brainThinks, or null if nothing happened.
    evaluate() {
        // If a trial is running, score it first
        if (this._activeTrial) {
            const trialAge = this._turnCount - this._activeTrial.startTurn;
            if (trialAge >= TRIAL_WINDOW) {
                return this._scoreTrial();
            }
            return null; // trial still running
        }

        const current = this._collectMetrics();
        const problem  = this._worstMetric(current);
        if (!problem) return null; // everything in range

        const candidate = this._pickMutation(problem.metric, problem.condition);
        if (!candidate) return null;

        return this._applyMutation(candidate, current);
    }

    // ── Ledger summary for LLM context ───────────────────────────────────────
    ledgerSummary(n = 3) {
        const recent = this.ledger.slice(-n);
        if (recent.length === 0) return null;
        return recent.map(e => {
            const result = e.accepted === null
                ? 'pending'
                : e.accepted
                    ? `accepted (${e.target_metric} ${e.metrics_before[e.target_metric]?.toFixed(3)}→${e.metrics_after?.[e.target_metric]?.toFixed(3)})`
                    : `reverted (no improvement)`;
            return `[turn ${e.turn}] ${e.parameter} ${e.before.toFixed(4)}→${e.after.toFixed(4)} | ${e.hypothesis} | ${result}`;
        }).join('\n');
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _collectMetrics() {
        const window = this._window.slice(-EVAL_INTERVAL);
        if (window.length === 0) return null;

        const interrupted   = window.filter(t => t.interrupted).length / window.length;
        const recalledSal   = window.reduce((s, t) => s + t.recalledSal, 0) / window.length;
        const pushed        = window.filter(t => t.goalPushed).length;
        const resolved      = window.filter(t => t.goalResolved).length;
        const goalRes       = pushed > 0 ? resolved / pushed : 1.0;

        return {
            prediction_accuracy:  this.meta.recentAccuracy() ?? 0.5,
            interrupt_rate:       interrupted,
            memory_usefulness:    recalledSal,
            goal_resolution_rate: goalRes,
        };
    }

    // Returns { metric, condition } for the metric furthest outside its target range, or null.
    _worstMetric(metrics) {
        if (!metrics) return null;
        let worst = null;
        let worstDist = 0;

        for (const [key, target] of Object.entries(METRIC_TARGETS)) {
            const val = metrics[key];
            if (val == null) continue;
            let dist = 0;
            let condition = null;
            if (val < target.min) { dist = target.min - val; condition = 'low'; }
            if (val > target.max) { dist = val - target.max; condition = 'high'; }
            if (condition && dist > worstDist) {
                worstDist = dist;
                worst = { metric: key, condition, value: val };
            }
        }
        return worst;
    }

    // Pick a mutation candidate for the given metric/condition.
    // Prefers parameters that haven't been tried recently, and uses ledger gradient hints.
    _pickMutation(metric, condition) {
        const candidates = MUTATION_MAP.filter(m => m.metric === metric && m.condition === condition);
        if (candidates.length === 0) return null;

        // Score each candidate — prefer ones with positive gradient history
        const scored = candidates.map(c => {
            const hint  = this._gradientHint(c.param, c.direction);
            const recency = this._recentlyTried(c.param) ? -1 : 0;
            return { ...c, score: hint + recency };
        });

        scored.sort((a, b) => b.score - a.score);
        return scored[0];
    }

    // Apply a mutation: save snapshot, update genome, create ledger entry.
    _applyMutation(candidate, metricsBefore) {
        const { param, direction } = candidate;
        const p      = this.genome.meta(param);
        const before = p.value;
        const after  = Math.max(p.min, Math.min(p.max, before + direction * p.step));

        if (Math.abs(after - before) < 1e-9) return null; // already at boundary

        const entry = {
            turn:           this._turnCount,
            parameter:      param,
            before,
            after,
            direction,
            target_metric:  candidate.metric,
            hypothesis:     `${candidate.condition} ${candidate.metric} → ${direction > 0 ? 'increase' : 'decrease'} ${param}`,
            metrics_before: metricsBefore,
            metrics_after:  null,
            accepted:       null,
        };

        this.genome.set(param, after);
        this._activeTrial = {
            entry,
            snapshot: this.genome.snapshot(),  // snapshot AFTER mutation (for revert we need before)
            snapshotBefore: { ...this.genome.snapshot(), [param]: before },
            startTurn: this._turnCount,
        };
        // Also push to ledger immediately so it's visible as pending
        this.ledger.push(entry);
        if (this.ledger.length > this.MAX_LEDGER) this.ledger.shift();

        return `[genome] trial started: ${param} ${before.toFixed(4)}→${after.toFixed(4)} (${entry.hypothesis})`;
    }

    // Score the active trial — accept or revert.
    _scoreTrial() {
        const { entry, snapshotBefore } = this._activeTrial;
        const metricsAfter = this._collectMetrics();
        entry.metrics_after = metricsAfter;

        const targetBefore = entry.metrics_before[entry.target_metric] ?? 0;
        const targetAfter  = metricsAfter?.[entry.target_metric] ?? 0;
        const improvement  = targetAfter - targetBefore;

        // Check no other metric degraded badly
        let collateral = false;
        if (metricsAfter) {
            for (const [k, v] of Object.entries(metricsAfter)) {
                if (k === entry.target_metric) continue;
                const before = entry.metrics_before[k] ?? v;
                if (before - v > MAX_DEGRADATION) { collateral = true; break; }
            }
        }

        const accepted = improvement >= MIN_IMPROVEMENT && !collateral;
        entry.accepted = accepted;

        if (!accepted) {
            // Revert genome to pre-mutation values
            this.genome.restore(snapshotBefore);
        }

        this._activeTrial = null;

        const dir    = improvement >= 0 ? '+' : '';
        const result = accepted ? 'accepted' : 'reverted';
        return `[genome] trial ${result}: ${entry.parameter} | ${entry.target_metric} ${dir}${improvement.toFixed(3)} | collateral=${collateral}`;
    }

    // Check ledger history for this parameter+direction — returns +1 if it helped before,
    // -1 if it hurt, 0 if unknown.
    _gradientHint(param, direction) {
        const history = this.ledger
            .filter(e => e.parameter === param && e.direction === direction && e.accepted !== null)
            .slice(-3);
        if (history.length === 0) return 0;
        const helped = history.filter(e => e.accepted).length;
        return helped > history.length / 2 ? 1 : -1;
    }

    // Returns true if this parameter was tried in the last EVAL_INTERVAL turns.
    _recentlyTried(param) {
        const cutoff = this._turnCount - EVAL_INTERVAL;
        return this.ledger.some(e => e.parameter === param && e.turn > cutoff);
    }
}
