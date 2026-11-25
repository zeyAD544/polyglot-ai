# Core/UI integration contract

`src/core.js` is a browser-native ES module and has no DOM dependencies. Import named exports from `../src/core.js` (adjust relative path if the UI entry point moves).

- `LANGS`, `STYLES`, `AUDIENCES`, `RELATIONSHIPS`: source-of-truth option lists.
- `normalizeLangCode(code)`, `detectLanguage(text)`, `isRtl(code)`: language helpers.
- `parseKeyList(text)`, `maskKey(key)`, `KeyRing`: key configuration/rotation helpers. Inject keys from a secure runtime configuration; **do not load, commit, or expose `tokens.txt` in the browser**. The checked-in token file contains credentials and should be removed/rotated.
- `buildMessages({text, source, target, style, audience, relationship})`: returns OpenAI/Groq chat message objects.
- `translate(ctx, {keyRing, fetchImpl?, timeoutMs?})`: makes one Groq request, returns `{translation, detectedSource, notes}`, and throws `AppError` with stable `code` and `retryable` properties. Caller may retry after recoverable errors.
- `extractJson(value)`, `normalizeResult(value, fallback?)`, `friendlyError(error)`: response and error helpers.

UI should disable submit while translating, render returned strings using `textContent` (not `innerHTML`), display `friendlyError(error)` on failure, and apply RTL direction based on `isRtl(target)`. This browser-direct API request is suitable only for demos with user-supplied keys; production credentials require a server-side proxy.
