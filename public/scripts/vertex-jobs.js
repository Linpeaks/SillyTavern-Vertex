import { chat, chat_metadata, characters, name2, deleteLastMessage, reloadCurrentChat, getCurrentChatId, getRequestHeaders, getGeneratingApi, getGeneratingModel, main_api, this_chid } from '../script.js';
import { chatAnchor } from './util/chat-anchor.js';
import { horde_settings } from './horde.js';
import { selected_group, group_generation_id } from './group-chats.js';
import { getStreamingReply, oai_settings } from './openai.js';
import { resolveSecretKey, secret_state } from './secrets.js';
import { getTextGenServer } from './textgen-settings.js';
import { getCurrentUserHandle } from './user.js';
import { getStringHash, uuidv4 } from './utils.js';
import { isMobile } from './RossAscends-mods.js';
import { eventSource, event_types } from './events.js';
import { ToolManager } from './tool-calling.js';
import { Popup, POPUP_TYPE } from './popup.js';
import { t } from './i18n.js';
import EventSourceStream from './sse-stream.js';

const api = '/api/backends/chat-completions/generation-jobs';
const key = () => 'linpeak.vertex.job.' + getCurrentUserHandle();
const preference = () => key() + '.enabled';
const delivery = Symbol('generation job');
const streamDetails = Symbol('streamed result');
export const savedChatReply = Symbol('reply already in the chat file');
export const generationOrigin = data => data?.[delivery];
export const generationStreamDetails = data => data?.[streamDetails];
let active;
let wake;
let pageId;
const element = id => document.getElementById(id);

function pending() {
    try {
        const job = JSON.parse(localStorage.getItem(key()));
        return job ? { mainApi: 'openai', source: 'vertexai', ...job } : null;
    } catch { return null; }
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
    return chatAnchor(count, last);
}
export function hasOriginalRegeneratedReply(job) {
    return job.type === 'regenerate' && job.replaced === vertexChatAnchor() && job.anchor === vertexChatAnchor(chat.length - 1);
}
function sameChat(job) {
    if (job.target?.group) return String(selected_group) === String(JSON.parse(job.chat)[0]) && getCurrentChatId() === job.target.file && chat_metadata.integrity === job.target.integrity;
    return job.chat === chatKey();
}

function autosavedTail(job) {
    const last = chat.at(-1);
    return last?.extra?.linpeak_job === job.id && last.extra.linpeak_autosaved && chat_metadata.linpeak_revision === job.id
        && job.anchor === vertexChatAnchor(chat.length - 1);
}

function matches(job) {
    return sameChat(job) && (job.anchor === vertexChatAnchor() || hasOriginalRegeneratedReply(job) || autosavedTail(job));
}

export function acceptSavedRevision(job) {
    if (job?.saved && sameChat(job)) chat_metadata.linpeak_revision = job.id;
}

export function savedRevisionAcknowledged(job) {
    return !job?.saved || (sameChat(job) && !!chat_metadata.linpeak_revision && chat_metadata.linpeak_revision !== job.id);
}

function makeTarget(job) {
    const file = getCurrentChatId();
    if (!file || !chat_metadata.integrity) return;
    return { file, name: name2, avatar: characters[this_chid]?.avatar || '', group: !!selected_group,
        groupGenerationId: group_generation_id, integrity: chat_metadata.integrity, revision: chat_metadata.linpeak_revision,
        anchor: job.anchor, replaced: job.replaced, type: job.type || 'normal', source: job.source, model: job.model, showThoughts: job.showThoughts };
}

async function alreadyWritten(job) {
    if (!job.target) return false;
    if (sameChat(job) && chat.some(message => message.extra?.linpeak_job === job.id)) return true;
    const res = await checked(await fetch(api + '/saved/' + encodeURIComponent(job.id), { ...post(job.target), signal: AbortSignal.timeout(15000) }));
    return (await res.json()).saved;
}

