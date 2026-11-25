import { MEDIA_SOURCE, MEDIA_TYPE } from '../public/scripts/constants.js';

const incompleteReply = () => new Error('The provider returned an incomplete reply.');
const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string' ? value : '';
const array = value => Array.isArray(value) ? value : [];
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];

function parseJson(text) {
    try {
        return JSON.parse(text);
    } catch {
        throw incompleteReply();
    }
}

function checkError(data) {
    if (data?.error || data?.type === 'error' || Number(data?.status) >= 400) {
        throw new Error('The provider returned a generation error.');
    }
}

function* streamEvents(body) {
    for (const frame of body.replace(/\r\n?/g, '\n').split('\n\n')) {
        const lines = frame.split('\n');
        const payload = lines.filter(line => line.startsWith('data:')).map(line => line.slice(line[5] === ' ' ? 6 : 5)).join('\n');
        if (lines.some(line => /^event: ?error$/.test(line))) throw new Error('The provider returned a generation error.');
        if (!payload.trim()) continue;
        if (payload.trim() === '[DONE]') {
            yield null;
            continue;
        }
        const data = parseJson(payload);
        if (!isObject(data)) throw incompleteReply();
        const event = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        if (event && !data.type) data.type = event;
        yield data;
    }
}

function variantAt(variants, index = 0) {
    if (!Number.isSafeInteger(index) || index < 0 || index > 127) throw incompleteReply();
    if (!variants.has(index)) {
        variants.set(index, { text: '', reasoning: '', signature: '', toolPlan: '', images: new Set(), calls: new Map(), toolSignatures: new Map() });
    }
    return variants.get(index);
}

function addImage(variant, url) {
    if (typeof url === 'string' && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/]+=*$/i.test(url)) variant.images.add(url);
}

function addInlineImage(variant, mimeType, data) {
    if (typeof mimeType === 'string' && typeof data === 'string') addImage(variant, `data:${mimeType};base64,${data}`);
}

function addContent(variant, content, separator = '') {
    if (typeof content === 'string') {
        variant.text += content;
        return;
    }
    const texts = [];
    const thoughts = [];
    for (const block of array(content)) {
        if (block?.type === 'thinking' || block?.thinking) {
            thoughts.push(string(block.thinking) || array(block.thinking).map(part => string(part?.text)).join(''));
            if (block.signature) variant.signature = string(block.signature);
            continue;
        }
        if (typeof block?.text === 'string') texts.push(block.text);
        addImage(variant, block?.image_url?.url ?? block?.image_url);
        if (block?.type === 'image' && block.source?.type === 'base64') addInlineImage(variant, block.source.media_type, block.source.data);
    }
    variant.text += texts.join(separator);
    variant.reasoning += thoughts.join(separator);
}

function toolAt(variant, index) {
    if (!Number.isSafeInteger(index) || index < 0) throw incompleteReply();
    if (!variant.calls.has(index)) variant.calls.set(index, {});
    return variant.calls.get(index);
}

function mergeToolCall(tool, fragment) {
    tool.id ||= string(fragment?.id);
    tool.name ||= string(fragment?.function?.name);
    tool.signature ||= string(fragment?.signature);
    const args = fragment?.function?.arguments;
    if (typeof args === 'string') tool.arguments = string(tool.arguments) + args;
    else if (args != null) tool.arguments = args;
}

function endVariant(variant, reason) {
    if (!reason || reason === 'FINISH_REASON_UNSPECIFIED') return;
    variant.finished = true;
    variant.failedTools ||= /^(?:length|max_tokens|content_filter|malformed_function_call|error)$/i.test(reason);
}

function addChoice(variant, choice) {
    const message = choice.delta ?? choice.message ?? choice;
    addContent(variant, message.content ?? choice.text ?? choice.token ?? choice.response ?? choice.output);
    variant.reasoning += string(message.reasoning_content ?? message.reasoning ?? message.thinking);
    for (const image of array(message.images)) addImage(variant, image?.image_url?.url ?? image?.image_url);
    for (const detail of array(message.reasoning_details)) {
        if (detail?.type !== 'reasoning.encrypted' || !string(detail.data)) continue;
        if (string(detail.id)) variant.toolSignatures.set(detail.id, detail.data);
        if (!/^(tool_|call_)/.test(detail.id)) variant.signature = detail.data;
    }
    const calls = message.tool_calls ?? (message.function_call ? [{ function: message.function_call }] : []);
    for (const [index, call] of list(calls).entries()) mergeToolCall(toolAt(variant, call?.index ?? index), call);
    endVariant(variant, choice.finish_reason);
}

