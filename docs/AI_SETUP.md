# Optional AI vision — setup

Desktop Cat is complete without AI. The optional AI mode lets the cat react to a *coarse description* of part of your screen (scene type, energy, interest, and one of eight allowed reactions). It never controls your PC: the model's answer is validated against a strict schema and can only pick among `ignore, watch, approach, play, startle, sit_nearby, sleep, groom`.

## 1. Opt in

Settings → **Privacy & Vision** → choose **AI** and read the consent dialog. Nothing is captured before you confirm. You can revoke at any time; **privacy pause** (tray menu) stops capture instantly.

Defaults once enabled: at most one AI request every 2 minutes and 12 per hour, only after a significant visual change or when the cat is curious; frames are ≤512 px JPEGs of the region around the cat, with the cat and excluded windows blacked out; nothing is stored.

## 2. Pick a provider (Settings → AI)

### Ollama (local, recommended)

1. Install Ollama from ollama.com and pull a small vision model, for example:
   ```
   ollama pull qwen3-vl:4b-instruct
   ```
   (Other vision models such as `gemma3:4b`, `qwen2.5vl:3b` or `granite3.2-vision` also work. Desktop Cat never downloads models itself.)
2. Provider **Ollama**, base URL `http://127.0.0.1:11434`, click **List models**, pick the model, **Test connection** (the test sends a synthetic picture, never your screen).

Ollama also offers *cloud* models (names ending in `-cloud`, or aliases of them). Those forward the image to ollama.com: Desktop Cat treats any model it cannot confirm as local as **cloud** and refuses to use it unless you enable **Allow cloud processing**.

### OpenAI-compatible local server (LM Studio, llama.cpp `llama-server`, vLLM)

Provider **OpenAI-compatible**, base URL e.g. `http://127.0.0.1:1234/v1` (LM Studio) or `http://127.0.0.1:8080/v1` (llama.cpp), model id as the server lists it, API key only if your server requires one. Structured output (`json_schema`) is used when the server supports it, with a plain-instruction fallback.

### Anthropic (cloud)

Provider **Anthropic**, model defaults to `claude-haiku-5-5` (the smallest current vision-capable Claude model as of 2026-10-28). Paste your API key (stored encrypted with Windows DPAPI; the settings window only ever shows "Key stored ✓"). Because images leave your PC, you must also turn on **Allow cloud processing**; the tray then shows `Vision: AI (cloud)`. Usage is billed by Anthropic to your account.

Any non-loopback URL for the other providers is also treated as cloud.

## 3. Check it

- Settings → Privacy & Vision → **Preview what the cat sees** shows the exact masked frame.
- Settings → Diagnostics shows the perception status, last error and capture counts.
- If the provider fails 3 times in a row the AI pauses itself with growing back-off (1 → 30 min); fixing the key or URL resets it.

## Status of verification

The adapters were tested against local mock servers that implement the documented request/response shapes (Ollama `/api/chat` + `/api/tags`, OpenAI `/v1/chat/completions` + `/v1/models`, Anthropic `/v1/messages`). They have **not** been exercised against real Ollama, LM Studio or Anthropic endpoints by the developers of this build (no keys were available and the build machine's Ollama was off-limits). Please report incompatibilities with the diagnostics export attached.
