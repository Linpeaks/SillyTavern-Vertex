import fs from 'node:fs';
import vm from 'node:vm';
import util from 'node:util';
import { EventEmitter } from 'node:events';
import { beforeAll, describe, expect, jest, test } from '@jest/globals';
import { Response } from 'node-fetch';
import * as constants from '../src/constants.js';
import * as geminiModels from '../public/scripts/gemini-models.js';

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
        ...constants, ...converters, ...geminiModels, URL, AbortController, util,
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
        getVertexHttp2Proxy: async () => '',
        fetchVertexHttp2: fetchMock,
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
    const response = Object.assign(new EventEmitter(), {
        headersSent: false, statusCode: 200,
        status(value) { this.statusCode = value; return this; },
        send(value) { this.value = value; return this; },
    });
    await context.sendMakerSuiteRequest(request, response);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.statusCode).toBe(200);
    expect(response.value.error).toBeUndefined();
    expect(response.listenerCount('close')).toBe(0);
    return { body: JSON.parse(fetchMock.mock.calls[0][1].body), url: fetchMock.mock.calls[0][0], response };
}

describe.each(['vertexai', 'makersuite'])('%s Google request thinking config', sourceName => {
    test('preserves preset images after merging and builds one native Google image part', async () => {
        const data = Buffer.from('synthetic-image-bytes').toString('base64');
        const messages = converters.postProcessPrompt([
            { role: 'user', content: 'synthetic question' },
            { role: 'assistant', content: [{ type: 'text', text: 'before\n' },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${data}` } }, { type: 'text', text: 'after' }] },
        ], 'merge_tools', { charName: '', userName: '', startsWithGroupName: () => false });
        const part = { functionCall: { name: 'emit_story', args: { body: 'synthetic answer' } }, thoughtSignature: 'synthetic' };
        const { body, response } = await makeRequest(sourceName, 'high', true, {
            messages,
            tools: [{ type: 'function', function: { name: 'emit_story', parameters: { type: 'object', properties: { body: { type: 'string' } } } } }],
            tool_choice: 'required',
        }, { candidates: [{ content: { parts: [part] }, finishReason: 'STOP' }] });
        expect(body.contents.flatMap(content => content.parts).filter(part => part.inlineData)).toEqual([
            { inlineData: { mimeType: 'image/jpeg', data } },
        ]);
        expect(body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
        expect(body.toolConfig.functionCallingConfig).toEqual({ mode: 'ANY' });
        expect(response.value.responseContent.parts).toEqual([part]);
    });

    describe.each(['gemini-4-argon', 'gemini-4-carbon'])('%s thinking levels', model => {
        test.each([
            ['auto', undefined], ['min', 'LOW'], ['low', 'LOW'],
            ['medium', 'MEDIUM'], ['high', 'HIGH'], ['max', 'HIGH'],
        ])('sends the effective %s level with either thoughts setting', async (effort, level) => {
            for (const includeThoughts of [false, true]) {
                const { body } = await makeRequest(sourceName, effort, includeThoughts, { model });
                expect(body.generationConfig.thinkingConfig).toEqual({
                    includeThoughts, ...(level ? { thinkingLevel: level } : {}),
                });
                expect(body.generationConfig.thinkingConfig).not.toHaveProperty('thinkingBudget');
            }
        });
    });

    test('Carbon non-streaming requests honor the output limit and omit fixed sampling parameters', async () => {
        const { body } = await makeRequest(sourceName, 'auto', false, {
            model: 'gemini-4-carbon', max_tokens: 1_048_576, temperature: 0.3, top_p: 0.7, top_k: 12,
        });
        expect(body.generationConfig.maxOutputTokens).toBe(32_768);
        for (const parameter of ['temperature', 'topP', 'topK', 'candidateCount']) {
            expect(body.generationConfig).not.toHaveProperty(parameter);
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

test.each(['us', 'eu'])('Carbon uses the official Vertex %s multi-region hostname', async region => {
    const { url } = await makeRequest('vertexai', 'low', false, { model: 'gemini-4-carbon', vertexai_region: region });
    expect(url).toBe(`https://aiplatform.${region}.rep.googleapis.com/v1/projects/synthetic-project/locations/${region}/publishers/google/models/gemini-4-carbon:generateContent`);
});

test('Carbon has built-in model options and honors its unified context cap even when unlocked', () => {
    const index = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    for (const id of ['model_google_select', 'model_vertexai_select']) {
        const options = index.split(`<select id="${id}">`)[1].split('</select>')[0];
        expect(options).toContain('<option value="gemini-4-carbon">gemini-4-carbon</option>');
    }
    const frontend = fs.readFileSync(new URL('../public/scripts/openai.js', import.meta.url), 'utf8');
    const context = vm.createContext({ ...geminiModels, model_list: [{ id: 'gemini-4-carbon', inputTokenLimit: 2_000_000 }] });
    vm.runInContext(frontend.match(/^function getGeminiMaxContext\([^]*?^}/m)[0], context);
    expect(context.getGeminiMaxContext('gemini-4-carbon', false)).toBe(1_048_576);
    expect(context.getGeminiMaxContext('gemini-4-carbon', true)).toBe(1_048_576);
});
