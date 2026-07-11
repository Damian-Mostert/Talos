// memory.js — memory cortex
// Memories are nodes with salience, emotion, and associative links.
// Recall works by pattern overlap, not key lookup.
// Salience decays over time. High-dopamine encodings are stronger.
// Frequently recalled memories consolidate (strengthen). Weak ones prune.
//
// Memory types:
//   episodic   — tied to a specific conversation turn, decay fast (time-bound events)
//   semantic   — general knowledge and facts, decay slowly (consolidated understanding)
//   procedural — learned interaction patterns, decay very slowly (habits)

const DECAY_RATE        = 0.0002;
const CONSOLIDATE_BOOST = 0.15;
const PRUNE_THRESHOLD   = 0.05;
const MAX_MEMORIES      = 500;

// Episodic memories decay faster — they're time-bound events, not general knowledge
const EPISODIC_DECAY_MULT   = 1.8;
// Semantic memories are more stable — consolidated understanding
const SEMANTIC_DECAY_MULT   = 0.6;
// Procedural memories are the most stable — learned patterns of interaction
const PROCEDURAL_DECAY_MULT = 0.3;

function decayMult(type) {
    if (type === 'episodic')   return EPISODIC_DECAY_MULT;
    if (type === 'procedural') return PROCEDURAL_DECAY_MULT;
    return SEMANTIC_DECAY_MULT;
}

export class MemoryCortex {
    // genome is optional — falls back to module constants when not provided.
    constructor(genome = null) {
        this.nodes   = [];
        this._nextId = 0;
        this.genome  = genome;
    }

    // Genome-aware accessors — use live values when genome is present.
    _decayRate()  { return this.genome ? this.genome.get('memory_decay_rate')        : DECAY_RATE;        }
    _boost()      { return this.genome ? this.genome.get('memory_consolidate_boost') : CONSOLIDATE_BOOST; }
    _pruneThresh(){ return this.genome ? this.genome.get('memory_prune_threshold')   : PRUNE_THRESHOLD;   }

    // ── Encode a new memory ───────────────────────────────────────────────────
    // type:   'episodic' | 'semantic' | 'procedural'
    // turnId: conversation turn number — episodic only, ties memory to a moment
    encode(content, entities = [], emotion = 'neutral', salience = 0.5, dopamine = 0, type = 'semantic', turnId = null) {
        if (!content || content.length < 2) return;

        const boost    = this._boost();
        const existing = this._findSimilar(entities, content);
        if (existing) {
            existing.salience   = Math.min(1, existing.salience + boost);
            existing.accessed   = Date.now();
            existing.accessCount++;
            if (content.length > existing.content.length) existing.content = content;
            return existing;
        }

        const effectiveSalience = Math.min(1, salience + Math.max(0, dopamine) * 0.2);

        const node = {
            id:          this._nextId++,
            content,
            entities:    entities.filter(e => typeof e === 'string').map(e => e.toLowerCase()).filter(Boolean),
            emotion,
            salience:    effectiveSalience,
            dopamine,
            timestamp:   Date.now(),
            accessed:    Date.now(),
            accessCount: 0,
            type,
            turnId:      type === 'episodic' ? turnId : null,
        };
        this.nodes.push(node);

        if (this.nodes.length > MAX_MEMORIES) this._prune();

        return node;
    }

    // ── Recall by association ─────────────────────────────────────────────────
    // context: 'conversation' | 'background' | 'introspect'
    // Episodic memories surface more during conversation.
    // Semantic memories surface more during background thinking.
    // Procedural memories surface more during introspection.
    recall(entities = [], emotion = 'neutral', topN = 8, context = 'conversation') {
        const now        = Date.now();
        const query      = entities.map(e => e.toLowerCase());
        const decayRate  = this._decayRate();
        const boost      = this._boost();
        const pruneThresh = this._pruneThresh();

        const scored = this.nodes
            .map(node => {
                const age     = now - node.accessed;
                const decayed = node.salience * Math.exp(-decayRate * decayMult(node.type) * age);

                const overlap     = query.filter(e =>
                    node.entities.some(ne => ne.includes(e) || e.includes(ne))
                ).length;
                const entityScore = query.length > 0 ? overlap / query.length : 0;

                const emotionScore = node.emotion === emotion && emotion !== 'neutral' ? 0.3 : 0;

                const recency = Math.max(0, 1 - age / 600000) * 0.2;

                const typeBias =
                    context === 'conversation' && node.type === 'episodic'   ?  0.2  :
                    context === 'background'   && node.type === 'semantic'   ?  0.2  :
                    context === 'introspect'   && node.type === 'procedural' ?  0.15 : 0;

                const score = decayed * 0.4 + entityScore * 0.35 + emotionScore + recency + typeBias;
                return { node, score, decayed };
            })
            .filter(({ score, decayed }) => score > 0.05 && decayed > pruneThresh)
            .sort((a, b) => b.score - a.score)
            .slice(0, topN);

        for (const { node } of scored) {
            node.salience   = Math.min(1, node.salience + boost * 0.5);
            node.accessed   = now;
            node.accessCount++;
        }

        return scored.map(({ node }) => node);
    }

