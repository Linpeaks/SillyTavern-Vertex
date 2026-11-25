import { chat, getMediaDisplay, getMediaIndex, main_api } from '../script.js';
import { eventSource, event_types } from './events.js';
import { IGNORE_SYMBOL, MEDIA_DISPLAY, MEDIA_TYPE } from './constants.js';
import { getChatCompletionModel, isImageInliningSupported, oai_settings } from './openai.js';
import { getGoogleFlexError } from './gemini-models.js';
import { supportsNativePdf } from './native-pdf.js';
import { Popup, POPUP_RESULT, POPUP_TYPE } from './popup.js';
import { t, translate } from './i18n.js';

const byId = id => document.getElementById(id);
const isImage = item => item && (!item.type || item.type === MEDIA_TYPE.IMAGE);

function selectedMedia(message) {
    const media = message.extra?.media;
    if (!Array.isArray(media)) return [];
    return getMediaDisplay(message) === MEDIA_DISPLAY.GALLERY ? [media[getMediaIndex(message)]] : media;
}

// Called on prompt copies, before extension injection and token budgeting.
// The option belongs to the user turn so regenerations and tool follow-ups agree.
export function applyTurnImageScope(messages) {
    const turn = messages.findLast(message => message.is_user && !message.is_system && !message.extra?.[IGNORE_SYMBOL]);
    if (!turn?.extra?.onlyTurnImages) return messages;
    return messages.map(message => {
        if (message === turn || !message.extra?.media?.some(isImage)) return message;
        const media = selectedMedia(message).filter(item => item && !isImage(item));
        return { ...message, extra: { ...message.extra, media, media_index: 0 } };
    });
}

export function takeDraftImageScope() {
    const choice = byId('composer_turn_images');
    const selected = choice.checked;
    choice.checked = false;
    return selected;
}

function modelLabel(settings) {
    const source = settings.chat_completion_source;
    const model = getChatCompletionModel(settings);
    if (source !== 'vertexai' && source !== 'makersuite') return model || source;
    const vertex = source === 'vertexai';
    const flex = vertex ? settings.vertexai_flex : settings.google_flex;
    const error = flex && getGoogleFlexError(model, vertex, settings.vertexai_region);
    return [vertex ? 'Vertex AI' : 'Google AI Studio', model, flex ? 'Flex' : 'Standard', error && translate(error)].filter(Boolean).join(' · ');
}

export function refreshComposerAttachments() {
    const panel = byId('composer_attachments');
    panel.classList.toggle('displayNone', main_api !== 'openai');
    byId('vertex_job_setting').classList.toggle('displayNone', oai_settings.chat_completion_source !== 'vertexai' || !!oai_settings.reverse_proxy);
    if (!panel.open || main_api !== 'openai') return;
    const input = byId('file_form_input');
    const draft = Array.from(input.files);
    const pendingMedia = draft.map(file => MEDIA_TYPE.getFromMime(file.type)).filter(Boolean);
    const pending = getMediaDisplay({}) === MEDIA_DISPLAY.GALLERY ? pendingMedia.slice(-1) : pendingMedia;
    const pdfs = [];
    const nativeSupported = supportsNativePdf(oai_settings);
    function addPdf(name, native) {
        const mode = native ? (nativeSupported ? t`Original PDF` : t`Original PDF unavailable`) : t`Extract text`;
        pdfs.push(`${name} (${mode})`);
    }
    let historical = 0;
    for (const message of chat) {
        if (message.is_system || message.extra?.[IGNORE_SYMBOL]) continue;
        historical += selectedMedia(message).filter(item => isImage(item) && item.url).length;
        for (const file of message.extra?.files || []) {
            if (file.mode === 'native' || /\.pdf$/i.test(file.name)) addPdf(file.name, file.mode === 'native');
        }
    }
    for (const file of draft) {
        if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) addPdf(file.name, byId('pdf_attachment_mode').value === 'native');
    }
    const enabled = isImageInliningSupported();
    const newCount = enabled ? pending.filter(type => type === MEDIA_TYPE.IMAGE).length : 0;
    const historyCount = enabled && !byId('composer_turn_images').checked ? historical : 0;
    byId('composer_model').textContent = modelLabel(oai_settings);
    byId('composer_image_count').textContent = t`New images: ${newCount} · History: ${historyCount}`;
    byId('composer_pdf_list').textContent = pdfs.length ? 'PDF · ' + pdfs.join('、') : '';
}