function addGoogleCandidate(variant, candidate, stream) {
    if (!isObject(candidate)) throw incompleteReply();
    const content = candidate.content ?? candidate.output;
    if (typeof content === 'string') variant.text += content;
    const text = [];
    const thoughts = [];
    for (const part of array(content?.parts)) {
        if (typeof part?.text === 'string') {
            (part.thought ? thoughts : text).push(part.text);
            if (string(part.thoughtSignature)) variant.signature = part.thoughtSignature;
        }
        if (part?.inlineData && !part.thought) addInlineImage(variant, part.inlineData.mimeType, part.inlineData.data);
        if (part?.functionCall) {
            const call = part.functionCall;
            if (call.willContinue || array(call.partialArgs).length) throw incompleteReply();
            const tool = toolAt(variant, variant.calls.size);
            tool.name = string(call.name);
            tool.googleCallId = string(call.id);
            tool.arguments = call.args;
            tool.signature = string(part.thoughtSignature);
        }
    }
    variant.text += text.join(stream ? '' : '\n\n');
    variant.reasoning += thoughts.join(stream ? '' : '\n\n');
    endVariant(variant, candidate.finishReason);
}

function addClaudeEvent(variant, data) {
    const index = data.index ?? 0;
    if (data.type === 'content_block_start') {
        const block = data.content_block;
        if (block?.type === 'tool_use') {
            const tool = toolAt(variant, index);
            Object.assign(tool, { id: block.id, name: block.name, arguments: block.input, open: true });
        } else {
            addContent(variant, [block]);
            if (block?.type === 'thinking' && string(block.signature)) variant.signatureBlock = index;
        }
    }
    if (data.delta?.type === 'input_json_delta') {
        const tool = toolAt(variant, index);
        tool.open = true;
        tool.partial = (tool.partial ?? '') + string(data.delta.partial_json);
    }
    if (data.type === 'content_block_stop') {
        const tool = variant.calls.get(index);
        if (tool) {
            if (tool.partial !== undefined) tool.arguments = parseJson(tool.partial);
            tool.open = false;
        }
    }
    variant.text += string(data.delta?.text);
    variant.reasoning += string(data.delta?.thinking);
    if (typeof data.delta?.signature === 'string') {
        if (variant.signatureBlock !== index) variant.signature = '';
        variant.signatureBlock = index;
        variant.signature += data.delta.signature;
    }
    if (data.type === 'message_delta') variant.failedTools ||= /^(?:max_tokens|refusal)$/.test(data.delta?.stop_reason);
    if (data.type === 'message_stop') variant.finished = true;
}

function addCohereMessage(variant, message, { index = 0, type, stream }) {
    if (!message) return;
    addContent(variant, message.content?.text ?? message.content, stream ? '' : '\n\n');
    variant.toolPlan += string(message.tool_plan);
    for (const [position, call] of list(message.tool_calls).entries()) {
        if (type === 'message-start' && !call?.function && !call?.id) continue;
        mergeToolCall(toolAt(variant, call?.index ?? index + position), call);
    }
}

function projectResponse(variants, data, job, stream) {
    checkError(data);
    const google = ['vertexai', 'makersuite'].includes(job.source);
    if (Array.isArray(data) && data.some(chunk => chunk?.candidates)) {
        for (const chunk of data) projectResponse(variants, chunk, job, stream);
        return;
    }
    if (Array.isArray(data?.candidates)) {
        for (const [index, candidate] of data.candidates.entries()) {
            addGoogleCandidate(variantAt(variants, candidate?.index ?? index), candidate, stream);
        }
        return;
    }
    if (data?.responseContent != null && google) {
        addGoogleCandidate(variantAt(variants), { content: data.responseContent, finishReason: data.finishReason }, stream);
        return;
    }
    if (stream && google) return; // Usage-only frames do not identify a candidate.
    if (job.source === 'claude' && (stream || Array.isArray(data?.content))) {
        const variant = variantAt(variants);
        if (stream) {
            addClaudeEvent(variant, data);
        } else {
            addContent(variant, data.content, '\n\n');
            for (const block of data.content.filter(part => part?.type === 'tool_use')) {
                Object.assign(toolAt(variant, variant.calls.size), { id: block.id, name: block.name, arguments: block.input });
            }
            endVariant(variant, data.stop_reason);
        }
        return;
    }
    if (job.source === 'cohere' && (stream || data?.message)) {
        const variant = variantAt(variants);
        addCohereMessage(variant, stream ? data.delta?.message : data.message, { index: data.index, type: data.type, stream });
        const tool = variant.calls.get(data.index ?? 0);
        if (tool && data.type === 'tool-call-start') tool.open = true;
        if (tool && data.type === 'tool-call-end') tool.open = false;
        if (data.type === 'message-end') endVariant(variant, data.delta?.finish_reason || 'complete');
        else if (!stream) endVariant(variant, data.finish_reason);
        return;
    }
    const choices = data?.choices ?? data?.results ?? (Array.isArray(data) ? data : [data]);
    if (!Array.isArray(choices)) throw incompleteReply();
    for (const [index, choice] of choices.entries()) {
        checkError(choice);
        if (typeof choice === 'string') variantAt(variants, index).text += choice;
        else if (isObject(choice)) addChoice(variantAt(variants, choice.index ?? index), choice);
    }
}

