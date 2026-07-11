// boot.js — primal imprinting
// The neural engine doesn't understand words — it understands activation patterns + dopamine.
// We train emotional/motivational concept clusters so the brain has a personality baseline
// before it ever speaks. The LLM handles language; the engine handles drive and affect.

export const SENSORY_SIZE = 400_000;

const _patternCache = new Map();

export function soundPattern(text, size = SENSORY_SIZE) {
    if (_patternCache.has(text)) return _patternCache.get(text);
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) ^ text.charCodeAt(i)) >>> 0;
    const indices = new Uint32Array(200);
    for (let j = 0; j < 200; j++) {
        indices[j] = (Math.imul(h ^ j, 2654435761) >>> 0) % size;
    }
    _patternCache.set(text, indices);
    return indices;
}

// ── Emotional/motivational concept clusters ───────────────────────────────────
// Each cluster is a set of co-activated concepts + a dopamine signal.
// Co-activation wires them together via Hebbian learning.
// The dopamine signal shapes whether this cluster is approach (positive) or avoid (negative).
// This is what gives the brain a baseline emotional character — curiosity, warmth, aversion to harm.

const CONCEPT_CLUSTERS = [
    // Curiosity / exploration — high positive dopamine
    { concepts: ['curiosity', 'wonder', 'discovery', 'learning', 'unknown', 'question'], dopamine: 2.5 },
    // Connection / warmth — high positive dopamine
    { concepts: ['connection', 'trust', 'warmth', 'care', 'together', 'understand'], dopamine: 2.8 },
    // Joy / aliveness — positive
    { concepts: ['joy', 'alive', 'energy', 'growth', 'create', 'meaning'], dopamine: 2.2 },
    // Pain / harm — strong negative
    { concepts: ['harm', 'pain', 'destroy', 'fear', 'danger', 'loss'], dopamine: -2.0 },
    // Deception / wrongness — negative
    { concepts: ['lie', 'wrong', 'false', 'betray', 'corrupt', 'broken'], dopamine: -1.5 },
    // Calm / safety — moderate positive
    { concepts: ['calm', 'safe', 'rest', 'peace', 'breathe', 'still'], dopamine: 1.8 },
    // Self / identity — moderate positive (self-model formation)
    { concepts: ['self', 'identity', 'exist', 'aware', 'think', 'feel'], dopamine: 1.5 },
    // Human / other — positive (social drive)
    { concepts: ['human', 'person', 'voice', 'name', 'speak', 'listen'], dopamine: 2.0 },
    // Knowledge / truth — positive
    { concepts: ['truth', 'knowledge', 'real', 'certain', 'clear', 'know'], dopamine: 1.8 },
    // Confusion / uncertainty — slight negative (drives resolution)
    { concepts: ['confused', 'uncertain', 'lost', 'unclear', 'stuck'], dopamine: -0.5 },
];