async function showSaved(job, canFinishLater = false) {
    update(job, canFinishLater ? 'stored' : 'saved');
    status(t`Reply saved in the original chat.`);
    // A suspended page may still show yesterday's pre-generation snapshot.
    if (matches(job) && !chat.some(message => message.extra?.linpeak_job === job.id)) await reloadCurrentChat();
    controls();
    return savedChatReply;
}

function connectionKey() {
    const source = getGeneratingApi();
    const settings = oai_settings;
    let endpoint;
    if (main_api === 'koboldhorde') endpoint = horde_settings.models;
    else if (main_api === 'textgenerationwebui') endpoint = getTextGenServer();
    else if (main_api === 'kobold') endpoint = element('api_url_text')?.value;
    else if (main_api === 'openai') {
        endpoint = [settings.reverse_proxy || ''];
        if (source === 'custom') endpoint.push(settings.custom_url || '');
        if (source === 'azure_openai') endpoint.push(settings.azure_base_url || '', settings.azure_deployment_name || '');
        if (source === 'vertexai') endpoint.push(settings.vertexai_region || 'global', settings.vertexai_auth_mode || 'express', settings.vertexai_express_project_id || '');
    }
    const secret = resolveSecretKey();
    const entries = secret_state[secret];
    const activeId = Array.isArray(entries) ? entries.find(entry => entry.active)?.id : null;
    const revision = secret ? localStorage.getItem(key() + '.revision.' + secret) : null;
    const selectedModel = main_api === 'koboldhorde' ? '' : getGeneratingModel();
    return getStringHash(JSON.stringify([main_api, source, selectedModel || '', endpoint, activeId || null, revision]));
}
export function isOriginalConnection(job) {
    if (!job) return true;
    if (job.connection !== undefined) return job.source === getGeneratingApi() && job.connection === connectionKey();
    return main_api === job.mainApi && getGeneratingApi() === job.source && getGeneratingModel() === job.model;
}

export function captureGenerationOrigin() {
    return { mainApi: main_api, source: getGeneratingApi(), model: getGeneratingModel(), connection: connectionKey(),
        showThoughts: !!oai_settings.show_thoughts, chat: chatKey(), anchor: vertexChatAnchor() };
}

export function backgroundGenerationEnabled(type) {
    const pref = localStorage.getItem(preference());
    return (pref === null ? isMobile() : pref === 'true') && ['openai', 'textgenerationwebui', 'kobold', 'novel', 'koboldhorde'].includes(main_api)
        && [undefined, 'normal', 'regenerate'].includes(type);
}

export function hasPendingVertexJob() {
    const job = pending();
    return job && ['waiting', 'cancel', 'needs-tool', 'claimed', 'conflict'].includes(job.phase);
}

