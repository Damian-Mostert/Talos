// snapshot.js — save/load trained brain weights for fast startup
// Only persists synapseWeights (learned connections) and firedAt (activity state)
// Everything else is deterministic from the Brain constructor

import fs from 'fs';

const SNAPSHOT_PATH = './brain.snapshot';
const GENOME_PATH   = './genome.json';

export function saveSnapshot(engine) {
    const weights = Buffer.from(engine.synapseWeights.buffer);
    const firedAt = Buffer.from(engine.firedAt.buffer);
    const header  = Buffer.alloc(16);
    header.writeUInt32LE(weights.length, 0);
    header.writeUInt32LE(firedAt.length, 4);
    fs.writeFileSync(SNAPSHOT_PATH, Buffer.concat([header, weights, firedAt]));
}

export function loadSnapshot(engine) {
    if (!fs.existsSync(SNAPSHOT_PATH)) return false;
    try {
        const buf     = fs.readFileSync(SNAPSHOT_PATH);
        const wLen    = buf.readUInt32LE(0);
        const fLen    = buf.readUInt32LE(4);
        const weights = buf.subarray(16, 16 + wLen);
        const firedAt = buf.subarray(16 + wLen, 16 + wLen + fLen);

        if (weights.length !== engine.synapseWeights.byteLength) {
            fs.unlinkSync(SNAPSHOT_PATH);
            return false;
        }

        new Float32Array(weights.buffer, weights.byteOffset, weights.length / 4)
            .forEach((v, i) => { engine.synapseWeights[i] = v; });

        if (firedAt.length === engine.firedAt.byteLength) {
            new Float64Array(firedAt.buffer, firedAt.byteOffset, firedAt.length / 8)
                .forEach((v, i) => { engine.firedAt[i] = v; });
        }

        return true;
    } catch {
        return false;
    }
}

// Persist the genome so tuned parameters survive restarts.
export function saveGenome(genome) {
    try {
        fs.writeFileSync(GENOME_PATH, JSON.stringify(genome.snapshot(), null, 2));
    } catch {}
}

export function loadGenome(genome) {
    if (!fs.existsSync(GENOME_PATH)) return false;
    try {
        const data = JSON.parse(fs.readFileSync(GENOME_PATH, 'utf8'));
        genome.restore(data);
        return true;
    } catch {
        return false;
    }
}
