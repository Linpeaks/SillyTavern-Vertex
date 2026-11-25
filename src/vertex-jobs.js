import fs from 'node:fs';
import { prepareChatTarget, saveCompletedMessage, hasSavedMessage, recoveryFile, storeRecovery } from './generation-chat-storage.js';
import { generationChatMessage } from './generation-chat-message.js';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { pipeline } from 'node:stream/promises';
import express from 'express';
import { createVertexStreamObserver } from './vertex-stream-observer.js';

const lifetime = 60 * 60 * 1000;
const maxBytes = 16 * 1024 * 1024;
const blockSize = 64 * 1024;

// A real writable owns the provider connection even when every browser disconnects.
class JobConnection extends EventEmitter {
    closed = false;

    on(event, listener) {
        if (event === 'close' && this.closed) { listener(); return this; }
        return super.on(event, listener);
    }

    disconnect() {
        this.closed = true;
        this.emit('close');
        this.removeAllListeners();
    }
}

class GenerationJobResponse extends Writable {
    socket = new JobConnection();

    statusCode = 200;
    contentType = 'application/json';
    bytes = 0;
    blocks = [];
    started = Date.now();
    observer;
    inspectChunks;

    constructor(stream) {
        super();
        this.inspectChunks = stream;
    }

    useStreamObserver(observer) {
        this.observer = observer;
        this.inspectChunks = false;
    }

    get headersSent() { return this.bytes > 0 || this.writableEnded; }
    status(code) { this.statusCode = code; return this; }
    setHeader(name, value) {
        if (name.toLowerCase() === 'content-type') this.contentType = value;
    }
    send(value) { this.end(JSON.stringify(value)); }
    json(value) { this.send(value); }
    sendStatus(code) { this.status(code).send({ error: true }); }
    async forwardBody(body) { await pipeline(body, this); }

    _write(chunk, encoding, callback) {
        if (this.bytes + chunk.length > maxBytes) return callback(new Error('Reply exceeded the 16 MiB recovery limit.'));
        if (this.inspectChunks) {
            this.observer ??= createVertexStreamObserver();
            this.observer.write(chunk, Date.now() - this.started);
        }
        for (let i = 0; i < chunk.length;) {
            const offset = this.bytes % blockSize;
            if (!offset) this.blocks.push(Buffer.allocUnsafe(blockSize));
            const copied = chunk.copy(this.blocks.at(-1), offset, i, i + blockSize - offset);
            this.bytes += copied;
            i += copied;
        }
        callback();
    }
}

