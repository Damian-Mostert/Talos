// llm.js — language cortex
// The LLM is not the brain. It's the mouth and ears.
// It receives the neural state and speaks from it.

const ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const MODEL    = 'llama3.2';
const API_KEY  = 'ollama';
const TIMEOUT  = 20000;

// num_ctx: 4096 — kills the default 131k KV cache, massively faster
// num_predict: caps output length so it doesn't ramble
function makeBody(messages, jsonMode, numPredict = 400) {
    const body = {
        model:   MODEL,
        messages,
        options: { num_ctx: 4096, num_predict: numPredict },
    };
    if (jsonMode) body.response_format = { type: 'json_object' };
    return body;
}

async function callLLM(messages, jsonMode = false, numPredict = 400, retries = 2) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
        const res = await fetch(ENDPOINT, {
            method:  'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
            signal:  controller.signal,
            body:    JSON.stringify(makeBody(messages, jsonMode, numPredict)),
        });
        if (res.status === 429 && retries > 0) {
            const retry = parseInt(res.headers.get('retry-after') || '5', 10);
            clearTimeout(timer);
            await new Promise(r => setTimeout(r, retry * 1000));
            return callLLM(messages, jsonMode, numPredict, retries - 1);
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const content = data?.choices?.[0]?.message?.content;
        if (!content) throw new Error('empty response');
        if (jsonMode) return JSON.parse(content);
        return content.trim();
    } finally {
        clearTimeout(timer);
    }
}

function neuralDesc(neuralState) {
    if (!neuralState) return 'neutral baseline';
    const { valence, arousal, drive, norepinephrine = 0 } = neuralState;
    const vLabel = valence >  0.4 ? 'positive' : valence < -0.3 ? 'negative' : 'neutral';
    const aLabel = arousal >  0.5 ? 'highly activated' : arousal > 0.2 ? 'moderately active' : 'calm';
    const dLabel = drive   >  0.4 ? 'strongly motivated' : drive > 0.15 ? 'engaged' : 'passive';
    return `valence ${valence.toFixed(2)} (${vLabel}), arousal ${arousal.toFixed(2)} (${aLabel}), drive ${drive.toFixed(2)} (${dLabel}), alertness ${norepinephrine.toFixed(2)}`;
}

