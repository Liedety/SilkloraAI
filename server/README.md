# SilkloraAI Local AI Hub (PC Desktop Server)

High-performance, standalone inference server for Windows and Linux workstations. Powers local execution of quantized GGUF language models and multimodal Vision projectors (mmproj) with direct Wi-Fi connectivity for the SilkloraAI mobile application.

---

## Key Features & Architecture

* **Embedded Web Dashboard**: Modern 5-tab browser management console served on `http://localhost:8080`.
* **Hardware Profiler**: Real-time inspection of CPU cores/threads, system RAM, NVIDIA GPU model, and dedicated VRAM via `nvidia-smi`. Automatically computes hardware tiers and tailored model recommendations.
* **GPU & CUDA Acceleration**: Automatically offloads model layers (`n_gpu_layers = -1`) directly to NVIDIA GPU VRAM using CUDA 12.1 prebuilt wheels.
* **Instant QR Code Connectivity**: Displays a high-contrast QR code on the desktop screen. The mobile app scans it with the camera to configure the exact PC IP and test connectivity automatically.
* **Hugging Face Model Store**: Search models by keyword, inspect GGUF quantization files, download with real-time speed progress, and auto-detect unquantized repositories with one-click GGUF suggestions.
* **Dedicated Vision Catalog**: Curated multimodal models (MiniCPM-V 2.6, LLaVA 1.5, Moondream 2, Qwen2-VL) with paired base model and `mmproj` projector downloads.
* **OpenAI-Compatible API**: Implements `/v1/chat/completions` (with Server-Sent Events streaming and multimodal Vision `image_url`), `/v1/models`, and `/v1/health`.
* **Bilingual UI**: English by default with an instant `[ EN | RU ]` toggle in the dashboard header.

---

## Quick Start Guide

### Windows
1. Run the launcher script:
   ```cmd
   start-server.bat
   ```
2. The launcher automatically:
   - Detects or downloads Python 3.11 runtime if missing.
   - Installs required packages from `requirements.txt`.
   - Auto-detects NVIDIA GPUs and installs CUDA-accelerated `llama-cpp-python`.
   - Configures the Windows Defender Firewall inbound rule for port 8080.
   - Opens the web dashboard at `http://localhost:8080`.

### Linux / macOS
1. Grant execute permissions (if needed) and run:
   ```bash
   chmod +x start-server.sh
   ./start-server.sh
   ```
2. Open `http://localhost:8080` in your web browser.

---

## Connecting the Mobile App

1. Ensure your smartphone and PC are connected to the same Wi-Fi network.
2. In the PC dashboard (`http://localhost:8080`), locate the QR code on the **Overview & Connect** tab.
3. Open the **SilkloraAI** app on your phone &rarr; Navigate to **Settings** &rarr; Tap **Scan QR Code**.
4. Point your phone camera at the PC screen. The IP address will populate automatically, and the app will verify the connection.

---

## Hardware Tiers & Recommendations

* **Tier Ultra (16+ GB VRAM)**: Complete GPU offload for 12B to 14B models (Mistral-Nemo 12B HERETIC, Qwen 2.5 14B Instruct, MiniCPM-V 2.6).
* **Tier High (8 - 12 GB VRAM)**: Complete GPU offload for 8B to 12B models (Mistral-Nemo 12B Q4_K_M, Llama 3.1 8B Instruct).
* **Tier Medium (4 - 6 GB VRAM)**: Recommended for 3B to 8B models (Llama 3.2 3B, Qwen 2.5 3B, Moondream 2 1.8B).
* **Tier CPU Mode**: Optimized CPU execution with multithreading for 1B to 3B models.

---

## Server Updates

To update server files in an existing installation:
1. Extract the updated `server.zip` into your server folder, selecting **Replace files**.
2. Your downloaded models in `models/` and existing `python_runtime` or `venv` are preserved. No re-downloading of Python is required.
