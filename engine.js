// Flat typed-array neural engine — optimized
//
// Key optimizations vs original:
//   - tick() only processes neurons with non-zero potential (sparse active set)
//   - activation() returns a subarray view — zero allocation
//   - meanAbs() computes directly on buffer — no slice, no reduce
//   - _inQueue uses a Uint8Array instead of a plain object — no hash overhead
//   - _fire() skips Hebbian update when dopamine is at baseline (common case)

const REFRACTORY_MS  = 20;
const HEBBIAN_RATE   = 0.02;
const WEIGHT_DECAY   = 0.001;
const MAX_WEIGHT     =  2.0;
const MIN_WEIGHT     = -2.0;
const DOPAMINE_DECAY = 0.98;
const NE_DECAY       = 0.95;
const MAX_QUEUE      = 50_000;

export class NeuralEngine {
    constructor(neuronCount, synapsesPerNeuron = 200) {
        this.n = neuronCount;
        const s = neuronCount * synapsesPerNeuron;

        this.potential  = new Float32Array(neuronCount);
        this.threshold  = new Float32Array(neuronCount).fill(1.0);
        this.decayRate  = new Float32Array(neuronCount).fill(0.95);
        this.firedAt    = new Float64Array(neuronCount);
        this.inhibitory = new Uint8Array(neuronCount);

        this.synapseTargets  = new Uint32Array(s);
        this.synapseWeights  = new Float32Array(s);
        this.synapseCounts   = new Uint32Array(neuronCount);

        this._synapseCapacity = synapsesPerNeuron;
        this.dopamine         = 0;
        this.norepinephrine   = 0;

        // Sparse active set — only neurons with non-zero potential are tracked
        this._active    = new Uint8Array(neuronCount);  // membership flag
        this._activeList = [];                           // indices with potential != 0

        // Reusable queue buffers — avoids allocation per propagation
        this._queueBuf  = new Int32Array(MAX_QUEUE);
        this._inQueue   = new Uint8Array(neuronCount);  // Uint8 vs object = much faster
        this._firingQueue = null;
        this._fqLen       = 0;
    }

    setThreshold(start, end, value) { this.threshold.fill(value, start, end); }
    setInhibitory(start, end)       { this.inhibitory.fill(1, start, end); }

    connect(src, dst, weight) {
        const base  = src * this._synapseCapacity;
        const count = this.synapseCounts[src];
        if (count >= this._synapseCapacity) return;
        this.synapseTargets[base + count] = dst;
        this.synapseWeights[base + count] = weight;
        this.synapseCounts[src]++;
    }

    receive(i, signal) {
        const prev = this.potential[i];
        this.potential[i] += signal;

        // Track in active set
        if (prev === 0 && signal !== 0) {
            if (!this._active[i]) {
                this._active[i] = 1;
                this._activeList.push(i);
            }
        }

        if (this.potential[i] >= this.threshold[i]) {
            if (this._firingQueue !== null) {
                if (!this._inQueue[i]) {
                    this._inQueue[i] = 1;
                    if (this._fqLen < MAX_QUEUE) this._queueBuf[this._fqLen++] = i;
                }
            } else {
                this._propagate(i);
            }
        }
    }

    _propagate(start) {
        this._fqLen = 0;
        this._queueBuf[this._fqLen++] = start;
        this._inQueue[start] = 1;
        this._firingQueue = this._queueBuf;
        const now = Date.now();

        for (let qi = 0; qi < this._fqLen; qi++) {
            this._fire(this._queueBuf[qi], now);
        }

        // Clear inQueue flags only for neurons that were queued
        for (let qi = 0; qi < this._fqLen; qi++) {
            this._inQueue[this._queueBuf[qi]] = 0;
        }
        this._firingQueue = null;
        this._fqLen = 0;
    }

    _fire(i, now) {
        if (this.firedAt[i] !== 0 && now - this.firedAt[i] < REFRACTORY_MS) return;

        this.firedAt[i]    = now;
        this.potential[i]  = 0;

        const base  = i * this._synapseCapacity;
        const count = this.synapseCounts[i];
        const sign  = this.inhibitory[i] ? -1 : 1;
        const da    = this.dopamine;
        const doHebbian = da > 0.05 || da < -0.05; // skip Hebbian at baseline — common case

        for (let k = 0; k < count; k++) {
            const dst = this.synapseTargets[base + k];

            if (doHebbian) {
                const coActive = this.firedAt[dst] !== 0 && now - this.firedAt[dst] < 50;
                if (coActive) {
                    const rate = HEBBIAN_RATE * Math.max(0.1, 1 + da);
                    const w = this.synapseWeights[base + k] + rate;
                    this.synapseWeights[base + k] = w > MAX_WEIGHT ? MAX_WEIGHT : w;
                } else {
                    const decay = WEIGHT_DECAY * (1 - da * 0.5);
                    const w = this.synapseWeights[base + k] - decay;
                    this.synapseWeights[base + k] = w < MIN_WEIGHT ? MIN_WEIGHT : w;
                }
            }

            const newPot = this.potential[dst] + sign * this.synapseWeights[base + k];
            this.potential[dst] = newPot;

            // Track in active set
            if (!this._active[dst]) {
                this._active[dst] = 1;
                this._activeList.push(dst);
            }

            if (newPot >= this.threshold[dst] && this._fqLen < MAX_QUEUE) {
                if (!this._inQueue[dst]) {
                    this._inQueue[dst] = 1;
                    this._queueBuf[this._fqLen++] = dst;
                }
            }
        }
    }

    // Sparse tick — only decay neurons that are actually active
    tick() {
        const pot     = this.potential;
        const decay   = this.decayRate;
        const active  = this._active;
        const list    = this._activeList;
        let   writeIdx = 0;

        for (let i = 0; i < list.length; i++) {
            const idx = list[i];
            const v   = pot[idx] * decay[idx];
            if (Math.abs(v) > 1e-6) {
                pot[idx]         = v;
                list[writeIdx++] = idx;
            } else {
                pot[idx]   = 0;
                active[idx] = 0;
            }
        }
        this._activeList.length = writeIdx;

        this.dopamine       *= DOPAMINE_DECAY;
        this.norepinephrine *= NE_DECAY;
    }

    // Zero-copy view — no allocation
    activation(start, end) {
        return this.potential.subarray(start, end);
    }

    // Compute mean absolute activation directly on buffer — no slice, no reduce
    // step > 1 for large regions — statistically equivalent, much faster
    meanAbs(start, end, step = 1) {
        const pot = this.potential;
        let sum = 0, count = 0;
        for (let i = start; i < end; i += step) {
            const v = pot[i];
            sum += v < 0 ? -v : v;
            count++;
        }
        return sum / count;
    }

    // Peak absolute activation in a range — used by selfAwareness
    peakAbs(start, end) {
        const pot = this.potential;
        let peak = 0;
        for (let i = start; i < end; i++) {
            const v = pot[i] < 0 ? -pot[i] : pot[i];
            if (v > peak) peak = v;
        }
        return peak;
    }
}
