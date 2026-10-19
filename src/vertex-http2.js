import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Transform, pipeline } from 'node:stream';
import { pipeline as forward } from 'node:stream/promises';
import { ProxyAgent } from 'proxy-agent';
import { AbortError, Response } from 'node-fetch';

/**
 * Select HTTP/2 before submitting a generation. null means retain node-fetch
 * (custom agents/filters, SOCKS/PAC, or a non-native endpoint). '' means direct.
 * Resolve through the installed agent, not a second interpretation of proxy env.
 * @param {string} endpoint
 * @param {https.Agent | ProxyAgent} agent
 * @returns {Promise<string | null>}
 */
export async function getVertexHttp2Proxy(endpoint, agent = https.globalAgent) {
    // Do not bypass a filter, custom TLS trust, DNS lookup, or source routing.
    const hasCustomConnectionOptions = options => [
        'ca', 'cert', 'key', 'pfx', 'rejectUnauthorized', 'checkServerIdentity',
        'lookup', 'servername', 'localAddress', 'family',
    ].some(key => Object.hasOwn(options || {}, key));
    const isDefaultAgent = candidate => candidate.constructor === https.Agent
        && candidate.createConnection === https.Agent.prototype.createConnection
        && !hasCustomConnectionOptions(candidate.options);
    const url = new URL(endpoint);
    if (url.protocol !== 'https:' || url.username || url.password
        || (url.port && url.port !== '443')
        || !/^(?:[a-z0-9-]+-)?aiplatform\.googleapis\.com$/.test(url.hostname)) {
        return null;
    }
    if (agent instanceof ProxyAgent) {
        if (hasCustomConnectionOptions(agent.connectOpts)) return null;
        const proxy = await agent.getProxyForUrl(endpoint);
        if (!proxy) return isDefaultAgent(agent.httpsAgent) ? '' : null;
        return ['http:', 'https:'].includes(new URL(proxy).protocol) ? proxy : null;
    }
    return isDefaultAgent(agent) ? '' : null;
}

/**
 * One HTTPS HTTP/2 request, one session, no retries or redirects.
 * The returned Response owns its body until EOF, error, or cancellation.
 * No request/read timeout is imposed on a model that is still generating.
 * @param {string} endpoint
 * @param {object} init
 * @param {string} init.body Serialized JSON
 * @param {Record<string, string>} init.headers
 * @param {AbortSignal} init.signal
 * @param {object} [options]
 * @param {string} [options.proxyUrl] Empty for direct/TUN routing
 * @param {number} [options.pingIntervalMs]
 * @param {number} [options.connectTimeoutMs]
 * @param {string | Buffer} [options.ca] Additional trust for local TLS tests
 * @param {function(object): void} [options.onDiagnostic] Receives metadata only
 * @returns {Promise<Response>}
 */
