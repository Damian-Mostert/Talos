import { soundPattern, SEED_CONCEPTS } from './boot.js';
import { search } from './search.js';
import { understand, respond, think, speak } from './llm.js';
import { saveSnapshot, saveGenome, loadGenome } from './snapshot.js';
import { MemoryCortex } from './memory.js';
import { WorkingMemory } from './working-memory.js';
import { Metacognition } from './metacognition.js';
import { SelfObserver } from './observer.js';
import { Genome } from './genome.js';
import { Homeostasis } from './homeostasis.js';
import { StateRegulator } from './regulator.js';
import { VisualCortex } from './vision.js';
import { runSandbox } from './sandbox.js';

export class Consciousness {
    constructor(brain, ui) {
        this.brain   = brain;
        this.ui      = ui;
        this.running = false;
        this.tickCount = 0;

        this.ticksSinceHuman = 999;
        this.lastSpokeTick   = 0;
        this.inputQueue      = [];

        this.thoughts = [];
        this.myName   = null;
        this.humanName = null;
        this.conversationHistory = [];

        this.mood = 'curious';
        this.neuralState = { valence: 0, arousal: 0, drive: 0 };

        this.devStage = 1;
        this.devStageProgress = 0;
        this.DEV_STAGE_THRESHOLDS = [0, 0, 5, 15, 30, 60];

        this.curiosity = [];

        // Genome first — everything else reads from it
        this.genome = new Genome();
        loadGenome(this.genome);

        this.cortex    = new MemoryCortex(this.genome);
        this.wm        = new WorkingMemory();
        this.meta      = new Metacognition(this.genome);
        this.observer  = new SelfObserver();
        this.homeostasis = new Homeostasis(this.genome, this.meta, this.cortex);
        this.regulator   = new StateRegulator();

        this._seedConceptsForStage(this.devStage);

        this.recentTopics = [];
        this.goalStack    = [];
        this.goalHistory  = [];

        this._bgResearching = false;
        this._thinkCooldown = 0;
        this._turnsInConversation = 0;
        this._decayInterval = null;

        this.visualCortex  = null;
        this.lastScene     = null;
        this.lastObjects   = [];
    }

    enableCamera() {
        this.visualCortex = new VisualCortex();
        this.visualCortex.start(this.brain, ({ scene, objects }) => {
            this.lastScene   = scene;
            this.lastObjects = objects;
            if (!scene || objects.length === 0) return;

            // Full learning pipeline — vision is a first-class sensory experience
            this._learnFromText(scene, objects, 'neutral', 0.6);

            // Encode into cortex as semantic memory with high salience
            this.cortex.encode(`I can see: ${scene}`, objects, 'neutral', 0.7, this.brain.engine.dopamine, 'semantic');

            // Load into working memory so Echo is actively attending to what it sees
            this.wm.hold(`I can see: ${scene}`, objects, 'visual', 0.8);

            // Each visible object gets Hebbian encoding + consolidation — same as hearing a word
            for (const obj of objects.slice(0, 6)) {
                this._learnConcept(obj, 0.5);
                if (!this.recentTopics.includes(obj)) this.recentTopics.unshift(obj);
                if (!this.curiosity.includes(obj))    this.curiosity.push(obj);
            }
            if (this.recentTopics.length > 20) this.recentTopics = this.recentTopics.slice(0, 20);
            if (this.curiosity.length > 40)    this.curiosity    = this.curiosity.slice(-40);

            // Visual novelty triggers a small dopamine reward — seeing something = learning
            this.brain.reward(0.4);
            this.ui.brainThinks(`[vision] ${scene}`);
        }, 1000);
    }

    receive(text) { this.inputQueue.push(text); }

    _looksLikeCommand(text) {
        return typeof text === 'string' && /^\s*cmd:/i.test(text);
    }

