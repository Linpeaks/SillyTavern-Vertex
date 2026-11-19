export const GEMINI_3_8_FLASH = 'gemini-3.8-flash';
export const GEMINI_4_ARGON = 'gemini-4-argon';
export const GEMINI_4_CARBON = 'gemini-4-carbon';
export const GEMINI_4_HYDROGEN = 'gemini-4-hydrogen';
export const GEMINI_4_NEON = 'gemini-4-neon';
export const GEMINI_MILLION_TOKENS = 1_048_576;

const GEMINI_4_VERTEX_REGIONS = ['global', 'us', 'eu'];
const GEMINI_3_8_VERTEX_REGIONS = [...GEMINI_4_VERTEX_REGIONS, 'northamerica-northeast1', 'asia-northeast1'];
const GEMINI_4_REGION_RESTRICTED_MODELS = new Map([
    [GEMINI_4_CARBON, 'Gemini 4 Carbon'],
    [GEMINI_4_HYDROGEN, 'Gemini 4 Hydrogen'],
    [GEMINI_4_NEON, 'Gemini 4 Neon'],
]);

export function isGemini4Model(model) {
    return model === GEMINI_4_ARGON || model === GEMINI_4_CARBON || model === GEMINI_4_HYDROGEN || model === GEMINI_4_NEON;
}

// The chat endpoint sends one GenerateContent request, without long-decode continuations.
export function limitGeminiOutputTokens(model, maxTokens, stream) {
    if (maxTokens == null || (!isGemini4Model(model) && model !== GEMINI_3_8_FLASH)) {
        return maxTokens;
    }
    const shortNonStreamingLimit = !stream && (model === GEMINI_4_CARBON || model === GEMINI_4_ARGON);
    return Math.min(maxTokens, shortNonStreamingLimit ? 32_768 : 65_536);
}

export function getVertexGeminiLocation(model, configuredRegion) {
    const supportsMultiRegion = isGemini4Model(model) || model === GEMINI_3_8_FLASH;
    const region = configuredRegion || (supportsMultiRegion ? 'global' : 'us-central1');
    const isMultiRegion = supportsMultiRegion && (region === 'us' || region === 'eu');
    let host = 'https://aiplatform.googleapis.com';
    if (isMultiRegion) {
        host = `https://aiplatform.${region}.rep.googleapis.com`;
    } else if (region !== 'global') {
        host = `https://${region}-aiplatform.googleapis.com`;
    }
    let regionError;

    if (model === GEMINI_3_8_FLASH && !GEMINI_3_8_VERTEX_REGIONS.includes(region)) {
        regionError = 'Gemini 3.8 Flash on Vertex AI requires the global, us, eu, northamerica-northeast1, or asia-northeast1 region.';
    }
    const modelName = GEMINI_4_REGION_RESTRICTED_MODELS.get(model);
    if (modelName && !GEMINI_4_VERTEX_REGIONS.includes(region)) {
        regionError = `${modelName} on Vertex AI requires the global, us, or eu region.`;
    }

    return { region, host, isMultiRegion, regionError };
}

// GenerateContent model lists differ between the Gemini Developer API and Vertex Flex PayGo.
// https://ai.google.dev/gemini-api/docs/generate-content/flex-inference
// https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/flex-paygo
const sharedFlexModels = new Set([
    GEMINI_3_8_FLASH, 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview', 'gemini-3-flash-preview', 'gemini-3-pro-image',
]);
const studioFlexModels = new Set([
    GEMINI_4_ARGON, GEMINI_4_CARBON, GEMINI_4_HYDROGEN, GEMINI_4_NEON,
    'gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-flash-image',
]);
const vertexFlexModels = new Set([
    'gemini-3.8-flash-cyber', 'gemini-3.7-flash', 'gemini-3.5-flash', 'gemini-3.1-flash-lite-image', 'gemini-3.1-flash-image',
]);

export function getGoogleFlexError(model, isVertex, region) {
    if (isVertex) {
        if (!sharedFlexModels.has(model) && !vertexFlexModels.has(model)) {
            return 'Flex is unavailable for this model on Vertex AI.';
        }
        if (getVertexGeminiLocation(model, region).region !== 'global') {
            return 'Vertex AI Flex requires the global region.';
        }
    } else if (!sharedFlexModels.has(model) && !studioFlexModels.has(model)) {
        return 'Flex is unavailable for this model on Google AI Studio.';
    }
    return '';
}

export function applyGoogleFlexTier(body, headers, isVertex) {
    if (isVertex) {
        headers['X-Vertex-AI-LLM-Request-Type'] = 'shared';
        headers['X-Vertex-AI-LLM-Shared-Request-Type'] = 'flex';
    } else {
        body.service_tier = 'flex';
    }
}

export const VERTEX_FLEX_MAX_BYTES = 20_000_000;
export const VERTEX_FLEX_SIZE_ERROR = 'Vertex AI Flex accepts up to 20 MB for the entire request. Reduce the prompt or attachments.';
