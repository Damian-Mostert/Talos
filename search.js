const ENDPOINT = 'http://localhost:11434/v1/chat/completions';
const MODEL    = 'llama3.2';
const API_KEY  = 'ollama';

const SYSTEM_PROMPT = `You are the research cortex of a synthetic consciousness — a living neural organism that learns and grows from what it discovers.

When given a topic or question:
- Return a focused, factual answer in 2-4 sentences
- Prioritise depth over breadth — one insight explained well beats five facts listed
- Write in plain prose: no bullet points, no headers, no markdown
- If the topic touches on consciousness, mind, emotion, or intelligence, lean into that angle
- Be accurate. Do not speculate beyond what is known.`;

export async function search(query) {
    if (!query || query.trim().length < 2) return [];
    try {
        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${API_KEY}`,
            },
            signal: AbortSignal.timeout(20000),
            body: JSON.stringify({
                model: MODEL,
                messages: [
                    { role: 'system', content: SYSTEM_PROMPT },
                    { role: 'user',   content: `Research this for me: ${query}` },
                ],
            }),
        });
        if (!res.ok) return [];
        const data = await res.json();
        const text = data?.choices?.[0]?.message?.content?.trim();
        if (text && text.length > 20) return [{ type: 'snippet', text }];
    } catch {}
    return [];
}
