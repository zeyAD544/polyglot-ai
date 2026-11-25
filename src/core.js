/** Core translation logic. DOM-free; keys are injected, never bundled. */
export const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
export const MODEL = 'llama-3.3-70b-versatile';
export const LANGS = Object.freeze([
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'ar', label: 'العربية · Arabic' },
  { code: 'pt-BR', label: 'Português (Brasil)' },
]);
export const STYLES = Object.freeze(['casual', 'formal', 'genz', 'neutral', 'girl-submission']);
export const AUDIENCES = Object.freeze(['friend', 'colleague', 'customer', 'elder', 'stranger']);
export const RELATIONSHIPS = Object.freeze(['close', 'neutral', 'hierarchical']);

export class AppError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.retryable = Boolean(options.retryable);
    this.status = options.status;
    if (options.cause) this.cause = options.cause;
  }
}

const ALLOWED_LANGS = new Set(['en', 'ar', 'pt-BR']);
export function normalizeLangCode(value) {
  if (!value) return null;
  const s = String(value).trim().toLowerCase().replace(/_/g, '-');
  if (/^(auto|detect|auto-detect)$/.test(s)) return 'auto';
  if (/^(pt|português|portugues)/.test(s)) return 'pt-BR';
  if (/^(ar|عرب)/.test(s)) return 'ar';
  if (/^(en|english)/.test(s)) return 'en';
  return ALLOWED_LANGS.has(value) ? value : null;
}
export const isRtl = (lang) => normalizeLangCode(lang) === 'ar';

export function detectLanguage(text) {
  const s = String(text || '');
  if (!s.trim()) return null;
  const ar = (s.match(/[\u0600-\u06ff\u0750-\u077f\u08a0-\u08ff]/g) || []).length;
  const latin = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length;
  if (ar && ar >= latin * 0.2) return 'ar';
  const l = s.toLowerCase();
  const pt = (l.match(/[ãõçáâêôàéíóú]/g) || []).length * 2 + (l.match(/\b(não|você|vocês|obrigad[oa]|também|muito|está|estou|oi|beleza)\b/g) || []).length;
  const en = (l.match(/\b(the|and|you|is|are|this|that|with|for|have|what|how|thanks|please|hello)\b/g) || []).length;
  return pt > en ? 'pt-BR' : 'en';
}