function controls() {
    const job = pending();
    element('vertex_job_bar').hidden = !active && !job;
    element('generation_job_origin').textContent = job ? [job.source, job.model].filter(Boolean).join(' · ') : '';
    element('vertex_job_time').hidden = job?.phase !== 'waiting';
    const expiry = element('generation_job_expiry');
    expiry.hidden = !job?.resultExpiresAt || !['delivered', 'claimed', 'needs-tool'].includes(job.phase);
    if (!expiry.hidden) {
        const time = new Date(job.resultExpiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        expiry.textContent = t`Temporary copy until ${time}`;
    }
    element('vertex_job_cancel').hidden = !(job?.phase === 'waiting' || job?.phase === 'cancel');
    element('vertex_job_open').hidden = !!active || !job || ['cancel', 'expired', 'saved', 'stored'].includes(job.phase);
    element('vertex_job_dismiss').hidden = !job || !['claimed', 'delivered', 'needs-tool', 'expired', 'saved', 'stored', 'conflict'].includes(job.phase);
}

function url(job, suffix = '') { return api + '/' + encodeURIComponent(job.id) + suffix; }
function post(body) { return { method: 'POST', headers: getRequestHeaders(), body: JSON.stringify(body) }; }
async function checked(response) {
    if (response.ok) return response;
    const error = new Error(t`Generation task returned HTTP ${response.status}.`);
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
            const temporary = [408, 425, 429, 502, 503, 504].includes(err.status);
            if (!temporary && !(err instanceof TypeError) && err.name !== 'TimeoutError') throw err;
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
    status(t`Stopping the generation…`);
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

async function decodeResult(response, bytes, job) {
    const prefix = new TextDecoder().decode(bytes.slice(0, 256)).trimStart();
    if (!response.ok || !job.stream || prefix.startsWith('{') || prefix.startsWith('[')) {
        const body = new TextDecoder().decode(bytes);
        let value;
        try {
            value = JSON.parse(body);
        } catch {
            throw new Error(response.ok ? t`The provider returned an incomplete reply.` : t`Generation task returned HTTP ${response.status}.`);
        }
        if (!response.ok || value?.error) throw new Error(value?.error?.message || value?.message || value?.response || t`Generation failed.`);
        return value;
    }
    const parser = new EventSourceStream();
    const pipe = new Response(bytes).body.pipeTo(parser.writable);
    const google = ['vertexai', 'makersuite'].includes(job.source);
    const parts = [];
    const toolCalls = [];
    const choices = [];
    const state = { reasoning: '', images: [], signature: '', toolSignatures: {} };
    let finished = false;
    const reader = parser.readable.getReader();
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value.data === '[DONE]') { if (!google) finished = true; continue; }
            const data = JSON.parse(value.data);
            if (data.error) throw new Error(data.error.message || t`Generation failed.`);
            if (job.mainApi !== 'openai') {
                const variants = data.choices?.length ? data.choices : [data];
                for (const variant of variants) {
                    const index = variant.index || 0;
                    if (!Number.isSafeInteger(index) || index < 0 || index > 127) throw new Error('Invalid streamed choice index');
                    choices[index] = (choices[index] || '') + (variant.text ?? variant.delta?.content ?? variant.token ?? variant.content ?? '');
                    if (!index) state.reasoning += variant.reasoning ?? variant.delta?.reasoning ?? variant.delta?.reasoning_content ?? variant.thinking ?? '';
                }
                continue;
            }
            if (!google) {
                if (data.type === 'message_stop' || data.type === 'message-end' || data.choices?.some(c => !c.index && c.finish_reason)) finished = true;
                const fragments = data.choices?.length ? data.choices.map(choice => ({ chunk: { ...data, choices: [choice] }, index: choice.index || 0 })) : [{ chunk: data, index: 0 }];
                for (const { chunk, index } of fragments) {
                    if (!Number.isSafeInteger(index) || index < 0 || index > 127) throw new Error('Invalid streamed choice index');
                    choices[index] = (choices[index] || '') + getStreamingReply(chunk, index ? { reasoning: '', images: [], toolSignatures: {} } : state, {
                        chatCompletionSource: job.source, overrideShowThoughts: !index && job.showThoughts,
                    });
                }
                if (data.type !== 'message-start' || data.delta?.message?.tool_calls) {
                    ToolManager.parseToolCalls(toolCalls, data, state.toolSignatures, true);
                }
                continue;
            }
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
    if (job.mainApi !== 'openai') {
        if (!choices.length) throw new Error(t`The provider returned an incomplete reply.`);
        const result = job.mainApi === 'kobold' ? { results: [{ text: choices[0] }] } : job.mainApi === 'novel' ? { output: choices[0] }
            : job.textGenType === 'llamacpp' ? Array.from(choices, text => ({ content: text || '' }))
                : { choices: Array.from(choices, (text, index) => ({ text: text || '', index })) };
        result[streamDetails] = state;
        return result;
    }
    if (!google) {
        const calls = ToolManager.getToolCallsFromData(toolCalls, true) || [];
        if ((!choices[0] && !state.reasoning && !state.images.length && !calls.length) || (calls.length && !finished)) {
            throw new Error(t`The provider returned an incomplete reply.`);
        }
        const result = { choices: Array.from(choices, (content, index) => ({ index, message: { content: content || '' } })) };
        if (calls.length) {
            for (const call of calls) {
                if (!call?.function?.name) throw new Error(t`The provider returned an incomplete reply.`);
                if (typeof call.function.arguments === 'string' && call.function.arguments) JSON.parse(call.function.arguments);
            }
            result.choices[0].message.tool_calls = calls;
        }
        result[streamDetails] = state;
        return result;
    }
    if (!finished || !parts.length) throw new Error(t`The provider returned an incomplete reply.`);
    const content = parts.filter(p => !p.thought && typeof p.text === 'string').map(p => p.text).join('');
    return { choices: [{ message: { content } }], responseContent: { parts } };
}

async function result(job) {
    // Buffer a complete download before decoding or claiming it. A lost GET has no side effects.
    const { res, bytes } = await readWhileConnected(async () => {
        const res = await fetch(url(job, '/result'), { cache: 'no-store', signal: AbortSignal.timeout(90000) });
        if (!res.ok && !res.headers.has('X-Linpeak-Job-Result')) await checked(res);
        return { res, bytes: await res.arrayBuffer() };
    }, job);
    return decodeResult(res, bytes, job);
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
        try {
            meta = await readWhileConnected(async () => (await checked(await fetch(url(job), { cache: 'no-store', signal: AbortSignal.timeout(15000) }))).json(), job);
        } catch (error) {
            if (error.status === 404 && await readWhileConnected(() => alreadyWritten(job), job)) return showSaved(job);
            throw error;
        }
        if (meta.state === 'conflict') {
            update(job, 'conflict');
            throw new Error(t`The reply was kept in a recovery copy. Open it to read the result.`);
        }
        job.saved = !!meta.saved;
        if (job.saved && (!matches(job) || meta.state === 'claimed')) return showSaved(job, meta.state === 'ready');
        if (!document.hidden) {
            const seconds = Math.max(0, Math.floor((Date.now() - job.started) / 1000));
            element('vertex_job_time').textContent = Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
        }
        if (meta.state === 'ready') {
            if (meta.saveFailed) toastr.warning(t`Could not write the reply to disk. Check available storage.`);
            job.resultExpiresAt = meta.expiresAt;
            break;
        }
        if (meta.state === 'claimed') {
            update(job, 'claimed');
            throw new Error(t`This result has already been picked up. You can view it without running tools again.`);
        }
        if (meta.state === 'failed') {
            update(job, 'expired');
            throw new Error(t`The provider disconnected or exceeded the recovery limit.`);
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
    if (!matches(job)) throw new Error(t`Open the original chat to receive this reply.`);
    await foreground(job);
    if (!matches(job)) throw new Error(t`The chat changed.`);
    if (job.mainApi === 'koboldhorde' && data.model) job.model = data.model;
    const calls = job.mainApi === 'openai' ? ToolManager.getToolCallsFromData(data) || [] : [];
    if (calls.length) {
        const names = new Set(ToolManager.tools.map(tool => tool.toFunctionOpenAI().function.name));
        if (!job.canPerformToolCalls || calls.some(call => !names.has(call.function?.name))) {
            if (job.saved) return showSaved(job);
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
    if (autosavedTail(job)) {
        // Until the completed browser result is ready to save, stale writes must be rejected.
        chat_metadata.linpeak_revision = job.target.revision;
        await deleteLastMessage();
    }
    data[delivery] = job;
    status(t`Applying the completed reply…`);
    return data;
}

export async function runVertexJob(payload, options, signal) {
    if (active || hasPendingVertexJob()) throw new Error(t`A generation task is already pending.`);
    const origin = options.mainApi ? options : { ...captureGenerationOrigin(), ...options };
    const job = { ...origin, source: payload.chat_completion_source || origin.source,
        model: payload.model || payload.models?.join(', ') || origin.model, textGenType: payload.api_type,
        stream: !!(payload.stream ?? payload.streaming), started: Date.now(), phase: 'waiting' };
    job.target = makeTarget(job);
    const previous = pending();
    if (['delivered', 'expired', 'saved', 'stored'].includes(previous?.phase)) {
        void fetch(url(previous), { method: 'DELETE', headers: getRequestHeaders() }).catch(() => {});
    }
    active = job;
    const cancel = () => { if (job.id && job.phase === 'waiting') void stop(job); };
    try {
        const res = await fetch(api, { ...post({ target: job.target }), signal: AbortSignal.timeout(15000) });
        if (res.status === 409) throw new Error(t`The original chat changed before submission. Reopen it and send again.`);
        await checked(res);
        job.id = (await res.json()).id;
        store(job);
        controls();
        signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) { await stop(job); throw new DOMException('Stopped', 'AbortError'); }
        if (!matches(job)) { await stop(job); throw new Error(t`The chat changed.`); }
        status(t`Submitting the generation…`);
        try {
            await checked(await fetch(url(job, '/start') + (job.mainApi === 'openai' ? '' : '?transport=' + encodeURIComponent(job.mainApi)), { ...post(payload), signal: AbortSignal.timeout(120000) }));
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
    let data;
    if (meta.state === 'conflict') {
        const res = await checked(await fetch(url(job, '/result'), { cache: 'no-store', signal: AbortSignal.timeout(90000) }));
        data = await res.json();
    } else if (['claimed', 'ready'].includes(meta.state)) {
        data = await result(job);
    } else {
        status(t`The result is not ready yet.`);
        return;
    }
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
    for (const event of [event_types.SECRET_WRITTEN, event_types.SECRET_EDITED, event_types.SECRET_ROTATED, event_types.SECRET_DELETED]) {
        eventSource.on(event, secret => localStorage.setItem(key() + '.revision.' + secret, uuidv4()));
    }
    setting.onchange = () => localStorage.setItem(preference(), String(setting.checked));
    element('vertex_job_cancel').onclick = () => stop(active || pending());
    element('vertex_job_dismiss').onclick = () => {
        const job = pending();
        if (!job || !['claimed', 'delivered', 'needs-tool', 'expired', 'saved', 'stored', 'conflict'].includes(job.phase)) return;
        localStorage.removeItem(key());
        void fetch(url(job), { method: 'DELETE', headers: getRequestHeaders() }).catch(() => {});
        status('');
        controls();
    };
    async function reconnect(manual = false) {
        wake?.();
        const job = pending();
        if (job?.resultExpiresAt <= Date.now() && ['claimed', 'delivered', 'needs-tool'].includes(job.phase)) update(job, job.saved ? 'saved' : 'expired');
        controls();
        if (!initialized || !job) return;
        if (job.phase === 'cancel') return stop(job);
        if (active) return;
        if (job.phase === 'saved' || (job.phase === 'stored' && !sameChat(job))) { status(t`Reply saved in the original chat.`); return; }
        if (job.phase === 'conflict') {
            status(t`The reply was kept in a recovery copy. Open it to read the result.`);
            if (manual) await view(job).catch(error => handleError(job, error));
            return;
        }
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
            if (job.target) {
                const meta = await fetch(url(job), { cache: 'no-store', signal: AbortSignal.timeout(15000) })
                    .then(res => res.ok ? res.json() : null).catch(() => null);
                if (meta?.state === 'conflict') {
                    update(job, 'conflict');
                    status(t`The reply was kept in a recovery copy. Open it to read the result.`);
                    controls();
                    if (manual) await view(job).catch(error => handleError(job, error));
                    return;
                }
                if (meta?.saved || (!meta && await alreadyWritten(job).catch(() => false))) {
                    // A chat load can finish while its status request is in flight.
                    if (active || pending()?.id !== job.id || !['waiting', 'stored'].includes(pending()?.phase)) return;
                    if (meta?.state === 'ready' && matches(job)) { void reconnect(); return; }
                    await showSaved(job, meta?.state === 'ready');
                    return;
                }
            }
            status(t`Open the original chat to receive this reply.`);
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
    update(job, job.saved ? 'saved' : 'delivered');
    status(job.saved ? t`Reply saved in the original chat.` : t`Reply picked up. Saved copy available.`);
    controls();
}

export function cancelVertexJob() { if (active?.id) void stop(active); }
