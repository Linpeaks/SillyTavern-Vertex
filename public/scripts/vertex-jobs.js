import { chat, chat_metadata, characters, getCurrentChatId, getRequestHeaders, main_api, this_chid } from '../script.js';
import { selected_group } from './group-chats.js';
import { getChatCompletionModel, oai_settings } from './openai.js';
import { getCurrentUserHandle } from './user.js';
import { getStringHash, uuidv4 } from './utils.js';
import { isMobile } from './RossAscends-mods.js';
import { eventSource, event_types } from './events.js';
import { ToolManager } from './tool-calling.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import EventSourceStream from './sse-stream.js';

const api = '/api/backends/chat-completions/vertex-jobs';
const key = () => 'linpeak.vertex.job.' + getCurrentUserHandle();
const preference = () => key() + '.enabled';
const delivery = Symbol('vertex job');
let active;
let wake;
let pageId;
const element = id => document.getElementById(id);

function pending() {
    try { return JSON.parse(localStorage.getItem(key())); } catch { return null; }
}
function store(job) { localStorage.setItem(key(), JSON.stringify(job)); }
function update(job, phase) {
    job.phase = phase;
    if (pending()?.id === job.id) store(job);
}
function status(text) {
    const output = element('vertex_job_status');
    if (output.textContent !== text) output.textContent = text;
}
function chatKey() {
    const id = getCurrentChatId();
    pageId ??= uuidv4();
    return JSON.stringify([selected_group || '', characters[this_chid]?.avatar || '', id || pageId, chat_metadata.integrity || '']);
}
export function vertexChatAnchor(count = chat.length, last = chat[count - 1]) {
    return JSON.stringify([count, last?.send_date, last?.swipe_id, getStringHash(String(last?.mes ?? ''))]);
}
export function hasOriginalRegeneratedReply(job) {
    return job.type === 'regenerate' && job.replaced === vertexChatAnchor() && job.anchor === vertexChatAnchor(chat.length - 1);
}
function matches(job) {
    return job.chat === chatKey() && (job.anchor === vertexChatAnchor() || hasOriginalRegeneratedReply(job)) && main_api === 'openai'
        && oai_settings.chat_completion_source === 'vertexai' && getChatCompletionModel() === job.model;
}

export function backgroundVertexEnabled(type) {
    const pref = localStorage.getItem(preference());
    return (pref === null ? isMobile() : pref === 'true') && main_api === 'openai'
        && oai_settings.chat_completion_source === 'vertexai' && !oai_settings.reverse_proxy
        && [undefined, 'normal', 'regenerate'].includes(type);
}

export function hasPendingVertexJob() {
    const job = pending();
    return job && ['waiting', 'cancel', 'needs-tool', 'claimed'].includes(job.phase);
}

function controls() {
    const job = pending();
    element('vertex_job_bar').hidden = !active && !job;
    element('vertex_job_time').hidden = job?.phase !== 'waiting';
    element('vertex_job_cancel').hidden = !(job?.phase === 'waiting' || job?.phase === 'cancel');
    element('vertex_job_open').hidden = !!active || !job || ['cancel', 'expired'].includes(job.phase);
    element('vertex_job_dismiss').hidden = !job || !['claimed', 'delivered', 'needs-tool', 'expired'].includes(job.phase);
}

function url(job, suffix = '') { return api + '/' + encodeURIComponent(job.id) + suffix; }
function post(body) { return { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) }; }
async function checked(response) {
    if (response.ok) return response;
    const error = new Error(t`Vertex task returned HTTP ${response.status}.`);
    error.status = response.status;
    throw error;
}

// Only polling, downloading a saved result, and an idempotent claim can reconnect.
// The provider-starting POST is never repeated, including when its receipt is lost.
async function readWhileConnected(operation, job) {
    let retryMs = 1500;
    for (;;) {
        if (job.phase === 'cancel' || pending()?.phase === 'cancel') throw new DOMException('Stopped', 'AbortError');
        try { return await operation(); } catch (err) {
            if (!(err instanceof TypeError) && err.name !== 'TimeoutError') throw err;
            status(t`Connection lost. Reconnecting to the same task…`);
            await pause(retryMs);
            retryMs = Math.min(retryMs * 2, 15000);
        }
    }
}
function pause(ms) {
    return new Promise(resolve => {
        const timer = ms ? setTimeout(finish, ms) : null;
        function finish() { clearTimeout(timer); if (wake === finish) wake = null; resolve(); }
        wake = finish;
    });
}

async function stop(job = pending()) {
    if (!job?.id || ['claimed', 'delivered', 'expired'].includes(job.phase)) return;
    if (active?.id === job.id) active.phase = 'cancel';
    update(job, 'cancel');
    wake?.();
    status(t`Stopping the Vertex task…`);
    try {
        const res = await fetch(url(job), { method: 'DELETE', headers: getRequestHeaders(), signal: AbortSignal.timeout(15000) });
        if (!res.ok && res.status !== 404) await checked(res);
        if (pending()?.id === job.id) localStorage.removeItem(key());
        status('');
    } catch {
        status(t`Stop pending. Reconnect to confirm cancellation.`);
    }
    controls();
}

