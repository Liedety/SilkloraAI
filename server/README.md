# SilkloraAI Local AI Hub

Local inference server for the SilkloraAI phone app. It runs language and vision models (GGUF) on your computer and serves them to the phone over Wi-Fi.

## Start

1. Run `start-server.bat` (Windows) or `./start-server.sh` (Linux and macOS).
2. The first start prepares everything on its own: Python (if missing), packages, the inference engine for your graphics card, and the network port for the phone. Later starts take a few seconds.
3. The dashboard opens at `http://localhost:8080`.

That single launcher is all you need. Options: `--repair` reinstalls the engine and asks for the firewall rule again, `--no-browser` does not open the dashboard.

## Using the dashboard

- **Home**: setup checklist, QR code for the phone, current model, quick chat test.
- **Models**: models picked for your computer, search on Hugging Face, installed files.
- **System**: hardware, engine, loading options, log and diagnostic report.

Connecting the phone: put the phone on the same Wi-Fi, open the app, Settings, Local AI, Scan QR.

## Models are chosen by your hardware

No model names are built in. The server measures video memory, RAM and CPU, then queries Hugging Face live and shows models whose size fits, grouped as best balance, lighter and faster, or larger and slower. For every repository it picks the quantization that fits your memory. Models whose architecture the installed engine cannot run are filtered out. One click downloads and starts a model, together with its image projector when it has one.

You can also search by name, paste a Hugging Face link, or copy any `.gguf` file into `models/`.

## Context length and long chats

- The server reads the model header and plans memory itself: context length (up to 32k by default), how many layers go to the graphics card, and a compressed context cache when it is safe. Override these in System if needed.
- The server reports the loaded context and a recommended prompt size at `/v1/models`. The app fits its prompt to that budget: newest messages word for word, older ones in a rolling summary, with no uncovered gap in between.
- As a safety net the server counts real tokens for every request. If a request is still too long it trims the oldest turns and keeps a short digest of them, so a chat never fails with a context error.

## Folder layout

```
start-server.bat / start-server.sh   single launchers
bootstrap.py                         setup and start
server.py                            entry point
hub/                                 server code
web/                                 dashboard
models/                              GGUF files
data/                                settings and logs
tests/                               unit tests (python -m unittest discover -s tests)
```

## API

OpenAI-compatible: `POST /v1/chat/completions` (streaming and images), `GET /v1/models`, `GET /v1/health`. Management endpoints under `/api/` and the dashboard are available only on the computer running the server.

## Updating

Extract the new files over the old folder. `models/`, `data/` and the Python runtime are kept.