/** Accept tokens.txt format and plain key lists; caller must supply keys securely. */
export function parseKeyList(text) {
  const keys = String(text || '').match(/gsk_[A-Za-z0-9_-]{20,}/g) || [];
  return [...new Set(keys)];
}
export function maskKey(key) {
  const s = String(key || '');
  return s.length < 10 ? (s ? '…' : '') : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Round-robin keys with independent cooldowns for rate-limited requests. */
export class KeyRing {
  constructor(keys, { cooldownMs = 15000, now = Date.now } = {}) {
    this.keys = [...new Set((keys || []).map((k) => String(k).trim()).filter(Boolean))];
    if (!this.keys.length) throw new AppError('NO_KEYS', 'No API keys configured.');
    this.cooldownMs = cooldownMs;
    this.now = now;
    this.cursor = 0;
    this.until = this.keys.map(() => 0);
    this.dead = this.keys.map(() => false);
  }
  next() {
    for (let n = 0; n < this.keys.length; n++) {
      const i = (this.cursor + n) % this.keys.length;
      if (!this.dead[i] && this.until[i] <= this.now()) {
        this.cursor = (i + 1) % this.keys.length;
        return { key: this.keys[i], index: i };
      }
    }
    if (this.dead.every(Boolean)) throw new AppError('AUTH', 'All API keys were rejected.');
    throw new AppError('RATE_LIMITED', 'All API keys are cooling down.', { retryable: true });
  }
  fail(index, status) {
    if (status === 401 || status === 403) this.dead[index] = true;
    else this.until[index] = this.now() + this.cooldownMs;
  }
  success(index) { this.until[index] = 0; }
}

const LABEL = { en: 'English', ar: 'Arabic', 'pt-BR': 'Brazilian Portuguese' };
/** Contrastive translation instructions; keep styles recognizable but faithful. */
export const STYLE_META = Object.freeze({
  casual: Object.freeze({
    label: 'Casual',
    instruction: 'Write like a relaxed, friendly conversation between peers. Prefer natural contractions and everyday phrasing; avoid stiff wording and do not add slang or intimacy absent from the source.',
  }),
  formal: Object.freeze({
    label: 'Formal',
    instruction: 'Use polished, formal grammar and a respectful professional register. Avoid contractions, colloquialisms, emojis, and slang; retain the source meaning without making it more deferential than it is.',
  }),
  genz: Object.freeze({
    label: 'Gen Z',
    instruction: 'Use contemporary, youth-oriented target-culture phrasing and a light amount of locally natural internet slang where it fits. Keep it clear and faithful; never force memes, emojis, or slang into serious content.',
  }),
  neutral: Object.freeze({
    label: 'Neutral',
    instruction: 'Use a clear, natural, broadly appropriate register that mirrors the source tone. Avoid adding casualness, formality, slang, warmth, or emotional emphasis not present in the original.',
  }),
  'girl-submission': Object.freeze({
    label: 'Girl Submission',
    instruction: 'Render the message in a gentle, feminine, softly deferential voice, as a woman addressing someone she wishes to please. Use warm, considerate wording and subtle yielding/polite phrasing where natural in the target language. Preserve the original facts and intent; do not invent romantic, sexual, apologetic, or submissive content, and do not imply the source speaker’s gender unless this style explicitly calls for a feminine voice.',
  }),
});

/** Resolve UI labels and common aliases to a canonical style id. */
export function normalizeStyle(value) {
  if (value == null || String(value).trim() === '') return 'neutral';
  const key = String(value).trim().toLowerCase().replace(/[ _]+/g, '-');
  const aliases = {
    'gen-z': 'genz',
    'girl-submission': 'girl-submission',
    girlsubmission: 'girl-submission',
    submission: 'girl-submission',
  };
  const normalized = aliases[key] || key;
  return Object.hasOwn(STYLE_META, normalized) ? normalized : null;
}
export function buildMessages({ text, source = 'auto', target, style = 'neutral', audience, relationship }) {
  const targetCode = normalizeLangCode(target);
  const sourceCode = normalizeLangCode(source) || 'auto';
  const styleCode = normalizeStyle(style);
  if (!styleCode) throw new AppError('BAD_STYLE', `Unsupported translation style: ${String(style)}.`);
  if (!text || !String(text).trim()) throw new AppError('EMPTY_INPUT', 'Enter text to translate.');
  if (!targetCode || targetCode === 'auto') throw new AppError('BAD_LANGUAGE', 'Choose a target language.');
  const sourceLabel = sourceCode === 'auto' ? 'Detect the source language (English, Arabic, or Brazilian Portuguese)' : `Source language: ${LABEL[sourceCode]}.`;
  const context = [
    STYLE_TEXT[style] || STYLE_TEXT.neutral,
    audience ? `The reader is a ${audience}.` : '',
    relationship ? `Relationship: ${relationship}.` : '',
  ].filter(Boolean).join(' ');
  return [
    { role: 'system', content: `You are a professional translator. Translate into ${LABEL[targetCode]}. ${sourceLabel} Preserve meaning, tone, names, numbers, URLs, emoji, and line breaks; do not add explanations. ${context} Return only JSON: {"translation":"...","detected_source_language":"en|ar|pt-BR","notes":""}.` },
    { role: 'user', content: String(text) },
  ];
}

/** Parse JSON despite markdown wrappers or surrounding prose. */
export function extractJson(value) {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const s = value.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = s.indexOf('{');
  if (start < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(s.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}
export function normalizeResult(value, fallback = {}) {
  const obj = typeof value === 'string' ? { translation: value } : (value || {});
  const translation = [obj.translation, obj.translated_text, obj.output, obj.text]
    .find((v) => typeof v === 'string' && v.trim());
  if (!translation) throw new AppError('BAD_OUTPUT', 'No translation in model response.');
  const detectedSource = normalizeLangCode(obj.detected_source_language) || fallback.detectedSource || null;
  return { translation: translation.trim(), detectedSource, notes: typeof obj.notes === 'string' ? obj.notes : '' };
}

/** Performs one request; caller can retry with a fresh KeyRing key if rate-limited. */
export async function translate(ctx, { keyRing, fetchImpl = globalThis.fetch, timeoutMs = 30000 } = {}) {
  if (!keyRing || typeof keyRing.next !== 'function') throw new AppError('NO_KEYS', 'No API keys configured.');
  if (typeof fetchImpl !== 'function') throw new AppError('NETWORK', 'Fetch is unavailable.');
  const text = String(ctx?.text || '');
  if (!text.trim()) throw new AppError('EMPTY_INPUT', 'Enter text to translate.');
  if (text.length > 20000) throw new AppError('TOO_LONG', 'Text exceeds the 20,000 character limit.');
  const { key, index } = keyRing.next();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(GROQ_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: MODEL, temperature: 0.2, messages: buildMessages(ctx) }),
        signal: controller.signal,
      });
    } catch (err) {
      keyRing.fail(index, 0);
      if (err?.name === 'AbortError') throw new AppError('TIMEOUT', 'Translation request timed out.', { retryable: true, cause: err });
      throw new AppError('NETWORK', 'Could not reach the translation service.', { retryable: true, cause: err });
    }
    if (!response.ok) {
      keyRing.fail(index, response.status);
      const code = response.status === 401 || response.status === 403 ? 'AUTH' : response.status === 429 ? 'RATE_LIMITED' : 'SERVER';
      throw new AppError(code, `Translation request failed (${response.status}).`, { status: response.status, retryable: response.status === 429 || response.status >= 500 });
    }
    keyRing.success(index);
    const payload = await response.json();
    const content = payload?.choices?.[0]?.message?.content;
    const parsed = extractJson(content);
    return normalizeResult(parsed || content, { detectedSource: detectLanguage(text) });
  } finally {
    clearTimeout(timer);
  }
}

export function friendlyError(error) {
  const messages = {
    EMPTY_INPUT: ['Nothing to translate', 'Type or paste some text first.'],
    TOO_LONG: ['Text too long', 'Shorten the text and try again.'],
    NO_KEYS: ['API key required', 'Configure a Groq API key to translate.'],
    AUTH: ['API key rejected', 'Check your Groq API key.'],
    RATE_LIMITED: ['Rate limited', 'Wait briefly, then try again.'],
    TIMEOUT: ['Request timed out', 'The translation service took too long.'],
    NETWORK: ['Network error', 'Check your connection and try again.'],
    SERVER: ['Service unavailable', 'Try again shortly.'],
    BAD_OUTPUT: ['Unreadable response', 'The model returned an invalid translation.'],
  };
  const [title, message] = messages[error?.code] || ['Translation failed', error?.message || 'Unexpected error.'];
  return { title, message, retryable: Boolean(error?.retryable) };
}
