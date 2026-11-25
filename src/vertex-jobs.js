import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import express from 'express';
import { createVertexStreamObserver } from './vertex-stream-observer.js';

const lifetime = 60 * 60 * 1000;
const maxBytes = 16 * 1024 * 1024;
const blockSize = 64 * 1024;

// A real writable owns the provider connection even when every browser disconnects.
class VertexJobResponse extends Writable {
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

export function createVertexJobsRouter(generate) {
    const router = express.Router();
    const jobs = new Map();
    function expire(job, ms) {
        clearTimeout(job.timer);
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
        const job = { id: randomUUID(), owner, state: 'reserved', bytes: 0 };
        jobs.set(job.id, job);
        expire(job, 60000);
        res.status(201).json({ id: job.id });
    });
    router.use('/:id', (req, res, next) => {
        const job = jobs.get(req.params.id);
        if (!job || job.owner !== req.user.profile.handle) return res.sendStatus(404);
        res.locals.job = job;
        next();
    });
    router.post('/:id/start', (req, res) => {
        const job = res.locals.job;
        if (job.state !== 'reserved') return res.sendStatus(409);
        if (req.body?.chat_completion_source !== 'vertexai' || req.body.reverse_proxy ||
            !['express', 'full'].includes(req.body.vertexai_auth_mode || 'express')) return res.sendStatus(400);
        const sink = new VertexJobResponse(req.body.stream);
        job.sink = sink;
        job.state = 'running';
        expire(job, lifetime);
        sink.on('error', () => {}); // close handles both transport errors and explicit cancellation
        sink.once('close', () => {
            if (job.state !== 'running') return;
            job.state = sink.writableFinished ? 'ready' : 'failed';
            if (job.state === 'failed') sink.blocks = [];
            expire(job, lifetime);
        });
        res.sendStatus(202);
        Promise.resolve(generate(req, sink)).catch(() => sink.destroy());
    });
    router.get('/:id', (_req, res) => {
        const job = res.locals.job;
        const stats = job.sink?.observer?.summary();
        res.json({ state: job.state, bytes: job.sink?.bytes || 0,
            thought: !!stats?.thoughtParts, tool: !!stats?.toolParts, text: !!stats?.textParts });
    });
    router.get('/:id/result', (_req, res) => {
        const job = res.locals.job;
        if (!['ready', 'claimed'].includes(job.state)) return res.sendStatus(409);
        const sink = job.sink;
        res.status(sink.statusCode).type(sink.contentType).set('Content-Length', String(sink.bytes));
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
        job.state = 'removed';
        job.sink?.destroy();
        if (job.sink) job.sink.blocks = [];
        res.sendStatus(204);
    });
    return router;
}