async function decodeResult(response, streamed) {
    if (!response.ok || !streamed) {
        const value = await response.json();
        if (!response.ok || value?.error) throw new Error(value?.error?.message || value?.message || t`Vertex generation failed.`);
        return value;
    }
    const parser = new EventSourceStream();
    const pipe = response.body.pipeTo(parser.writable);
    const parts = [];
    let finished = false;
    const reader = parser.readable.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value.data === '[DONE]') continue;
            const data = JSON.parse(value.data);
            if (data.error) throw new Error(data.error.message || t`Vertex generation failed.`);
            const candidate = data.candidates?.[0];
            if (candidate?.finishReason) finished = true;
            for (const part of candidate?.content?.parts || []) {
                const previous = parts.at(-1);
                if (typeof part.text === 'string' && typeof previous?.text === 'string'
                    && !!part.thought === !!previous.thought && !part.thoughtSignature && !part.functionCall && !part.inlineData) {
                    previous.text += part.text;
                } else parts.push(part);
            }
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
        await pipe.catch(() => {});
    }
    if (!finished || !parts.length) throw new Error(t`Vertex returned an incomplete reply.`);
    const content = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    return { choices: [{ message: { content } }], responseContent: { parts } };
}

async function result(job) {
    // Buffer a complete download before decoding or claiming it. A lost GET has no side effects.
    const response = await readWhileConnected(async () => {
        const res = await fetch(url(job, '/result'), { cache: 'no-store', signal: AbortSignal.timeout(90000) });
        if ([404, 409].includes(res.status) && !res.headers.get('content-type')?.includes('json')) await checked(res);
        return new Response(await res.arrayBuffer(), { status: res.status, headers: res.headers });
    }, job);
    return decodeResult(response, job.stream);
}

async function foreground(job) {
    while (document.hidden) {
        if (job.phase === 'cancel' || pending()?.phase === 'cancel') throw new DOMException('Stopped', 'AbortError');
        await pause();
    }
}

async function receive(job) {
    let meta;
    for (;;) {
        await foreground(job);
        meta = await readWhileConnected(async () => (await checked(await fetch(url(job), { cache: 'no-store', signal: AbortSignal.timeout(15000) }))).json(), job);
        if (!document.hidden) {
            const seconds = Math.max(0, Math.floor((Date.now() - job.started) / 1000));
            element('vertex_job_time').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
        }
        if (meta.state === 'ready') break;
        if (meta.state === 'claimed') {
            update(job, 'claimed');
            throw new Error(t`This result has already been picked up. You can view it without running tools again.`);
        }
        if (meta.state === 'failed') {
            update(job, 'expired');
            throw new Error(t`Vertex disconnected or exceeded the recovery limit.`);
        }
        status(meta.state === 'reserved' ? t`Waiting for submission confirmation…` : meta.tool ? t`Received a tool call. Waiting for completion…` : meta.thought ? t`Receiving model reasoning…`
            : meta.bytes ? t`Receiving the reply…` : job.stream ? t`Submitted. Waiting for the first model data…` : t`Submitted. Waiting for the complete reply…`);
        await pause(1000);
    }
    let data;
    try { data = await result(job); } catch (error) {
        if (error.name !== 'AbortError') update(job, 'expired');
        throw error;
    }
    if (!matches(job)) throw new Error(t`Open the original chat and model to receive this reply.`);
    await foreground(job);
    if (!matches(job)) throw new Error(t`The chat changed.`);
    const calls = data.responseContent?.parts?.filter(part => part.functionCall) || [];
    if (calls.length) {
        const names = new Set(ToolManager.tools.map(tool => tool.toFunctionOpenAI().function.name));
        if (!job.canPerformToolCalls || !ToolManager.canPerformToolCalls(job.type) || calls.some(part => !names.has(part.functionCall.name))) {
            update(job, 'needs-tool');
            throw new Error(t`The required tool is unavailable. Open the saved reply to read its complete arguments.`);
        }
    }
    const consumer = uuidv4();
    try {
        await readWhileConnected(async () => checked(await fetch(url(job, '/claim'), { ...post({ consumer }), signal: AbortSignal.timeout(15000) })), job);
    } catch (error) {
        if (error.status === 409) {
            update(job, 'claimed');
            throw new Error(t`This result has already been picked up. You can view it without running tools again.`);
        }
        throw error;
    }
    update(job, 'claimed');
    if (!matches(job)) throw new Error(t`The chat changed. The saved result is available to view.`);
    data[delivery] = job;
    status(t`Applying the completed reply…`);
    return data;
}