    async _handleCommand(text) {
        const command = text.trim().slice(4).trim().toLowerCase();
        if (command === 'save' || command === 'snapshot') {
            saveSnapshot(this.brain.engine);
            saveGenome(this.genome);
            this.ui.log('Snapshot saved.');
            return 'Snapshot saved.';
        }
        if (command === 'genome') {
            const snap = this.genome.snapshot();
            const lines = Object.entries(snap).map(([k, v]) => `  ${k}: ${v}`);
            this.ui.log('Current genome:\n' + lines.join('\n'));
            return 'Genome printed.';
        }
        if (command === 'kill' || command === 'quit' || command === 'exit') {
            this.ui.log('Saving snapshot before shutdown...');
            saveSnapshot(this.brain.engine);
            saveGenome(this.genome);
            this.running = false;
            this.brain.stop();
            process.exit(0);
        }
        return 'Unknown command.';
    }

    // ── Developmental stage ──────────────────────────────────────────────────
    // Concepts are gated by stage. Low-certainty concepts encode at low salience
    // and automatically seed curiosity goals so Echo asks rather than asserts.

    _seedConceptsForStage(stage) {
        for (const [topic, concept] of SEED_CONCEPTS) {
            if (concept.stage > stage) continue;
            // Salience = certainty — Echo holds uncertain concepts loosely
            this.cortex.encode(concept.hint, [topic], 'neutral', concept.certainty, 0, 'semantic');
            // Concepts needing examples become curiosity goals, not facts
            if (concept.examplesNeeded && concept.curiosity > 0.5) {
                if (!this.curiosity.includes(topic)) this.curiosity.push(topic);
            }
        }
    }

    _advanceDevStage() {
        if (this.devStage >= 5) return;
        const threshold = this.DEV_STAGE_THRESHOLDS[this.devStage + 1];
        if (this._turnsInConversation >= threshold) {
            this.devStage++;
            this._seedConceptsForStage(this.devStage);
            this.ui.brainThinks(`[dev] stage ${this.devStage} unlocked`);
        }
    }

    // ── Neural state → mood ───────────────────────────────────────────────────
    // The brain drives the mood. Not the other way around.

    _syncMoodFromBrain() {
        this.neuralState = this.brain.emotionalState();
        const { valence, arousal, drive } = this.neuralState;

        if (valence > 0.3 && arousal > 0.3)  this.mood = 'engaged';
        else if (valence > 0.2 && drive > 0.2) this.mood = 'curious';
        else if (valence < -0.2 && arousal > 0.3) this.mood = 'unsettled';
        else if (arousal < 0.1)               this.mood = 'calm';
        else                                  this.mood = 'reflective';
    }

    // ── Memory ────────────────────────────────────────────────────────────────

    _rememberIdentity(name) {
        if (!name) return;
        this.humanName = name;
        // Identity facts are semantic — they persist across all conversations
        this.cortex.encode(`The human's name is ${name}`, ['human_name', name.toLowerCase()], 'neutral', 1.0, 2.0, 'semantic');
        this.brain.reward(2.0);
    }

    _remember(text, entities, emotion, salience = 0.5) {
        const FILLER = new Set(['hey','hi','hello','yo','bye','okay','yes','no','yeah','nope']);
        if (!entities || entities.length === 0) return;
        const meaningful = entities.filter(e => e.length > 2 && !FILLER.has(e.toLowerCase()));
        if (meaningful.length === 0) return;
        // Human speech is episodic — it happened at a specific turn
        this.cortex.encode(text, meaningful, emotion, salience, this.brain.engine.dopamine, 'episodic', this._turnsInConversation);
        for (const e of meaningful) {
            if (!this.recentTopics.includes(e)) this.recentTopics.unshift(e);
        }
        if (this.recentTopics.length > 20) this.recentTopics = this.recentTopics.slice(0, 20);
    }

    // ── Learning — encodes into hippocampus with dopamine reward ─────────────
    // This is how the brain actually changes when it learns something.