function completeTools(variant, jobId, index) {
    return [...variant.calls.entries()].sort(([a], [b]) => a - b).map(([position, tool]) => {
        if (!string(tool.name).trim() || tool.open || variant.failedTools) throw incompleteReply();
        const args = typeof tool.arguments === 'string' ? parseJson(tool.arguments) : tool.arguments;
        if (!isObject(args)) throw incompleteReply();
        const signature = tool.signature || variant.toolSignatures.get(tool.id);
        return {
            call: {
                id: string(tool.id) || string(tool.googleCallId) || `${jobId}:${index}:${position}`,
                function: { name: tool.name, arguments: tool.arguments },
                ...(tool.googleCallId && { googleCallId: tool.googleCallId }),
                ...(signature && { signature }),
            },
            args,
        };
    });
}

function toolText({ call, args }) {
    const prose = ['body', 'text', 'content', 'story', 'response', 'reply', 'message', 'answer', 'markdown', 'output', 'prose']
        .map(key => string(args[key])).filter(text => text.trim());
    if (prose.length) return [...new Set(prose)].join('\n\n');
    const values = Object.values(args);
    if (values.length === 1 && string(values[0]).trim()) return values[0];
    return `\`\`\`json\n${JSON.stringify({ [call.function.name]: args }, null, 2)}\n\`\`\``;
}

/** Builds the native assistant message from a complete, buffered generation response. */
export function generationChatMessage(body, job) {
    if (job.statusCode != null && (job.statusCode < 200 || job.statusCode >= 300)) {
        throw new Error(`Generation task returned HTTP ${job.statusCode}.`);
    }
    const raw = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body);
    const text = raw.trimStart();
    const stream = job.stream && !['{', '[', '"'].includes(text[0]);
    const variants = new Map();
    let done = false;
    let model = job.model;
    let title = '';
    if (stream) {
        for (const event of streamEvents(text)) {
            if (event === null) { done = true; continue; }
            projectResponse(variants, event, job, true);
        }
    } else {
        const data = parseJson(text);
        projectResponse(variants, data, job, false);
        if (job.mainApi === 'koboldhorde') {
            model = string(data?.model) || model;
            title = string(data?.workerName);
        }
    }

    const started = new Date(job.started).toISOString();
    const finished = new Date(job.finished ?? job.started).toISOString();
    const dates = { send_date: finished, gen_started: started, gen_finished: finished };
    const swipes = [];
    const swipeInfo = [];
    const googleStream = stream && ['vertexai', 'makersuite'].includes(job.source);
    for (const [index, variant] of [...variants.entries()].sort(([a], [b]) => a - b)) {
        if (googleStream && !variant.finished) throw incompleteReply();
        if (stream && variant.calls.size && !done && !variant.finished) throw incompleteReply();
        const tools = completeTools(variant, job.id, index);
        const reasoning = job.mainApi !== 'openai' || job.showThoughts !== false ? variant.reasoning : '';
        const mes = variant.text.trim() ? variant.text : tools.length ? tools.map(toolText).join('\n\n') : variant.toolPlan;
        if (!mes.trim() && !reasoning.trim() && !variant.images.size) continue;
        const extra = {
            api: job.source,
            model,
            reasoning,
            reasoning_duration: null,
            reasoning_signature: variant.signature || null,
            linpeak_job: job.id,
            linpeak_autosaved: true,
        };
        if (job.group) extra.gen_id = job.groupGenerationId ?? job.started;
        if (tools.length) extra.pending_tool_calls = tools.map(tool => tool.call);
        if (variant.images.size) {
            extra.media = [...variant.images].map(url => ({ url, type: MEDIA_TYPE.IMAGE, source: MEDIA_SOURCE.API }));
            extra.inline_image = true;
        }
        swipes.push(mes);
        swipeInfo.push({ ...dates, extra });
    }
    if (!swipes.length) throw incompleteReply();

    const message = {
        name: job.name,
        is_user: false,
        ...dates,
        mes: swipes[0],
        title,
        extra: structuredClone(swipeInfo[0].extra),
        swipe_id: 0,
        swipes,
        swipe_info: swipeInfo,
    };
    if (job.group) {
        message.original_avatar = job.avatar || 'none';
        message.force_avatar = message.original_avatar === 'none' ? 'img/ai4.png' : `/thumbnail?type=avatar&file=${encodeURIComponent(message.original_avatar)}`;
    }
    return message;
}
