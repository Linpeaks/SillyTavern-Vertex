import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import util from 'node:util';
import http from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import express from 'express';
import fetch, { Response } from 'node-fetch';
import { afterAll, beforeAll, expect, jest, test } from '@jest/globals';
import * as constants from '../src/constants.js';
import * as pdf from '../src/native-pdf.js';
import * as references from '../public/scripts/native-pdf.js';
import { forwardVertexResponse } from '../src/vertex-http2.js';
import { makePdf } from './fixtures/native-pdf.js';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, fallback) => fallback,
    tryParse: value => { try { return JSON.parse(value); } catch { return undefined; } },
}));
const converters = await import('../src/prompt-converters.js');
const source = fs.readFileSync(new URL('../src/endpoints/backends/chat-completions.js', import.meta.url), 'utf8');
const uploadSource = fs.readFileSync(new URL('../src/endpoints/files.js', import.meta.url), 'utf8');
let server, url, directories;
const calls = [];
const logs = [];
const toolReply = { candidates: [{ content: { parts: [{ functionCall: { name: 'emit', args: { body: 'synthetic tool response' } } }] }, finishReason: 'STOP' }] };

beforeAll(async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'st-pdf-route-test-'));
    directories = { root, files: path.join(root, 'user', 'files') };
    await fsp.mkdir(directories.files, { recursive: true });
    const router = express.Router();
    const context = vm.createContext({
        ...constants, ...converters, ...pdf, ...references, router, URL, AbortController, util, forwardVertexResponse,
        API_VERTEX_AI: 'https://aiplatform.googleapis.com', API_MAKERSUITE: 'https://generativelanguage.googleapis.com',
        getConfigValue: (_key, fallback) => fallback,
        getVertexAIAuth: async () => ({ authType: 'full', authHeader: 'Bearer synthetic' }),
        getProjectIdFromServiceAccount: account => account.project_id,
        SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: 'service' }, readSecret: () => '{"project_id":"synthetic-project"}',
        getPromptNames: () => ({ charName: '', userName: '', groupNames: [], startsWithGroupName: () => false }),
        console: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(method => [method, (...args) => logs.push(args)])),
        getVertexHttp2Proxy: async () => '',
        fetchVertexHttp2: async (_url, init) => {
            calls.push({ body: JSON.parse(init.body), signal: init.signal });
            return new Response(Readable.from(['data: ' + JSON.stringify(toolReply) + '\n\n']), { headers: { 'content-type': 'text/event-stream' } });
        },
    });
    vm.runInContext(source.match(/^async function sendMakerSuiteRequest\([^]*?^}/m)[0], context);
    vm.runInContext(source.match(/^router.post\('\/generate', async function[^]*?^}\);/m)[0], context);
    vm.runInContext(uploadSource.match(/^router.post\('\/upload-pdf', async[^]*?^}\);/m)[0], context);
    const app = express();
    app.use(express.json({ limit: '70mb' }));
    app.use((req, _res, next) => { req.user = { directories }; next(); });
    app.use(router);
    server = http.createServer(app).listen(0, '127.0.0.1');
    await once(server, 'listening');
    url = `http://127.0.0.1:${server.address().port}`;
});
afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    if (path.dirname(directories.root) !== path.resolve(os.tmpdir()) || !path.basename(directories.root).startsWith('st-pdf-route-test-')) throw new Error('Unsafe cleanup path');
    await fsp.rm(directories.root, { recursive: true, force: true });
});
const post = (route, body) => fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('real upload and generate routes preserve PDF bytes, merge_tools and tool-only response', async () => {
    const bytes = makePdf('synthetic large document ' + 'x'.repeat(6 * 1024 * 1024));
    const upload = await post('/upload-pdf', { data: bytes.toString('base64') });
    expect(upload.status).toBe(200);
    const file = await upload.json();
    expect(file.url).toMatch(/^user\/files\//);
    const marker = references.nativePdfMarker(file);
    const count = calls.length;
    const response = await post('/generate', {
        chat_completion_source: 'vertexai', vertexai_auth_mode: 'full', vertexai_region: 'global', model: 'gemini-4-argon',
        stream: true, max_tokens: 65535, include_reasoning: true, reasoning_effort: 'high',
        custom_prompt_post_processing: 'merge_tools', messages: [{ role: 'user', content: marker + '\nquestion' }],
        native_pdf_refs: [marker], tools: [{ type: 'function', function: { name: 'emit', parameters: { type: 'object' } } }],
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('data: ' + JSON.stringify(toolReply) + '\n\n');
    expect(calls).toHaveLength(count + 1);
    expect(calls.at(-1).body.contents[0].parts[0].inlineData).toEqual({ mimeType: 'application/pdf', data: bytes.toString('base64') });
    expect(calls.at(-1).body.generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    expect(JSON.stringify(logs)).not.toContain(bytes.toString('base64'));
});

test('unsupported source, stripped manifest and missing file make zero generation calls', async () => {
    const count = calls.length;
    const marker = references.nativePdfMarker({ id: '00000000-0000-0000-0000-000000000000', sha256: '0'.repeat(64), pages: 1 });
    for (const overrides of [{ chat_completion_source: 'openai' }, { messages: [{ role: 'user', content: 'stripped' }] }, {}]) {
        const response = await post('/generate', { model: 'gemini-4-argon', chat_completion_source: 'vertexai', vertexai_auth_mode: 'full',
            messages: [{ role: 'user', content: marker }], native_pdf_refs: [marker], ...overrides });
        expect(response.status).toBe(400);
        expect((await response.json()).error).toBe(true);
    }
    expect(calls).toHaveLength(count);
});

test('upload errors are explicit and never expose local paths', async () => {
    const response = await post('/upload-pdf', { data: Buffer.from('broken').toString('base64') });
    expect(response.status).toBe(400);
    const value = await response.json();
    expect(value.error).toMatch(/PDF upload failed/);
    expect(JSON.stringify(value)).not.toContain(directories.root);
});
