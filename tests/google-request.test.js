import fs from 'node:fs';
import vm from 'node:vm';
import util from 'node:util';
import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Response } from 'node-fetch';
import * as constants from '../src/constants.js';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, fallback) => fallback,
    tryParse: value => { try { return JSON.parse(value); } catch { return undefined; } },
}));

let converters;
beforeAll(async () => {
    converters = await import('../src/prompt-converters.js');
});

// Exercise the entire production handler, with unrelated authentication/server imports
// isolated. No credentials, user settings, or Google requests are used by these tests.
const source = fs.readFileSync(new URL('../src/endpoints/backends/chat-completions.js', import.meta.url), 'utf8');
const handlerSource = source.match(/^async function sendMakerSuiteRequest\([^]*?^}/m)?.[0];
if (!handlerSource) throw new Error('Google request handler not found');

async function makeRequest(sourceName, effort, includeThoughts, overrides = {}, result = null) {
    const fetchMock = jest.fn(async () => new Response(JSON.stringify(result ?? {
        candidates: [{ content: { parts: [{ text: 'synthetic reply' }] } }],
    }), { status: 200 }));
    const context = vm.createContext({
        ...constants, ...converters, URL, AbortController, util,
        API_VERTEX_AI: 'https://aiplatform.googleapis.com',
        API_MAKERSUITE: 'https://generativelanguage.googleapis.com',
        getConfigValue: (_key, fallback) => fallback,
        getVertexAIAuth: async () => ({ authType: 'full', authHeader: 'Bearer synthetic' }),
        getProjectIdFromServiceAccount: account => account.project_id,
        SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: 'service' },
        readSecret: () => '{"project_id":"synthetic-project"}',
        getPromptNames: () => ({ charName: '', userName: '', groupNames: [], startsWithGroupName: () => false }),
        console: { debug() {}, info() {}, warn() {}, error: (...args) => { throw new Error(util.format(...args)); } },
        fetch: fetchMock,
    });
    vm.runInContext(handlerSource, context);
    const request = {
        body: {
            chat_completion_source: sourceName, model: 'gemini-4-argon',
            reasoning_effort: effort, include_reasoning: includeThoughts,
            max_tokens: 65535, vertexai_region: 'global', stream: false,
            messages: [{ role: 'user', content: 'synthetic prompt' }],
            ...overrides,
        },
        user: { directories: {} },
        socket: new EventEmitter(),
    };
    const response = {
        headersSent: false, statusCode: 200,
        status(value) { this.statusCode = value; return this; },
        send(value) { this.value = value; return this; },
    };
    await context.sendMakerSuiteRequest(request, response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(response.value.error).toBeUndefined();
    return { body: JSON.parse(fetchMock.mock.calls[0][1].body), response };
}

describe.each(['vertexai', 'makersuite'])('%s Google request thinking config', sourceName => {
    test.each([
        ['auto', undefined], ['min', 'LOW'], ['low', 'LOW'],
        ['medium', 'MEDIUM'], ['high', 'HIGH'], ['max', 'HIGH'],
    ])('sends the effective Argon %s level with either thoughts setting', async (effort, level) => {
        for (const includeThoughts of [false, true]) {
            const { body } = await makeRequest(sourceName, effort, includeThoughts);
            expect(body.generationConfig.thinkingConfig).toEqual({
                includeThoughts, ...(level ? { thinkingLevel: level } : {}),
            });
            expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget');
        }
    });

    test.each([
        ['gemini-3.7-flash', 'medium', { includeThoughts: true, thinkingLevel: 'medium' }],
        ['gemini-3.0-pro', 'medium', { includeThoughts: true, thinkingLevel: 'low' }],
        ['gemini-2.5-pro', 'low', { includeThoughts: true, thinkingBudget: 6553 }],
        ['gemini-2.5-flash-image', 'high', undefined],
        ['gemini-4-unknown', 'high', undefined],
    ])('preserves %s compatibility', async (model, effort, expected) => {
        const { body } = await makeRequest(sourceName, effort, true, { model });
        expect(body.generationConfig.thinkingConfig).toEqual(expected);
    });

    test('preserves tool-only replies, arguments and signatures', async () => {
        const part = { functionCall: { name: 'emit_story', args: { body: 'synthetic story' } }, thoughtSignature: 'synthetic' };
        const { body, response } = await makeRequest(sourceName, 'high', true, {
            tools: [{ type: 'function', function: { name: 'emit_story', parameters: { type: 'object', properties: { body: { type: 'string' } } } } }],
            tool_choice: 'required',
        }, { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] });
        expect(body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY' });
        expect(response.value.responseContent.parts).toEqual([part]);
    });
});
