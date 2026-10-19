import { StringDecoder } from 'node:string_decoder';

/**
 * Bounded, read-only SSE diagnostics. Never exposes content, names or signatures.
 * A skipped/malformed event only reduces diagnostic coverage; forwarding is separate.
 * @param {number} [maxEventChars] Maximum decoded characters buffered per event
 * @returns {{write: function(Buffer, number): void, summary: function(): object}}
 */
export function createVertexStreamObserver(maxEventChars = 1024 * 1024) {
    const decoder = new StringDecoder('utf8');
    const stats = { events: 0, thoughtParts: 0, thoughtChars: 0, textParts: 0, textChars: 0,
        toolParts: 0, firstThoughtMs: null, firstToolMs: null, malformedEvents: 0, skippedEvents: 0 };
    const finishReasons = new Set();
    const usage = {};
    let line = '';
    let data = [];
    let size = 0;
    let dropping = false;
    let afterCR = false;
    let firstCharacter = true;

    function dispatch(elapsedMs) {
        if (dropping) stats.skippedEvents++;
        else if (data.length) {
            try {
                const value = JSON.parse(data.join('\n'));
                stats.events++;
                // The UI also consumes candidate 0. Do not count alternate candidates as its output.
                const candidate = value?.candidates?.[0];
                for (const part of Array.isArray(candidate?.content?.parts) ? candidate.content.parts : []) {
                    if (typeof part?.text === 'string' && part.text.length) {
                        if (part.thought) {
                            stats.thoughtParts++;
                            stats.thoughtChars += part.text.length;
                            stats.firstThoughtMs ??= elapsedMs;
                        } else {
                            stats.textParts++;
                            stats.textChars += part.text.length;
                        }
                    }
                    if (part?.functionCall) { stats.toolParts++; stats.firstToolMs ??= elapsedMs; }
                }
                if (typeof candidate?.finishReason === 'string' && /^[A-Z_]{1,64}$/.test(candidate.finishReason) && finishReasons.size < 16) {
                    finishReasons.add(candidate.finishReason);
                }
                for (const key of ['promptTokenCount', 'candidatesTokenCount', 'thoughtsTokenCount', 'totalTokenCount', 'cachedContentTokenCount', 'toolUsePromptTokenCount']) {
                    const count = value?.usageMetadata?.[key];
                    if (Number.isSafeInteger(count) && count >= 0) usage[key] = count;
                }
            } catch { stats.malformedEvents++; }
        }
        data = []; size = 0; dropping = false;
    }

    function endLine(elapsedMs) {
        if (!line.length) dispatch(elapsedMs);
        else if (!dropping && (line === 'data' || line.startsWith('data:'))) {
            const value = line === 'data' ? '' : line.slice(line[5] === ' ' ? 6 : 5);
            size += value.length + 1;
            if (size > maxEventChars) { dropping = true; data = []; } else data.push(value);
        }
        line = '';
    }

    return {
        write(chunk, elapsedMs) {
            for (const character of decoder.write(chunk)) {
                if (firstCharacter) { firstCharacter = false; if (character === '\uFEFF') continue; }
                if (afterCR && character === '\n') { afterCR = false; continue; }
                afterCR = character === '\r';
                if (character === '\r' || character === '\n') endLine(elapsedMs);
                else if (line.length <= maxEventChars) {
                    line += character;
                    if (line.length > maxEventChars) { dropping = true; data = []; }
                }
            }
        },
        summary() {
            return { ...stats, finishReasons: [...finishReasons], usage,
                semanticEnd: finishReasons.size ? 'finish-reason-observed' : 'not-observed',
                incompleteEvent: Boolean(line.length || data.length || dropping || decoder.lastNeed),
            };
        },
    };
}