export async function runVertexJob(payload, options, signal) {
    if (active || hasPendingVertexJob()) throw new Error(t`A Vertex task is already pending.`);
    const job = { ...options, chat: chatKey(), anchor: vertexChatAnchor(), model: payload.model, stream: !!payload.stream, started: Date.now(), phase: 'waiting' };
    const previous = pending();
    if (previous?.phase === 'delivered' || previous?.phase === 'expired') {
        void fetch(url(previous), { method: 'DELETE', headers: getRequestHeaders() }).catch(() => {});
    }
    active = job;
    const cancel = () => { if (job.id && job.phase === 'waiting') void stop(job); };
    try {
        const res = await checked(await fetch(api, { ...post({}), signal: AbortSignal.timeout(15000) }));
        job.id = (await res.json()).id;
        store(job);
        controls();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) { await stop(job); throw new DOMException('Stopped', 'AbortError'); }
        if (!matches(job)) { await stop(job); throw new Error(t`The chat changed.`); }
        status(t`Submitting to Vertex…`);
        try {
            await checked(await fetch(url(job, '/start'), { ...post(payload), signal: AbortSignal.timeout(120000) }));
        } catch (err) {
            if (!(err instanceof TypeError) && err.name !== 'TimeoutError') throw err;
        }
        return await receive(job);
    } catch (error) {
        handleError(job, error);
        throw error;
    } finally {
        signal.removeEventListener('abort', cancel);
        active = null;
        controls();
    }
}

function handleError(job, error) {
    if (error.name === 'AbortError') return;
    if (error.status === 404 || error.status === 400 || error.status === 429) update(job, 'expired');
    const message = error.status === 404 ? t`Task expired or Termux restarted.` : error.message;
    status(message);
    if (!job.id) toastr.error(message);
    controls();
}

async function view(job) {
    const meta = await (await checked(await fetch(url(job), { cache: 'no-store', signal: AbortSignal.timeout(15000) }))).json();
    if (!['claimed', 'ready'].includes(meta.state)) {
        status(t`The result is not ready yet.`);
        return;
    }
    const data = await result(job);
    const field = document.createElement('textarea');
    field.readOnly = true;
    field.className = 'wide100p';
    field.rows = 15;
    field.value = JSON.stringify(data.responseContent || data, null, 2);
    await new Popup(field, POPUP_TYPE.TEXT).show();
}

export function initVertexJobs(applyRecovered) {
    const setting = element('vertex_job_enabled');
    setting.checked = localStorage.getItem(preference()) === null ? isMobile() : localStorage.getItem(preference()) === 'true';
    let initialized = false;
    eventSource.on(event_types.APP_READY, () => {
        setting.checked = localStorage.getItem(preference()) === null ? isMobile() : localStorage.getItem(preference()) === 'true';
        initialized = true;
    });
    setting.onchange = () => localStorage.setItem(preference(), String(setting.checked));
    element('vertex_job_cancel').onclick = () => stop(active || pending());
    element('vertex_job_dismiss').onclick = () => {
        const job = pending();
        if (!job || !['claimed', 'delivered', 'needs-tool', 'expired'].includes(job.phase)) return;
        localStorage.removeItem(key());
        void fetch(url(job), { method: 'DELETE', headers: getRequestHeaders() }).catch(() => {});
        status('');
        controls();
    };
    async function reconnect(manual = false) {
        wake?.();
        const job = pending();
        controls();
        if (!initialized || !job) return;
        if (job.phase === 'cancel') return stop(job);
        if (active) return;
        if (job.phase === 'expired') {
            status(t`Task expired or Termux restarted.`);
            if (manual) { localStorage.removeItem(key()); controls(); }
            return;
        }
        if (job.phase === 'needs-tool' && manual) {
            await view(job).catch(error => handleError(job, error));
            return;
        }
        if (job.phase === 'claimed' || job.phase === 'delivered') {
            status(t`Reply picked up. Saved copy available.`);
            if (manual) await view(job).catch(error => handleError(job, error));
            return;
        }
        if (!matches(job)) {
            status(t`Open the original chat and model to receive this reply.`);
            if (manual) await view(job).catch(error => handleError(job, error));
            return;
        }
        active = job;
        controls();
        try {
            await applyRecovered(job, async () => {
                const data = await receive(job);
                active = null;
                return data;
            });
        } catch (error) {
            handleError(job, error);
        } finally {
            if (active === job) active = null;
            controls();
        }
    }
    element('vertex_job_open').onclick = () => reconnect(true);
    for (const event of [event_types.APP_READY, event_types.CHAT_CHANGED, event_types.CHATCOMPLETION_MODEL_CHANGED]) {
        eventSource.on(event, () => { if (!document.hidden) void reconnect(); });
    }
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void reconnect(); });
    window.addEventListener('online', () => { void reconnect(); });
    window.addEventListener('storage', event => {
        if (event.key === key()) { wake?.(); controls(); }
    });
    controls();
}

export function finishVertexDelivery(data) {
    const job = data?.[delivery];
    if (!job) return;
    update(job, 'delivered');
    status(t`Reply picked up. Saved copy available.`);
    controls();
}

export function cancelVertexJob() { if (active?.id) void stop(active); }
