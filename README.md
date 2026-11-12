# SilkloraAI

A local-first mobile roleplay client for Android (and modern web browsers), paired with an optional standalone desktop inference server (**Silklora Local AI Hub**) for running local GGUF models over Wi-Fi.

SilkloraAI works with:
- **Local PC Server:** Built-in **Silklora Local AI Hub** (`server/`) with one-click setup and QR code pairing, plus Ollama, LM Studio, KoboldCpp, vLLM, or any OpenAI-compatible server.
- **Cloud APIs:** OpenRouter, Groq, Together AI, Mistral, OpenAI, etc.

---

## Features

- **Silklora Local AI Hub (`server/`):** Standalone PC server (Windows, Linux, macOS) with automated Python/engine setup (CUDA, Metal, CPU), hardware-aware Hugging Face GGUF model search, resumable downloads, `mmproj` vision pairing, and a local web dashboard with QR code pairing.
- **Characters, Groups & Emotion Sprites:** Rich character cards with lore, custom greetings, static avatars, and dedicated emotion sprites rendered below messages with validated emotion tags.
- **Per-Function AI Routing & Vision:** Route roleplay chat, Magic Wand ghostwriter, memory extraction, summarization, character/group generators, and image/vision requests independently between your PC and cloud APIs.
- **Interactive Memory Graph & Long-Chat Optimization:** Draggable knowledge graph of facts and relationships, cache-friendly prompt layout, token-budgeted verbatim context window, and batched rolling summaries.
- **100% Local & Private:** Characters, personas, messages, and memory graphs are stored directly on your device via IndexedDB.
- **Customizable UI & Bilingual Support:** 4-tab settings, Graphite & custom themes, configurable writing styles, and full English / Russian localization.

---

## Quick Start (v2.0.0)

### 1. Android App
1. Download `silklora-ai.apk` from [Releases](../../releases).
2. Install the APK on your Android device.
3. Connect either a cloud API key or your local PC server via QR code in **Settings -> AI & Connection**.

### 2. Local PC Server (`server.zip`)
1. Download `server.zip` from [Releases](../../releases) (or use the `server/` folder from this repository) and extract it on your PC.
2. Run `start-server.bat` (Windows) or `./start-server.sh` (Linux / macOS).
3. On first launch, the launcher installs Python 3.12 (if missing), required packages, and an inference engine matched to your GPU/CPU, then opens the web dashboard at `http://localhost:8080`.
4. Download a GGUF model from the **Models** tab, load it, and scan the dashboard QR code from the mobile app.

For detailed server options and troubleshooting, see [`server/README.md`](server/README.md).

---

## Local Development & Building

### Requirements
- Node.js 18+
- JDK 17
- Android SDK (platform `android-34`)
- Python 3.10–3.13 (optional; for running server unit tests)

### Run Web App & Tests
```bash
npm install
npm test
npm run dev
```

### Build Android APK
```bash
./build-apk.sh
```

---

## Authors

- **[Liedety](https://github.com/Liedety)** — project creator, concept, design & testing
- **Gemini** (Google DeepMind / Antigravity) — code architecture & development

---

## License

[MIT](LICENSE) © 2026 Liedety
