export const GEMINI_4_CARBON = 'gemini-4-carbon';
export const GEMINI_4_CONTEXT_LIMIT = 1_048_576;

export function isGemini4Model(model) {
    return model === 'gemini-4-argon' || model === GEMINI_4_CARBON;
}

// The chat endpoint sends one GenerateContent request, without long-decode continuations.
export function limitCarbonOutputTokens(maxTokens, stream) {
    return maxTokens == null ? maxTokens : Math.min(maxTokens, stream ? 65_536 : 32_768);
}