export async function reviewRequestAttachments(type, payload, nativePdfs, signal) {
    if (type === 'quiet') return;
    let images = 0;
    for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
        if (Array.isArray(message?.content)) images += message.content.filter(part => part?.type === 'image_url').length;
    }
    const google = ['vertexai', 'makersuite'].includes(payload.chat_completion_source);
    const model = google ? `${payload.model} · ${payload.google_use_flex ? 'Flex' : 'Standard'}` : payload.model;
    const summary = t`${model} · Images: ${images} · Original PDFs: ${nativePdfs.length}`;
    const review = byId('composer_review_once');
    if (review.checked) {
        review.checked = false;
        signal.throwIfAborted();
        const box = document.createElement('div');
        const title = document.createElement('h3');
        title.textContent = t`Review this request`;
        const details = document.createElement('p');
        details.textContent = summary;
        box.append(title, details);
        if (nativePdfs.length) {
            const names = new Map();
            for (const message of chat) {
                for (const file of message.extra?.files || []) {
                    if (file.mode === 'native') names.set(file.id, file.name);
                }
            }
            const list = document.createElement('ul');
            for (const ref of nativePdfs) {
                const item = document.createElement('li');
                item.textContent = names.get(ref.id) || t`Original PDF`;
                list.append(item);
            }
            box.append(list);
        }
        const popup = new Popup(box, POPUP_TYPE.CONFIRM, '', { okButton: t`Send`, cancelButton: t`Cancel` });
        const abort = () => popup.completeCancelled();
        signal.addEventListener('abort', abort, { once: true });
        eventSource.on(event_types.CHAT_CHANGED, abort);
        try {
            const result = await popup.show();
            signal.throwIfAborted();
            if (result !== POPUP_RESULT.AFFIRMATIVE) throw new DOMException(t`Request cancelled`, 'AbortError');
        } finally {
            signal.removeEventListener('abort', abort);
            eventSource.removeListener(event_types.CHAT_CHANGED, abort);
        }
    }
    byId('composer_last_request').textContent = t`Last request: ${summary}`;
}

export function initComposerAttachments() {
    const panel = byId('composer_attachments');
    panel.addEventListener('toggle', refreshComposerAttachments);
    $('#composer_turn_images, #pdf_attachment_mode, #file_form_input, #main_api, #google_flex, #vertexai_flex, #openai_media_inlining').on('change', () => queueMicrotask(refreshComposerAttachments));
    $('#file_form').on('reset', () => queueMicrotask(refreshComposerAttachments));
    eventSource.on(event_types.CHAT_CHANGED, () => {
        byId('composer_turn_images').checked = false;
        byId('composer_review_once').checked = false;
        byId('composer_last_request').textContent = '';
        refreshComposerAttachments();
    });
    for (const event of [event_types.APP_READY, event_types.SETTINGS_UPDATED, event_types.CHATCOMPLETION_MODEL_CHANGED,
        event_types.CHATCOMPLETION_SOURCE_CHANGED, event_types.OAI_PRESET_CHANGED_AFTER, event_types.MESSAGE_SENT,
        event_types.MESSAGE_RECEIVED, event_types.MESSAGE_UPDATED, event_types.MESSAGE_DELETED,
        event_types.MESSAGE_FILE_EMBEDDED, event_types.FILE_ATTACHMENT_DELETED, event_types.IMAGE_SWIPED]) {
        eventSource.on(event, refreshComposerAttachments);
    }
}
