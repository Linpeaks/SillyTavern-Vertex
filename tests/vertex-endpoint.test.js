import fs from 'node:fs';
import vm from 'node:vm';
import http from 'node:http';
import http2 from 'node:http2';
import util from 'node:util';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import express from 'express';
import fetch, { Response } from 'node-fetch';
import { afterEach, beforeAll, expect, jest, test } from '@jest/globals';
import * as constants from '../src/constants.js';
import { fetchVertexHttp2, forwardVertexResponse } from '../src/vertex-http2.js';

jest.unstable_mockModule('../src/util.js', () => ({
    getConfigValue: (_key, fallback) => fallback,
    tryParse: value => { try { return JSON.parse(value); } catch { return undefined; } },
}));
let converters;
beforeAll(async () => { converters = await import('../src/prompt-converters.js'); });
const cert = fs.readFileSync(new URL('./fixtures/vertex-http2/cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/vertex-http2/key.pem', import.meta.url));
const source = fs.readFileSync(new URL('../src/endpoints/backends/chat-completions.js', import.meta.url), 'utf8')
    .match(/^async function sendMakerSuiteRequest\([^]*?^}/m)[0];
const resources = [];
const sessions = new Set();
const sockets = new Set();
const timers = [];
async function listen(server) {
    resources.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}
async function until(predicate) {
    for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(5); }
    throw new Error('Endpoint cleanup timed out');
}
afterEach(async () => {
    timers.splice(0).forEach(clearTimeout);
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(resources.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function fixture(onStream, { enabled = true, proxy = '', authType = 'full' } = {}) {
    const requests = [];
    const diagnostics = [];
    const upstream = http2.createSecureServer({ key, cert });
    upstream.on('session', session => { sessions.add(session); session.on('error', () => {}); session.once('close', () => sessions.delete(session)); });
    upstream.on('stream', (stream, headers) => {
        stream.on('error', () => {});
        const record = { headers, data: '' };
        requests.push(record);
        stream.on('data', chunk => { record.data += chunk; });
        onStream(stream);
    });
    const upstreamPort = await listen(upstream);
    const h2 = jest.fn((url, init, options) => fetchVertexHttp2(
        url.replace(new URL(url).origin, 'https://localhost:' + upstreamPort), init,
        { ...options, ca: cert, pingIntervalMs: 25, onDiagnostic: value => {
            diagnostics.push(value);
            options.onDiagnostic?.(value);
        } },
    ));
    const h1 = jest.fn(async () => new Response('{"candidates":[{"content":{"parts":[{"text":"synthetic h1"}]}}]}'));
    const logs = [];
    const context = vm.createContext({
        ...constants, ...converters, URL, AbortController, util,
        API_VERTEX_AI: 'https://aiplatform.googleapis.com', API_MAKERSUITE: 'https://generativelanguage.googleapis.com',
        getConfigValue: (name, fallback) => name === 'gemini.vertexHttp2.enabled' ? enabled : fallback,
        getVertexAIAuth: async () => ({ authType, authHeader: 'Bearer synthetic' }),
        getProjectIdFromServiceAccount: account => account.project_id,
        SECRET_KEYS: { VERTEXAI_SERVICE_ACCOUNT: 'service' },
        readSecret: () => '{"project_id":"synthetic-project"}',
        getPromptNames: () => ({ charName: '', userName: '', groupNames: [], startsWithGroupName: () => false }),
        console: Object.fromEntries(['debug', 'info', 'warn', 'error'].map(method => [method, (...args) => logs.push(args)])),
        fetch: h1, fetchVertexHttp2: h2, getVertexHttp2Proxy: async () => proxy, forwardVertexResponse,
    });
    vm.runInContext(source, context);
    const responses = [];
    const app = express();
    app.use(express.json());
    app.post('/generate', async (req, res) => {
        req.user = { directories: {} };
        responses.push(res);
        await context.sendMakerSuiteRequest(req, res);
    });
    const port = await listen(http.createServer(app));
    return { url: 'http://127.0.0.1:' + port + '/generate', requests, diagnostics, responses, h2, h1, logs };
}
function client(url, { stream = true, signal, sourceName = 'vertexai' } = {}) {
    return fetch(url, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            chat_completion_source: sourceName, vertexai_region: 'global', model: 'gemini-4-argon',
            stream, reasoning_effort: 'high', include_reasoning: true, max_tokens: 65535,
            messages: [{ role: 'user', content: 'synthetic-private-prompt' }],
            tools: [{ type: 'function', function: { name: 'emit_story', parameters: { type: 'object', properties: { body: { type: 'string' } } } } }],
        }),
    });
}

