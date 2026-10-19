/* eslint-disable playwright/no-standalone-expect -- Jest test.each is not a Playwright test. */
import { describe, expect, test } from '@jest/globals';
import { createVertexStreamObserver } from '../src/vertex-stream-observer.js';

describe('Vertex SSE observation without content retention', () => {
    test.each(['\n', '\r\n', '\r'])('handles %j lines and arbitrary UTF-8 splits', newline => {
        const value = { candidates: [{ content: { parts: [
            { thought: true, text: '思考🧪' }, { thought: true, thoughtSignature: 'private-signature' },
            { text: '正文' }, { functionCall: { name: 'private-tool', args: { content: 'private-body' } } },
        ] }, finishReason: 'STOP' }], usageMetadata: { thoughtsTokenCount: 15, totalTokenCount: 40, unknown: 'private' } };
        const bytes = Buffer.from('\uFEFF: comment' + newline + 'data: ' + JSON.stringify(value) + newline + newline);
        const observer = createVertexStreamObserver();
        for (const byte of bytes) observer.write(Buffer.from([byte]), 100);
        expect(observer.summary()).toMatchObject({ events: 1, thoughtParts: 1, thoughtChars: 4,
            textParts: 1, textChars: 2, toolParts: 1, firstThoughtMs: 100, firstToolMs: 100,
            finishReasons: ['STOP'], usage: { thoughtsTokenCount: 15, totalTokenCount: 40 }, incompleteEvent: false });
        expect(JSON.stringify(observer.summary())).not.toMatch(/private|正文|思考/);
    });

    test('multiline JSON, malformed events and incomplete EOF stay diagnostic only', () => {
        const observer = createVertexStreamObserver();
        observer.write(Buffer.from('data: {\ndata: "usageMetadata":{"totalTokenCount":3}}\n\ndata: broken\n\ndata: {"unfinished":'), 1);
        expect(observer.summary()).toMatchObject({ events: 1, malformedEvents: 1, incompleteEvent: true,
            semanticEnd: 'not-observed', usage: { totalTokenCount: 3 } });
    });

    test('bounds oversized events and resumes at the next event', () => {
        const observer = createVertexStreamObserver(256);
        observer.write(Buffer.from('data: ' + 'x'.repeat(100000) + '\r\n\r\ndata: {"candidates":[{"finishReason":"MAX_TOKENS"}]}\r\n\r\n'), 2);
        expect(observer.summary()).toMatchObject({ skippedEvents: 1, events: 1, finishReasons: ['MAX_TOKENS'], incompleteEvent: false });
    });

    test('tool-only responses are observable without text or arguments in the log', () => {
        const observer = createVertexStreamObserver();
        observer.write(Buffer.from('data: {"candidates":[{"content":{"parts":[{"functionCall":{"args":{"content":"body"}}}]}}]}\n\n'), 50);
        expect(observer.summary()).toMatchObject({ toolParts: 1, textChars: 0, thoughtChars: 0, firstToolMs: 50, semanticEnd: 'not-observed' });
    });
});