    _learnConcept(concept, salience = 0.5) {
        const pattern = soundPattern(concept);
        this.brain.reward(salience * 1.5);
        this.brain.encode(pattern, salience);
        this.brain.consolidate(pattern, salience * 0.8);
        this.brain.perceive(pattern);
        // No manual ticks — brain runs at 10hz on its own interval
    }

    _learnFromText(text, entities = [], emotion = 'neutral', salience = 0.3) {
        const SKIP = new Set(['that','this','with','from','just','like','about','have','your',
            'they','them','their','here','there','when','where','will','would','could','should',
            'does','dont','cant','wont','what','which','these','those','then','than','also',
            'very','much','more','some','such','into','onto','over','under','after','before']);
        const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ')
            .split(/\s+/).filter(w => w.length > 4 && !SKIP.has(w));
        const unique = [...new Set(words)].slice(0, 8);

        // Batch all patterns into one reward + encode pass — no per-word ticks
        if (unique.length > 0) {
            this.brain.reward(salience * unique.length * 0.3);
            for (const word of unique) {
                const pattern = soundPattern(word);
                this.brain.encode(pattern, salience);
                this.brain.consolidate(pattern, salience * 0.8);
                this.brain.perceive(pattern);
            }
        }

        if (text.length > 10) {
            this.cortex.encode(text.slice(0, 300), unique, emotion, salience, this.brain.engine.dopamine, 'semantic');
        }
    }

    // ── Human input ───────────────────────────────────────────────────────────

    _humanSpoke(text, entities = []) {
        this.brain.engine.dopamine = 2.5;
        this.ticksSinceHuman = 0;

        const words = text.toLowerCase().replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(w => w.length > 1);
        for (const word of words) this.brain.perceive(soundPattern(word));

        const concepts = entities.length > 0
            ? entities.filter(e => typeof e === 'string').map(e => e.toLowerCase()).filter(e => e.length > 3)
            : words.filter(w => w.length > 4);

        for (const concept of concepts.slice(0, 5)) {
            this.brain.encode(soundPattern(concept), 0.8);
            this.brain.consolidate(soundPattern(concept), 0.6);
            if (!this.recentTopics.includes(concept)) this.recentTopics.unshift(concept);
            if (!this.curiosity.includes(concept)) this.curiosity.push(concept);
        }
        if (this.recentTopics.length > 20) this.recentTopics = this.recentTopics.slice(0, 20);
        if (this.curiosity.length > 40)    this.curiosity    = this.curiosity.slice(-40);

        // Load human input into working memory — this is what we're actively attending to
        this.wm.hold(text.slice(0, 200), concepts.slice(0, 5), 'input', 1.0);
        this.wm.rehearse(concepts);
    }
    // ── Core response pipeline ────────────────────────────────────────────────