    // ── Recall biased by neural reafference ─────────────────────────────────
    // neuralIndices: top active association neuron indices from brain.reafference()
    // These are used as an additional scoring signal — memories whose encoding
    // pattern overlaps with the current firing pattern surface preferentially.
    // This is what makes the neural simulation actually drive cognition.
    recallByReafference(neuralIndices = [], entities = [], emotion = 'neutral', topN = 8, context = 'conversation') {
        if (neuralIndices.length === 0) return this.recall(entities, emotion, topN, context);

        const now        = Date.now();
        const query      = entities.filter(e => typeof e === 'string').map(e => e.toLowerCase());
        const indexSet   = new Set(neuralIndices);
        const decayRate  = this._decayRate();
        const boost      = this._boost();
        const pruneThresh = this._pruneThresh();

        const scored = this.nodes
            .map(node => {
                const age     = now - node.accessed;
                const decayed = node.salience * Math.exp(-decayRate * decayMult(node.type) * age);

                const overlap     = query.filter(e =>
                    node.entities.some(ne => ne.includes(e) || e.includes(ne))
                ).length;
                const entityScore = query.length > 0 ? overlap / query.length : 0;

                const emotionScore = node.emotion === emotion && emotion !== 'neutral' ? 0.3 : 0;
                const recency      = Math.max(0, 1 - age / 600000) * 0.2;

                const typeBias =
                    context === 'conversation' && node.type === 'episodic'   ?  0.2  :
                    context === 'background'   && node.type === 'semantic'   ?  0.2  :
                    context === 'introspect'   && node.type === 'procedural' ?  0.15 : 0;

                const neuralHit = indexSet.has(node.id % 600000) ? 0.25 : 0;

                const score = decayed * 0.35 + entityScore * 0.3 + emotionScore + recency + typeBias + neuralHit;
                return { node, score, decayed };
            })
            .filter(({ score, decayed }) => score > 0.05 && decayed > pruneThresh)
            .sort((a, b) => b.score - a.score)
            .slice(0, topN);

        for (const { node } of scored) {
            node.salience    = Math.min(1, node.salience + boost * 0.5);
            node.accessed    = now;
            node.accessCount++;
        }

        return scored.map(({ node }) => node);
    }
    recallFact(keyword) {
        const kw  = keyword.toLowerCase();
        const now = Date.now();
        return this.nodes
            .filter(n => n.entities.some(e => e.includes(kw) || kw.includes(e)) ||
                         n.content.toLowerCase().includes(kw))
            .sort((a, b) => {
                const aScore = Math.exp(-DECAY_RATE * decayMult(a.type) * (now - a.accessed)) * a.salience;
                const bScore = Math.exp(-DECAY_RATE * decayMult(b.type) * (now - b.accessed)) * b.salience;
                return bScore - aScore;
            })
            .slice(0, 3);
    }

    // ── Format memories for LLM context ──────────────────────────────────────
    format(memories) {
        if (!memories || memories.length === 0) return '(nothing relevant recalled)';
        return memories
            .map(m => {
                const tag = m.type === 'episodic'
                    ? `episodic turn:${m.turnId ?? '?'}`
                    : m.type === 'procedural' ? 'procedural' : 'semantic';
                return `[${tag}, ${m.emotion}, salience ${m.salience.toFixed(2)}] ${m.content}`;
            })
            .join('\n');
    }

    // ── Decay all memories (call periodically) ────────────────────────────────
    decay() {
        const now       = Date.now();
        const decayRate = this._decayRate();
        for (const node of this.nodes) {
            const age = now - node.accessed;
            node.salience = node.salience * Math.exp(-decayRate * decayMult(node.type) * age);
        }
        this._prune();
    }

    // ── Internal ──────────────────────────────────────────────────────────────
    _findSimilar(entities, content) {
        const query        = entities.filter(e => typeof e === 'string').map(e => e.toLowerCase());
        const contentWords = new Set(content.toLowerCase().split(/\s+/).filter(w => w.length > 4));
        for (const node of this.nodes) {
            const entityMatch  = query.length > 1 &&
                query.filter(e => node.entities.includes(e)).length >= Math.ceil(query.length * 0.7);
            const contentMatch = [...contentWords].filter(w => node.content.toLowerCase().includes(w)).length >= 5;
            if (entityMatch && contentMatch) return node;
        }
        return null;
    }

    _prune() {
        const now         = Date.now();
        const decayRate   = this._decayRate();
        const pruneThresh = this._pruneThresh();
        this.nodes = this.nodes
            .map(n => ({ ...n, _decayed: n.salience * Math.exp(-decayRate * decayMult(n.type) * (now - n.accessed)) }))
            .filter(n => n._decayed > pruneThresh)
            .sort((a, b) => b._decayed - a._decayed)
            .slice(0, MAX_MEMORIES)
            .map(({ _decayed, ...n }) => n);
    }

    get size() { return this.nodes.length; }
}
