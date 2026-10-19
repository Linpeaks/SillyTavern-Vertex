/* eslint-disable playwright/no-standalone-expect -- Jest test.each is not a Playwright test. */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import { once, getEventListeners } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, jest, test } from '@jest/globals';
import fetch from 'node-fetch';
import { ProxyAgent } from 'proxy-agent';
import { fetchVertexHttp2, forwardVertexResponse, getVertexHttp2Proxy } from '../src/vertex-http2.js';

const cert = fs.readFileSync(new URL('./fixtures/vertex-http2/cert.pem', import.meta.url));
const key = fs.readFileSync(new URL('./fixtures/vertex-http2/key.pem', import.meta.url));
const servers = [];
const sockets = new Set();
const sessions = new Set();
const timers = [];
function later(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds);
    timers.push(timer);
    return timer;
}
async function listen(server) {
    servers.push(server);
    server.on('connection', socket => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        socket.on('error', () => {});
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return server.address().port;
}
async function target(handler) {
    const server = http2.createSecureServer({ key, cert });
    const state = { requests: 0, pings: 0, headers: [], bodies: [] };
    server.on('session', session => {
        sessions.add(session);
        session.on('error', () => {});
        session.on('ping', () => state.pings++);
        session.once('close', () => sessions.delete(session));
    });
    server.on('stream', (stream, headers) => {
        state.requests++;
        state.headers.push(headers);
        stream.on('error', () => {});
        let body = '';
        stream.on('data', chunk => { body += chunk.toString(); });
        stream.on('end', () => state.bodies.push(body));
        handler(stream, headers, state);
    });
    const port = await listen(server);
    return { url: 'https://localhost:' + port + '/v1/test:streamGenerateContent?alt=sse', state, server };
}
function request(url, options = {}, init = {}) {
    const controller = new AbortController();
    const onDiagnostic = jest.fn();
    const signal = init.signal || controller.signal;
    return {
        controller, onDiagnostic, signal,
        response: fetchVertexHttp2(url, {
            body: '{"contents":"synthetic"}',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer synthetic' },
            signal, ...init,
        }, { ca: cert, pingIntervalMs: 25, connectTimeoutMs: 2000, onDiagnostic, ...options }),
    };
}
async function until(predicate) {
    for (let count = 0; count < 200; count++) {
        if (predicate()) return;
        await delay(5);
    }
    throw new Error('Condition did not complete');
}
afterEach(async () => {
    jest.restoreAllMocks();
    timers.splice(0).forEach(clearTimeout);
    for (const session of sessions) session.destroy();
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe('Vertex HTTP/2 lifecycle', () => {
    test('observes SSE while preserving bytes and stops optional progress at EOF', async () => {
        const data = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"secret thought"},{"functionCall":{"args":{"body":"secret tool"}}}]},"finishReason":"STOP"}]}\r\n\r\n';
        const { url, state } = await target(stream => {
            stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
            later(() => stream.end(data), 100);
        });
        const run = request(url, { progressIntervalMs: 20 });
        expect(await (await run.response).text()).toBe(data);
        await until(() => run.onDiagnostic.mock.calls.some(([value]) => value.outcome === 'eof'));
        const summaries = run.onDiagnostic.mock.calls.map(([value]) => value);
        expect(summaries.some(value => value.outcome === 'progress')).toBe(true);
        expect(summaries.at(-1)).toMatchObject({ outcome: 'eof', sse: { thoughtParts: 1, toolParts: 1, finishReasons: ['STOP'] } });
        expect(summaries.at(-1).maxIdleMs).toBeGreaterThanOrEqual(50);
        expect(JSON.stringify(summaries)).not.toContain('secret');
        await delay(60);
        expect(run.onDiagnostic).toHaveBeenCalledTimes(summaries.length);
        expect(state.requests).toBe(1);
    });

    test('throwing diagnostic callbacks cannot break a successful response', async () => {
        const { url } = await target(stream => { stream.respond({ ':status': 200 }); stream.end('body'); });
        const run = request(url, { onDiagnostic() { throw new Error('diagnostic failure'); } });
        expect(await (await run.response).text()).toBe('body');
        await until(() => sessions.size === 0);
    });

    test('keeps waiting before headers, preserves query/body and cleans up', async () => {
        const { url, state } = await target(stream => later(() => {
            stream.respond({ ':status': 200, 'content-type': 'text/event-stream' });
            stream.end('data: {"complete":true}\r\n\r\n');
        }, 130));
        const run = request(url);
        expect(await (await run.response).text()).toBe('data: {"complete":true}\r\n\r\n');
        await until(() => run.onDiagnostic.mock.calls.length === 1 && sessions.size === 0);
        expect(state.pings).toBeGreaterThanOrEqual(2);
        expect(state.requests).toBe(1);
        expect(state.headers[0][':path']).toBe('/v1/test:streamGenerateContent?alt=sse');
        expect(state.headers[0].authorization).toBe('Bearer synthetic');
        expect(state.bodies).toEqual(['{"contents":"synthetic"}']);
        expect(run.onDiagnostic.mock.calls[0][0]).toMatchObject({ outcome: 'eof', route: 'direct', status: 200 });
        expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
        expect(JSON.stringify(run.onDiagnostic.mock.calls)).not.toMatch(/synthetic|contents|alt=sse/);
    });

    test('continues idle pings after first data and preserves tool-only SSE byte for byte', async () => {
        const tool = 'data: ' + JSON.stringify({ candidates: [{ content: { parts: [{
            functionCall: { name: 'emit_story', args: { body: '合成正文\n' + 'x'.repeat(120000) } },
            thoughtSignature: 'synthetic-signature',
        }] }, finishReason: 'STOP' }] }) + '\r\n\r\n';
        const thought = 'data: {"candidates":[{"content":{"parts":[{"thought":true,"text":"synthetic thought"}]}}]}\n\n';
        const { url, state } = await target(stream => {
            stream.respond({ ':status': 200 });
            stream.write(thought);
            later(() => {
                stream.write(tool.slice(0, 17));
                stream.end(tool.slice(17));
            }, 130);
        });
        const run = request(url);
        const response = await run.response;
        expect(run.onDiagnostic).not.toHaveBeenCalled();
        expect(await response.text()).toBe(thought + tool);
        expect(state.pings).toBeGreaterThanOrEqual(2);
        expect(state.requests).toBe(1);
    });

    test('does not ping a continuously active response', async () => {
        const { url, state } = await target(stream => {
            stream.respond({ ':status': 200 });
            stream.write('start');
            for (let i = 1; i <= 10; i++) later(() => stream.write('.'), i * 10);
            later(() => stream.end('end'), 110);
        });
        expect(await (await request(url, { pingIntervalMs: 70 }).response).text()).toBe('start..........end');
        expect(state.pings).toBe(0);
    });

    test('keeps at most one unacknowledged ping and still accepts the response', async () => {
        const connect = http2.connect;
        const ping = jest.fn(() => true);
        jest.spyOn(http2, 'connect').mockImplementation((...args) => {
            const session = connect(...args);
            session.ping = ping;
            return session;
        });
        const { url } = await target(stream => later(() => { stream.respond({ ':status': 200 }); stream.end('ok'); }, 140));
        const run = request(url);
        expect(await (await run.response).text()).toBe('ok');
        expect(ping).toHaveBeenCalledTimes(1);
        expect(run.onDiagnostic.mock.calls[0][0]).toMatchObject({ pingsSent: 1, pingsAck: 0, outcome: 'eof' });
    });

    test('PING callback failure does not resubmit a generation', async () => {
        const connect = http2.connect;
        jest.spyOn(http2, 'connect').mockImplementation((...args) => {
            const session = connect(...args);
            session.ping = callback => {
                queueMicrotask(() => callback(Object.assign(new Error('synthetic ping failure'), { code: 'ERR_HTTP2_PING_CANCEL' })));
                return false;
            };
            return session;
        });
        const { url, state } = await target(stream => later(() => { stream.respond({ ':status': 200 }); stream.end('ok'); }, 100));
        const run = request(url);
        expect(await (await run.response).text()).toBe('ok');
        expect(state.requests).toBe(1);
        expect(run.onDiagnostic.mock.calls[0][0].pingError).toBe('ERR_HTTP2_PING_CANCEL');
    });

    test('retains backpressure and buffered bytes until the consumer finishes', async () => {
        const payload = Buffer.alloc(1024 * 1024, 's');
        const { url } = await target(stream => {
            stream.respond({ ':status': 200 });
            stream.end(payload);
        });
        const run = request(url);
        const response = await run.response;
        await delay(50);
        let length = 0;
        for await (const chunk of response.body) {
            length += chunk.length;
            await delay(1);
        }
        expect(length).toBe(payload.length);
        await until(() => run.onDiagnostic.mock.calls.length === 1);
        expect(run.onDiagnostic.mock.calls[0][0].bytes).toBe(payload.length);
    });

    test.each([400, 401, 403, 429, 500])('preserves HTTP %s and its body without retry', async status => {
        const { url, state } = await target(stream => {
            stream.respond({ ':status': status, 'content-type': 'application/json' });
            stream.end('{"error":{"message":"synthetic failure"}}');
        });
        const result = await request(url).response;
        expect(result.status).toBe(status);
        expect(result.ok).toBe(false);
        expect(await result.json()).toEqual({ error: { message: 'synthetic failure' } });
        expect(state.requests).toBe(1);
    });

    test('rejects a TLS certificate that is not trusted', async () => {
        const { url, state } = await target(() => {});
        const run = request(url, { ca: undefined });
        await expect(run.response).rejects.toHaveProperty('code', 'DEPTH_ZERO_SELF_SIGNED_CERT');
        expect(state.requests).toBe(0);
        expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
    });

    test('does not send a POST if HTTP/2 was not negotiated', async () => {
        const server = https.createServer({ key, cert }, () => { throw new Error('POST must not be sent'); });
        const port = await listen(server);
        const run = request('https://localhost:' + port);
        await expect(run.response).rejects.toHaveProperty('code', 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL');
    });

    test('pre-aborted requests never connect', async () => {
        const { url, state } = await target(() => {});
        const controller = new AbortController();
        controller.abort();
        const run = request(url, {}, { signal: controller.signal });
        await expect(run.response).rejects.toHaveProperty('name', 'AbortError');
        expect(state.requests).toBe(0);
        expect(sessions.size).toBe(0);
    });

    test.each(['headers', 'body'])('cancels while waiting for %s', async phase => {
        const { url, state } = await target(stream => {
            if (phase === 'body') { stream.respond({ ':status': 200 }); stream.write('data: partial\n\n'); }
        });
        const run = request(url);
        const result = run.response.then(response => response.text());
        await until(() => state.requests === 1);
        run.controller.abort();
        await expect(result).rejects.toHaveProperty('name', 'AbortError');
        await until(() => sessions.size === 0);
        expect(state.requests).toBe(1);
        expect(run.onDiagnostic.mock.calls[0][0].outcome).toBe('cancelled');
        expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
    });

    test('cancels abandoned response bodies', async () => {
        const { url } = await target(stream => { stream.respond({ ':status': 200 }); stream.write('start'); });
        const run = request(url);
        const response = await run.response;
        response.body.destroy();
        await until(() => run.onDiagnostic.mock.calls.length === 1 && sessions.size === 0);
        expect(run.onDiagnostic.mock.calls[0][0].outcome).toBe('cancelled');
    });

    test.each(['headers', 'body'])('reports reset before %s without replay', async phase => {
        const { url, state } = await target(stream => {
            if (phase === 'body') { stream.respond({ ':status': 200 }); stream.write('partial'); }
            later(() => stream.session.destroy(), 30);
        });
        const run = request(url);
        await expect(run.response.then(response => response.text())).rejects.toBeDefined();
        expect(state.requests).toBe(1);
        await until(() => run.onDiagnostic.mock.calls.length === 1);
        expect(run.onDiagnostic.mock.calls[0][0].outcome).toBe('error');
    });

    test('RST_STREAM fails the body instead of returning partial success', async () => {
        const { url, state } = await target(stream => {
            stream.respond({ ':status': 200 }); stream.write('partial');
            later(() => stream.destroy(new Error('synthetic reset')), 30);
        });
        await expect(request(url).response.then(response => response.text())).rejects.toBeDefined();
        expect(state.requests).toBe(1);
    });

    test('graceful GOAWAY lets an accepted stream finish', async () => {
        const { url, state } = await target(stream => {
            stream.respond({ ':status': 200 }); stream.write('start');
            stream.session.goaway(http2.constants.NGHTTP2_NO_ERROR, stream.id);
            later(() => stream.end('end'), 50);
        });
        expect(await (await request(url).response).text()).toBe('startend');
        expect(state.requests).toBe(1);
    });

    test('GOAWAY rejection fails without another POST', async () => {
        const { url, state } = await target(stream => stream.session.goaway(http2.constants.NGHTTP2_ENHANCE_YOUR_CALM, 0));
        await expect(request(url).response.then(response => response.text())).rejects.toBeDefined();
        expect(state.requests).toBe(1);
    });

    test.each(['timeout', 'cancel'])('cleans up a stalled TLS handshake on %s', async action => {
        const port = await listen(net.createServer());
        const run = request('https://localhost:' + port, { connectTimeoutMs: action === 'timeout' ? 40 : 2000 });
        if (action === 'cancel') later(() => run.controller.abort(), 30);
        await expect(run.response).rejects.toHaveProperty(action === 'cancel' ? 'name' : 'code', action === 'cancel' ? 'AbortError' : 'ETIMEDOUT');
        expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
    });

    test('concurrent and repeated requests own independent sessions', async () => {
        const { url, state } = await target(stream => later(() => { stream.respond({ ':status': 200 }); stream.end('ok'); }, 40));
        const runs = Array.from({ length: 6 }, () => request(url));
        expect(await Promise.all(runs.map(run => run.response.then(response => response.text())))).toEqual(Array(6).fill('ok'));
        await until(() => sessions.size === 0);
        expect(state.requests).toBe(6);
        expect(new Set(runs.map(run => run.onDiagnostic.mock.calls[0][0].id)).size).toBe(6);
        for (const run of runs) expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
    });

    test('invalid timing options fail before connecting', async () => {
        await expect(request('https://localhost', { pingIntervalMs: Infinity }).response).rejects.toThrow('positive finite');
    });
});

