# SilkloraAI

A clean, local-first mobile client for roleplaying and chatting with AI characters on Android (and modern web browsers).

SilkloraAI connects to any OpenAI-compatible API backend:
- **Local:** Ollama, LM Studio, KoboldCpp, vLLM, text-generation-webui
- **Cloud:** OpenRouter, Groq, Together AI, Mistral, OpenAI, etc.

---

## Features

- **Characters & Group Chats:** Create rich character cards with lore, custom greetings, avatars, and dynamic emotion sprites. Bring multiple characters into group chats with shared world rules and manual speaker invocation.
- **Interactive Memory Graph:** Visual graph of memories, facts, and relationships with draggable nodes and detailed inspection.
- **100% Local & Private:** All characters, personas, messages, and lorebooks stay stored directly on your device via IndexedDB. No external servers or telemetry — your data only talks to the AI endpoint you configure.
- **Customizable Themes:** Personalize the interface with custom accent colors and dedicated chat theme presets.
- **Text Styles:** Configure bot writing style constraints (novelist style, dialogue focus, paragraph limits, etc.).
- **Bilingual:** Native support for both English and Russian.

---

## Installation (Android)

1. Go to the [Releases](../../releases) tab and download `silklora-ai.apk`.
2. Install the APK on your Android device (enable "Install from unknown sources" if prompted).
3. In the app settings, enter your API base URL (for example, `http://192.168.1.5:11434/v1` for local Ollama, or `https://openrouter.ai/api/v1` with your API key), pick a model, and you are ready to chat.

---

## Local Development & Building

### Requirements
- Node.js 18+
- JDK 17
- Android SDK (platform `android-34`)

### Run in Browser
```bash
# Install dependencies
npm install

# Start Vite dev server
npm run dev
```

### Build Android APK
```bash
./build-apk.sh
```
The compiled APK will be output to `silklora-ai.apk` in the root directory.

---

## Authors

- **[Liedety](https://github.com/Liedety)** — project creator, concept, design & testing
- **Gemini** (Google DeepMind / Antigravity) — code architecture & development

---

## License

[MIT](LICENSE) © 2026 Liedety