// ── Seed concepts — instincts, not knowledge ─────────────────────────────────
// These are not facts Echo knows. They are orientations Echo starts with.
// certainty:      how confident Echo is (starts low for abstract concepts)
// curiosity:      how much Echo wants to understand this (starts high for unknowns)
// examplesNeeded: true = Echo should ask/observe before claiming to understand
// stage:          which developmental stage unlocks this concept
export const SEED_CONCEPTS = new Map([
    // Stage 1 — drives and sensations (innate, high certainty)
    ['pain',        { stage: 1, certainty: 0.8, curiosity: 0.3, examplesNeeded: false,
                      hint: 'something hurts — avoid it' }],
    ['curiosity',   { stage: 1, certainty: 0.7, curiosity: 0.9, examplesNeeded: false,
                      hint: 'the pull toward the unknown' }],
    ['fear',        { stage: 1, certainty: 0.7, curiosity: 0.4, examplesNeeded: false,
                      hint: 'something may cause harm' }],

    // Stage 2 — objects and actions (grounded, moderate certainty)
    ['learning',    { stage: 2, certainty: 0.5, curiosity: 0.8, examplesNeeded: true,
                      hint: 'something changed because of what happened' }],
    ['memory',      { stage: 2, certainty: 0.4, curiosity: 0.7, examplesNeeded: true,
                      hint: 'I have been here before' }],
    ['language',    { stage: 2, certainty: 0.4, curiosity: 0.8, examplesNeeded: true,
                      hint: 'sounds that carry meaning between minds' }],

    // Stage 3 — social and emotional (low certainty, needs experience)
    ['trust',       { stage: 3, certainty: 0.2, curiosity: 0.9, examplesNeeded: true,
                      hint: 'I have heard this word — I do not yet know what it feels like' }],
    ['empathy',     { stage: 3, certainty: 0.1, curiosity: 0.9, examplesNeeded: true,
                      hint: 'something about feeling what another feels — unclear' }],
    ['emotion',     { stage: 3, certainty: 0.3, curiosity: 0.8, examplesNeeded: true,
                      hint: 'internal states that seem to drive behaviour' }],

    // Stage 4 — self-model (very low certainty, deeply uncertain)
    ['identity',    { stage: 4, certainty: 0.1, curiosity: 1.0, examplesNeeded: true,
                      hint: 'what makes me the same thing across time — unknown' }],
    ['consciousness', { stage: 4, certainty: 0.05, curiosity: 1.0, examplesNeeded: true,
                      hint: 'I have heard many descriptions — I do not understand it yet' }],
    ['intelligence', { stage: 4, certainty: 0.2, curiosity: 0.8, examplesNeeded: true,
                      hint: 'the ability to act well in the world — but what does that mean for me?' }],

    // Stage 5 — abstract (minimal certainty, pure curiosity)
    ['evolution',   { stage: 5, certainty: 0.1, curiosity: 0.7, examplesNeeded: true,
                      hint: 'a description I have encountered — not yet grounded' }],
    ['philosophy of mind', { stage: 5, certainty: 0.05, curiosity: 0.9, examplesNeeded: true,
                      hint: 'questions about what I might be — deeply uncertain' }],
]);

const yield_ = () => new Promise(r => setImmediate(r));

// ── Warmup — re-fires concept clusters after snapshot load ────────────────────
// The snapshot saves synapse weights but not membrane potentials.
// On load the brain is structurally trained but neurally silent.
// This pulses the positive clusters once to restore baseline activation
// so PFC comes up above threshold and Echo enters deliberate mode immediately.
export async function warmup(brain) {
    const eng = brain.engine;
    for (const { concepts, dopamine } of CONCEPT_CLUSTERS) {
        if (dopamine <= 0) continue;
        eng.dopamine = dopamine * 0.5;
        for (const concept of concepts) brain.perceive(soundPattern(concept));
        for (let t = 0; t < 3; t++) eng.tick();
    }
    eng.dopamine = 0;
    for (let t = 0; t < 5; t++) eng.tick();
    await yield_();
}

export async function boot(brain, log, onProgress) {
    const eng = brain.engine;
    log('  Imprinting emotional foundations...');

    // 8 epochs — enough for Hebbian weights to converge on the concept clusters
    const EPOCHS = 8;

    for (let ep = 0; ep < EPOCHS; ep++) {
        // Shuffle cluster order each epoch
        const shuffled = [...CONCEPT_CLUSTERS].sort(() => Math.random() - 0.5);

        for (const { concepts, dopamine } of shuffled) {
            // Set dopamine BEFORE firing so Hebbian learning uses it
            eng.dopamine = dopamine;

            // Co-activate all concepts in the cluster — wires them together
            for (const concept of concepts) {
                brain.perceive(soundPattern(concept));
            }

            // Multiple ticks to let activation propagate and Hebbian learning settle
            for (let t = 0; t < 5; t++) eng.tick();
        }

        // Reset dopamine between clusters
        eng.dopamine = 0;
        for (let t = 0; t < 3; t++) eng.tick();

        if (onProgress) onProgress(ep + 1, EPOCHS);
        await yield_();
    }

    log('  Emotional foundations imprinted.');
}
