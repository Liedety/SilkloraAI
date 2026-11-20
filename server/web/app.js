(function () {
    "use strict";

    const $ = (sel, root) => (root || document).querySelector(sel);
    const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

    const state = {
        lang: localStorage.getItem("silklora.lang") || ((navigator.language || "en").toLowerCase().startsWith("ru") ? "ru" : "en"),
        view: "home",
        status: null,
        hw: null,
        ip: null,
        kind: "chat",
        modelsTab: "recommended",
        rec: {},
        recLoading: false,
        recError: "",
        searchQuery: "",
        searchResults: null,
        searching: false,
        inspect: null,
        installed: null,
        imageLibrary: null,
        settings: null,
        assistantCfg: null,
        assistantResult: null,
        assistantQuery: "",
        assistantKind: "image",
        assistantLoading: false,
        assistantStartedAt: 0,
        assistantShowCfg: false,
        recStartedAt: 0,
        searchStartedAt: 0,
        inspectStartedAt: 0,
        inspectRepoName: "",
        installedStartedAt: 0,
        switchingModelAt: 0,
        pendingDownload: null,
        chat: [],
        chatAbort: null,
        chatStartedAt: 0,
        online: true,
        lastDownloadState: "",
    };

    const ICONS = {
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"><path d="M20 6 9 17l-5-5"/></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"><path d="M12 8v5"/><path d="M12 17h.01"/></svg>',
        dots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 12h.01M12 12h.01M18 12h.01"/></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
        play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M6 4l14 8-14 8z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"><path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
    };

    const SEARCH_PRESETS = {
        image: [
            { key: "searchPresetImg1", q: "FLUX.1-Kontext-dev-GGUF" },
            { key: "searchPresetImg2", q: "Qwen-Image-Edit" },
            { key: "searchPresetImg4", q: "illustrious" },
            { key: "searchPresetImg6", q: "pony xl" },
            { key: "searchPresetImg5", q: "Chroma-GGUF" },
            { key: "searchPresetImg7", q: "Indigo Furry XL" },
            { key: "searchPresetImg3", q: "sdxl-turbo" },
        ],
        chat: [
            { key: "searchPresetChat1", q: "Qwen3 8B" },
            { key: "searchPresetChat2", q: "gemma-3-12b-it" },
            { key: "searchPresetChat3", q: "Qwen3 4B" },
            { key: "searchPresetChat4", q: "Llama-3.1-8B-Instruct" },
        ],
        vision: [
            { key: "searchPresetVis1", q: "Qwen2.5-VL-7B-Instruct" },
            { key: "searchPresetVis2", q: "gemma-3-12b-it" },
            { key: "searchPresetVis3", q: "gemma-3-4b-it" },
        ],
    };

    // ------------------------------------------------------------------ helpers

    function t(key, vars) {
        const dict = window.I18N[state.lang] || window.I18N.en;
        let text = dict[key] !== undefined ? dict[key] : (window.I18N.en[key] !== undefined ? window.I18N.en[key] : key);
        if (vars) {
            Object.keys(vars).forEach((k) => { text = text.split("{" + k + "}").join(vars[k]); });
        }
        return text;
    }

    function esc(value) {
        return String(value === undefined || value === null ? "" : value)
            .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    }

    function fmtBytes(bytes) {
        if (!bytes) return "0";
        const gb = bytes / 1073741824;
        if (gb >= 1) return gb.toFixed(gb >= 10 ? 1 : 2) + " GB";
        return Math.round(bytes / 1048576) + " MB";
    }

    function fmtGb(bytes) { return (bytes / 1073741824).toFixed(1); }
    function fmtNum(n) { return Number(n || 0).toLocaleString(state.lang === "ru" ? "ru-RU" : "en-US"); }

    function fmtEta(sec) {
        if (sec === null || sec === undefined) return "";
        if (sec < 60) return sec + (state.lang === "ru" ? " с" : " s");
        const m = Math.floor(sec / 60);
        if (m < 60) return m + (state.lang === "ru" ? " мин" : " min");
        return Math.floor(m / 60) + (state.lang === "ru" ? " ч " : " h ") + (m % 60) + (state.lang === "ru" ? " мин" : " min");
    }

    function taskProgressHtml(opts) {
        const pct = (opts.percent !== null && opts.percent !== undefined && opts.percent > 0)
            ? Math.max(4, Math.min(100, Math.round(opts.percent)))
            : null;
        const sinceAttr = opts.startedAtMs ? ' data-elapsed-since="' + Number(opts.startedAtMs) + '"' : "";
        const pctAttr = pct !== null ? ' data-pct="' + pct + '"' : "";
        const elapsedSec = opts.elapsedSec !== undefined && opts.elapsedSec !== null
            ? Math.max(0, Math.round(opts.elapsedSec))
            : (opts.startedAtMs ? Math.max(0, Math.floor((Date.now() - opts.startedAtMs) / 1000)) : 0);
        const metaParts = [];
        if (pct !== null) metaParts.push(pct + "%");
        metaParts.push(t("actElapsed", { s: elapsedSec }));
        const barCls = pct !== null ? "progress active" + (opts.okColor ? " ok" : "") : "progress indeterminate";
        const barSpan = pct !== null ? '<span style="width:' + pct + '%"></span>' : "<span></span>";
        return '<div class="task-progress">' +
            '<div class="task-progress-head"><strong>' + esc(opts.label || "") + "</strong>" +
            '<span class="task-progress-meta"' + sinceAttr + pctAttr + ">" + esc(metaParts.join(" - ")) + "</span></div>" +
            '<div class="' + barCls + '">' + barSpan + "</div>" +
            (opts.subtext ? '<div class="task-progress-sub">' + esc(opts.subtext) + "</div>" : "") +
            "</div>";
    }

    function updateLiveElapsedNodes() {
        $$("[data-elapsed-since]").forEach((el) => {
            const since = Number(el.getAttribute("data-elapsed-since") || 0);
            if (!since) return;
            const sec = Math.max(0, Math.floor((Date.now() - since) / 1000));
            const pct = el.getAttribute("data-pct");
            const parts = [];
            if (pct) parts.push(pct + "%");
            parts.push(t("actElapsed", { s: sec }));
            el.textContent = parts.join(" - ");
        });
    }

    function llmLoadStepLabel(modelObj) {
        const code = (modelObj && modelObj.loading_step_code) || "";
        if (code === "preparing") return t("actStagePreparing");
        if (code === "releasing_memory") return t("actStageReleasing");
        if (code === "planning_memory") return t("actStagePlanning");
        if (code === "loading_weights") return t("actStageLoadingWeights");
        if (code === "retrying") return t("actStageRetrying");
        return (modelObj && modelObj.loading_step) || t("loading");
    }

    function sceneJobStageLabel(job) {
        if (!job) return "";
        const st = job.stage || job.status || "";
        if (st === "preparing" || st === "queued") return t("actSceneStagePrep");
        if (st === "loading_model") return t("actSceneStageLoad");
        if (st === "encoding_prompt") return t("actSceneStageEncode");
        if (st === "decoding") return t("actSceneStageDecode");
        if (job.total_steps && job.step) return t("actSceneStageStep", { a: job.step, b: job.total_steps });
        return t("actSceneStagePrep");
    }

    function loraJobStageLabel(job) {
        if (!job) return "";
        const st = job.stage || job.status || "";
        if (st === "preparing_dataset" || st === "preparing") return t("actLoraStageDataset");
        if (st === "loading_checkpoint") return t("actLoraStageLoad");
        if (st === "encoding_latents") return t("actLoraStageEncode");
        if (st === "saving_weights") return t("actLoraStageSave");
        if (job.total_steps && job.step) return t("actLoraStageStep", { a: job.step, b: job.total_steps });
        return t("actLoraStageLoad");
    }

    function loraGuideHtml() {
        return '<details class="expert-details" style="margin-top:12px"><summary>' + esc(t("loraGuideSummary")) + "</summary>" +
            '<div class="guide-list">' +
            "<div>" + esc(t("loraGuideP1")) + "</div>" +
            "<div>" + esc(t("loraGuideP2")) + "</div>" +
            "<div>" + esc(t("loraGuideP3")) + "</div>" +
            "<div>" + esc(t("loraGuideP4")) + "</div>" +
            "</div></details>";
    }

    function activeServerActivity(s) {
        if (!s) return null;
        const imgJob = s.image_engine && s.image_engine.active_job;
        if (imgJob) {
            return {
                kind: "scene",
                jobId: imgJob.job_id,
                label: t("actSceneGenerating", { m: imgJob.model || "sd-server", s: sceneJobStageLabel(imgJob) }),
                percent: imgJob.progress || 10,
                elapsedSec: imgJob.elapsed_sec || 0,
            };
        }
        const loraJob = s.lora_trainer && s.lora_trainer.job;
        if (loraJob && (loraJob.status === "preparing" || loraJob.status === "training")) {
            return {
                kind: "lora",
                label: t("actLoraTraining", { f: loraJob.output_file || "LoRA", s: loraJobStageLabel(loraJob) }),
                percent: loraJob.progress || 5,
                elapsedSec: loraJob.elapsed_sec || 0,
            };
        }
        if (s.model && s.model.is_loading) {
            return {
                kind: "llm_load",
                label: t("actLoadingLlm", { m: s.model.loading_model || "" }) + " - " + llmLoadStepLabel(s.model),
                percent: s.model.loading_progress || null,
                elapsedSec: Math.round(s.model.loading_elapsed || 0),
            };
        }
        if (s.coordinator && s.coordinator.mode === "swapping") {
            return {
                kind: "swap",
                label: t("actSwappingMemory"),
                percent: null,
                elapsedSec: Math.round(s.coordinator.swap_elapsed || 0),
            };
        }
        if (s.model && s.model.is_generating) {
            return {
                kind: "llm_gen",
                label: t("actLlmGenerating", { m: s.model.model || "LLM" }),
                percent: null,
                elapsedSec: Math.round(s.model.generating_elapsed || 0),
            };
        }
        if (state.switchingModelAt) {
            return {
                kind: "switch",
                label: t("switchingModelProgress"),
                percent: null,
                elapsedSec: Math.max(0, Math.floor((Date.now() - state.switchingModelAt) / 1000)),
            };
        }
        return null;
    }

    function renderActivityBar() {
        const bar = $("#activityBar");
        if (!bar) return;
        const act = activeServerActivity(state.status);
        if (!act) {
            bar.hidden = true;
            bar.innerHTML = "";
            return;
        }
        const pct = (act.percent !== null && act.percent !== undefined && act.percent > 0)
            ? Math.max(4, Math.min(100, Math.round(act.percent)))
            : null;
        const meta = (pct !== null ? pct + "% - " : "") + t("actElapsed", { s: act.elapsedSec || 0 });
        const barCls = pct !== null ? "progress active ok" : "progress indeterminate";
        const barSpan = pct !== null ? '<span style="width:' + pct + '%"></span>' : "<span></span>";
        bar.hidden = false;
        bar.innerHTML = '<div class="activity-inner"><div class="activity-main">' +
            '<div class="activity-head"><strong>' + esc(act.label) + '</strong><span class="activity-meta">' + esc(meta) + "</span></div>" +
            '<div class="' + barCls + '">' + barSpan + "</div></div>" +
            (act.kind === "scene" && act.jobId
                ? '<button class="btn small danger" id="actCancelSceneBtn">' + esc(t("actCancelScene")) + "</button>"
                : "") +
            "</div>";
        const cBtn = $("#actCancelSceneBtn");
        if (cBtn && act.jobId) {
            cBtn.onclick = async () => {
                cBtn.disabled = true;
                await api("/api/images/jobs/" + encodeURIComponent(act.jobId) + "/cancel", { method: "POST" }).catch(() => {});
                refreshStatus();
            };
        }
    }

    async function api(path, options) {
        const opts = Object.assign({ headers: {} }, options || {});
        if (opts.body && typeof opts.body !== "string") {
            opts.body = JSON.stringify(opts.body);
            opts.headers["Content-Type"] = "application/json";
        }
        let res;
        try {
            res = await fetch(path, opts);
        } catch (e) {
            setOnline(false);
            throw { status: 0, message: "network" };
        }
        setOnline(true);
        if (!res.ok) {
            let detail = "";
            try {
                const data = await res.json();
                detail = data.detail || (data.error && data.error.message) || "";
                if (data.error && data.error.code === "local_only") showBanner(t("localOnly"));
            } catch (e) { /* not JSON */ }
            throw { status: res.status, message: String(detail) };
        }
        return res.json();
    }

    function setOnline(value) {
        if (state.online === value) return;
        state.online = value;
        if (value) hideBanner(); else showBanner(t("connectionLost"));
        renderPill();
    }

    function showBanner(text) {
        const el = $("#banner");
        el.textContent = text;
        el.hidden = false;
    }

    function hideBanner() { $("#banner").hidden = true; }

    function toast(text) { showBanner(text); setTimeout(hideBanner, 6000); }

    // ------------------------------------------------------------------ top bar

    function applyStaticText() {
        document.documentElement.lang = state.lang;
        $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
        $$("#lang button").forEach((b) => b.classList.toggle("active", b.dataset.lang === state.lang));
    }

    function renderPill() {
        const pill = $("#statusPill");
        const text = $("#statusPillText");
        const s = state.status;
        pill.className = "pill";
        const loraBusy = Boolean(s && s.lora_trainer && s.lora_trainer.job && (s.lora_trainer.job.status === "preparing" || s.lora_trainer.job.status === "training"));
        const imgBusy = Boolean(s && s.image_engine && s.image_engine.is_busy);
        if (state.online && !s) {
            pill.classList.add("busy");
            text.textContent = t("connectingStatus");
        } else if (!state.online || !s) {
            pill.classList.add("bad");
            text.textContent = t("pillOffline");
        } else if (s.model.is_loading || (s.coordinator && s.coordinator.mode === "swapping") || imgBusy || loraBusy || s.model.is_generating) {
            pill.classList.add("busy");
            text.textContent = (s.model.is_loading || (s.coordinator && s.coordinator.mode === "swapping"))
                ? t("pillLoading")
                : (imgBusy || (s.coordinator && s.coordinator.mode === "image") ? t("modeImagePill") : t("pillReady"));
        } else if (s.coordinator && s.coordinator.mode === "image") {
            pill.classList.add("ok");
            text.textContent = t("modeImagePill");
        } else if (s.model.ready) {
            pill.classList.add("ok");
            text.textContent = t("pillReady");
        } else {
            text.textContent = t("pillNoModel");
        }
    }

    function setView(view) {
        state.view = view;
        $$(".nav-btn").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
        $$(".view").forEach((v) => v.classList.toggle("active", v.id === "view-" + view));
        if (view === "home") { refreshImageLibrary(); updateHome(); }
        if (view === "models") enterModels();
        if (view === "assistant") renderAssistant();
        if (view === "system") enterSystem();
    }

    // ------------------------------------------------------------------ messages & badges

    function loadErrorText(err) {
        if (!err) return "";
        switch (err.code) {
            case "engine_missing": return t("errEngineMissing");
            case "file_missing": return t("errFileMissing");
            case "is_projector": return t("errIsProjector");
            case "file_invalid": return t("errFileInvalid");
            case "out_of_memory": return t("errOom");
            case "load_failed": return t("errLoadFailed", { arch: err.arch || "?", engine: err.engine || "?" });
            case "engine_crash": return t("errEngineCrash");
            default: return err.message || t("error");
        }
    }

    function planNotes(plan) {
        const out = [];
        const warns = plan.warnings || [];
        if (warns.includes("engine_cpu_only")) out.push({ cls: "warn", text: t("warnEngineCpuOnly") });
        else if (warns.includes("cpu_only_with_gpu")) out.push({ cls: "warn", text: t("warnCpuOnly") });

        if (warns.includes("partial_offload")) {
            const ratio = plan.n_layer ? (plan.layers_gpu / plan.n_layer) : 1;
            if (ratio < 0.5) out.push({ cls: "warn", text: t("warnPartialSlow") });
            else out.push({ cls: "", text: t("infoPartialGpu") });
        }
        if (warns.includes("memory_tight")) out.push({ cls: "warn", text: t("warnMemory") });
        if (warns.includes("fallback_settings")) out.push({ cls: "", text: t("warnFallback") });
        if (warns.includes("ctx_above_training")) out.push({ cls: "", text: t("warnCtxTrain") });
        if (warns.includes("vision_handler_missing")) out.push({ cls: "warn", text: t("warnVisionNoHandler") });
        return out;
    }

    function fitBadge(fit) {
        const map = {
            gpu_full: ["ok", "fitGpuFull"],
            gpu_stream: ["ok", "fitGpuStream"],
            gpu_partial: ["accent", "fitGpuPartial"],
            cpu_ok: ["", "fitCpuOk"],
            too_big: ["bad", "fitTooBig"],
            projector: ["", "fitProjector"],
        };
        const entry = map[fit];
        return entry ? '<span class="badge ' + entry[0] + '">' + t(entry[1]) + "</span>" : "";
    }

    function archBadge(supported, arch) {
        if (supported === false) return '<span class="badge bad">' + esc(t("archUnsupported", { a: arch })) + "</span>";
        return "";
    }

    // ------------------------------------------------------------------ HOME

    async function refreshImageLibrary() {
        try {
            state.imageLibrary = await api("/api/images/models");
            if (state.view === "home" && state.status) renderImageModelCard(state.status);
        } catch (e) { /* ignore initial offline */ }
    }

    function initHome() {
        $("#view-home").innerHTML =
            '<div class="stack">' +
            '<div class="card"><div class="card-head"><h2>' + t("quickStart") + '</h2></div><div class="steps" id="homeSteps"><div class="small muted">' + t("loadingData") + '</div></div></div>' +
            '<div class="grid-2">' +
            '<div class="card" id="homePhone"><div class="card-head"><h2>' + t("connectTitle") + '</h2></div><div class="small muted">' + t("loadingData") + '</div></div>' +
            '<div class="card" id="homeModel"><div class="card-head"><h2>' + t("currentModel") + '</h2></div><div class="small muted">' + t("loadingData") + '</div></div>' +
            "</div>" +
            '<div class="card" id="homeImageModel"><div class="card-head"><h2>' + t("currentImageModel") + '</h2></div><div class="small muted">' + t("loadingData") + '</div></div>' +
            '<div class="card" id="homeChat"></div>' +
            "</div>";
        renderChatCard();
        state.sig = {};
        updateHome();
    }

    function stepHtml(cls, icon, title, text, action) {
        return '<div class="step ' + cls + '"><div class="step-icon">' + ICONS[icon] + '</div><div class="step-body"><div class="step-title">' +
            esc(title) + '</div><div class="step-text">' + esc(text) + "</div>" + (action || "") + "</div></div>";
    }

    function updateHome() {
        const s = state.status;
        if (!s || state.view !== "home") return;

        const hasGpu = Boolean((state.hw && state.hw.gpu && state.hw.gpu.has_gpu) || s.engine.gpu_offload);
        const gpuMissing = Boolean(state.hw && state.hw.gpu && state.hw.gpu.kind === "cuda" && s.engine.available && !s.engine.gpu_offload);
        const imgEng = s.image_engine || {};
        const sdOk = Boolean(imgEng.sdcpp && imgEng.sdcpp.installed);
        const sdTag = (imgEng.sdcpp && (imgEng.sdcpp.backend || imgEng.sdcpp.tag)) || "sd-server";

        let enginesStep;
        if (!s.engine.available) {
            enginesStep = stepHtml("bad", "alert", t("stepEnginesTitle"), t("stepEngineBad"));
        } else if (gpuMissing) {
            const failed = ((s.engine_setup && s.engine_setup.attempts) || []).filter((a) => a.result === "failed" && a.reason);
            const reason = failed.length ? " " + t("engineReason", { r: failed[failed.length - 1].reason }) : "";
            enginesStep = stepHtml("warn", "alert", t("stepEnginesTitle"), t("stepEngineGpuMissing") + reason);
        } else {
            const label = hasGpu
                ? t("stepEnginesAllOk", { v: s.engine.version, t: sdOk ? sdTag : "auto" })
                : t("stepEnginesCpuOk", { v: s.engine.version });
            const extra = sdOk ? "" : (" " + t("stepImageEngineMissingNote"));
            enginesStep = stepHtml("ok", "check", t("stepEnginesTitle"), label + extra);
        }

        const coord = s.coordinator || {};
        let modelStep;
        if (s.model.ready) {
            modelStep = stepHtml("ok", "check", t("stepModel"), s.model.model);
        } else if (s.model.is_loading || coord.mode === "swapping") {
            modelStep = stepHtml("", "dots", t("stepModel"), t("stepModelLoading") + " " + (s.model.loading_model || ""));
        } else if (coord.mode === "image" && coord.saved_llm && coord.saved_llm.model) {
            modelStep = stepHtml(
                "ok",
                "check",
                t("stepModel"),
                t("stepModelSwapped", { m: coord.saved_llm.model }),
                '<div class="step-action"><button class="btn small" id="homeRestoreLlmBtn">' + t("backToChatLlm") + "</button></div>"
            );
        } else if (s.model.load_error) {
            modelStep = stepHtml("bad", "alert", t("stepModel"), loadErrorText(s.model.load_error));
        } else {
            modelStep = stepHtml("", "dots", t("stepModel"), t("stepModelNone"), '<div class="step-action"><button class="btn primary small" data-goto="models">' + t("chooseModel") + "</button></div>");
        }

        const activeImg = (s.settings && s.settings.image_model) || (imgEng && imgEng.image_model) || "";
        const imgModelStep = activeImg
            ? stepHtml("ok", "check", t("stepImageModel"), activeImg)
            : stepHtml("", "dots", t("stepImageModel"), t("stepImageModelNone"), '<div class="step-action"><button class="btn small" id="homeOpenImgBtn">' + t("chooseImageModel") + "</button></div>");

        const phoneStep = s.phone.connected
            ? stepHtml("ok", "check", t("stepPhone"), t("stepPhoneOk"))
            : stepHtml("", "dots", t("stepPhone"), t("stepPhoneWait"));

        const stepsHtml = enginesStep + modelStep + imgModelStep + phoneStep;
        if (state.sig.steps !== stepsHtml) {
            state.sig.steps = stepsHtml;
            $("#homeSteps").innerHTML = stepsHtml;
            const imgBtn = $("#homeOpenImgBtn");
            if (imgBtn) imgBtn.onclick = () => { state.modelsTab = "recommended"; state.kind = "image"; setView("models"); };
            const restoreBtn = $("#homeRestoreLlmBtn");
            if (restoreBtn) {
                restoreBtn.onclick = async () => {
                    restoreBtn.disabled = true;
                    await api("/api/images/unload", { method: "POST", body: { restore_llm: true } }).catch(() => {});
                    refreshStatus();
                };
            }
        }

        renderPhoneCard(s);
        renderModelCard(s);
        renderImageModelCard(s);
    }

    function selectedAdapter(s) {
        const list = s.network.adapters;
        if (!state.ip || !list.some((a) => a.ip === state.ip)) state.ip = s.network.primary_ip;
        return list.find((a) => a.ip === state.ip) || list[0];
    }

    function adapterLabel(a) {
        const kinds = { wifi: "netWifi", ethernet: "netEthernet", virtual: "netVirtual", other: "netOther", loopback: "netLoopback" };
        return a.ip + " - " + a.interface + " (" + t(kinds[a.kind] || "netOther") + ")";
    }

    function renderPhoneCard(s) {
        const adapter = selectedAdapter(s);
        const url = "http://" + adapter.ip + ":" + s.port + "/v1";
        const sig = JSON.stringify([url, s.network.adapters.map((a) => a.ip), state.lang]);
        if (state.sig.phone !== sig) {
            state.sig.phone = sig;
            const options = s.network.adapters.map((a) =>
                '<option value="' + esc(a.ip) + '"' + (a.ip === adapter.ip ? " selected" : "") + ">" + esc(adapterLabel(a)) + "</option>").join("");
            $("#homePhone").innerHTML =
                '<div class="card-head"><h2>' + t("connectTitle") + "</h2></div>" +
                '<div class="qr-wrap"><div class="qr-box" id="qrBox"></div><div class="qr-side">' +
                '<div><span class="field-label">' + t("phoneAddress") + '</span><div class="url-row"><input type="text" readonly id="phoneUrl" value="' + esc(url) + '">' +
                '<button class="btn" id="copyUrl" title="' + t("copy") + '">' + ICONS.copy + "</button></div></div>" +
                (s.network.adapters.length > 1 ? '<div><span class="field-label">' + t("network") + '</span><select id="adapterSelect">' + options + "</select></div>" : "") +
                (adapter.kind === "virtual" || adapter.kind === "loopback" ? '<div class="note warn">' + t("virtualWarn") + "</div>" : "") +
                '<div class="small muted">' + t("connectHint1") + "<br>" + t("connectHint2") + "</div>" +
                '<div class="small" id="phoneSeen"></div><div class="small muted" id="phoneFw" hidden>' + t("firewallHint") + "</div>" +
                "</div></div>";
            const box = $("#qrBox");
            if (window.QRCode) {
                new QRCode(box, { text: url, width: 170, height: 170, colorDark: "#0a0a0a", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
            }
            $("#copyUrl").onclick = () => {
                const done = () => { $("#copyUrl").innerHTML = ICONS.check; setTimeout(() => { $("#copyUrl").innerHTML = ICONS.copy; }, 1500); };
                if (navigator.clipboard) navigator.clipboard.writeText(url).then(done); else { $("#phoneUrl").select(); document.execCommand("copy"); done(); }
            };
            const select = $("#adapterSelect");
            if (select) select.onchange = () => { state.ip = select.value; state.sig.phone = ""; updateHome(); };
        }
        const seen = $("#phoneSeen");
        if (seen) {
            seen.textContent = s.phone.connected ? t("phoneSeen", { s: s.phone.seconds_ago }) : t("phoneWaiting");
            seen.className = "small " + (s.phone.connected ? "" : "muted");
            const fw = $("#phoneFw");
            if (fw) fw.hidden = s.phone.connected;
        }
    }

    function planDetails(plan, model) {
        const rows = [];
        rows.push([t("ctxLabel"), t("ctxValue", { n: fmtNum(plan.n_ctx) })]);
        let offload = t("offloadNone");
        if (plan.offload === "full") offload = t("offloadFull");
        else if (plan.offload === "partial") offload = t("offloadPartial", { a: plan.layers_gpu, b: plan.n_layer });
        rows.push([t("offloadLabel"), offload]);
        rows.push([t("memoryLabel"), plan.est_gpu_gb > 0 ? t("memoryValue", { g: plan.est_gpu_gb, r: plan.est_ram_gb }) : t("memoryRamOnly", { r: plan.est_ram_gb })]);
        rows.push([t("kvLabel"), plan.kv_type === "q8_0" ? t("kvQ8") : t("kvF16")]);
        rows.push([t("visionLabel"), model.projector ? t("visionOn") : t("visionOff")]);
        rows.push([t("promptLabel"), t("ctxValue", { n: fmtNum(model.recommended_prompt_tokens) })]);
        return '<dl class="kv">' + rows.map((r) => "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>").join("") + "</dl>";
    }

    function renderModelCard(s) {
        const m = s.model;
        const coord = s.coordinator || {};
        let html = '<div class="card-head"><h2>' + t("currentModel") + "</h2>";
        if (m.ready) html += '<button class="btn small" id="unloadBtn">' + t("unload") + "</button>";
        html += "</div>";

        if (m.is_loading || coord.mode === "swapping") {
            const targetName = m.loading_model || (coord.saved_llm && coord.saved_llm.model) || "";
            const stepText = m.is_loading ? llmLoadStepLabel(m) : (coord.swap_message || t("actSwappingMemory"));
            const elapsed = m.is_loading ? Math.round(m.loading_elapsed || 0) : Math.round(coord.swap_elapsed || 0);
            html += '<div class="model-name" style="margin-bottom:10px">' + esc(targetName) + "</div>" +
                taskProgressHtml({
                    label: stepText,
                    percent: m.is_loading ? (m.loading_progress || null) : null,
                    elapsedSec: elapsed,
                });
        } else if (m.ready) {
            html += '<div class="model-name" style="margin-bottom:12px">' + esc(m.model) + "</div>" + planDetails(m.plan, m);
            if (m.is_generating) {
                html += '<div style="margin-top:12px">' + taskProgressHtml({
                    label: t("actLlmGenerating", { m: m.model }),
                    percent: null,
                    elapsedSec: Math.round(m.generating_elapsed || 0),
                    okColor: true,
                }) + "</div>";
            }
            planNotes(m.plan).forEach((w) => { html += '<div class="note ' + w.cls + '" style="margin-top:12px">' + esc(w.text) + "</div>"; });
            html += '<div class="note" style="margin-top:12px">' + t("longChatNote") + "</div>";
        } else if (coord.mode === "image" && coord.saved_llm && coord.saved_llm.model) {
            html += '<div class="note ok" style="margin-bottom:12px">' + esc(t("stepModelSwapped", { m: coord.saved_llm.model })) + "</div>" +
                '<button class="btn primary small" id="cardRestoreLlmBtn">' + t("backToChatLlm") + "</button>";
        } else if (m.load_error) {
            html += '<div class="note bad">' + esc(loadErrorText(m.load_error)) + "</div>";
            if (m.load_error.message) html += "<details><summary>" + t("errTechnical") + "</summary><pre>" + esc(m.load_error.message) + "</pre></details>";
            html += '<div style="margin-top:14px"><button class="btn primary small" data-goto="models">' + t("chooseModel") + "</button></div>";
        } else {
            html += '<div class="muted" style="margin-bottom:14px">' + t("noModelLoaded") + '</div><button class="btn primary small" data-goto="models">' + t("chooseModel") + "</button>";
        }

        const sig = JSON.stringify([html]);
        if (state.sig.model !== sig) {
            state.sig.model = sig;
            $("#homeModel").innerHTML = html;
            const un = $("#unloadBtn");
            if (un) un.onclick = async () => { un.disabled = true; await api("/api/models/unload", { method: "POST" }).catch(() => {}); refreshStatus(); };
            const rest = $("#cardRestoreLlmBtn");
            if (rest) rest.onclick = async () => { rest.disabled = true; await api("/api/images/unload", { method: "POST", body: { restore_llm: true } }).catch(() => {}); refreshStatus(); };
        }
    }

    function renderImageModelCard(s) {
        const el = $("#homeImageModel");
        if (!el) return;
        const imgEng = s.image_engine || {};
        const sdcpp = imgEng.sdcpp || {};
        const activeJob = imgEng.active_job || null;
        const loraJob = (s.lora_trainer && s.lora_trainer.job) || null;
        const activeLoraTrain = Boolean(loraJob && (loraJob.status === "preparing" || loraJob.status === "training"));
        const activeImg = (s.settings && s.settings.image_model) || imgEng.image_model || "";
        const lib = state.imageLibrary;
        const list = (lib && lib.models) || [];
        const info = list.find((m) => m.filename === activeImg) || null;
        const hasGpu = Boolean((state.hw && state.hw.gpu && state.hw.gpu.has_gpu) || s.engine.gpu_offload);
        const backendLabel = (imgEng.preferred_backend === "comfyui" || imgEng.preferred_backend === "a1111")
            ? imgEng.preferred_backend.toUpperCase()
            : (hasGpu ? t("imageEngineBuiltInGpu") : t("imageEngineBuiltInReady"));

        let statusBadge = "";
        if (info) {
            if (info.weight_role === "lora") {
                statusBadge = '<span class="badge bad">' + t("imageModelLoraBadge") + "</span>";
            } else if (info.missing_companions && info.missing_companions.length) {
                statusBadge = '<span class="badge warn">' + esc(t("imageModelMissingBadge", { m: info.missing_companions.join(", ") })) + "</span>";
            } else {
                statusBadge = '<span class="badge ok">' + t("imageModelReadyBadge") + "</span>";
            }
        }
        const warmBadge = sdcpp.daemon_running
            ? '<span class="badge ok">' + t("imageModelWarmBadge") + "</span>"
            : "";

        let html = '<div class="card-head"><div><h2>' + t("currentImageModel") + '</h2>' +
            '<div class="small muted">' + t("imageEngineBackendLabel") + ": " + esc(backendLabel) + "</div></div>" +
            '<div class="row"><button class="btn small" id="homeOpenFindImage">' + t("navAssistant") + '</button>' +
            '<button class="btn small" id="homeOpenImageRec">' + t("chooseImageModel") + "</button></div></div>";

        if (activeImg) {
            html += '<div class="model-name">' + esc(activeImg) + "</div>" +
                '<div class="model-meta" style="margin-top:8px">' +
                (info && info.family ? '<span class="badge">' + esc(info.family) + (info.variant ? " / " + esc(info.variant) : "") + "</span>" : "") +
                (info && info.supports_refs ? '<span class="badge accent">' + t("supportsRefs") + "</span>" : "") +
                (info ? '<span class="badge">' + fmtBytes(info.size_bytes) + "</span>" : "") +
                statusBadge + warmBadge + "</div>";
        } else {
            html += '<div class="muted" style="margin-bottom:8px">' + t("noImageModelSelected") + "</div>";
        }

        if (activeJob) {
            html += '<div style="margin-top:12px">' + taskProgressHtml({
                label: t("actSceneGenerating", { m: activeJob.model || activeImg || "sd-server", s: sceneJobStageLabel(activeJob) }),
                percent: activeJob.progress || 10,
                elapsedSec: activeJob.elapsed_sec || 0,
                okColor: true,
            }) + "</div>";
        } else if (activeLoraTrain && loraJob) {
            const lastLog = (loraJob.logs && loraJob.logs.length) ? loraJob.logs[loraJob.logs.length - 1] : "";
            html += '<div style="margin-top:12px">' + taskProgressHtml({
                label: t("actLoraTraining", { f: loraJob.output_file || "LoRA", s: loraJobStageLabel(loraJob) }),
                percent: loraJob.progress || 5,
                elapsedSec: loraJob.elapsed_sec || 0,
                subtext: lastLog,
            }) + "</div>";
        }

        if (list.length > 0) {
            html += '<div class="home-img-select"><select id="homeImgSelect"' + (activeJob ? " disabled" : "") + ">" +
                list.map((m) => {
                    const miss = (m.missing_companions || []).length;
                    const missTag = miss ? " [" + t("imageModelMissingDropdown", { m: m.missing_companions.join(", ") }) + "]" : "";
                    return '<option value="' + esc(m.filename) + '"' + (m.filename === activeImg ? " selected" : "") + (m.weight_role === "lora" ? " disabled" : "") + ">" +
                        esc(m.filename) + " (" + (m.weight_role === "lora" ? "LoRA" : esc(m.family || "img")) + ", " + fmtBytes(m.size_bytes) + ")" + esc(missTag) + "</option>";
                }).join("") +
                "</select>" +
                (info && info.weight_role === "lora" ? '<button class="btn small" id="homeMoveLora">' + t("moveToLoras") + "</button>" : "") +
                (info && info.weight_role !== "lora" && info.missing_companions && info.missing_companions.length
                    ? '<button class="btn primary small" id="homeRepairComp">' + ICONS.download + esc(t("repairCompanionsBtn", { m: info.missing_companions.join(", ") })) + "</button>"
                    : "") +
                "</div>";
        }

        const sig = JSON.stringify([
            activeImg,
            backendLabel,
            Boolean(sdcpp.daemon_running),
            activeJob,
            activeLoraTrain ? [loraJob.stage, loraJob.step, loraJob.progress, loraJob.elapsed_sec] : null,
            list.map((x) => x.filename + ":" + x.weight_role + ":" + (x.missing_companions || []).join(",")),
        ]);
        if (state.sig.imageModel !== sig) {
            state.sig.imageModel = sig;
            el.innerHTML = html;
            const recBtn = $("#homeOpenImageRec");
            if (recBtn) recBtn.onclick = () => { state.modelsTab = "recommended"; state.kind = "image"; setView("models"); };
            const findBtn = $("#homeOpenFindImage");
            if (findBtn) findBtn.onclick = () => { state.assistantKind = "image"; setView("assistant"); };
            const sel = $("#homeImgSelect");
            if (sel) {
                sel.onchange = () => {
                    if (sel.value && sel.value !== activeImg) selectImageModel(sel.value);
                };
            }
            const mvBtn = $("#homeMoveLora");
            if (mvBtn && info) mvBtn.onclick = () => moveImageToLora(info.filename);
            const repBtn = $("#homeRepairComp");
            if (repBtn && info) repBtn.onclick = () => repairImageCompanions(info.filename, repBtn);
        }
    }

    function renderChatCard() {
        const el = $("#homeChat");
        el.innerHTML =
            '<div class="card-head"><div><h2>' + t("testChat") + '</h2><div class="small muted">' + t("testChatHint") + "</div></div>" +
            '<button class="btn small" id="chatClear">' + t("clear") + "</button></div>" +
            '<div class="chat-log" id="chatLog"></div>' +
            '<div id="chatProgressBox" hidden style="margin-bottom:12px"></div>' +
            '<div class="chat-input"><input type="text" id="chatInput" placeholder="' + esc(t("testPlaceholder")) + '"><button class="btn primary" id="chatSend">' + ICONS.send + t("send") + "</button></div>";
        redrawChat();
        $("#chatSend").onclick = sendChat;
        $("#chatInput").onkeydown = (e) => { if (e.key === "Enter") sendChat(); };
        $("#chatClear").onclick = () => { state.chat = []; redrawChat(); };
    }

    function redrawChat() {
        const log = $("#chatLog");
        if (!log) return;
        log.innerHTML = state.chat.map((m) => '<div class="msg ' + (m.role === "user" ? "user" : "bot") + '">' + esc(m.content) + "</div>").join("");
        log.scrollTop = log.scrollHeight;
        const pBox = $("#chatProgressBox");
        if (pBox) {
            if (state.chatAbort) {
                pBox.hidden = false;
                pBox.innerHTML = taskProgressHtml({
                    label: t("chatGeneratingProgress"),
                    percent: null,
                    startedAtMs: state.chatStartedAt || Date.now(),
                });
            } else {
                pBox.hidden = true;
                pBox.innerHTML = "";
            }
        }
    }

    async function sendChat() {
        if (state.chatAbort) {
            state.chatAbort.abort();
            return;
        }
        const input = $("#chatInput");
        const text = input.value.trim();
        if (!text) return;
        const canAutoRestore = state.status && state.status.coordinator && state.status.coordinator.mode === "image" && state.status.coordinator.saved_llm;
        if (!state.status || (!state.status.model.ready && !canAutoRestore)) { toast(t("testNoModel")); return; }
        input.value = "";
        state.chat.push({ role: "user", content: text });
        const reply = { role: "assistant", content: "" };
        state.chat.push(reply);

        const controller = new AbortController();
        state.chatAbort = controller;
        state.chatStartedAt = Date.now();
        redrawChat();
        const send = $("#chatSend");
        send.textContent = t("stop");
        try {
            const res = await fetch("/v1/chat/completions", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                signal: controller.signal,
                body: JSON.stringify({
                    messages: state.chat.slice(0, -1).map((m) => ({ role: m.role, content: m.content })),
                    stream: true,
                    max_tokens: 400,
                }),
            });
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                reply.content = (data.error && data.error.message) || t("error");
                redrawChat();
                return;
            }
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const { value, done } = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split("\n");
                buffer = lines.pop();
                for (const line of lines) {
                    if (!line.startsWith("data:")) continue;
                    const payload = line.slice(5).trim();
                    if (!payload || payload === "[DONE]") continue;
                    try {
                        const chunk = JSON.parse(payload);
                        if (chunk.error) reply.content += chunk.error.message || "";
                        const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
                        if (delta && delta.content) reply.content += delta.content;
                    } catch (e) { /* partial line */ }
                }
                redrawChat();
            }
        } catch (e) {
            if (e.name !== "AbortError") reply.content += "\n" + t("error");
            redrawChat();
        } finally {
            state.chatAbort = null;
            state.chatStartedAt = 0;
            redrawChat();
            send.innerHTML = ICONS.send + t("send");
            refreshStatus();
        }
    }

    // ------------------------------------------------------------------ MODELS

    function initModels() {
        $("#view-models").innerHTML =
            '<div class="tabs" id="modelsTabs">' +
            '<button class="tab" data-tab="recommended">' + t("tabRecommended") + "</button>" +
            '<button class="tab" data-tab="search">' + t("tabSearch") + "</button>" +
            '<button class="tab" data-tab="installed">' + t("tabInstalled") + "</button></div>" +
            '<div id="modelsBody"></div>';
        $$("#modelsTabs .tab").forEach((b) => { b.onclick = () => { state.modelsTab = b.dataset.tab; enterModels(); }; });
    }

    function enterModels() {
        if (state.modelsTab === "assistant") state.modelsTab = "recommended";
        $$("#modelsTabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.modelsTab));
        if (state.modelsTab === "recommended") renderRecommended();
        else if (state.modelsTab === "search") renderSearch();
        else renderInstalled();
    }

    function kindChips() {
        return '<div class="chips"><button class="chip' + (state.kind === "chat" ? " active" : "") + '" data-kind="chat">' + t("kindChat") + "</button>" +
            '<button class="chip' + (state.kind === "vision" ? " active" : "") + '" data-kind="vision">' + t("kindVision") + "</button>" +
            '<button class="chip' + (state.kind === "image" ? " active" : "") + '" data-kind="image">' + t("kindImage") + "</button></div>";
    }

    function bindKindChips(onChange) {
        $$("#modelsBody [data-kind]").forEach((b) => { b.onclick = () => { state.kind = b.dataset.kind; onChange(); }; });
    }

    async function renderRecommended(forceRefresh) {
        const body = $("#modelsBody");
        const data = state.rec[state.kind];

        let html = '<div class="row" style="justify-content:space-between;align-items:center;margin-bottom:16px">' + kindChips() +
            '<button class="btn small" id="recRefresh">' + ICONS.refresh + t("refresh") + "</button></div>";
        html += pcSummaryHtml(data && data.profile);

        if (data && !forceRefresh) {
            html += recListHtml(data);
            body.innerHTML = html;
            bindRecommended();
            return;
        }

        if (!state.recStartedAt) state.recStartedAt = Date.now();
        html += '<div style="margin-top:12px">' + taskProgressHtml({
            label: t("findingModels"),
            percent: null,
            startedAtMs: state.recStartedAt,
        }) + "</div>";
        body.innerHTML = html;
        bindRecommended();

        if (state.recLoading) return;
        state.recLoading = true;
        const kind = state.kind;
        try {
            state.rec[kind] = await api("/api/recommendations?kind=" + kind + (forceRefresh ? "&refresh=true" : ""));
            state.recError = "";
        } catch (e) {
            state.recError = e.status === 502 || e.status === 0 ? "offline" : e.message;
        }
        state.recLoading = false;
        state.recStartedAt = 0;
        if (state.view === "models" && state.modelsTab === "recommended") {
            if (state.recError) {
                const bodyNow = $("#modelsBody");
                bodyNow.innerHTML = '<div class="row" style="justify-content:space-between;margin-bottom:16px">' + kindChips() + "</div>" +
                    '<div class="note bad">' + esc(state.recError === "offline" ? t("offlineStore") : state.recError) + "</div>" +
                    '<div style="margin-top:14px"><button class="btn small" id="recRefresh">' + ICONS.refresh + t("refresh") + "</button></div>";
                bindRecommended();
            } else {
                renderRecommended();
            }
        }
    }

    function bindRecommended() {
        bindKindChips(() => { state.recStartedAt = 0; renderRecommended(); });
        const refresh = $("#recRefresh");
        if (refresh) refresh.onclick = () => { delete state.rec[state.kind]; state.recStartedAt = 0; renderRecommended(true); };
        $$("#modelsBody [data-dl]").forEach((b) => {
            b.onclick = () => {
                const item = state.rec[state.kind].items[Number(b.dataset.dl)];
                if (state.kind === "image") {
                    const files = [{
                        filename: item.file.filename,
                        local_name: item.file.local_name,
                        size_bytes: item.file.size_bytes,
                        role: "image",
                        family: item.family || "",
                        supports_refs: Boolean(item.supports_refs),
                    }];
                    (item.companions || []).forEach((c) => {
                        files.push({
                            filename: c.filename,
                            repo_id: c.repo_id || item.repo_id,
                            local_name: c.local_name,
                            url: c.url || "",
                            size_bytes: c.size_bytes,
                            role: c.role || "image_aux",
                            aux_role: c.role || "image_aux",
                        });
                    });
                    startDownload(item.repo_id, files, true, b);
                } else {
                    const files = [{ filename: item.file.filename, size_bytes: item.file.size_bytes, role: "model" }];
                    if (item.projector) files.push({ filename: item.projector.filename, size_bytes: item.projector.size_bytes, role: "projector" });
                    startDownload(item.repo_id, files, true, b);
                }
            };
        });
        $$("#modelsBody [data-load]").forEach((b) => {
            b.onclick = () => {
                const item = state.rec[state.kind].items[Number(b.dataset.load)];
                if (state.kind === "image") selectImageModel(item.file.local_name);
                else loadModel(item.file.local_name, item.projector ? item.projector.local_name : undefined);
            };
        });
    }

    function pcSummaryHtml(profile) {
        const hw = state.hw;
        if (!hw || !profile) return "";
        const isGpu = profile.mode === "gpu" || (hw.gpu && hw.gpu.has_gpu);
        const heading = isGpu ? t("yourPc") : t("yourPcCpu");
        const line = isGpu
            ? t("pcGpuMode", { name: hw.gpu.name || "GPU", g: profile.gpu_budget_gb, r: profile.ram_budget_gb })
            : t("pcCpuMode", { r: profile.ram_budget_gb });
        const advice = state.kind === "image"
            ? ""
            : '<div class="muted small" style="margin-top:4px">' + esc(t("pcAdvice", { n: profile.comfortable_params_b, q: profile.quant, c: fmtNum(profile.target_ctx) })) + "</div>";
        return '<div class="card" style="margin-bottom:8px"><div class="small muted" style="margin-bottom:4px">' + esc(heading) + "</div><div>" + esc(line) + "</div>" + advice + "</div>";
    }

    function sdEngineBannerHtml() {
        const imgEng = state.status && state.status.image_engine;
        if (!imgEng) return "";
        if (imgEng.sdcpp && imgEng.sdcpp.installed) {
            return '<div class="note ok" style="margin-top:12px">' + esc(t("sdEngineReady", { t: imgEng.sdcpp.backend || imgEng.sdcpp.tag || "GPU" })) + "</div>";
        }
        return '<div class="note" style="margin-top:12px">' + esc(t("stepImageEngineMissingNote")) + "</div>";
    }

    function recListHtml(data) {
        if (!data.items.length) return '<div class="empty">' + t("noRecommendations") + "</div>";
        const titles = { best: "groupBest", light: "groupLight", heavy: "groupHeavy" };
        let html = "";
        if (state.kind === "vision") html += '<div class="note" style="margin-top:12px">' + t("visionNote") + "</div>";
        if (state.kind === "image") html += '<div class="note" style="margin-top:12px">' + t("imageNote") + "</div>" + loraGuideHtml() + sdEngineBannerHtml();
        ["best", "light", "heavy"].forEach((group) => {
            const entries = data.items.map((item, index) => ({ item, index })).filter((e) => e.item.group === group);
            if (!entries.length) return;
            html += '<div class="group-title">' + t(titles[group]) + '</div><div class="model-list">';
            entries.forEach(({ item, index }) => {
                const busy = state.status && state.status.model.is_loading;
                const isImg = state.kind === "image";
                const compCount = (item.companions || []).length;
                html += '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(item.name) + '</div><div class="small muted">' + esc(item.author) + "</div>" +
                    '<div class="model-meta">' + fitBadge(item.fit) +
                    (item.params_b ? '<span class="badge">' + t("paramsB", { n: item.params_b }) + "</span>" : "") +
                    (item.family ? '<span class="badge">' + esc(item.family) + (item.variant ? " / " + esc(item.variant) : "") + "</span>" : "") +
                    '<span class="badge">' + esc(item.file.quant || item.file.filename.split(".").pop().toUpperCase()) + " - " + fmtBytes(item.total_bytes) + "</span>" +
                    (item.supports_refs ? '<span class="badge accent">' + t("supportsRefs") + "</span>" : "") +
                    (item.trainable_lora ? '<span class="badge ok">' + t("trainableLoraBadge") + "</span>" : "") +
                    (compCount ? '<span class="badge ok">' + t("companionsIncluded", { n: compCount }) + "</span>" : "") +
                    (item.projector ? '<span class="badge accent">' + t("withVision") + "</span>" : "") +
                    '<span class="badge">' + t("downloadsCount", { n: fmtNum(item.downloads) }) + "</span>" +
                    (!isImg ? archBadge(item.arch_supported, item.arch) : "") + "</div></div>" +
                    '<div class="model-actions">' +
                    (item.installed
                        ? '<button class="btn primary" data-load="' + index + '"' + (!isImg && busy ? " disabled" : "") + ">" + ICONS.play + (isImg ? t("selectImageModel") : t("load")) + "</button>"
                        : '<button class="btn primary" data-dl="' + index + '">' + ICONS.download + (isImg ? t("downloadBundle") : t("downloadAndLoad")) + "</button>") +
                    "</div></div>";
            });
            html += "</div>";
        });
        return html;
    }

    // ---- search

    function renderSearch() {
        const body = $("#modelsBody");
        if (state.inspect) { renderInspect(); return; }
        const presets = SEARCH_PRESETS[state.kind] || SEARCH_PRESETS.chat;
        body.innerHTML =
            '<div class="row" style="margin-bottom:12px">' + kindChips() + "</div>" +
            '<div class="note" style="margin-bottom:14px">' + esc(t("searchGuide")) + "</div>" +
            (state.kind === "image" ? '<div style="margin-bottom:14px">' + loraGuideHtml() + "</div>" : "") +
            '<div class="search-row" style="margin-bottom:12px"><input type="text" id="searchInput" placeholder="' + esc(t("searchPlaceholder")) + '" value="' + esc(state.searchQuery) + '">' +
            '<button class="btn primary" id="searchBtn">' + ICONS.search + t("search") + "</button></div>" +
            '<div class="chips" style="margin-bottom:18px">' +
            presets.map((p, idx) => '<button class="chip" data-spreset="' + idx + '">' + esc(t(p.key)) + "</button>").join("") +
            "</div>" +
            '<div id="searchResults"></div>';
        bindKindChips(() => { state.inspect = null; renderSearch(); if (state.searchQuery) runSearch(); });
        $("#searchBtn").onclick = runSearch;
        $("#searchInput").onkeydown = (e) => { if (e.key === "Enter") runSearch(); };
        $$("#modelsBody [data-spreset]").forEach((b) => {
            b.onclick = () => {
                const preset = presets[Number(b.dataset.spreset)];
                if (!preset) return;
                state.searchQuery = preset.q;
                $("#searchInput").value = preset.q;
                runSearch();
            };
        });
        drawSearchResults();
    }

    const IMAGE_QUERY_HINT_RE = /\b(sdxl|illustrious|ilxl|pony|pdxl|animagine|flux|kontext|chroma|kroma|furry|noobai|noob|juggernaut|dreamshaper|sd1\.?5|safetensors|wai[-_ ]?nsfw|hassaku)\b/i;

    async function runSearch() {
        const input = $("#searchInput");
        const q = (input ? input.value : state.searchQuery).trim();
        state.searchQuery = q;
        if (!q) return;
        if (q.indexOf("huggingface.co/") !== -1 || /^[\w.-]+\/[\w.-]+$/.test(q)) {
            if (state.kind !== "image" && IMAGE_QUERY_HINT_RE.test(q)) {
                state.kind = "image";
            }
            openRepo(q);
            return;
        }
        if (state.kind === "chat" && IMAGE_QUERY_HINT_RE.test(q)) {
            state.kind = "image";
            toast(t("autoSwitchedImageSearch"));
            renderSearch();
        }
        state.searching = true;
        state.searchStartedAt = Date.now();
        state.searchResults = null;
        drawSearchResults();
        try {
            let data = await api("/api/hf/search?kind=" + state.kind + "&q=" + encodeURIComponent(q));
            if ((!data.results || !data.results.length) && state.kind === "chat") {
                const imgData = await api("/api/hf/search?kind=image&q=" + encodeURIComponent(q)).catch(() => null);
                if (imgData && imgData.results && imgData.results.length) {
                    state.kind = "image";
                    data = imgData;
                    toast(t("autoSwitchedImageSearch"));
                    state.searching = false;
                    state.searchStartedAt = 0;
                    state.searchResults = data.results;
                    renderSearch();
                    return;
                }
            }
            state.searchResults = data.results;
        } catch (e) {
            state.searchResults = [];
            toast(e.status === 502 || e.status === 0 ? t("offlineStore") : e.message);
        }
        state.searching = false;
        state.searchStartedAt = 0;
        drawSearchResults();
    }

    function drawSearchResults() {
        const box = $("#searchResults");
        if (!box) return;
        if (state.searching) {
            box.innerHTML = taskProgressHtml({
                label: t("searching"),
                percent: null,
                startedAtMs: state.searchStartedAt || Date.now(),
            });
            return;
        }
        if (state.searchResults === null) { box.innerHTML = ""; return; }
        if (!state.searchResults.length) { box.innerHTML = '<div class="empty">' + t("noResults") + "</div>"; return; }
        const isImg = state.kind === "image";
        box.innerHTML = '<div class="model-list">' + state.searchResults.map((r, i) =>
            '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(r.name) + '</div><div class="small muted">' + esc(r.author) + "</div>" +
            '<div class="model-meta">' +
            (r.params_b ? '<span class="badge">' + t("paramsB", { n: r.params_b }) + "</span>" : "") +
            (r.family ? '<span class="badge">' + esc(r.family) + (r.variant ? " / " + esc(r.variant) : "") + "</span>" : "") +
            (r.has_gguf_tag ? '<span class="badge">' + t("ggufSceneOnlyBadge") + "</span>" : "") +
            (r.has_safetensors && !r.has_gguf_tag && (r.family === "sdxl" || r.family === "sd15") ? '<span class="badge ok">' + t("trainableLoraBadge") + "</span>" : (r.has_safetensors ? '<span class="badge">' + t("safetensorsFormatBadge") + "</span>" : "")) +
            (r.supports_refs ? '<span class="badge accent">' + t("supportsRefs") + "</span>" : "") +
            '<span class="badge">' + t("downloadsCount", { n: fmtNum(r.downloads) }) + "</span>" +
            (!isImg ? archBadge(r.arch_supported, r.arch) : "") + "</div></div>" +
            '<div class="model-actions"><button class="btn primary small" data-open="' + i + '">' + t("openModelCard") + "</button></div></div>").join("") + "</div>";
        $$("#searchResults [data-open]").forEach((b) => { b.onclick = () => openRepo(state.searchResults[Number(b.dataset.open)].repo_id); });
    }

    async function openRepo(repoId) {
        state.inspectStartedAt = Date.now();
        state.inspectRepoName = repoId;
        $("#modelsBody").innerHTML = taskProgressHtml({
            label: t("inspectingRepo", { r: repoId }),
            percent: null,
            startedAtMs: state.inspectStartedAt,
        });
        try {
            state.inspect = await api("/api/hf/inspect", { method: "POST", body: { repo_id: repoId, kind: state.kind } });
        } catch (e) {
            state.inspect = null;
            state.inspectStartedAt = 0;
            toast(e.status === 502 || e.status === 0 ? t("offlineStore") : e.message);
            renderSearch();
            return;
        }
        state.inspectStartedAt = 0;
        renderInspect();
    }

    function bestProjector(files) {
        const list = files.filter((f) => f.is_projector && !f.split);
        if (!list.length) return null;
        return list.find((f) => /f16/i.test(f.filename)) || list.find((f) => /bf16/i.test(f.filename)) || list[0];
    }

    function buildCompanionSpecs(repoId, companions) {
        return (companions || []).map((c) => ({
            filename: c.filename,
            repo_id: c.repo_id || repoId,
            local_name: c.local_name,
            url: c.url || "",
            size_bytes: c.size_bytes,
            role: c.role || "image_aux",
            aux_role: c.role || "image_aux",
        }));
    }

    function renderInspect() {
        const r = state.inspect;
        const models = r.files.filter((f) => !f.is_projector);
        const projectors = r.files.filter((f) => f.is_projector && !f.split);
        const defaultProj = bestProjector(r.files);
        const isImg = r.kind === "image";
        const rec = r.recommended_download;

        let html = '<div style="margin-bottom:14px"><button class="btn small" id="inspectBack">&larr; ' + t("tabSearch") + "</button></div>" +
            '<div class="card"><div class="card-head"><div><h2>' + esc(r.repo_id) + '</h2><div class="model-meta">' +
            (r.params_b ? '<span class="badge">' + t("paramsB", { n: r.params_b }) + "</span>" : "") +
            (r.family ? '<span class="badge">' + esc(r.family) + "</span>" : "") +
            (r.supports_refs ? '<span class="badge accent">' + t("supportsRefs") + "</span>" : "") +
            '<span class="badge">' + t("downloadsCount", { n: fmtNum(r.downloads) }) + "</span>" +
            (!isImg ? archBadge(r.arch_supported, r.arch) : "") + "</div></div></div>";

        if (!r.has_gguf) {
            html += '<div class="note bad">' + t(r.diffusers_only ? "noDiffusersSingleFile" : "noGguf") + "</div>";
            if (r.suggestions && r.suggestions.length) {
                html += '<div class="group-title">' + t("suggestions") + '</div><div class="model-list">' + r.suggestions.map((s, i) =>
                    '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(s.repo_id) + '</div></div><div class="model-actions"><button class="btn primary small" data-sugg="' + i + '">' + t("openModelCard") + "</button></div></div>").join("") + "</div>";
            }
        } else {
            if (rec && rec.file) {
                const qLabel = rec.file.quant || rec.file.filename.split(".").pop().toUpperCase();
                const compCount = (rec.companions || []).length;
                let desc = t("recBundleDescChat", { q: qLabel });
                if (isImg) {
                    desc = compCount ? t("recBundleDescImage", { q: qLabel, n: compCount }) : t("recBundleDescImageSingle", { q: qLabel });
                } else if (rec.projector) {
                    desc = t("recBundleDescVision", { q: qLabel });
                }
                html += '<div class="rec-bundle-card">' +
                    '<div class="rec-bundle-main">' +
                    '<div class="rec-bundle-title">' + esc(t("recBundleTitle")) + "</div>" +
                    '<div class="small muted">' + esc(desc) + "</div>" +
                    '<div class="model-meta" style="margin-top:10px">' +
                    fitBadge(rec.file.fit) +
                    '<span class="badge">' + esc(qLabel) + " - " + fmtBytes(rec.total_bytes || rec.file.size_bytes) + "</span>" +
                    (rec.trainable_lora ? '<span class="badge ok">' + esc(t("trainableLoraBadge")) + "</span>" : "") +
                    (compCount ? '<span class="badge ok">' + esc(t("companionsIncluded", { n: compCount })) + "</span>" : "") +
                    (rec.projector ? '<span class="badge accent">' + esc(t("withVision")) + "</span>" : "") +
                    "</div></div>" +
                    '<div class="model-actions">' +
                    (rec.all_installed
                        ? '<button class="btn primary" id="recBundleRun">' + ICONS.play + (isImg ? t("selectImageModel") : t("load")) + "</button>"
                        : '<button class="btn primary" id="recBundleDl">' + ICONS.download + (isImg ? t("downloadBundle") : t("downloadAndLoad")) + "</button>") +
                    "</div></div>";
            }

            html += '<details class="expert-details"' + (!rec ? " open" : "") + "><summary>" +
                esc(t("advancedFilesSummary", { n: models.length })) + "</summary>" +
                '<div class="small muted" style="margin-bottom:10px">' + t("quantNote") + "</div>";
            if (projectors.length) {
                html += '<div style="margin-bottom:12px"><span class="field-label">' + t("projectorSelect") + '</span><select id="projSelect"><option value="">' + t("projectorNone") + "</option>" +
                    projectors.map((p) => '<option value="' + esc(p.filename) + '"' + (defaultProj && p.filename === defaultProj.filename ? " selected" : "") + ">" + esc(p.filename) + " (" + fmtBytes(p.size_bytes) + ")</option>").join("") + "</select></div>";
            }
            html += models.map((f, i) =>
                '<div class="file-row"><div><div class="file-name">' + esc(f.filename) + '</div><div class="model-meta">' +
                (f.role && f.role !== "model" ? '<span class="badge accent">' + esc(f.role) + "</span>" : "") +
                (f.quant ? '<span class="badge">' + esc(f.quant) + "</span>" : "") + '<span class="badge">' + fmtBytes(f.size_bytes) + "</span>" +
                (f.split ? '<span class="badge bad">' + t("splitFile") + "</span>" : fitBadge(f.fit)) +
                (f.installed ? '<span class="badge ok">' + t("installed") + "</span>" : "") + "</div></div>" +
                '<div class="model-actions">' + (f.split ? "" : (f.installed
                    ? ((f.role === "image")
                        ? '<button class="btn primary small" data-isel="' + i + '">' + t("selectImageModel") + "</button>"
                        : (f.role === "model" ? '<button class="btn primary small" data-iload="' + i + '">' + ICONS.play + t("load") + "</button>" : '<span class="badge ok">' + t("installed") + "</span>"))
                    : '<button class="btn small" data-idl="' + i + '">' + ICONS.download + t("download") + "</button>" +
                      (f.role === "model" ? '<button class="btn primary small" data-idl-load="' + i + '">' + t("downloadAndLoad") + "</button>" : ""))) + "</div></div>").join("");
            html += "</details>";
        }
        html += "</div>";
        $("#modelsBody").innerHTML = html;
        $("#inspectBack").onclick = () => { state.inspect = null; renderSearch(); };
        $$("#modelsBody [data-sugg]").forEach((b) => { b.onclick = () => openRepo(r.suggestions[Number(b.dataset.sugg)].repo_id); });

        const dlBundleBtn = $("#recBundleDl");
        if (dlBundleBtn && rec && rec.file) {
            dlBundleBtn.onclick = () => {
                const files = [{
                    filename: rec.file.filename,
                    local_name: rec.file.local_name,
                    size_bytes: rec.file.size_bytes,
                    role: rec.file.role || (isImg ? "image" : "model"),
                    family: r.family || "",
                    supports_refs: Boolean(r.supports_refs),
                }];
                if (rec.projector) {
                    files.push({
                        filename: rec.projector.filename,
                        local_name: rec.projector.local_name,
                        size_bytes: rec.projector.size_bytes,
                        role: "projector",
                    });
                }
                files.push(...buildCompanionSpecs(r.repo_id, rec.companions));
                startDownload(r.repo_id, files, true, dlBundleBtn);
            };
        }
        const runBundleBtn = $("#recBundleRun");
        if (runBundleBtn && rec && rec.file) {
            runBundleBtn.onclick = () => {
                if (isImg) selectImageModel(rec.file.local_name);
                else loadModel(rec.file.local_name, rec.projector ? rec.projector.local_name : undefined);
            };
        }

        const filesFor = (f) => {
            const role = f.role || (f.is_projector ? "projector" : (isImg ? "image" : "model"));
            const files = [{
                filename: f.filename,
                local_name: f.local_name,
                size_bytes: f.size_bytes,
                role,
                aux_role: f.aux_role || "",
                family: r.family || "",
                supports_refs: Boolean(r.supports_refs),
            }];
            const sel = $("#projSelect");
            if (sel && sel.value && role === "model") {
                const p = projectors.find((x) => x.filename === sel.value);
                if (p) files.push({ filename: p.filename, size_bytes: p.size_bytes, role: "projector" });
            }
            if (role === "image" && r.companions && r.companions.length) {
                files.push(...buildCompanionSpecs(r.repo_id, r.companions));
            }
            return files;
        };
        $$("#modelsBody [data-idl]").forEach((b) => {
            b.onclick = () => {
                const target = models[Number(b.dataset.idl)];
                startDownload(r.repo_id, filesFor(target), target.role === "image", b);
            };
        });
        $$("#modelsBody [data-idl-load]").forEach((b) => { b.onclick = () => startDownload(r.repo_id, filesFor(models[Number(b.dataset["idlLoad"])]), true, b); });
        $$("#modelsBody [data-iload]").forEach((b) => { b.onclick = () => loadModel(models[Number(b.dataset.iload)].local_name); });
        $$("#modelsBody [data-isel]").forEach((b) => { b.onclick = () => selectImageModel(models[Number(b.dataset.isel)].local_name); });
    }

    // ---- AI assistant (top-level view-assistant)

    function assistantCandidateCardHtml(c, idx) {
        const compCount = (c.companions || []).length;
        const totalSize = c.total_bytes || (c.file.size_bytes + (c.companions || []).reduce((acc, x) => acc + (x.size_bytes || 0), 0));
        return '<div class="model-card candidate-card"><div class="model-main">' +
            '<div class="model-name">' + esc(c.name || c.repo_id) + '</div>' +
            '<div class="small muted">' + esc(c.repo_id) + ' - ' + esc(c.file.filename.split("/").pop()) + '</div>' +
            '<div class="model-meta">' +
            fitBadge(c.fit) +
            (c.family ? '<span class="badge">' + esc(c.family) + '</span>' : '') +
            '<span class="badge">' + fmtBytes(totalSize) + '</span>' +
            (c.supports_refs ? '<span class="badge accent">' + t("supportsRefs") + '</span>' : '') +
            (compCount ? '<span class="badge ok">' + t("companionsIncluded", { n: compCount }) + ' (' + t("assistantAllInOne") + ')</span>' : '') +
            (c.projector ? '<span class="badge accent">' + t("withVision") + '</span>' : '') +
            '<span class="badge">' + t("downloadsCount", { n: fmtNum(c.downloads || 0) }) + '</span>' +
            '</div></div>' +
            '<div class="model-actions">' +
            '<button class="btn small" data-aopen="' + idx + '">' + t("files") + '</button>' +
            '<button class="btn primary" data-adl="' + idx + '">' + ICONS.download + (c.kind === "image" ? t("downloadBundle") : t("downloadAndLoad")) + '</button>' +
            '</div></div>';
    }

    async function renderAssistant() {
        const host = $("#view-assistant");
        if (!host) return;
        if (!state.assistantCfg) {
            host.innerHTML = '<div class="card">' + taskProgressHtml({
                label: t("loadingData"),
                percent: null,
                startedAtMs: Date.now(),
            }) + '</div>';
            try { state.assistantCfg = await api("/api/assistant/config"); }
            catch (e) { state.assistantCfg = { mode: "local", provider: "openrouter", api_url: "", api_model: "", has_api_key: false, api_key_preview: "" }; }
        }
        if (state.view !== "assistant") return;
        const cfg = state.assistantCfg;
        const mode = cfg.mode || "local";
        const hints = [t("assistantHint1"), t("assistantHint2"), t("assistantHint3"), t("assistantHint4")];

        let html = '<div class="stack">' +
            '<div class="card">' +
            '<div class="assistant-head">' +
            '<div><h2>' + t("assistantTitle") + '</h2><div class="small muted" style="margin-top:4px">' + t("assistantHint") + '</div></div>' +
            '<div class="row" style="align-items:center">' +
            '<div class="seg-toggle">' +
            '<button class="seg-btn' + (mode === "local" ? " active" : "") + '" data-amode="local">' + t("assistantModeLocal") + '</button>' +
            '<button class="seg-btn' + (mode === "api" ? " active" : "") + '" data-amode="api">' + t("assistantModeApi") + '</button>' +
            '</div>' +
            (mode === "api"
                ? '<button class="btn small" id="asToggleCfg">' + (state.assistantShowCfg || !cfg.has_api_key ? t("assistantHideApiSettings") : t("assistantShowApiSettings")) + '</button>'
                : '') +
            '</div></div>';

        if (mode === "local") {
            const activeLlm = state.status && state.status.model && state.status.model.ready ? state.status.model.model : "";
            const noteText = activeLlm
                ? t("assistantLocalModelActiveNote", { m: activeLlm })
                : t("assistantLocalReadyNote");
            html += '<div class="note ok" style="margin-top:12px">' + esc(noteText) + '</div>';
        } else if (state.assistantShowCfg || !cfg.has_api_key) {
            html += '<div class="assistant-cfg-box">' +
                '<div class="form-grid" style="margin-bottom:12px">' +
                '<div><span class="field-label">' + t("assistantProvider") + '</span><select id="asProvider">' +
                ["openrouter", "openai", "gemini", "deepseek", "groq", "custom"].map((p) => '<option value="' + p + '"' + (cfg.provider === p ? " selected" : "") + '>' + p + '</option>').join("") + '</select></div>' +
                '<div><span class="field-label">' + t("assistantApiKey") + '</span><input type="password" id="asKey" value="' + esc(cfg.api_key_preview || "") + '" placeholder="sk-..."></div>' +
                '<div><span class="field-label">' + t("assistantBaseUrl") + '</span><input type="text" id="asUrl" value="' + esc(cfg.api_url || "") + '" placeholder="https://..."></div>' +
                '<div><span class="field-label">' + t("assistantModel") + '</span><input type="text" id="asModel" value="' + esc(cfg.api_model || "") + '" placeholder="auto"></div>' +
                '</div><button class="btn primary small" id="asSaveCfg">' + t("assistantSaveCfg") + '</button></div>';
        }

        html += '<div class="assistant-form">' +
            '<div class="row" style="align-items:center;justify-content:space-between">' +
            '<span class="small muted">' + t("assistantPromptLabel") + '</span>' +
            '<div class="chips">' +
            [["image", t("kindImage")], ["chat", t("kindChat")], ["vision", t("kindVision")]].map((o) =>
                '<button class="chip' + (state.assistantKind === o[0] ? " active" : "") + '" data-akind="' + o[0] + '">' + esc(o[1]) + '</button>'
            ).join("") +
            '</div></div>' +
            '<div class="assistant-prompt-row">' +
            '<input type="text" id="asQuery" value="' + esc(state.assistantQuery) + '" placeholder="' + esc(t("assistantQueryPlaceholder")) + '">' +
            '<button class="btn primary" id="asAsk"' + (state.assistantLoading ? " disabled" : "") + '>' +
            (state.assistantLoading ? '<span class="spinner"></span> ' : ICONS.search) +
            (state.assistantLoading ? t("assistantThinking") : t("assistantAsk")) +
            '</button></div>' +
            '<div class="chips">' +
            hints.map((h, i) => '<button class="chip" data-ahint="' + i + '">' + esc(h) + '</button>').join("") +
            '</div>' +
            (state.assistantKind === "image" ? loraGuideHtml() : '') +
            '</div></div>';

        if (state.assistantLoading) {
            html += '<div class="card">' + taskProgressHtml({
                label: t("assistantThinking"),
                percent: null,
                startedAtMs: state.assistantStartedAt || Date.now(),
            }) + '</div>';
        } else if (state.assistantResult) {
            const res = state.assistantResult;
            html += '<div class="card stack">' +
                '<div class="small muted">' + esc(res.hardware || "") + '</div>' +
                '<div class="assistant-answer">' + esc(res.answer || "") + '</div>';
            if (res.candidates && res.candidates.length) {
                html += '<div class="group-title" style="margin:6px 0 0">' + t("assistantCardsHeading") + '</div>' +
                    '<div class="model-list">' +
                    res.candidates.map((c, idx) => assistantCandidateCardHtml(c, idx)).join("") +
                    '</div>';
            }
            html += '</div>';
        }
        html += '</div>';
        host.innerHTML = html;

        $$("#view-assistant [data-amode]").forEach((b) => {
            b.onclick = async () => {
                state.assistantCfg = await api("/api/assistant/config", { method: "POST", body: { mode: b.dataset.amode } });
                renderAssistant();
            };
        });
        const toggleBtn = $("#asToggleCfg");
        if (toggleBtn) toggleBtn.onclick = () => { state.assistantShowCfg = !state.assistantShowCfg; renderAssistant(); };
        const saveBtn = $("#asSaveCfg");
        if (saveBtn) {
            saveBtn.onclick = async () => {
                state.assistantCfg = await api("/api/assistant/config", {
                    method: "POST",
                    body: {
                        provider: $("#asProvider").value,
                        api_key: $("#asKey").value,
                        api_url: $("#asUrl").value,
                        api_model: $("#asModel").value,
                    },
                });
                state.assistantShowCfg = false;
                toast(t("saved"));
                renderAssistant();
            };
        }
        $$("#view-assistant [data-akind]").forEach((b) => {
            b.onclick = () => { state.assistantKind = b.dataset.akind; renderAssistant(); };
        });
        $$("#view-assistant [data-ahint]").forEach((b) => {
            b.onclick = () => {
                const idx = Number(b.dataset.ahint);
                state.assistantQuery = hints[idx];
                if (idx === 3) state.assistantKind = "chat";
                else state.assistantKind = "image";
                renderAssistant();
                runAssistant();
            };
        });
        const qInput = $("#asQuery");
        if (qInput) {
            qInput.oninput = () => { state.assistantQuery = qInput.value; };
            qInput.onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); runAssistant(); } };
        }
        $("#asAsk").onclick = runAssistant;
        $$("#view-assistant [data-aopen]").forEach((b) => {
            b.onclick = () => {
                const cand = state.assistantResult.candidates[Number(b.dataset.aopen)];
                state.kind = cand.kind || state.assistantKind || "image";
                state.modelsTab = "search";
                setView("models");
                openRepo(cand.repo_id);
            };
        });
        $$("#view-assistant [data-adl]").forEach((b) => {
            b.onclick = () => {
                const c = state.assistantResult.candidates[Number(b.dataset.adl)];
                const files = [{
                    filename: c.file.filename,
                    local_name: c.file.local_name,
                    size_bytes: c.file.size_bytes,
                    role: c.file.role || (c.kind === "image" ? "image" : "model"),
                    family: c.family || "",
                    supports_refs: Boolean(c.supports_refs),
                }];
                if (c.projector) files.push({ filename: c.projector.filename, local_name: c.projector.local_name, size_bytes: c.projector.size_bytes, role: "projector" });
                files.push(...buildCompanionSpecs(c.repo_id, c.companions));
                startDownload(c.repo_id, files, true, b);
            };
        });
    }

    async function runAssistant() {
        const el = $("#asQuery");
        const q = (el ? el.value : state.assistantQuery).trim();
        if (!q) return;
        state.assistantQuery = q;
        state.assistantLoading = true;
        state.assistantStartedAt = Date.now();
        renderAssistant();
        try {
            state.assistantResult = await api("/api/assistant/recommend", {
                method: "POST",
                body: { query: q, kind: state.assistantKind, lang: state.lang },
            });
        } catch (e) {
            toast(e.message || t("error"));
        }
        state.assistantLoading = false;
        state.assistantStartedAt = 0;
        renderAssistant();
    }

    // ---- installed

    async function renderInstalled() {
        const body = $("#modelsBody");
        state.installedStartedAt = Date.now();
        body.innerHTML = taskProgressHtml({
            label: t("scanningInstalled"),
            percent: null,
            startedAtMs: state.installedStartedAt,
        });
        try {
            state.installed = await api("/api/models");
        } catch (e) {
            state.installedStartedAt = 0;
            return;
        }
        state.installedStartedAt = 0;
        drawInstalled();
    }

    function drawInstalled() {
        if (state.view !== "models" || state.modelsTab !== "installed") return;
        const data = state.installed;
        const body = $("#modelsBody");
        const imgModels = data.image_models || [];
        const imgAux = data.image_aux || [];
        const loras = data.loras || [];
        const activeImgObj = imgModels.find((m) => m.is_active && m.weight_role !== "lora") || null;
        const busy = state.status && state.status.model.is_loading;
        const coord = state.status && state.status.coordinator;

        let html = sdEngineBannerHtml();
        if (coord && coord.mode === "image") {
            html += '<div class="note ok" style="margin-top:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap"><span>' + t("modeImagePill") + '</span><button class="btn small" id="restoreLlmBtn">' + t("backToChatLlm") + "</button></div>";
        }

        html += '<div class="group-title">' + t("installedTitle") + "</div>";
        if (!data.models.length && !data.projectors.length) {
            html += '<div class="empty" style="padding:18px">' + t("noInstalled") + '<div class="small mono" style="margin-top:6px">' + esc(data.models_dir) + "</div></div>";
        } else {
            html += '<div class="small muted" style="margin-bottom:10px"><span class="mono">' + esc(data.models_dir) + "</span></div>";
            html += '<div class="model-list">' + data.models.map((m, i) =>
                '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(m.filename) + '</div><div class="model-meta">' +
                '<span class="badge">' + fmtBytes(m.size_bytes) + "</span>" + (m.arch ? '<span class="badge">' + esc(m.arch) + "</span>" : "") +
                (m.projector ? '<span class="badge accent">' + esc(t("paired", { p: m.projector })) + "</span>" : "") +
                (m.is_active ? '<span class="badge ok">' + t("active") + "</span>" : "") +
                (!m.valid ? '<span class="badge bad">' + t("errFileInvalid") + "</span>" : "") + "</div></div>" +
                '<div class="model-actions"><button class="btn primary small" data-iload="' + i + '"' + (busy || !m.valid ? " disabled" : "") + ">" + ICONS.play + t("load") + "</button>" +
                '<button class="btn danger small" data-idel="' + esc(m.filename) + '">' + ICONS.trash + "</button></div></div>").join("") + "</div>";
            if (data.projectors.length) {
                html += '<div class="group-title">' + t("projectorFiles") + '</div><div class="model-list">' + data.projectors.map((p) =>
                    '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(p.filename) + '</div><div class="model-meta"><span class="badge">' + fmtBytes(p.size_bytes) + "</span></div></div>" +
                    '<div class="model-actions"><button class="btn danger small" data-idel="' + esc(p.filename) + '">' + ICONS.trash + "</button></div></div>").join("") + "</div>";
            }
        }

        html += loraGuideHtml();
        html += '<div class="group-title">' + t("installedImageTitle") + "</div>";
        if (!imgModels.length) {
            html += '<div class="small muted">' + esc(data.image_models_dir || "models/image") + "</div>";
        } else {
            html += '<div class="model-list">' + imgModels.map((m) => {
                const isLora = m.weight_role === "lora";
                const missing = (m.missing_companions || []).length;
                return '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(m.filename) + '</div><div class="model-meta">' +
                    '<span class="badge">' + fmtBytes(m.size_bytes) + "</span>" +
                    '<span class="badge">' + esc(m.family) + (m.variant ? " / " + esc(m.variant) : "") + "</span>" +
                    (m.trainable_lora ? '<span class="badge ok">' + t("trainableLoraBadge") + "</span>" : (m.format === "gguf" ? '<span class="badge">' + t("ggufSceneOnlyBadge") + "</span>" : "")) +
                    (m.supports_refs ? '<span class="badge accent">' + t("supportsRefs") + "</span>" : "") +
                    (isLora ? '<span class="badge bad">' + t("imageModelLoraBadge") + "</span>" : "") +
                    (!isLora && missing ? '<span class="badge warn">' + esc(t("imageModelMissingBadge", { m: m.missing_companions.join(", ") })) + "</span>" : "") +
                    (m.is_active && !isLora ? '<span class="badge ok">' + t("activeImage") + "</span>" : "") + "</div></div>" +
                    '<div class="model-actions">' +
                    (isLora
                        ? '<button class="btn primary small" data-img-move="' + esc(m.filename) + '">' + t("moveToLoras") + "</button>"
                        : (missing
                            ? '<button class="btn primary small" data-img-repair="' + esc(m.filename) + '">' + ICONS.download + esc(t("repairCompanionsBtn", { m: m.missing_companions.join(", ") })) + "</button>"
                            : "") +
                          '<button class="btn ' + (missing ? "" : "primary ") + 'small" data-img-sel="' + esc(m.filename) + '">' + t("selectImageModel") + "</button>") +
                    '<button class="btn danger small" data-img-del="' + esc(m.filename) + '">' + ICONS.trash + "</button></div></div>";
            }).join("") + "</div>";
        }

        if (loras.length) {
            html += '<div class="group-title">' + t("installedLorasTitle") + '</div><div class="model-list">' + loras.map((l) => {
                let compatBadge = "";
                if (l.is_full_model) {
                    compatBadge = '<span class="badge warn">' + esc(t("loraFullModelBadge")) + "</span>";
                } else if (activeImgObj && l.base_arch) {
                    if (l.compatible_with_active === true) {
                        compatBadge = '<span class="badge ok">' + esc(t("loraCompatOk")) + "</span>";
                    } else if (l.compatible_with_active === false) {
                        compatBadge = '<span class="badge warn">' + esc(t("loraCompatMismatch", {
                            a: l.base_arch.toUpperCase(),
                            m: (activeImgObj.family || "").toUpperCase(),
                        })) + "</span>";
                    }
                }
                return '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(l.filename) + '</div><div class="model-meta">' +
                    '<span class="badge">' + fmtBytes(l.size_bytes) + "</span>" +
                    (l.base_arch ? '<span class="badge">' + esc(l.base_arch.toUpperCase()) + "</span>" : "") +
                    (l.trigger_word ? '<span class="badge accent">' + esc(l.trigger_word) + "</span>" : "") +
                    compatBadge + "</div></div>" +
                    '<div class="model-actions">' +
                    (l.is_full_model
                        ? '<button class="btn primary small" data-lora-move="' + esc(l.filename) + '">' + t("moveToImageModels") + "</button>"
                        : "") +
                    '<button class="btn danger small" data-lora-del="' + esc(l.filename) + '">' + ICONS.trash + "</button></div></div>";
            }).join("") + "</div>";
        }

        if (imgAux.length) {
            html += '<div class="group-title">' + t("installedAuxTitle") + '</div><div class="model-list">' + imgAux.map((a) =>
                '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(a.filename) + '</div><div class="model-meta">' +
                '<span class="badge">' + esc(a.role) + '</span><span class="badge">' + fmtBytes(a.size_bytes) + "</span></div></div>" +
                '<div class="model-actions"><button class="btn danger small" data-aux-del="' + esc(a.filename) + '">' + ICONS.trash + "</button></div></div>").join("") + "</div>";
        }

        body.innerHTML = html;
        const rBtn = $("#restoreLlmBtn");
        if (rBtn) rBtn.onclick = async () => { await api("/api/images/unload", { method: "POST", body: { restore_llm: true } }); renderInstalled(); refreshStatus(); };
        $$("#modelsBody [data-iload]").forEach((b) => { b.onclick = () => loadModel(data.models[Number(b.dataset.iload)].filename); });
        $$("#modelsBody [data-img-sel]").forEach((b) => { b.onclick = () => selectImageModel(b.dataset.imgSel); });
        $$("#modelsBody [data-img-repair]").forEach((b) => { b.onclick = () => repairImageCompanions(b.dataset.imgRepair, b); });
        $$("#modelsBody [data-img-move]").forEach((b) => { b.onclick = () => moveImageToLora(b.dataset.imgMove); });
        $$("#modelsBody [data-lora-move]").forEach((b) => { b.onclick = () => moveLoraToImage(b.dataset.loraMove); });
        $$("#modelsBody [data-idel]").forEach((b) => {
            b.onclick = async () => {
                const name = b.dataset.idel;
                if (!confirm(t("confirmDelete", { f: name }))) return;
                await api("/api/models/" + encodeURIComponent(name), { method: "DELETE" }).catch((e) => toast(e.message));
                delete state.rec.chat; delete state.rec.vision;
                renderInstalled(); refreshStatus();
            };
        });
        $$("#modelsBody [data-img-del]").forEach((b) => {
            b.onclick = async () => {
                const name = b.dataset.imgDel;
                if (!confirm(t("confirmDelete", { f: name }))) return;
                await api("/api/images/models/" + encodeURIComponent(name), { method: "DELETE" }).catch((e) => toast(e.message));
                delete state.rec.image;
                renderInstalled(); refreshStatus();
            };
        });
        $$("#modelsBody [data-lora-del]").forEach((b) => {
            b.onclick = async () => {
                const name = b.dataset.loraDel;
                if (!confirm(t("confirmDelete", { f: name }))) return;
                await api("/api/images/loras/" + encodeURIComponent(name), { method: "DELETE" }).catch((e) => toast(e.message));
                renderInstalled();
            };
        });
        $$("#modelsBody [data-aux-del]").forEach((b) => {
            b.onclick = async () => {
                const name = b.dataset.auxDel;
                if (!confirm(t("confirmDelete", { f: name }))) return;
                await api("/api/images/aux/" + encodeURIComponent(name), { method: "DELETE" }).catch((e) => toast(e.message));
                renderInstalled();
            };
        });
    }

    async function selectImageModel(model) {
        state.switchingModelAt = Date.now();
        renderActivityBar();
        try {
            await api("/api/images/select", { method: "POST", body: { model } });
            delete state.rec.image;
            toast(t("activeImage") + ": " + model);
            refreshImageLibrary();
            if (state.view === "models" && state.modelsTab === "installed") renderInstalled();
            if (state.view === "models" && state.modelsTab === "search" && state.inspect) renderInspect();
            refreshStatus();
        } catch (e) {
            toast(e.message || t("error"));
        } finally {
            state.switchingModelAt = 0;
            renderActivityBar();
        }
    }

    async function repairImageCompanions(model, btn) {
        if (btn) btn.disabled = true;
        try {
            const res = await api("/api/images/repair-companions", { method: "POST", body: { model } });
            if (res && res.files && res.files.length) {
                toast(t("repairCompanionsStarted", { f: res.files.join(", ") }));
            }
            refreshStatus();
        } catch (e) {
            toast(e.status === 409 ? t("dlBusy") : (e.status === 507 ? t("dlDisk") : (e.message || t("error"))));
            if (btn) btn.disabled = false;
        }
    }

    async function moveImageToLora(filename) {
        try {
            await api("/api/images/move-lora", { method: "POST", body: { filename } });
            delete state.rec.image;
            toast(t("movedToLoras") + ": " + filename);
            await refreshImageLibrary();
            if (state.view === "models" && state.modelsTab === "installed") renderInstalled();
            refreshStatus();
        } catch (e) { toast(e.message || t("error")); }
    }

    async function moveLoraToImage(filename) {
        try {
            await api("/api/images/move-to-image", { method: "POST", body: { filename } });
            delete state.rec.image;
            toast(t("movedToImageModels") + ": " + filename);
            await refreshImageLibrary();
            if (state.view === "models" && state.modelsTab === "installed") renderInstalled();
            refreshStatus();
        } catch (e) { toast(e.message || t("error")); }
    }

    // ---- actions

    async function startDownload(repoId, files, loadAfter, triggerBtn) {
        const prevHtml = triggerBtn ? triggerBtn.innerHTML : "";
        if (triggerBtn) {
            triggerBtn.disabled = true;
            triggerBtn.innerHTML = '<span class="spinner"></span> ' + t("dlStarting");
        }
        state.pendingDownload = {
            current: (files[0] && (files[0].local_name || files[0].filename.split("/").pop())) || repoId,
            count: files.length,
        };
        renderDownload();
        try {
            await api("/api/downloads", { method: "POST", body: { repo_id: repoId, files, load_after: loadAfter } });
            refreshStatus();
        } catch (e) {
            state.pendingDownload = null;
            renderDownload();
            if (e.status === 409) toast(t("dlBusy"));
            else if (e.status === 507) toast(t("dlDisk"));
            else toast(e.message || t("error"));
        } finally {
            if (triggerBtn) {
                triggerBtn.disabled = false;
                triggerBtn.innerHTML = prevHtml;
            }
        }
    }

    async function loadModel(model, projector) {
        state.switchingModelAt = Date.now();
        renderActivityBar();
        try {
            await api("/api/models/load", { method: "POST", body: { model, projector } });
            state.sig = {};
            setView("home");
            refreshStatus();
        } catch (e) {
            toast(e.status === 409 ? t("errBusy") : (e.message || t("error")));
        } finally {
            state.switchingModelAt = 0;
            renderActivityBar();
        }
    }

    // ------------------------------------------------------------------ download bar

    function renderDownload() {
        const bar = $("#downloadBar");
        const d = state.status && state.status.download;
        if (d) state.pendingDownload = null;
        if (!d && state.pendingDownload) {
            bar.hidden = false;
            bar.innerHTML = '<div class="download-inner"><div class="download-info"><div><strong>' +
                esc(t("dlPreparing", { f: state.pendingDownload.current })) + '</strong></div>' +
                '<div class="progress indeterminate" style="margin-top:8px"><span></span></div></div></div>';
            return;
        }
        if (!d) { bar.hidden = true; state.lastDownloadState = ""; return; }
        bar.hidden = false;
        let html;
        if (d.status === "downloading") {
            const speed = d.speed_bps ? (d.speed_bps / 1048576).toFixed(1) + " MB/s" : "";
            html = '<div class="download-inner"><div class="download-info"><div><strong>' + esc(t("dlDownloading", { f: d.current })) + '</strong> <span class="muted small">' +
                esc(t("dlFile", { i: d.index, n: d.count })) + "</span></div>" +
                '<div class="progress active"><span style="width:' + d.percent + '%"></span></div>' +
                '<div class="small muted" style="margin-top:6px">' + d.percent + "% - " + fmtBytes(d.downloaded_bytes) + " / " + fmtBytes(d.total_bytes) +
                (speed ? " - " + speed : "") + (d.eta_sec !== null && d.eta_sec !== undefined ? " - " + esc(t("dlEta", { t: fmtEta(d.eta_sec) })) : "") + "</div></div>" +
                '<button class="btn danger" id="dlCancel">' + t("dlCancel") + "</button></div>";
        } else {
            const text = d.status === "completed" ? t("dlCompleted") : d.status === "cancelled" ? t("dlCancelled") : t("dlFailed", { e: d.error || "" });
            html = '<div class="download-inner"><div class="download-info"><strong>' + esc(text) + "</strong></div></div>";
            if (state.lastDownloadState === "downloading") {
                delete state.rec.chat; delete state.rec.vision; delete state.rec.image;
                refreshImageLibrary();
                if (state.view === "models") {
                    if (state.modelsTab === "search" && state.inspect) openRepo(state.inspect.repo_id);
                    else enterModels();
                }
            }
        }
        state.lastDownloadState = d.status;
        bar.innerHTML = html;
        const cancel = $("#dlCancel");
        if (cancel) cancel.onclick = () => api("/api/downloads/cancel", { method: "POST" });
    }

    // ------------------------------------------------------------------ SYSTEM

    function initSystem() {
        $("#view-system").innerHTML =
            '<div class="stack">' +
            '<div class="grid-2"><div class="card" id="sysHardware"></div><div class="card" id="sysEngine"></div></div>' +
            '<div class="card" id="sysSettings"></div>' +
            '<div class="card" id="sysLogs"></div></div>';
    }

    async function enterSystem() {
        await Promise.all([refreshHardware(), loadSettings()]);
        renderSettings();
        renderLogsCard();
        refreshLogs();
    }

    async function refreshHardware() {
        try {
            const resp = await api("/api/hardware");
            state.hw = Object.assign({}, resp.hardware, { profile: resp.profile });
        } catch (e) { return; }
        if (state.view === "system") renderHardware();
    }

    function renderHardware() {
        const hw = state.hw;
        if (!hw || !$("#sysHardware")) return;
        const tiers = { ultra: "tierUltra", high: "tierHigh", mid: "tierMid", low: "tierLow", cpu: "tierCpu" };
        const rows = [
            [t("gpu"), hw.gpu.has_gpu ? hw.gpu.name : t("gpuNone")],
        ];
        if (hw.gpu.has_gpu) rows.push([t("vram"), t("vramValue", { t: fmtGb(hw.gpu.vram_total), f: fmtGb(hw.gpu.vram_free) })]);
        if (hw.gpu.driver) rows.push([t("driver"), hw.gpu.driver]);
        rows.push([t("ram"), t("ramValue", { t: fmtGb(hw.ram_total), a: fmtGb(hw.ram_available) })]);
        rows.push([t("cpu"), t("cpuValue", { c: hw.cpu.cores, t: hw.cpu.threads })]);
        rows.push([t("tier"), t(tiers[hw.profile.tier] || (hw.gpu.has_gpu ? "tierMid" : "tierCpu"))]);
        $("#sysHardware").innerHTML = '<div class="card-head"><h2>' + t("hardware") + "</h2></div>" +
            '<dl class="kv">' + rows.map((r) => "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>").join("") + "</dl>";
        renderEngine();
    }

    function renderEngine() {
        const s = state.status;
        if (!s || !$("#sysEngine")) return;
        const e = s.engine;
        const sdcpp = (s.image_engine && s.image_engine.sdcpp) || {};
        const lt = s.lora_trainer || {};
        const hasGpu = Boolean((state.hw && state.hw.gpu && state.hw.gpu.has_gpu) || e.gpu_offload);

        const llmBadge = !e.available
            ? '<span class="badge bad">' + t("backendNone") + "</span>"
            : '<span class="badge ' + (e.gpu_offload ? "ok" : "accent") + '">' + esc(e.gpu_offload ? t("compStatusGpuOk") : t("backendCpu")) + "</span>";
        const sceneBadge = sdcpp.installed
            ? '<span class="badge ok">' + esc(hasGpu ? t("compStatusGpuOk") : t("compStatusReady")) + "</span>"
            : '<span class="badge">' + esc(t("compStatusStandby")) + "</span>";
        const loraBadge = lt.installed
            ? '<span class="badge ok">' + esc(t("compStatusGpuOk")) + "</span>"
            : (!lt.gpu_ok ? '<span class="badge">' + esc(t("compStatusLowVram")) + "</span>" : '<span class="badge">' + esc(t("compStatusStandby")) + "</span>");

        let html = '<div class="card-head"><h2>' + t("engineTitle") + '</h2><span class="badge">v' + esc(s.version) + "</span></div>" +
            '<div class="comp-list">' +
            '<div class="comp-row"><div><strong>' + esc(t("compLlmEngine")) + '</strong><div class="small muted">v' + esc(e.version || "-") + "</div></div>" + llmBadge + "</div>" +
            '<div class="comp-row"><div><strong>' + esc(t("compSceneEngine")) + '</strong><div class="small muted">' + esc(sdcpp.backend || sdcpp.tag || "sd-server") + "</div></div>" + sceneBadge + "</div>" +
            '<div class="comp-row"><div><strong>' + esc(t("compLoraEngine")) + '</strong></div>' + loraBadge + "</div>" +
            "</div>" +
            '<div class="small muted" style="margin-top:12px">' + esc(t("engineLauncherNote")) + "</div>";

        if (!e.available) {
            html += '<div class="note bad" style="margin-top:12px">' + t("stepEngineBad") + "</div><details><summary>" + t("errTechnical") + "</summary><pre>" + esc(e.error) + "</pre></details>";
        } else if (state.hw && state.hw.gpu.kind === "cuda" && !e.gpu_offload) {
            html += '<div class="note warn" style="margin-top:12px">' + t("stepEngineGpuMissing") + "</div>";
        }
        $("#sysEngine").innerHTML = html;
    }

    async function loadSettings() {
        try { state.settings = await api("/api/settings"); } catch (e) { /* keep previous */ }
    }

    function renderSettings() {
        const st = state.settings;
        const box = $("#sysSettings");
        if (!st || !box) return;
        const qualityOptions = [
            ["fast", t("imgQualityFast")],
            ["balanced", t("imgQualityBalanced")],
            ["quality", t("imgQualityQuality")],
        ];
        const vramOptions = [
            ["auto", t("imgVramAuto")],
            ["always", t("imgVramAlways")],
            ["off", t("imgVramKeep")],
        ];
        const ctxOptions = ["auto", 4096, 8192, 16384, 32768, 65536];
        const layerOptions = [["auto", t("setAuto")], ["0", t("setLayersCpu")], ["-1", t("setLayersAll")]];
        const backendOptions = [
            ["sdcpp", t("imgBackendAuto")],
            ["comfyui", t("imgBackendComfy")],
            ["a1111", t("imgBackendA1111")],
        ];
        const currentQuality = String(st.image_quality || "balanced");
        const currentBackend = (st.image_backend === "comfyui" || st.image_backend === "a1111") ? st.image_backend : "sdcpp";

        box.innerHTML = '<div class="card-head"><div><h2>' + t("settingsTitle") + '</h2><div class="small muted">' + t("settingsHint") + "</div></div></div>" +
            '<div class="form-grid">' +
            '<div><span class="field-label">' + t("imgQualityLabel") + '</span><select id="setImgQuality">' +
            qualityOptions.map((o) => '<option value="' + o[0] + '"' + (currentQuality === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select>" +
            '<div class="field-help">' + esc(t("imgQualityHelp")) + "</div></div>" +
            '<div><span class="field-label">' + t("imgVramMode") + '</span><select id="setImgVram">' +
            vramOptions.map((o) => '<option value="' + o[0] + '"' + (String(st.image_low_vram || "auto") === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select>" +
            '<div class="field-help">' + esc(t("imgVramHelp")) + "</div></div>" +
            "</div>" +
            '<div style="margin-bottom:14px"><label class="check"><input type="checkbox" id="setAutoLoad"' + (st.auto_load_last ? " checked" : "") + "><span>" + t("setAutoLoad") + "</span></label></div>" +
            '<details class="expert-details"><summary>' + esc(t("expertSettingsSummary")) + "</summary>" +
            '<div class="small muted" style="margin-bottom:12px">' + esc(t("expertSettingsHint")) + "</div>" +
            '<div class="form-grid">' +
            '<div><span class="field-label">' + t("setCtx") + '</span><select id="setCtx">' +
            ctxOptions.map((o) => '<option value="' + o + '"' + (String(st.ctx_mode) === String(o) ? " selected" : "") + ">" + (o === "auto" ? t("setAuto") : fmtNum(o)) + "</option>").join("") + "</select></div>" +
            '<div><span class="field-label">' + t("setLayers") + '</span><select id="setLayers">' +
            layerOptions.map((o) => '<option value="' + o[0] + '"' + (String(st.gpu_layers_mode) === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select></div>" +
            '<div><span class="field-label">' + t("setCap") + '</span><select id="setCap">' +
            [8192, 16384, 32768, 65536].map((o) => '<option value="' + o + '"' + (Number(st.ctx_cap) === o ? " selected" : "") + ">" + fmtNum(o) + "</option>").join("") + "</select></div>" +
            '<div><span class="field-label">' + t("imgBackend") + '</span><select id="setImgBackend">' +
            backendOptions.map((o) => '<option value="' + o[0] + '"' + (currentBackend === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select></div>" +
            '<div><span class="field-label">' + t("comfyUrl") + '</span><input type="text" id="setComfyUrl" value="' + esc(st.comfyui_url || "") + '" placeholder="http://127.0.0.1:8188"></div>' +
            '<div><span class="field-label">' + t("a1111Url") + '</span><input type="text" id="setA1111Url" value="' + esc(st.a1111_url || "") + '" placeholder="http://127.0.0.1:7860"></div>' +
            "</div>" +
            '<label class="check"><input type="checkbox" id="setKv"' + (st.kv_quant ? " checked" : "") + "><span>" + t("setKv") + "</span></label>" +
            "</details>" +
            '<div class="row" style="align-items:center;margin-top:16px"><button class="btn primary" id="setSave">' + t("save") + '</button><span class="small muted" id="setMsg"></span></div>';

        $("#setSave").onclick = async () => {
            const body = {
                image_quality: $("#setImgQuality").value,
                image_low_vram: $("#setImgVram").value,
                image_steps: 0,
                image_cfg: 0,
                auto_load_last: $("#setAutoLoad").checked,
                ctx_mode: $("#setCtx").value,
                gpu_layers_mode: $("#setLayers").value,
                ctx_cap: Number($("#setCap").value),
                kv_quant: $("#setKv").checked,
                image_backend: $("#setImgBackend").value,
                comfyui_url: $("#setComfyUrl").value,
                a1111_url: $("#setA1111Url").value,
            };
            try {
                state.settings = await api("/api/settings", { method: "POST", body });
                $("#setMsg").textContent = t("saved");
            } catch (e) { toast(e.message || t("error")); }
        };
    }

    function renderLogsCard() {
        const box = $("#sysLogs");
        if (!box) return;
        box.innerHTML = '<div class="card-head"><h2>' + t("logsTitle") + '</h2><div class="row">' +
            '<button class="btn small" id="logRefresh">' + t("logRefresh") + '</button><button class="btn small" id="logCopy">' + t("logCopy") + "</button>" +
            '<a class="btn small" href="/api/logs/download">' + t("logReport") + '</a><button class="btn small danger" id="logClear">' + t("logClear") + "</button></div></div>" +
            '<div class="log-box mono" id="logBox"></div>';
        $("#logRefresh").onclick = refreshLogs;
        $("#logClear").onclick = async () => { await api("/api/logs/clear", { method: "POST" }).catch(() => {}); refreshLogs(); };
        $("#logCopy").onclick = () => { if (navigator.clipboard) navigator.clipboard.writeText($("#logBox").textContent); };
    }

    async function refreshLogs() {
        const box = $("#logBox");
        if (!box) return;
        try {
            const data = await api("/api/logs");
            const lines = data.logs.slice(-200);
            box.textContent = lines.length ? lines.join("\n") : t("logEmpty");
            box.scrollTop = box.scrollHeight;
        } catch (e) { /* ignore */ }
    }

    // ------------------------------------------------------------------ polling

    let polling = false;
    async function refreshStatus() {
        if (polling) return;
        polling = true;
        try {
            const previous = state.status;
            state.status = await api("/api/status");
            renderPill();
            renderActivityBar();
            renderDownload();
            if (state.view === "home") updateHome();
            if (state.view === "system") renderEngine();
            const was = previous && previous.model;
            const now = state.status.model;
            const wasLoraStatus = previous && previous.lora_trainer && previous.lora_trainer.job && previous.lora_trainer.job.status;
            const nowLoraStatus = state.status.lora_trainer && state.status.lora_trainer.job && state.status.lora_trainer.job.status;
            if (state.view === "models" && was && (was.is_loading !== now.is_loading || was.model !== now.model || wasLoraStatus !== nowLoraStatus)) {
                if (state.modelsTab === "installed") renderInstalled(); else if (state.modelsTab === "recommended" && state.rec[state.kind]) renderRecommended();
            }
        } catch (e) { /* offline handled in api() */ }
        polling = false;
    }

    function renderAll() {
        applyStaticText();
        state.sig = {};
        initHome();
        initModels();
        initSystem();
        renderPill();
        renderActivityBar();
        if (state.view === "models") enterModels();
        if (state.view === "assistant") renderAssistant();
        if (state.view === "system") enterSystem();
    }

    function bindGlobal() {
        $$("#nav .nav-btn").forEach((b) => { b.onclick = () => setView(b.dataset.view); });
        $$("#lang button").forEach((b) => {
            b.onclick = () => {
                state.lang = b.dataset.lang;
                localStorage.setItem("silklora.lang", state.lang);
                renderAll();
            };
        });
        document.addEventListener("click", (e) => {
            const target = e.target.closest("[data-goto]");
            if (target) setView(target.dataset.goto);
        });
    }

    function start() {
        bindGlobal();
        renderAll();
        refreshStatus();
        refreshImageLibrary();
        refreshHardware().then(() => { if (state.view === "home") updateHome(); });
        setInterval(refreshStatus, 1500);
        setInterval(updateLiveElapsedNodes, 1000);
        setInterval(() => { if (state.view === "system") { refreshHardware(); refreshLogs(); } }, 5000);
    }

    start();
})();