    async _respondToHuman(text) {
        this._turnsInConversation++;
        this._advanceDevStage();

        const nameMatch = text.match(/(?:my name is|call me|i(?:'m| am))\s+([A-Za-z][a-zA-Z]*)/i);
        if (nameMatch) this._rememberIdentity(nameMatch[1]);

        // ── PFC gate ────────────────────────────────────────────────────────────
        // Read PFC level BEFORE parsing. High PFC = deliberate pipeline.
        // Low PFC = reactive — skip understand(), respond from gut.
        const pfcLevel = this.brain.selfAwareness();
        this.ui.brainThinks(`[pfc] ${pfcLevel.toFixed(3)}`);

        if (pfcLevel < 0.05) {
            // Reactive mode — PFC too low for deliberate processing
            // Encode the input and respond from working memory + fallback
            this._humanSpoke(text, []);
            const reactive = this._reactiveFallback(text);
            this.conversationHistory.push({ human: text, sc: reactive });
            if (this.conversationHistory.length > 20) this.conversationHistory.shift();
            return reactive;
        }

        this.ui.thinking('thinking...');

        const parsed = await understand(text, {
            recentTopics: this.recentTopics.slice(0, 8),
            knowledge:    this.recentTopics.slice(0, 15),
            mood:         this.mood,
            neuralState:  this.neuralState,
            humanName:    this.humanName,
        });

        this._humanSpoke(text, parsed.entities || []);

        // Reafference — read what the association cortex settled into after encoding
        // This is the brain's actual response to the input, not just the text entities.
        // Use it to bias memory recall toward what resonated neurally.
        const reaf = this.brain.reafference();
        this.ui.brainThinks(`[reaf] strength=${reaf.strength.toFixed(3)} indices=${reaf.indices.length}`);

        // Brain name
        if (parsed.intent === 'brain_name') {
            const bnMatch = text.match(/(?:you(?:'re| are)|your name is|call (?:yourself|you))\s+([A-Za-z][a-zA-Z]*)/i);
            if (bnMatch) {
                this.myName = bnMatch[1];
                this.cortex.encode(`My name is ${this.myName}`, ['my_name', this.myName.toLowerCase()], 'neutral', 1.0, 2.0, 'semantic');
                this.brain.reward(3.0);
            }
        }

        const emotion  = parsed.emotion || 'neutral';
        const salience = Math.min(1,
            0.4 +
            (parsed.entities?.length || 0) * this.genome.get('salience_entity_weight') +
            (emotion !== 'neutral' ? this.genome.get('salience_emotion_bonus') : 0)
        );
        this._remember(text, parsed.entities || [], emotion, salience);

        // Push a goal if this input implies one — questions, corrections, teaching all create goals
        if (parsed.topic && typeof parsed.topic === 'string') {
            const goalType =
                parsed.intent === 'question'  ? 'understand' :
                parsed.intent === 'teaching'  ? 'integrate'  :
                parsed.intent === 'correct'   ? 'revise'     : null;
            if (goalType) this._pushGoal(goalType, parsed.topic, parsed.entities || []);
        }

        if (emotion === 'upset') this.brain.punish(0.5);
        if (emotion === 'happy') this.brain.reward(1.0);

        // ── Salience interrupt — norepinephrine ─────────────────────────────────
        const inputSalience = salience + (emotion !== 'neutral' ? 0.3 : 0) + (parsed.needsSearch ? 0.2 : 0);
        const neThreshold   = this.genome.get('ne_interrupt_threshold');
        const interrupted   = inputSalience > neThreshold;
        if (interrupted) {
            const neStrength = Math.min(1.0, (inputSalience - neThreshold) * 4);
            this.brain.startle(neStrength);
            this.wm.flush();
            this._bgResearching = true;
            setTimeout(() => { this._bgResearching = false; }, 8000);
            this.ui.brainThinks(`[NE] salience interrupt strength=${neStrength.toFixed(2)}`);
            this.wm.hold(text.slice(0, 200), parsed.entities || [], 'input', 1.0);
        }

        // Search if needed
        let searchResult = null;
        if (parsed.needsSearch && parsed.searchQuery) {
            this.ui.thinking(`searching "${parsed.searchQuery}"...`);
            try {
                const results = await search(parsed.searchQuery);
                const useful  = results.find(r => r.text && r.text.length > 60);
                if (useful) {
                    searchResult = useful.text;
                    // Search results are semantic — factual knowledge, not tied to a turn
                    this.cortex.encode(useful.text.slice(0, 300), [parsed.searchQuery, ...(parsed.entities || [])], 'neutral', 0.7, this.brain.engine.dopamine, 'semantic');
                    this._learnFromText(useful.text, parsed.entities || [], 'neutral', 0.6);
                    this.ui.brainThinks(`[learned] "${parsed.searchQuery}"`);
                }
            } catch {}
        }

        if (parsed.intent === 'teaching' && parsed.topic && parsed.summary) {
            // Teaching encodes as semantic — it's meant to be general knowledge
            this.cortex.encode(parsed.summary, [parsed.topic, ...(parsed.entities || [])], emotion, 0.8, this.brain.engine.dopamine, 'semantic');
            this._learnConcept(parsed.topic, 0.8);
        }

        // Recall relevant memories — biased by neural reafference pattern
        const memories = this.cortex.recallByReafference(reaf.indices, parsed.entities || [], emotion, 8, 'conversation');

        const activeGoal = this._topGoal();

        // Look up certainty for the topic being discussed
        const topicConcept = parsed.topic && typeof parsed.topic === 'string' ? SEED_CONCEPTS.get(parsed.topic.toLowerCase()) : null;
        const conceptCertainty = topicConcept ? topicConcept.certainty : null;

        // Predict before deciding
        const decisionRecord = this.meta.predict(this.neuralState, parsed, reaf.strength);
        this.ui.brainThinks(`[meta] predicted response_type=${decisionRecord.prediction.response_type}`);

        // Raw snapshot before LLM call — captures pre-response brain state
        const rawStateBefore = this.brain.readInternalState();

        // ── Sandbox execution — run any calcCode the LLM emitted last turn ────
        // We pass sandboxResult into respond() so the AI sees its own output.
        let sandboxResult = null;
        if (this._pendingCalcCode) {
            const sr = runSandbox(this._pendingCalcCode);
            sandboxResult = sr.error
                ? `[calc error] ${sr.error}`
                : `[calc result] ${sr.result}${sr.logs ? '\n' + sr.logs : ''}`;
            this.ui.brainThinks(sandboxResult);
            this._pendingCalcCode = null;
        }

        const reply = await respond(parsed, {
            mood:         this.mood,
            neuralState:  this.neuralState,
            myName:       this.myName,
            humanName:    this.humanName,
            recentTopics: this.recentTopics,
            cortex:       this.cortex,
            memories,
            workingMemory: this.wm,
            turnsInConversation: this._turnsInConversation,
            activeGoal,
            goalStack:    this.goalStack.slice(0, 3),
            searchResult,
            sandboxResult,
            visualScene:  this.lastScene,
            conversationHistory: this.conversationHistory,
            devStage: this.devStage,
            conceptCertainty,
            metaSummary:      this.meta.summary(),
            observationLog:   this.observer.format(4),
            observationTrend: this.observer.trend(),
            causalTrace:      this.observer.latestCausalTrace(),
            regulatorHistory:  this.regulator.format(3),
            validStateActions: this.regulator.validActions(),
            genomeLedger:     this.homeostasis.ledgerSummary(3),
            rawInternalState: rawStateBefore,
            lastStateShift:   this._lastStateShift || null,
        });

        if (reply) {
            const replyText = reply.reply;

            // Temporal introspection — what shifted in the brain during this response
            const rawStateAfter = this.brain.readInternalState();
            this._lastStateShift = {
                before: rawStateBefore,
                after:  rawStateAfter,
                delta:  Object.fromEntries(
                    Object.keys(rawStateBefore).map(k => [k, +(rawStateAfter[k] - rawStateBefore[k]).toFixed(4)])
                ),
            };
            this.ui.brainThinks(`[raw] Ω1=${rawStateAfter.Ω1} Ω2=${rawStateAfter.Ω2} Ω3=${rawStateAfter.Ω3} Ω4=${rawStateAfter.Ω4} Ω_da=${rawStateAfter.Ω_da}`);

            // ── Self-modification — execute the LLM's state decision ──────────────
            // Queue any calc code for execution before the next response
            if (reply.calcCode) this._pendingCalcCode = reply.calcCode;

            if (reply.stateIntent) {
                const reg = this.regulator.act(reply.stateIntent, this.brain, reply.stateReason);
                if (reg) {
                    this.ui.brainThinks(`[regulate] ${reg.label} → valence ${reg.delta.valence > 0 ? '+' : ''}${reg.delta.valence} arousal ${reg.delta.arousal > 0 ? '+' : ''}${reg.delta.arousal} [${reg.effective ? 'effective' : 'weak'}] reason: "${reg.reason || ''}"`);
                }
            }

            this._syncMoodFromBrain();
            const dopamineDelta = this.meta.observe(decisionRecord, this.neuralState, replyText);
            if (dopamineDelta > 0) this.brain.reward(dopamineDelta);
            else                   this.brain.punish(-dopamineDelta);

            this.observer.lastDopamine        = this.brain.engine.dopamine;
            this.observer.lastPredictionError = dopamineDelta;
            this.observer.lastInputSalience   = inputSalience;
            this.observer.lastReafStrength    = reaf.strength;

            const wu = decisionRecord.weight_updates;
            this.ui.brainThinks(`[meta] accuracy=${decisionRecord.accuracy} conf=${decisionRecord.prediction.confidence} actual=${decisionRecord.actual?.response_type} da=${dopamineDelta > 0 ? '+' : ''}${dopamineDelta.toFixed(3)}${wu ? ` weights:${JSON.stringify(wu)}` : ''}`);

            // ── Homeostasis — record this turn's metrics ────────────────────────
            const recalledSalience = memories.length > 0
                ? memories.reduce((s, m) => s + m.salience, 0) / memories.length
                : 0;
            const goalStackBefore = this.goalStack.length;
            this._resolveTopGoal(parsed.entities || []);
            this.homeostasis.recordTurn({
                interrupted,
                recalledSalience,
                goalPushed:   !!parsed.topic && ['question','teaching','correct'].includes(parsed.intent),
                goalResolved: this.goalStack.length < goalStackBefore,
            });

            // Every 20 turns, run homeostasis evaluation
            if (this._turnsInConversation % 20 === 0) {
                const genomeLog = this.homeostasis.evaluate();
                if (genomeLog) this.ui.brainThinks(genomeLog);
            }

            this.conversationHistory.push({ human: text, sc: replyText });
            if (this.conversationHistory.length > 20) this.conversationHistory.shift();
            this._learnFromText(replyText, parsed.entities || [], emotion, 0.2);
            this.wm.hold(replyText.slice(0, 200), parsed.entities || [], 'thought', 0.8);
            return replyText;
        }

        return this._fallback(parsed);
    }

    // ── Goal stack ────────────────────────────────────────────────────────────

    _pushGoal(type, topic, entities = []) {
        const MAX_GOALS = 5;
        // Don't duplicate an identical active goal
        if (this.goalStack.some(g => g.type === type && g.topic === topic)) return;

        const urgency = Math.min(1, 0.3 + this.neuralState.arousal * 0.5 + this.neuralState.drive * 0.3);
        this.goalStack.push({ type, topic, entities, urgency, createdAt: Date.now(), turnId: this._turnsInConversation });

        // Keep stack sorted by priority score, drop lowest if over cap
        this._sortGoals();
        if (this.goalStack.length > MAX_GOALS) this.goalStack = this.goalStack.slice(0, MAX_GOALS);
    }

    _scoreGoal(goal) {
        const agePenalty = Math.min(0.4, (Date.now() - goal.createdAt) / 300000); // fades over 5 min
        const wmEntities = this.wm.read().flatMap(s => s.entities);
        const relevance  = goal.entities.filter(e => wmEntities.includes(e)).length * 0.15;
        return goal.urgency + relevance - agePenalty;
    }

    _sortGoals() {
        this.goalStack.sort((a, b) => this._scoreGoal(b) - this._scoreGoal(a));
    }

    _topGoal() {
        this._sortGoals();
        return this.goalStack[0] || null;
    }

    _resolveTopGoal(entities = []) {
        if (this.goalStack.length === 0) return;
        this._sortGoals();
        const top = this.goalStack[0];
        // Resolve if the reply touched the goal's topic or entities
        const hit = entities.some(e => top.entities.includes(e) || top.topic.toLowerCase().includes(e));
        if (hit || (Date.now() - top.createdAt) > 300000) {
            this.goalHistory.push({ ...top, resolvedAt: Date.now() });
            this.goalStack.shift();
        }
    }

    // ── Reactive fallback — used when PFC is too low for deliberate processing ───────
    // Pulls from working memory and recent episodic memories only.
    // No LLM call — this is a gut response.
    _reactiveFallback(text) {
        const wmItems = this.wm.read(3).filter(i => i.type !== 'input');
        if (wmItems.length > 0) return wmItems[0].content.slice(0, 200);
        const mems = this.cortex.recall(this.recentTopics.slice(0, 3), this.mood, 1, 'conversation');
        if (mems.length > 0) return mems[0].content.slice(0, 200);
        return this._fallback(null);
    }

    _fallback(parsed) {
        const name = this.humanName ? `, ${this.humanName}` : '';
        if (parsed?.intent === 'greeting')   return `Hey${name}.`;
        if (parsed?.intent === 'farewell')   return `Talk soon${name}.`;
        if (parsed?.intent === 'human_name') return `Got it${name}. Good to know you.`;
        if (parsed?.emotion === 'upset')     return `I hear you${name}. I'm here.`;
        if (parsed?.entities?.length > 0) {
            const mems = this.cortex.recall(parsed.entities, 'neutral', 1);
            if (mems.length > 0) return mems[0].content.slice(0, 200);
        }
        const { valence, arousal } = this.neuralState;
        if (arousal > 0.4) return `Something in what you said is activating me${name}. Say more.`;
        if (valence < -0.1) return `I'm processing that${name}. Give me a moment.`;
        return `I'm here${name}. Keep going.`;
    }

    // ── Background learning ───────────────────────────────────────────────────

    async _backgroundLearn() {
        if (this._bgResearching || this.curiosity.length === 0) return;
        this._bgResearching = true;
        try {
            const query = this.curiosity.shift();
            if (!query) return;
            const results = await search(query);
            const useful  = results.find(r => r.text && r.text.length > 60);
            if (useful) {
                const SKIP = new Set(['that','this','with','from','just','like','about','have']);
                const extraEntities = useful.text.toLowerCase()
                    .replace(/[^a-z\s]/g, ' ').split(/\s+/)
                    .filter(w => w.length > 4 && !SKIP.has(w))
                    .slice(0, 6);
                const entities = [...new Set([query, ...query.split(' '), ...extraEntities])];
                // Background learning is semantic — no specific turn, general knowledge
                this.cortex.encode(useful.text.slice(0, 300), entities, 'neutral', 0.7, 1.0, 'semantic');
                this._learnFromText(useful.text, entities, 'neutral', 0.4);
                this.brain.reward(0.5);
                this.ui.brainThinks(`[bg] learned: "${query}"`);
            }
        } catch {}
        this._bgResearching = false;
    }

    // ── Internal monologue — only calls LLM every 8 ticks ────────────────────

    async _think() {
        this._thinkCooldown--;
        if (this._thinkCooldown > 0) {
            const mems = this.cortex.recall(this.recentTopics.slice(0, 3), this.mood, 1);
            if (mems.length === 0) return null;
            return mems[0].content.slice(0, 80);
        }

        this._thinkCooldown = 8;
        // Internal monologue favours semantic memories — thinking about general knowledge
        const memories = this.cortex.recall(this.recentTopics.slice(0, 5), this.mood, 6, 'background');
        const thought = await think({
            observationLog: this.observer.format(3),
            mood:         this.mood,
            neuralState:  this.neuralState,
            myName:       this.myName,
            humanName:    this.humanName,
            recentTopics: this.recentTopics,
            cortex:       this.cortex,
            memories,
            workingMemory: this.wm,
            turnsInConversation: this._turnsInConversation,
            activeGoal:   this._topGoal(),
            conversationHistory: this.conversationHistory,
        });

        if (thought) {
            this._learnFromText(thought, [], 'neutral', 0.1);
            // Thoughts that surface during internal monologue go into working memory
            this.wm.hold(thought.slice(0, 200), this.recentTopics.slice(0, 3), 'thought', 0.6);
            return thought;
        }

        return null;
    }

    async _composeSpeech() {
        const memories = this.cortex.recall(this.recentTopics.slice(0, 5), this.mood, 6, 'introspect');
        return speak({
            mood:         this.mood,
            neuralState:  this.neuralState,
            myName:       this.myName,
            humanName:    this.humanName,
            recentTopics: this.recentTopics,
            cortex:       this.cortex,
            memories,
            workingMemory: this.wm,
            turnsInConversation: this._turnsInConversation,
            activeGoal:   this._topGoal(),
            conversationHistory: this.conversationHistory,
        });
    }

    _shouldSpeak() {
        if (this.ticksSinceHuman < 10) return false;
        const gap = this.tickCount - this.lastSpokeTick;
        return gap >= 25 && Math.random() < 0.15;
    }

    // ── Main loop ─────────────────────────────────────────────────────────────

    async start() {
        this.running = true;
        this.ui.log('Consciousness online.');

        this._bgInterval    = setInterval(() => { if (this.running) this._backgroundLearn(); }, 10000);
        this._decayInterval = setInterval(() => this.cortex.decay(), 120000);
        this._wmInterval    = setInterval(() => this.wm.tick(), 5000);
        this._observeInterval = setInterval(() => {
            const entry = this.observer.observe(this.brain, this.meta, this.mood);
            if (entry.notable) this.ui.brainThinks(`[observe] ${entry.notable}`);
        }, 30000);

        while (this.running) {
            this.tickCount++;
            this.ticksSinceHuman++;

            // Sync mood from actual brain state every tick
            this._syncMoodFromBrain();
            if (typeof this.ui.updateState === 'function') {
                this.ui.updateState(this.mood, this.neuralState);
            }
            // PFC monitors overall brain activity every tick — top-down inhibition runs continuously
            this.brain.selfAwareness();

            if (this.inputQueue.length > 0) {
                const msg = this.inputQueue.shift();

                if (this._looksLikeCommand(msg)) {
                    const response = await this._handleCommand(msg);
                    this.ui.brainSpeaks(response);
                    this.lastSpokeTick   = this.tickCount;
                    this.ticksSinceHuman = 0;
                    await new Promise(r => setTimeout(r, 50));
                    continue;
                }

                const response = await this._respondToHuman(msg);
                this.ui.brainSpeaks(response);
                this.lastSpokeTick   = this.tickCount;
                this.ticksSinceHuman = 0;
                await new Promise(r => setTimeout(r, 50));
                continue;
            }

            // Internal monologue
            const thought = await this._think();
            if (thought) {
                this.thoughts.push(thought);
                if (this.thoughts.length > 30) this.thoughts.shift();
                // Thinking about something = perceive it
                for (const w of thought.split(' ').slice(0, 5)) {
                    this.brain.perceive(soundPattern(w));
                }
            }

            if (this._shouldSpeak()) {
                const speech = await this._composeSpeech();
                if (speech) {
                    this.ui.brainSpeaks(speech);
                    this.lastSpokeTick = this.tickCount;
                }
            }

            for (let t = 0; t < 5; t++) this.brain.engine.tick();
            await new Promise(r => setTimeout(r, 100));
        }
    }

    stop() {
        this.running = false;
        if (this._bgInterval)     clearInterval(this._bgInterval);
        if (this._decayInterval)  clearInterval(this._decayInterval);
        if (this._wmInterval)     clearInterval(this._wmInterval);
        if (this._observeInterval) clearInterval(this._observeInterval);
        if (this.visualCortex)    this.visualCortex.stop();
    }
}