export function createGenerationJobsRouter(handlers) {
    const router = express.Router();
    const jobs = new Map();
    function expire(job, ms) {
        clearTimeout(job.timer);
        job.expiresAt = Date.now() + ms;
        job.timer = setTimeout(() => {
            job.state = 'expired';
            job.sink?.destroy();
            if (job.sink) job.sink.blocks = [];
            jobs.delete(job.id);
        }, ms).unref();
    }
    router.use((req, res, next) => {
        res.set('Cache-Control', 'no-store');
        if (!req.user?.profile?.handle) return res.sendStatus(403);
        next();
    });
    router.post('/', (req, res) => {
        const owner = req.user.profile.handle;
        if (jobs.size >= 12 || [...jobs.values()].filter(job => job.owner === owner).length >= 4) return res.sendStatus(429);
        let target;
        if (req.body?.target) {
            try {
                target = prepareChatTarget(req.user.directories, req.body.target);
            } catch {
                return res.status(409).json({ error: 'original_chat_changed' });
            }
        }
        const job = { id: randomUUID(), owner, target, state: 'reserved', bytes: 0 };
        jobs.set(job.id, job);
        expire(job, 60000);
        res.status(201).json({ id: job.id });
    });
    router.post('/saved/:id', (req, res) => {
        const saved = hasSavedMessage(req.user.directories, req.body, req.params.id);
        return res.json({ saved });
    });
    router.use('/:id', (req, res, next) => {
        const job = jobs.get(req.params.id);
        if (!job) {
            const file = recoveryFile(req.user.directories, req.params.id);
            if (!file || !fs.existsSync(file)) return res.sendStatus(404);
            res.locals.job = { id: req.params.id, state: 'conflict', file };
            return next();
        }
        if (job.owner !== req.user.profile.handle) return res.sendStatus(404);
        res.locals.job = job;
        next();
    });
    router.post('/:id/start', (req, res) => {
        const job = res.locals.job;
        if (job.state !== 'reserved') return res.sendStatus(409);
        const transport = req.query.transport ?? 'openai';
        if (typeof transport !== 'string' || !Object.hasOwn(handlers, transport) || !req.body) return res.sendStatus(400);
        const google = transport === 'openai' && ['vertexai', 'makersuite'].includes(req.body.chat_completion_source);
        const sink = new GenerationJobResponse(google && req.body.stream);
        // Provider handlers observe the lifetime of the job, independently of the control POST.
        const request = Object.create(req, {
            socket: { value: sink.socket },
            generationJob: { value: true },
        });
        job.sink = sink;
        job.state = 'running';
        expire(job, lifetime);
        sink.on('error', () => {}); // close handles both transport errors and explicit cancellation
        const format = { id: job.id, started: sink.started, mainApi: transport, source: req.body.chat_completion_source || job.target?.source || req.body.api_type || transport,
            model: req.body.model || req.body.models?.join(', ') || job.target?.model, stream: !!(req.body.stream ?? req.body.streaming),
            textGenType: req.body.api_type, showThoughts: job.target?.showThoughts };
        const user = req.user;
        sink.once('close', async () => {
            if (!sink.writableFinished) sink.socket.disconnect();
            else sink.socket.removeAllListeners();
            if (job.state !== 'running') return;
            job.state = sink.writableFinished ? 'ready' : 'failed';
            if (job.state === 'failed') sink.blocks = [];
            if (job.target && job.state === 'ready' && sink.statusCode >= 200 && sink.statusCode < 300) {
                job.state = 'saving';
                const body = Buffer.concat(sink.blocks, sink.bytes);
                let copy;
                try {
                    copy = generationChatMessage(body, { ...job.target, ...format, finished: Date.now() });
                    job.saved = await saveCompletedMessage(user, job.target, copy, () => job.state === 'saving');
                } catch {
                    // Preserve a completed but unrecognized wire format for inspection.
                    copy ??= { api: format.source, model: format.model, raw: body.toString('utf8') };
                }
                if (job.state !== 'saving') return;
                job.state = 'ready';
                if (!job.saved) {
                    try {
                        storeRecovery(user.directories, job.id, copy);
                        job.file = recoveryFile(user.directories, job.id);
                        job.state = 'conflict';
                        sink.blocks = [];
                    } catch (error) {
                        // A disk error still permits foreground delivery from the memory cache.
                        job.saveFailed = true;
                        console.warn('Background reply could not be written:', error.code || error.name);
                    }
                }
            }
            expire(job, lifetime);
        });
        res.sendStatus(202);
        Promise.resolve(handlers[transport](request, sink)).catch(() => sink.destroy());
    });
    router.get('/:id', (_req, res) => {
        const job = res.locals.job;
        const stats = job.sink?.observer?.summary();
        res.json({ state: job.state, saved: !!job.saved, saveFailed: !!job.saveFailed, expiresAt: job.expiresAt, bytes: job.sink?.bytes || 0,
            thought: !!stats?.thoughtParts, tool: !!stats?.toolParts, text: !!stats?.textParts });
    });
    router.get('/:id/result', (_req, res) => {
        const job = res.locals.job;
        if (job.state === 'conflict') return res.type('application/json').send(fs.readFileSync(job.file));
        if (!['ready', 'claimed'].includes(job.state)) return res.sendStatus(409);
        const sink = job.sink;
        res.status(sink.statusCode).type(sink.contentType).set('X-Linpeak-Job-Result', '1').set('Content-Length', String(sink.bytes));
        let remaining = sink.bytes;
        for (const block of sink.blocks) {
            const size = Math.min(remaining, blockSize);
            res.write(block.subarray(0, size));
            remaining -= size;
        }
        res.end();
    });
    router.post('/:id/claim', (req, res) => {
        const job = res.locals.job;
        const consumer = req.body?.consumer;
        if (typeof consumer !== 'string' || !/^[\da-f-]{36}$/i.test(consumer)) return res.sendStatus(400);
        if (job.state !== 'ready' && !(job.state === 'claimed' && job.consumer === consumer)) return res.sendStatus(409);
        job.state = 'claimed';
        job.consumer = consumer;
        res.sendStatus(204);
    });
    router.delete('/:id', (_req, res) => {
        const job = res.locals.job;
        clearTimeout(job.timer);
        jobs.delete(job.id);
        if (job.file) fs.rmSync(job.file, { force: true });
        job.state = 'removed';
        job.sink?.destroy();
        if (job.sink) job.sink.blocks = [];
        res.sendStatus(204);
    });
    return router;
}
