// sandbox.js — safe JS execution for math/numeric experiments
// Uses Node's vm module. Not a full security boundary, but sufficient
// for a cooperative AI that isn't trying to escape.
//
// Exposed API: Math, Number, Array, Object, JSON, console (log only),
// plus a small stats helper and a range() utility.
// No: fs, net, process, require, import, setTimeout, setInterval.

import vm from 'vm';

const TIMEOUT_MS = 2000;
const MAX_OUTPUT_CHARS = 2000;

function buildSandbox(logs) {
    const stats = {
        sum:    arr => arr.reduce((a, b) => a + b, 0),
        mean:   arr => arr.reduce((a, b) => a + b, 0) / arr.length,
        median: arr => { const s = [...arr].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; },
        std:    arr => { const m = stats.mean(arr); return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); },
        min:    arr => Math.min(...arr),
        max:    arr => Math.max(...arr),
    };

    return vm.createContext({
        Math, Number, Array, Object, JSON, isNaN, isFinite, parseFloat, parseInt,
        stats,
        range: (start, end, step = 1) => { const r = []; for (let i = start; i < end; i += step) r.push(i); return r; },
        console: { log: (...args) => { logs.push(args.map(a => JSON.stringify(a) ?? String(a)).join(' ')); } },
        result: undefined,
    });
}

// Run a JS string. Returns { result, logs, error }.
// The code should assign to `result` or the last expression is captured via IIFE.
export function runSandbox(code) {
    const logs = [];
    try {
        const sandbox = buildSandbox(logs);
        const wrapped = `result = (() => { ${code} })();`;
        new vm.Script(wrapped).runInContext(sandbox, { timeout: TIMEOUT_MS });
        const out = sandbox.result;
        const resultStr = out === undefined ? '(undefined)' : JSON.stringify(out, null, 2) ?? String(out);
        return {
            result: resultStr.slice(0, MAX_OUTPUT_CHARS),
            logs:   logs.join('\n').slice(0, MAX_OUTPUT_CHARS),
            error:  null,
        };
    } catch (err) {
        return { result: null, logs: logs.join('\n'), error: err.message };
    }
}