test('client -> production handler -> TLS HTTP/2 -> delayed tool-only SSE is complete', async () => {
    const data = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{
        functionCall: { name: 'emit_story', args: { body: 'synthetic-private-tool-body' } },
        thoughtSignature: 'synthetic-signature',
    }] }, finishReason: 'STOP' }] }) + '\r\n\r\n';
    const f = await fixture(stream => {
        timers.push(setTimeout(() => { stream.respond({ ':status': 200, 'content-type': 'text/event-stream' }); stream.end(data); }, 110));
    });
    expect(await (await client(f.url)).text()).toBe(data);
    await until(() => f.diagnostics.length === 1 && sessions.size === 0);
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0].headers[':path']).toContain(':streamGenerateContent?alt=sse');
    expect(JSON.parse(f.requests[0].data).generationConfig.thinkingConfig).toEqual({ includeThoughts: true, thinkingLevel: 'HIGH' });
    expect(f.diagnostics[0]).toMatchObject({ outcome: 'eof', status: 200 });
    expect(f.diagnostics[0].pingsAck).toBeGreaterThanOrEqual(2);
    expect(f.h1).not.toHaveBeenCalled();
    expect(f.responses[0].listeners('close').some(listener => listener.name === 'onResponseClose')).toBe(false);
    expect(JSON.stringify(f.logs)).not.toMatch(/synthetic-private-prompt|synthetic-private-tool-body|synthetic-signature/);
    expect(f.logs.find(args => args[0] === '[Vertex HTTP/2]')[1]).toMatchObject({
        model: 'gemini-4-argon', thinkingConfig: { thinkingLevel: 'HIGH' }, id: f.diagnostics[0].id,
    });
});

test.each(['before headers', 'during body'])('browser cancellation %s cleans the upstream request', async phase => {
    const f = await fixture(stream => {
        if (phase === 'during body') { stream.respond({ ':status': 200 }); stream.write('data: partial\n\n'); }
    });
    const controller = new AbortController();
    const result = client(f.url, { signal: controller.signal }).then(response => response.text());
    await until(() => f.requests.length === 1);
    controller.abort();
    await expect(result).rejects.toHaveProperty('name', 'AbortError');
    await until(() => f.diagnostics.length === 1 && sessions.size === 0);
    await until(() => !f.responses[0].listeners('close').some(listener => listener.name === 'onResponseClose'));
    expect(f.diagnostics[0].outcome).toBe('cancelled');
    expect(f.requests).toHaveLength(1);
    expect(f.h1).not.toHaveBeenCalled();
});

test('upstream stream failure rejects the client rather than completing partial output', async () => {
    const f = await fixture(stream => {
        stream.respond({ ':status': 200 }); stream.write('data: partial\n\n');
        timers.push(setTimeout(() => stream.destroy(new Error('synthetic reset')), 40));
    });
    await expect(client(f.url).then(response => response.text())).rejects.toBeDefined();
    await until(() => f.diagnostics.length === 1 && sessions.size === 0);
    expect(f.diagnostics[0].outcome).toBe('error');
    expect(f.requests).toHaveLength(1);
    expect(f.h1).not.toHaveBeenCalled();
});

test.each([
    [{ enabled: false }, 'vertexai'],
    [{ proxy: null }, 'vertexai'],
    [{ authType: 'proxy' }, 'vertexai'],
    [{}, 'makersuite'],
])('retains node-fetch for disabled/unsupported/reverse-proxy/AI Studio route %#', async (options, sourceName) => {
    const f = await fixture(() => { throw new Error('HTTP/2 should not be used'); }, options);
    const result = await (await client(f.url, { stream: false, sourceName })).json();
    expect(result.choices[0].message.content).toBe('synthetic h1');
    expect(f.h1).toHaveBeenCalledTimes(1);
    expect(f.h2).not.toHaveBeenCalled();
    expect(f.requests).toHaveLength(0);
});
