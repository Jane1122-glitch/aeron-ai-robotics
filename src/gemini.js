import { GoogleGenAI } from '@google/genai';

export class GeminiApiError extends Error {
  constructor(status, message = 'Gemini request failed.', code = 'gemini_error') {
    super(message);
    this.name = 'GeminiApiError';
    this.status = status;
    this.code = code;
  }
}

function fetchWithoutTransportRetries(fetcher) {
  return async (...args) => {
    try { return await fetcher(...args); }
    catch {
      // The SDK retry runner also retries thrown fetch errors; make those
      // non-retryable so the configured retry applies only to HTTP 504.
      throw new TypeError('Gemini request failed before receiving an HTTP response.');
    }
  };
}

/** Shared server-side SDK entry point used by the general generator and blog provider. */
export async function generateGeminiContent({ apiKey, model, systemInstruction, prompt, maxOutputTokens, responseSchema, retryOptions, fetcher = globalThis.fetch, client }) {
  if (!apiKey && !client) throw new GeminiApiError(503, 'Gemini is not configured.');
  const ai = client || new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        systemInstruction,
        maxOutputTokens,
        ...(responseSchema ? { responseMimeType: 'application/json', responseSchema } : {}),
        ...(retryOptions ? { httpOptions: { retryOptions, fetch: fetchWithoutTransportRetries(fetcher) } } : {}),
      },
    });
    return typeof response?.text === 'string' ? response.text.trim() : '';
  } catch (error) {
    // Keep raw SDK details (which may contain request metadata) out of API responses and logs.
    const status = Number(error?.status || error?.httpStatusCode);
    const details = `${error?.code || ''} ${error?.message || ''} ${error?.error?.status || ''} ${error?.error?.message || ''}`.toLowerCase();
    const code = /quota|billing|insufficient/.test(details) ? 'insufficient_quota' : status === 429 ? 'rate_limited' : status === 504 ? 'gateway_timeout' : status ? 'gemini_error' : 'network_error';
    throw new GeminiApiError(Number.isInteger(status) ? status : 0, 'Gemini request failed.', code);
  }
}