async function proxyServer({ secure = false, status = 200, stall = false } = {}) {
    const server = secure ? https.createServer({ key, cert }) : http.createServer();
    const state = { connections: 0, headers: null, path: null };
    server.on('connect', (req, client) => {
        state.connections++;
        state.headers = req.headers;
        state.path = req.url;
        if (stall) return;
        if (status !== 200) { client.end('HTTP/1.1 ' + status + ' Rejected\r\n\r\n'); return; }
        const port = Number(req.url.split(':').at(-1));
        const upstream = net.connect(port, '127.0.0.1', () => {
            client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            client.pipe(upstream).pipe(client);
        });
        sockets.add(upstream);
        upstream.on('error', () => client.destroy());
        upstream.once('close', () => { sockets.delete(upstream); client.destroy(); });
        client.once('close', () => upstream.destroy());
    });
    const port = await listen(server);
    return { url: (secure ? 'https' : 'http') + '://localhost:' + port, state };
}

describe('Vertex proxy routing and forwarding', () => {
    test.each([false, true])('HTTP%s CONNECT preserves authentication and target query', async secure => {
        const { url, state } = await target(stream => { stream.respond({ ':status': 200 }); stream.end('proxied'); });
        const proxy = await proxyServer({ secure });
        const proxyUrl = new URL(proxy.url);
        proxyUrl.username = 'synthetic';
        proxyUrl.password = 'p%40ss';
        const run = request(url, { proxyUrl: proxyUrl.toString() });
        expect(await (await run.response).text()).toBe('proxied');
        expect(proxy.state.connections).toBe(1);
        expect(proxy.state.headers['proxy-authorization']).toBe('Basic ' + Buffer.from('synthetic:p@ss').toString('base64'));
        expect(proxy.state.headers.authorization).toBeUndefined();
        expect(state.headers[0]['proxy-authorization']).toBeUndefined();
        expect(state.headers[0][':path']).toContain('?alt=sse');
    });

    test.each([407, 502])('proxy %s fails without a direct request', async status => {
        const { url, state } = await target(() => {});
        const proxy = await proxyServer({ status });
        await expect(request(url, { proxyUrl: proxy.url }).response).rejects.toHaveProperty('code', 'ERR_VERTEX_PROXY');
        expect(state.requests).toBe(0);
        expect(proxy.state.connections).toBe(1);
    });

    test.each(['timeout', 'cancel'])('cleans a stalled CONNECT on %s', async action => {
        const proxy = await proxyServer({ stall: true });
        const run = request('https://localhost:443', { proxyUrl: proxy.url, connectTimeoutMs: action === 'timeout' ? 40 : 2000 });
        if (action === 'cancel') later(() => run.controller.abort(), 30);
        await expect(run.response).rejects.toBeDefined();
        expect(proxy.state.connections).toBe(1);
        expect(getEventListeners(run.signal, 'abort')).toHaveLength(0);
    });

    test('selection retains custom filters, proxy bypass, and unsupported proxy protocols', async () => {
        const url = 'https://aiplatform.googleapis.com/v1/test';
        class FilteringAgent extends https.Agent {}
        expect(await getVertexHttp2Proxy(url, new FilteringAgent())).toBeNull();
        expect(await getVertexHttp2Proxy(url, new https.Agent())).toBe('');
        expect(await getVertexHttp2Proxy(url, new https.Agent({ ca: cert }))).toBeNull();
        const customConnection = new https.Agent();
        customConnection.createConnection = () => { throw new Error('custom policy'); };
        expect(await getVertexHttp2Proxy(url, customConnection)).toBeNull();
        const customProxyTls = new ProxyAgent({ ca: cert, getProxyForUrl: () => 'https://localhost:1234' });
        expect(await getVertexHttp2Proxy(url, customProxyTls)).toBeNull();
        customProxyTls.destroy();
        for (const value of ['http://localhost:1234', 'https://localhost:1234', '', 'socks5://localhost:1234', 'pac+http://localhost/proxy']) {
            const agent = new ProxyAgent({ getProxyForUrl: () => value });
            expect(await getVertexHttp2Proxy(url, agent)).toBe(value.startsWith('socks') || value.startsWith('pac') ? null : value);
            agent.destroy();
        }
        const filteredBypass = new ProxyAgent({ getProxyForUrl: () => '', httpsAgent: new FilteringAgent() });
        expect(await getVertexHttp2Proxy(url, filteredBypass)).toBeNull();
        filteredBypass.destroy();
        expect(await getVertexHttp2Proxy('https://aiplatform.googleapis.com.example.com/v1')).toBeNull();
        expect(await getVertexHttp2Proxy('http://aiplatform.googleapis.com/v1')).toBeNull();
        expect(await getVertexHttp2Proxy('https://us-central1-aiplatform.googleapis.com/v1', new https.Agent())).toBe('');
    });

    test('forwarding awaits late bytes and maps 401 without resetting browser authentication', async () => {
        const upstream = await target(stream => {
            stream.respond({ ':status': 401, 'content-type': 'application/json' });
            later(() => stream.end('{"error":"synthetic"}'), 50);
        });
        let finished = false;
        const port = await listen(http.createServer(async (_req, res) => {
            await forwardVertexResponse(await request(upstream.url).response, res);
            finished = true;
        }));
        const result = await fetch('http://127.0.0.1:' + port);
        expect(result.status).toBe(400);
        expect(await result.json()).toEqual({ error: 'synthetic' });
        await until(() => finished);
    });

    test('forwarding a broken stream rejects the browser body', async () => {
        const upstream = await target(stream => {
            stream.respond({ ':status': 200 });
            stream.write('data: partial\n\n');
            later(() => stream.destroy(new Error('synthetic reset')), 50);
        });
        let rejected = false;
        const port = await listen(http.createServer(async (_req, res) => {
            try { await forwardVertexResponse(await request(upstream.url).response, res); }
            catch { rejected = true; }
        }));
        await expect(fetch('http://127.0.0.1:' + port).then(response => response.text())).rejects.toBeDefined();
        await until(() => rejected);
    });
});

// Opt in for the real default interval; routine unit tests use accelerated waits.
const longIdleSuite = process.env.VERTEX_LONG_IDLE_TEST === '1' ? describe : describe.skip;
longIdleSuite('real default interval', () => {
    test('default 30s PING keeps a real 65s pre-header wait alive', async () => {
        const { url, state } = await target(stream => later(() => {
            stream.respond({ ':status': 200 });
            stream.end('data: {"tool":"synthetic complete"}\n\n');
        }, 65000));
        const run = request(url, { pingIntervalMs: undefined });
        expect(await (await run.response).text()).toBe('data: {"tool":"synthetic complete"}\n\n');
        expect(state.pings).toBe(2);
        expect(state.requests).toBe(1);
        await until(() => run.onDiagnostic.mock.calls.length === 1 && sessions.size === 0);
        expect(run.onDiagnostic.mock.calls[0][0]).toMatchObject({ pingsSent: 2, pingsAck: 2, outcome: 'eof' });
        expect(run.onDiagnostic.mock.calls[0][0].headersMs).toBeGreaterThanOrEqual(65000);
    }, 75000);
});
