import fs from 'node:fs';
import vm from 'node:vm';
import { describe, expect, test } from '@jest/globals';
import { CHAT_COMPLETION_SOURCES } from '../src/constants.js';

const source = fs.readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
const handler = source.match(/^export function getStreamingReply\([^]*?^}/m)[0].replace('export ', '');
const context = vm.createContext({
    chat_completion_sources: CHAT_COMPLETION_SOURCES,
    oai_settings: { show_thoughts: true },
    isDataURL: value => value.startsWith('data:'),
});
vm.runInContext(handler, context);

describe.each(['makersuite', 'vertexai'])('%s streaming parts', chatCompletionSource => {
    test('keeps every text part, even after signatures, images and tools', () => {
        const parts = [
            { thought: true, thoughtSignature: 'opaque-only' },
            { thought: true, text: '思考🧪' }, { thought: true, text: '继续' },
            { functionCall: { name: 'emit_story', args: { content: 'tool body' } }, thoughtSignature: 'tool-signature' },
            { inlineData: { mimeType: 'image/png', data: 'synthetic' } },
            { text: '正文', thoughtSignature: 'text-signature' }, { text: '尾部' },
        ];
        const original = structuredClone(parts);
        const state = { reasoning: 'earlier', images: [], signature: '' };
        const result = context.getStreamingReply({ candidates: [{ content: { parts } }] }, state, { chatCompletionSource });
        expect(result).toBe('正文尾部');
        expect(state.reasoning).toBe('earlier思考🧪继续');
        expect(state.signature).toBe('text-signature');
        expect(state.images).toEqual(['data:image/png;base64,synthetic']);
        expect(parts).toEqual(original);
    });

    test('honors hidden thoughts and accepts tool-only/metadata-only chunks', () => {
        const state = { reasoning: '', images: [], signature: '' };
        for (const parts of [[], [{ thought: true, text: 'hidden' }], [{ functionCall: { name: 'emit_story', args: { content: 'body' } } }]]) {
            expect(context.getStreamingReply({ candidates: [{ content: { parts } }] }, state,
                { chatCompletionSource, overrideShowThoughts: false })).toBe('');
        }
        expect(context.getStreamingReply({}, state, { chatCompletionSource })).toBe('');
        expect(state.reasoning).toBe('');
    });
});