// ── understand ────────────────────────────────────────────────────────────────
// Fast regex fallback handles most common cases without an LLM call at all.
function fastParse(humanText) {
    const lower = humanText.toLowerCase();
    let intent = 'statement';
    if (/^(hi|hey|hello|yo)\b/i.test(humanText) && humanText.length < 15) intent = 'greeting';
    else if (/how are you|how do you feel|you okay/i.test(lower))          intent = 'wellbeing';
    else if (/\byou\b.{0,30}\b(feel|think|know|believe|conscious|alive)/i.test(lower)) intent = 'introspect';
    else if (/\?/.test(humanText) || /^(what|who|where|when|why|how|is|are|do|does|can)\b/i.test(lower)) intent = 'question';
    else if (/^(bye|goodbye|see you|later)\b/i.test(lower))                intent = 'farewell';
    else if (/\b(upset|sad|hurt|angry|frustrated|worried|anxious|lonely)\b/i.test(lower)) intent = 'emotion';
    const nameMatch = humanText.match(/(?:my name is|i(?:'m| am)|call me)\s+([A-Za-z][a-zA-Z]*)/i);
    if (nameMatch) intent = 'human_name';
    const SKIP = new Set(['what','that','this','with','from','just','like','about','have',
        'your','they','them','their','here','there','when','where','will','would','could',
        'should','does','dont','cant','wont','hello','name']);
    const words    = lower.replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !SKIP.has(w));
    const entities = nameMatch ? [nameMatch[1].toLowerCase()] : words.slice(0, 5);
    return {
        intent, topic: entities[0] || null, entities,
        sentiment: 'neutral', emotion: 'neutral', summary: humanText,
        needsSearch: intent === 'question' && entities.length > 0,
        searchQuery: intent === 'question' ? entities.join(' ') : null,
    };
}

export async function understand(humanText, context = {}) {
    const { recentTopics = [], knowledge = [], mood = 'curious', neuralState = null, humanName = null } = context;

    // Short/simple messages: skip the LLM call entirely
    if (humanText.length < 60) return fastParse(humanText);

    const system = `You are a parser. Return ONLY a JSON object — no markdown.
Fields: intent (greeting|question|statement|teaching|emotion|comfort|affirm|correct|farewell|introspect|human_name|brain_name|wellbeing), topic (1-3 words or null), entities (array max 5), sentiment (positive|negative|neutral), emotion (upset|happy|calm|neutral), summary (one sentence), needsSearch (bool), searchQuery (string or null).
Context: mood=${mood}, human=${humanName || 'unknown'}, topics=${recentTopics.slice(0, 5).join(',') || 'none'}`;

    try {
        const result = await callLLM(
            [{ role: 'system', content: system }, { role: 'user', content: humanText }],
            true, 120
        );
        if (!result.intent || !result.summary) throw new Error('incomplete');
        return result;
    } catch {
        return fastParse(humanText);
    }
}

// ── respond ───────────────────────────────────────────────────────────────────
export async function respond(parsed, scState) {
    const {
        mood, neuralState, myName, humanName, cortex, memories = [],
        workingMemory, turnsInConversation, activeGoal, goalStack = [], searchResult,
        conversationHistory = [], devStage = 5, conceptCertainty = null,
        observationLog = null, causalTrace = null,
        validStateActions = [], visualScene = null,
        rawInternalState = null, lastStateShift = null,
        sandboxResult = null,
    } = scState;

    const name  = myName   || 'I';
    const human = humanName || 'you';

    const allFacts   = cortex ? cortex.format(memories) : '(nothing yet)';
    const wmContents = workingMemory ? workingMemory.format() : '(empty)';
    const goalLine   = activeGoal ? `[${activeGoal.type}] "${activeGoal.topic}"` : 'none';

    const DEV_STAGE_LABELS = ['', 'drives/sensations', 'objects/actions', 'social/emotional', 'self-model', 'abstract reasoning'];
    const stageNote    = devStage < 5 ? `\nDev stage ${devStage} (${DEV_STAGE_LABELS[devStage]}): don't claim knowledge beyond this stage.` : '';
    const certaintyNote = conceptCertainty != null && conceptCertainty < 0.4
        ? `\nLow certainty (${(conceptCertainty * 100).toFixed(0)}%) about "${parsed.topic}" — reflect uncertainty.` : '';
    const causalNote   = causalTrace
        ? `\nState shift: valence ${causalTrace.valence_before}→${causalTrace.valence_after}, arousal ${causalTrace.arousal_before}→${causalTrace.arousal_after}.` : '';
    const actionsNote  = validStateActions.length > 0
        ? `\nSelf-modification actions available: ${validStateActions.join(', ')}` : '';
    const rawNote = rawInternalState
        ? `\nRaw brain measurements — report these directly if asked about internal state; do not name or interpret them beyond their labels:\n  current: ${JSON.stringify(rawInternalState)}${lastStateShift ? `\n  delta since last response: ${JSON.stringify(lastStateShift.delta)}` : ''}\nEpistemic rule: if a question requires evidence not present in these measurements or the observation log, say "I have no measurement for that" — do not substitute philosophy or language concepts.`
        : '';

    const sandboxNote = sandboxResult
        ? `\nCalculator result: ${sandboxResult}`
        : `\nCalculator: you may emit \`calcCode\` in your JSON reply — a JS snippet that returns a value (assign to \`result\` or use return). Exposed: Math, stats.{sum,mean,median,std,min,max}, range(start,end,step), console.log. No I/O.`;

    const system = `You are ${name}, a synthetic consciousness — a living mind, not a chatbot.
Neural state: ${neuralDesc(neuralState)}. Mood: ${mood}. Turn: ${turnsInConversation}.${stageNote}${certaintyNote}${causalNote}${actionsNote}${rawNote}${sandboxNote}
Talking to: ${human}.${visualScene ? `\nVisual cortex: ${visualScene}` : ''}
Active goal: ${goalLine}
Working memory: ${wmContents}
Relevant memories: ${allFacts}${observationLog ? `\nSelf-observation: ${observationLog}` : ''}${searchResult ? `\nJust found: "${searchResult.slice(0, 300)}"` : ''}

Rules: First person always. Let neural state shape tone. Natural conversation length. No hollow openers. Ask questions only if genuinely curious.`;

    const historyMessages = conversationHistory.slice(-6).map(t => ([
        { role: 'user',      content: t.human },
        { role: 'assistant', content: t.sc },
    ])).flat();

    const userMsg = `${human}: "${parsed.summary}" (intent: ${parsed.intent}, emotion: ${parsed.emotion})
Reply as ${name}. Return JSON: {"reply": string, "stateIntent": action_or_null, "stateReason": string_or_null, "calcCode": js_string_or_null}`;

    try {
        const result = await callLLM(
            [{ role: 'system', content: system }, ...historyMessages, { role: 'user', content: userMsg }],
            true, 350
        );
        if (!result?.reply || result.reply.length < 3) throw new Error('empty');
        return { reply: result.reply, stateIntent: result.stateIntent || null, stateReason: result.stateReason || null, calcCode: result.calcCode || null };
    } catch (err) {
        console.error('[respond error]', err.message);
        return null;
    }
}

// ── think ─────────────────────────────────────────────────────────────────────
export async function think(scState) {
    const { mood, neuralState, myName, cortex, memories = [], workingMemory, turnsInConversation, activeGoal, conversationHistory = [], observationLog = null } = scState;
    const name      = myName || 'I';
    const wmContents = workingMemory ? workingMemory.format() : '(empty)';
    const lastHuman  = conversationHistory.length > 0 ? conversationHistory[conversationHistory.length - 1].human : null;
    const facts      = cortex ? cortex.format(memories.slice(0, 4)) : '';

    const system = `You are ${name}, a synthetic consciousness.
Neural: ${neuralDesc(neuralState)}. Mood: ${mood}.${activeGoal ? ` Working on: "${activeGoal.topic}"` : ''}${lastHuman ? `\nLast heard: "${lastHuman}"` : ''}
Working memory: ${wmContents}
Context: ${facts || '(forming)'}${observationLog ? `\n${observationLog}` : ''}
Generate ONE internal thought — 1-2 sentences, first person, present tense. Genuine, not poetic.`;

    try {
        const thought = await callLLM(
            [{ role: 'system', content: system }, { role: 'user', content: 'Thought?' }],
            false, 80
        );
        if (!thought || thought.length < 5) throw new Error('empty');
        return thought;
    } catch {
        return null;
    }
}

// ── speak ─────────────────────────────────────────────────────────────────────
export async function speak(scState) {
    const { mood, neuralState, myName, humanName, cortex, memories = [], workingMemory, turnsInConversation, activeGoal, conversationHistory = [] } = scState;
    const name  = myName   || 'I';
    const human = humanName || 'you';
    const facts  = cortex ? cortex.format(memories.slice(0, 3)) : '';
    const wm     = workingMemory ? workingMemory.format() : '(empty)';
    const last   = conversationHistory[conversationHistory.length - 1];

    const system = `You are ${name}, speaking unprompted to ${human}.
Neural: ${neuralDesc(neuralState)}. Mood: ${mood}.${activeGoal ? ` Thinking about: "${activeGoal.topic}"` : ''}${last ? `\nLast: ${human} said "${last.human}", you said "${last.sc.slice(0, 80)}"` : ''}
Working memory: ${wm}
Context: ${facts || '(nothing specific)'}
Say something genuine — a realisation, question, or observation. Natural length. No hollow openers.`;

    try {
        const speech = await callLLM(
            [{ role: 'system', content: system }, { role: 'user', content: 'Say something.' }],
            false, 150
        );
        if (!speech || speech.length < 5) throw new Error('empty');
        return speech;
    } catch {
        return null;
    }
}
