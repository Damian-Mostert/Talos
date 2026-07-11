// working-memory.js — dorsolateral prefrontal cortex analog
// Holds what the mind is actively attending to right now.
// Capacity-limited (7±2), fast decay, rehearsal keeps items alive.
// This is NOT long-term memory — it's the current contents of attention.

const CAPACITY     = 7;
const DECAY_MS     = 30000;  // item expires after 30s without rehearsal
const REHEARSE_BOOST = 10000; // rehearsal extends lifetime by 10s

export class WorkingMemory {
    constructor() {
        this.slots = []; // { content, entities, type, strength, expiresAt }
    }

    // ── Hold something in attention ───────────────────────────────────────────
    hold(content, entities = [], type = 'thought', strength = 1.0) {
        if (!content || content.length < 2) return;

        // If already held, rehearse it instead
        const existing = this.slots.find(s =>
            s.content === content ||
            (entities.length > 0 && s.entities.some(e => entities.includes(e)))
        );
        if (existing) {
            existing.strength  = Math.min(1, existing.strength + 0.2);
            existing.expiresAt = Date.now() + DECAY_MS;
            return;
        }

        const item = {
            content,
            entities: entities.filter(e => typeof e === 'string').map(e => e.toLowerCase()).filter(Boolean),
            type,     // 'input' | 'thought' | 'goal' | 'fact'
            strength,
            expiresAt: Date.now() + DECAY_MS,
        };

        this.slots.push(item);

        // Over capacity — drop the weakest item
        if (this.slots.length > CAPACITY) {
            this.slots.sort((a, b) => b.strength - a.strength);
            this.slots = this.slots.slice(0, CAPACITY);
        }
    }

    // ── Rehearse items matching entities — keeps them alive ──────────────────
    rehearse(entities = []) {
        const query = entities.filter(e => typeof e === 'string').map(e => e.toLowerCase());
        for (const slot of this.slots) {
            if (slot.entities.some(e => query.includes(e))) {
                slot.expiresAt = Date.now() + REHEARSE_BOOST;
                slot.strength  = Math.min(1, slot.strength + 0.1);
            }
        }
    }

    // ── Expire stale items ────────────────────────────────────────────────────
    tick() {
        const now = Date.now();
        this.slots = this.slots.filter(s => s.expiresAt > now);
    }

    // ── Get current contents, strongest first ────────────────────────────────
    read(topN = CAPACITY) {
        this.tick();
        return [...this.slots]
            .sort((a, b) => b.strength - a.strength)
            .slice(0, topN);
    }

    // ── Format for LLM prompt ─────────────────────────────────────────────────
    format() {
        const items = this.read();
        if (items.length === 0) return '(working memory empty)';
        return items.map(s => `[${s.type}] ${s.content}`).join('\n');
    }

    // ── Clear everything — e.g. after a salience interrupt ───────────────────
    flush() {
        this.slots = [];
    }

    get size() { return this.slots.length; }
}
