import { GEMINI_4_CARBON } from './gemini-models.js';

const IMAGE_PART_TYPES = ['image_url'];
const GEMINI_4_CARBON_PART_TYPES = ['image_url', 'audio_url', 'video_url'];

export function getGoogleProtectedMediaTypes(model) {
    return model === GEMINI_4_CARBON ? GEMINI_4_CARBON_PART_TYPES : IMAGE_PART_TYPES;
}

/**
 * Preserve attachment positions while a text-only preset rewrites selected messages.
 * References live only for this event; original media parts never enter the
 * preset's stringified conversation. Missing/duplicated references stop sending.
 * @param {() => object[]} getMessages Current array, including replacements by the event
 * @param {() => Promise<unknown>} process Preset event
 * @param {string[]} types Message part types to protect
 * @returns {Promise<unknown>} Event result
 */
export async function preserveMediaParts(getMessages, process, types = IMAGE_PART_TYPES) {
    const media = new Map();
    const nonce = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
    const prefix = `[[ST_IMAGE_${nonce}_`;
    for (const message of getMessages() || []) {
        if (!Array.isArray(message?.content)) continue;
        message.content = message.content.map(part => {
            if (!types.includes(part?.type)) return part;
            const marker = `${prefix}${media.size}]]`;
            media.set(marker, part);
            return { type: 'text', text: marker };
        });
    }

    function restore(validate) {
        const counts = new Map();
        let invalid = false;
        const pattern = new RegExp(`\\[\\[ST_IMAGE_${nonce}_\\d+\\]\\]`, 'g');
        for (const message of getMessages() || []) {
            const wasString = typeof message?.content === 'string';
            const parts = wasString ? [{ type: 'text', text: message.content }] : message?.content;
            if (!Array.isArray(parts)) continue;
            let changed = false;
            const restored = parts.flatMap(part => {
                if (part?.type !== 'text' || typeof part.text !== 'string' || !part.text.includes(prefix)) return [part];
                changed = true;
                const result = [];
                let offset = 0;
                for (const match of part.text.matchAll(pattern)) {
                    if (match.index > offset) result.push({ ...part, text: part.text.slice(offset, match.index) });
                    if (media.has(match[0])) {
                        result.push(media.get(match[0]));
                        counts.set(match[0], (counts.get(match[0]) || 0) + 1);
                    } else invalid = true;
                    offset = match.index + match[0].length;
                }
                if (offset < part.text.length) result.push({ ...part, text: part.text.slice(offset) });
                if (result.some(value => value.text?.includes(prefix))) invalid = true;
                return result;
            });
            if (changed) message.content = restored;
        }
        if (validate && (invalid || [...media.keys()].some(marker => counts.get(marker) !== 1))) {
            const attachment = types === IMAGE_PART_TYPES ? 'an image attachment' : 'a media attachment';
            throw new Error(`Preset processing removed or duplicated ${attachment}. Generation was stopped; check the preset post-processing script.`);
        }
    }

    try {
        const result = await process();
        if (media.size) restore(true);
        return result;
    } catch (error) {
        // Do not leave references in an inspectable prompt after a failed event.
        if (media.size) restore(false);
        throw error;
    }
}

/** @param {object[]} messages @param {string[]} types @returns {string[]} Snapshot for later event validation */
export function mediaPartSignatures(messages, types = IMAGE_PART_TYPES) {
    return (messages || []).flatMap(message => Array.isArray(message?.content)
        ? message.content.filter(part => types.includes(part?.type)).map(part => JSON.stringify(part)) : []).sort();
}

/** @param {string[]} expected @param {object[]} messages @param {string[]} types */
export function assertMediaParts(expected, messages, types = IMAGE_PART_TYPES) {
    const actual = mediaPartSignatures(messages, types);
    if (expected.length !== actual.length || expected.some((value, index) => value !== actual[index])) {
        const attachmentType = types === IMAGE_PART_TYPES ? 'image' : 'media';
        throw new Error(`Prompt processing changed ${attachmentType} attachments. Generation was stopped; check the preset or extension.`);
    }
}
