# SilkloraAI Local AI Hub

Local inference server for the SilkloraAI phone app. It runs language and vision models (GGUF) on your computer and serves them to the phone over Wi-Fi.

## Start

The launcher does the whole setup itself. You only need to run one file:

- **Windows:** `start-server.bat`
- **Linux and macOS:** `./start-server.sh`

On the first run it:

1. Finds Python 3.10 to 3.13. If none is found, it downloads Python 3.11 into `python_runtime\` (about 25 MB).
2. Creates a private environment in `venv\` and installs all packages into it.
3. Installs the inference engine for your graphics card (CUDA on NVIDIA, CPU otherwise).
4. Opens the network port (8080 and up) for the phone in the Windows firewall (one administrator prompt).
5. Starts the server and opens the dashboard at `http://localhost:8080`.

Later runs skip what is already installed and start in a few seconds.

Options:

- `start-server.bat install` installs everything and exits without starting the server. Use it to prepare the computer in advance.
- `start-server.bat --repair` reinstalls the inference engine and asks for the firewall rule again.
- `--no-browser` does not open the dashboard automatically.

### Offline installation

If the computer has no internet access, download `python-3.11.9-amd64.exe` from python.org on another machine and place it next to `start-server.bat`. The launcher uses that file instead of downloading. The packages and the engine still need internet access once, during setup.

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