export function fetchVertexHttp2(endpoint, { body, headers, signal }, {
    proxyUrl = '',
    pingIntervalMs = 30000,
    connectTimeoutMs = 30000,
    ca,
    onDiagnostic = summary => console.info('[Vertex HTTP/2]', summary),
} = {}) {
    return new Promise((resolve, reject) => {
        if (![pingIntervalMs, connectTimeoutMs].every(value => Number.isFinite(value) && value > 0 && value <= 2147483647)) {
            reject(new RangeError('Vertex HTTP/2 intervals must be positive finite milliseconds'));
            return;
        }
        const url = new URL(endpoint);
        if (url.protocol !== 'https:') {
            reject(new Error('Vertex HTTP/2 requires HTTPS'));
            return;
        }
        let session;
        let stream;
        let socket;
        let tunnel;
        let pingTimer;
        let setupTimer;
        let stopped = false;
        let receivedHeaders = false;
        let pendingPing = false;
        const started = performance.now();
        let lastActivity = started;
        const stats = {
            id: randomUUID(), route: proxyUrl ? new URL(proxyUrl).protocol : 'direct',
            phase: 'connect', headersMs: null, firstDataMs: null, lastDataMs: null,
            bytes: 0, pingsSent: 0, pingsAck: 0,
        };
        const responseBody = new Transform({
            transform(chunk, encoding, callback) {
                lastActivity = performance.now();
                stats.firstDataMs ??= Math.round(lastActivity - started);
                stats.lastDataMs = Math.round(lastActivity - started);
                stats.bytes += chunk.length;
                stats.phase = 'body';
                callback(null, chunk);
            },
        });
        // Failure may precede the consumer attaching to the returned body.
        responseBody.on('error', () => {});

        function finish(error) {
            if (stopped) return;
            stopped = true;
            clearTimeout(setupTimer);
            clearTimeout(pingTimer);
            signal?.removeEventListener('abort', abort);
            if (error) {
                responseBody.destroy(error);
                stream?.destroy(error);
                session?.destroy();
                tunnel?.destroy();
                socket?.destroy();
                reject(error);
            } else {
                // Only reached by pipeline after the upstream body has ended.
                // Buffered response bytes remain readable by the consumer.
                session?.close();
            }
            onDiagnostic({
                ...stats, elapsedMs: Math.round(performance.now() - started),
                ...(stream ? { rstCode: stream.rstCode } : {}),
                outcome: error ? (error.name === 'AbortError' ? 'cancelled' : 'error') : 'eof',
                ...(error ? { code: error.code || error.name } : {}),
            });
        }

        function fail(code, message) {
            finish(Object.assign(new Error(message), { code }));
        }

        function abort() {
            finish(new AbortError('Vertex request cancelled'));
        }

        responseBody.once('close', () => {
            if (!stopped && !responseBody.readableEnded) abort();
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
            abort();
            return;
        }
        setupTimer = setTimeout(() => fail('ETIMEDOUT', 'Vertex connection setup timed out'), connectTimeoutMs);
        setupTimer.unref();

        function startSession(connectedSocket) {
            socket = connectedSocket;
            socket.on('error', finish);
            socket.once('close', () => {
                if (!session && !stopped) fail('ECONNRESET', 'Vertex TLS connection closed before HTTP/2 setup');
            });
            socket.once('secureConnect', () => {
                if (stopped) return;
                if (socket.alpnProtocol !== 'h2') {
                    fail('ERR_HTTP2_ALPN', 'Vertex endpoint did not negotiate HTTP/2');
                    return;
                }
                session = http2.connect(url.origin, {
                    createConnection: () => socket,
                    maxOutstandingPings: 1,
                });
                session.on('error', finish);
                session.on('goaway', (code, lastStreamID) => {
                    stats.goawayCode = code;
                    // Graceful GOAWAY may allow this already-accepted stream to finish.
                    if (code !== 0 || !stream?.id || stream.id > lastStreamID) {
                        fail('ERR_HTTP2_GOAWAY_SESSION', 'Vertex HTTP/2 peer rejected the active stream');
                    }
                });
                session.once('close', () => {
                    if (!stopped) fail('ECONNRESET', 'Vertex HTTP/2 session closed before response completion');
                });
                session.once('connect', () => {
                    if (stopped) return;
                    clearTimeout(setupTimer);
                    stats.connectMs = Math.round(performance.now() - started);
                    lastActivity = performance.now();
                    try {
                        const requestHeaders = {
                            ...Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])),
                            ':method': 'POST',
                            ':path': url.pathname + url.search,
                            'accept-encoding': 'identity',
                        };
                        stream = session.request(requestHeaders);
                        stats.phase = 'headers';
                        stream.on('error', finish);
                        stream.once('aborted', () => {
                            stats.rstCode = stream.rstCode;
                            fail('ECONNRESET', 'Vertex HTTP/2 response was aborted');
                        });
                        stream.once('close', () => {
                            stats.rstCode = stream.rstCode;
                            if (!receivedHeaders && !stopped) {
                                fail('ECONNRESET', 'Vertex stream closed before response headers');
                            }
                        });
                        stream.once('response', responseHeaders => {
                            if (stopped) return;
                            receivedHeaders = true;
                            lastActivity = performance.now();
                            stats.headersMs = Math.round(lastActivity - started);
                            stats.status = Number(responseHeaders[':status']);
                            // We request identity encoding so raw SSE bytes remain intact.
                            const encoding = responseHeaders['content-encoding'];
                            if (encoding && encoding !== 'identity') {
                                fail('ERR_VERTEX_ENCODING', 'Unexpected compressed Vertex response');
                                return;
                            }
                            const normalHeaders = Object.fromEntries(Object.entries(responseHeaders).filter(([key]) => !key.startsWith(':')));
                            resolve(new Response(responseBody, {
                                status: stats.status, statusText: http.STATUS_CODES[stats.status] || '',
                                headers: normalHeaders,
                            }));
                            pipeline(stream, responseBody, error => finish(error || undefined));
                        });
                        function pingWhenIdle() {
                            if (stopped || session.closed || session.destroyed) return;
                            const remaining = pingIntervalMs - (performance.now() - lastActivity);
                            if (remaining > 0 || pendingPing) {
                                pingTimer = setTimeout(pingWhenIdle, Math.max(1, remaining > 0 ? remaining : pingIntervalMs));
                                pingTimer.unref();
                                return;
                            }
                            pendingPing = true;
                            // PING failure is diagnostic, not permission to replay a POST.
                            try {
                                const sent = session.ping(error => {
                                    pendingPing = false;
                                    if (!error) stats.pingsAck++;
                                    else stats.pingError = error.code || error.name;
                                });
                                if (sent) stats.pingsSent++;
                                else pendingPing = false;
                            } catch (error) {
                                pendingPing = false;
                                stats.pingError = error.code || error.name;
                            }
                            pingTimer = setTimeout(pingWhenIdle, pingIntervalMs);
                            pingTimer.unref();
                        }
                        pingTimer = setTimeout(pingWhenIdle, pingIntervalMs);
                        pingTimer.unref();
                        stream.end(body);
                    } catch (error) {
                        finish(error);
                    }
                });
            });
        }

        try {
            const tlsOptions = { servername: url.hostname, ALPNProtocols: ['h2'], rejectUnauthorized: true, ...(ca ? { ca } : {}) };
            if (!proxyUrl) {
                startSession(tls.connect({ ...tlsOptions, host: url.hostname, port: Number(url.port || 443) }));
                return;
            }
            const proxy = new URL(proxyUrl);
            if (!['http:', 'https:'].includes(proxy.protocol)) {
                fail('ERR_VERTEX_PROXY', 'HTTP/2 transport requires an HTTP or HTTPS proxy');
                return;
            }
            const authority = url.hostname + ':' + (url.port || '443');
            const proxyHeaders = { Host: authority };
            if (proxy.username || proxy.password) {
                proxyHeaders['Proxy-Authorization'] = 'Basic ' + Buffer.from(
                    decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password),
                ).toString('base64');
            }
            tunnel = (proxy.protocol === 'https:' ? https : http).request({
                hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
                method: 'CONNECT', path: authority, headers: proxyHeaders,
                agent: false, rejectUnauthorized: true, ...(ca ? { ca } : {}),
            });
            tunnel.on('error', finish);
            tunnel.once('connect', (response, rawSocket, head) => {
                if (stopped) { rawSocket.destroy(); return; }
                socket = rawSocket;
                if (response.statusCode !== 200 || head.length) {
                    fail('ERR_VERTEX_PROXY', 'Vertex proxy CONNECT failed (' + response.statusCode + ')');
                    return;
                }
                startSession(tls.connect({ ...tlsOptions, socket: rawSocket }));
            });
            tunnel.end();
        } catch (error) {
            finish(error);
        }
    });
}

/**
 * Await actual forwarding completion. A transport error destroys the browser
 * response instead of turning a truncated SSE stream into a successful EOF.
 * @param {Response} from
 * @param {import('express').Response} to
 */
export async function forwardVertexResponse(from, to) {
    to.statusCode = from.status === 401 ? 400 : from.status;
    to.statusMessage = from.statusText;
    to.setHeader('Content-Type', from.headers.get('content-type') || (from.ok ? 'text/event-stream' : 'application/json'));
    if (from.body) await forward(from.body, to);
    else to.end();
}
