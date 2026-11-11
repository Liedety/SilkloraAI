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
        settings: null,
        chat: [],
        chatAbort: null,
        online: true,
        lastDownloadState: "",
    };

    const ICONS = {
        brand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18c4-1 6-6 9-6s5 5 9 6"/><path d="M3 12c4-1 6-6 9-6s5 5 9 6"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8v5"/><path d="M12 17h.01"/></svg>',
        dots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 12h.01M12 12h.01M18 12h.01"/></svg>',
        copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
        download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 11 5 5 5-5"/><path d="M5 21h14"/></svg>',
        play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l14 8-14 8z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
        refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>',
        search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>',
        send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 2 11 13"/><path d="M22 2l-7 20-4-9-9-4z"/></svg>',
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
        $("#brandMark").innerHTML = ICONS.brand;
    }

    function renderPill() {
        const pill = $("#statusPill");
        const text = $("#statusPillText");
        const s = state.status;
        pill.className = "pill";
        if (state.online && !s) {
            text.textContent = "...";
        } else if (!state.online || !s) {
            pill.classList.add("bad");
            text.textContent = t("pillOffline");
        } else if (s.model.is_loading) {
            pill.classList.add("busy");
            text.textContent = t("pillLoading");
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
        if (view === "home") updateHome();
        if (view === "models") enterModels();
        if (view === "system") enterSystem();
    }

    // ------------------------------------------------------------------ messages

    function loadErrorText(err) {
        if (!err) return "";
        switch (err.code) {
            case "engine_missing": return t("errEngineMissing");
            case "file_missing": return t("errFileMissing");
            case "is_projector": return t("errIsProjector");
            case "file_invalid": return t("errFileInvalid");
            case "out_of_memory": return t("errOom");
            case "load_failed": return t("errLoadFailed", { arch: err.arch || "?", engine: err.engine || "?" });
            default: return err.message || t("error");
        }
    }

    function warningTexts(plan) {
        const map = {
            partial_offload: "warnPartial",
            cpu_only_with_gpu: "warnCpuOnly",
            memory_tight: "warnMemory",
            fallback_settings: "warnFallback",
            layout_unknown: "warnLayout",
            ctx_above_training: "warnCtxTrain",
        };
        return (plan.warnings || []).filter((w) => map[w]).map((w) => t(map[w]));
    }

    function fitBadge(fit) {
        const map = {
            gpu_full: ["ok", "fitGpuFull"],
            gpu_partial: ["warn", "fitGpuPartial"],
            cpu_ok: ["warn", "fitCpuOk"],
            too_big: ["bad", "fitTooBig"],
            projector: ["", "fitProjector"],
        };
        const entry = map[fit];
        return entry ? '<span class="badge ' + entry[0] + '">' + t(entry[1]) + "</span>" : "";
    }

    function archBadge(supported, arch) {
        if (supported === false) return '<span class="badge bad">' + esc(t("archUnsupported", { a: arch })) + "</span>";
        if (supported === null || supported === undefined) return '<span class="badge">' + t("archUnknown") + "</span>";
        return "";
    }

    // ------------------------------------------------------------------ HOME

    function initHome() {
        $("#view-home").innerHTML =
            '<div class="stack">' +
            '<div class="card"><div class="card-head"><h2>' + t("quickStart") + '</h2></div><div class="steps" id="homeSteps"></div></div>' +
            '<div class="grid-2">' +
            '<div class="card" id="homePhone"></div>' +
            '<div class="card" id="homeModel"></div>' +
            "</div>" +
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

        const gpuMissing = state.hw && state.hw.gpu.kind === "cuda" && s.engine.available && !s.engine.gpu_offload;
        let engineStep;
        if (!s.engine.available) engineStep = stepHtml("bad", "alert", t("stepEngine"), t("stepEngineBad"));
        else if (gpuMissing) engineStep = stepHtml("warn", "alert", t("stepEngine"), t("stepEngineGpuMissing"));
        else engineStep = stepHtml("ok", "check", t("stepEngine"), t("stepEngineOk") + " (" + s.engine.version + ")");

        let modelStep;
        if (s.model.ready) modelStep = stepHtml("ok", "check", t("stepModel"), s.model.model);
        else if (s.model.is_loading) modelStep = stepHtml("warn", "dots", t("stepModel"), t("stepModelLoading") + " " + s.model.loading_model);
        else if (s.model.load_error) modelStep = stepHtml("bad", "alert", t("stepModel"), loadErrorText(s.model.load_error));
        else modelStep = stepHtml("", "dots", t("stepModel"), t("stepModelNone"), '<div class="step-action"><button class="btn primary small" data-goto="models">' + t("chooseModel") + "</button></div>");

        const phoneStep = s.phone.connected
            ? stepHtml("ok", "check", t("stepPhone"), t("stepPhoneOk"))
            : stepHtml("", "dots", t("stepPhone"), t("stepPhoneWait"));

        const stepsHtml = engineStep + modelStep + phoneStep;
        if (state.sig.steps !== stepsHtml) {
            state.sig.steps = stepsHtml;
            $("#homeSteps").innerHTML = stepsHtml;
        }

        renderPhoneCard(s);
        renderModelCard(s);
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
                new QRCode(box, { text: url, width: 170, height: 170, colorDark: "#181530", colorLight: "#ffffff", correctLevel: QRCode.CorrectLevel.M });
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
        let html = '<div class="card-head"><h2>' + t("currentModel") + "</h2>";
        if (m.ready) html += '<button class="btn small" id="unloadBtn">' + t("unload") + "</button>";
        html += "</div>";

        if (m.is_loading) {
            html += '<div class="model-name">' + esc(m.loading_model) + "</div>" +
                '<div class="progress indeterminate" style="margin:14px 0"><span></span></div>' +
                '<div class="small muted">' + esc(m.loading_step) + " (" + t("loadingElapsed", { s: Math.round(m.loading_elapsed) }) + ")</div>";
        } else if (m.ready) {
            html += '<div class="model-name" style="margin-bottom:12px">' + esc(m.model) + "</div>" + planDetails(m.plan, m);
            warningTexts(m.plan).forEach((w) => { html += '<div class="note warn" style="margin-top:12px">' + esc(w) + "</div>"; });
            html += '<div class="note" style="margin-top:12px">' + t("longChatNote") + "</div>";
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
        }
    }

    function renderChatCard() {
        const el = $("#homeChat");
        el.innerHTML =
            '<div class="card-head"><div><h2>' + t("testChat") + '</h2><div class="small muted">' + t("testChatHint") + "</div></div>" +
            '<button class="btn small" id="chatClear">' + t("clear") + "</button></div>" +
            '<div class="chat-log" id="chatLog"></div>' +
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
    }

    async function sendChat() {
        if (state.chatAbort) {
            state.chatAbort.abort();
            return;
        }
        const input = $("#chatInput");
        const text = input.value.trim();
        if (!text) return;
        if (!state.status || !state.status.model.ready) { toast(t("testNoModel")); return; }
        input.value = "";
        state.chat.push({ role: "user", content: text });
        const reply = { role: "assistant", content: "" };
        state.chat.push(reply);
        redrawChat();

        const controller = new AbortController();
        state.chatAbort = controller;
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
            send.innerHTML = ICONS.send + t("send");
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
        $$("#modelsTabs .tab").forEach((b) => b.classList.toggle("active", b.dataset.tab === state.modelsTab));
        if (state.modelsTab === "recommended") renderRecommended();
        else if (state.modelsTab === "search") renderSearch();
        else renderInstalled();
    }

    function kindChips() {
        return '<div class="chips"><button class="chip' + (state.kind === "chat" ? " active" : "") + '" data-kind="chat">' + t("kindChat") + "</button>" +
            '<button class="chip' + (state.kind === "vision" ? " active" : "") + '" data-kind="vision">' + t("kindVision") + "</button></div>";
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

        html += '<div class="empty"><span class="spinner"></span><div style="margin-top:12px">' + t("findingModels") + "</div></div>";
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
        bindKindChips(() => renderRecommended());
        const refresh = $("#recRefresh");
        if (refresh) refresh.onclick = () => { delete state.rec[state.kind]; renderRecommended(true); };
        $$("#modelsBody [data-dl]").forEach((b) => {
            b.onclick = () => {
                const item = state.rec[state.kind].items[Number(b.dataset.dl)];
                const files = [{ filename: item.file.filename, size_bytes: item.file.size_bytes, role: "model" }];
                if (item.projector) files.push({ filename: item.projector.filename, size_bytes: item.projector.size_bytes, role: "projector" });
                startDownload(item.repo_id, files, true);
            };
        });
        $$("#modelsBody [data-load]").forEach((b) => {
            b.onclick = () => {
                const item = state.rec[state.kind].items[Number(b.dataset.load)];
                loadModel(item.file.local_name, item.projector ? item.projector.local_name : undefined);
            };
        });
    }

    function pcSummaryHtml(profile) {
        const hw = state.hw;
        if (!hw || !profile) return "";
        let line;
        if (profile.mode === "gpu") line = t("pcGpuMode", { name: hw.gpu.name, g: profile.gpu_budget_gb, r: profile.ram_budget_gb });
        else line = t("pcCpuMode", { r: profile.ram_budget_gb });
        const advice = t("pcAdvice", { n: profile.comfortable_params_b, q: profile.quant, c: fmtNum(profile.target_ctx) });
        return '<div class="card" style="margin-bottom:8px"><div class="small muted" style="margin-bottom:4px">' + t("yourPc") + "</div><div>" + esc(line) + '</div><div class="muted small" style="margin-top:4px">' + esc(advice) + "</div></div>";
    }

    function recListHtml(data) {
        if (!data.items.length) return '<div class="empty">' + t("noRecommendations") + "</div>";
        const titles = { best: "groupBest", light: "groupLight", heavy: "groupHeavy" };
        let html = state.kind === "vision" ? '<div class="note" style="margin-top:12px">' + t("visionNote") + "</div>" : "";
        ["best", "light", "heavy"].forEach((group) => {
            const entries = data.items.map((item, index) => ({ item, index })).filter((e) => e.item.group === group);
            if (!entries.length) return;
            html += '<div class="group-title">' + t(titles[group]) + '</div><div class="model-list">';
            entries.forEach(({ item, index }) => {
                const busy = state.status && state.status.model.is_loading;
                html += '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(item.name) + '</div><div class="small muted">' + esc(item.author) + "</div>" +
                    '<div class="model-meta">' + fitBadge(item.fit) +
                    '<span class="badge">' + t("paramsB", { n: item.params_b }) + "</span>" +
                    '<span class="badge">' + esc(item.file.quant || "GGUF") + " - " + fmtBytes(item.total_bytes) + "</span>" +
                    (item.projector ? '<span class="badge accent">' + t("withVision") + "</span>" : "") +
                    '<span class="badge">' + t("downloadsCount", { n: fmtNum(item.downloads) }) + "</span>" +
                    archBadge(item.arch_supported, item.arch) + "</div></div>" +
                    '<div class="model-actions">' +
                    (item.installed
                        ? '<button class="btn primary" data-load="' + index + '"' + (busy ? " disabled" : "") + ">" + ICONS.play + t("load") + "</button>"
                        : '<button class="btn primary" data-dl="' + index + '">' + ICONS.download + t("downloadAndLoad") + "</button>") +
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
        body.innerHTML =
            '<div class="row" style="margin-bottom:14px">' + kindChips() + "</div>" +
            '<div class="search-row"><input type="text" id="searchInput" placeholder="' + esc(t("searchPlaceholder")) + '" value="' + esc(state.searchQuery) + '">' +
            '<button class="btn primary" id="searchBtn">' + ICONS.search + t("search") + "</button></div>" +
            '<div id="searchResults"></div>';
        bindKindChips(() => { renderSearch(); if (state.searchQuery) runSearch(); });
        $("#searchBtn").onclick = runSearch;
        $("#searchInput").onkeydown = (e) => { if (e.key === "Enter") runSearch(); };
        drawSearchResults();
    }

    async function runSearch() {
        const q = $("#searchInput").value.trim();
        state.searchQuery = q;
        if (!q) return;
        if (q.indexOf("huggingface.co/") !== -1 || /^[\w.-]+\/[\w.-]+$/.test(q)) {
            openRepo(q);
            return;
        }
        state.searching = true;
        state.searchResults = null;
        drawSearchResults();
        try {
            const data = await api("/api/hf/search?kind=" + state.kind + "&q=" + encodeURIComponent(q));
            state.searchResults = data.results;
        } catch (e) {
            state.searchResults = [];
            toast(e.status === 502 || e.status === 0 ? t("offlineStore") : e.message);
        }
        state.searching = false;
        drawSearchResults();
    }

    function drawSearchResults() {
        const box = $("#searchResults");
        if (!box) return;
        if (state.searching) { box.innerHTML = '<div class="empty"><span class="spinner"></span><div style="margin-top:12px">' + t("searching") + "</div></div>"; return; }
        if (state.searchResults === null) { box.innerHTML = ""; return; }
        if (!state.searchResults.length) { box.innerHTML = '<div class="empty">' + t("noResults") + "</div>"; return; }
        box.innerHTML = '<div class="model-list">' + state.searchResults.map((r, i) =>
            '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(r.name) + '</div><div class="small muted">' + esc(r.author) + "</div>" +
            '<div class="model-meta">' + (r.params_b ? '<span class="badge">' + t("paramsB", { n: r.params_b }) + "</span>" : "") +
            '<span class="badge">' + t("downloadsCount", { n: fmtNum(r.downloads) }) + "</span>" + archBadge(r.arch_supported, r.arch) + "</div></div>" +
            '<div class="model-actions"><button class="btn" data-open="' + i + '">' + t("files") + "</button></div></div>").join("") + "</div>";
        $$("#searchResults [data-open]").forEach((b) => { b.onclick = () => openRepo(state.searchResults[Number(b.dataset.open)].repo_id); });
    }

    async function openRepo(repoId) {
        $("#modelsBody").innerHTML = '<div class="empty"><span class="spinner"></span></div>';
        try {
            state.inspect = await api("/api/hf/inspect", { method: "POST", body: { repo_id: repoId } });
        } catch (e) {
            state.inspect = null;
            toast(e.status === 502 || e.status === 0 ? t("offlineStore") : e.message);
            renderSearch();
            return;
        }
        renderInspect();
    }

    function bestProjector(files) {
        const list = files.filter((f) => f.is_projector && !f.split);
        if (!list.length) return null;
        return list.find((f) => /f16/i.test(f.filename)) || list.find((f) => /bf16/i.test(f.filename)) || list[0];
    }

    function renderInspect() {
        const r = state.inspect;
        const models = r.files.filter((f) => !f.is_projector);
        const projectors = r.files.filter((f) => f.is_projector && !f.split);
        const defaultProj = bestProjector(r.files);
        let html = '<div style="margin-bottom:14px"><button class="btn small" id="inspectBack">&larr; ' + t("tabSearch") + "</button></div>" +
            '<div class="card"><div class="card-head"><div><h2>' + esc(r.repo_id) + '</h2><div class="model-meta">' +
            (r.params_b ? '<span class="badge">' + t("paramsB", { n: r.params_b }) + "</span>" : "") +
            '<span class="badge">' + t("downloadsCount", { n: fmtNum(r.downloads) }) + "</span>" + archBadge(r.arch_supported, r.arch) + "</div></div></div>";
        if (!r.has_gguf) {
            html += '<div class="note bad">' + t("noGguf") + "</div>";
            if (r.suggestions && r.suggestions.length) {
                html += '<div class="group-title">' + t("suggestions") + '</div><div class="model-list">' + r.suggestions.map((s, i) =>
                    '<div class="model-card"><div class="model-main"><div class="model-name">' + esc(s.repo_id) + '</div></div><div class="model-actions"><button class="btn" data-sugg="' + i + '">' + t("files") + "</button></div></div>").join("") + "</div>";
            }
        } else {
            html += '<div class="small muted" style="margin-bottom:10px">' + t("quantNote") + "</div>";
            if (projectors.length) {
                html += '<div style="margin-bottom:12px"><span class="field-label">' + t("projectorSelect") + '</span><select id="projSelect"><option value="">' + t("projectorNone") + "</option>" +
                    projectors.map((p) => '<option value="' + esc(p.filename) + '"' + (defaultProj && p.filename === defaultProj.filename ? " selected" : "") + ">" + esc(p.filename) + " (" + fmtBytes(p.size_bytes) + ")</option>").join("") + "</select></div>";
            }
            html += models.map((f, i) =>
                '<div class="file-row"><div><div class="file-name">' + esc(f.filename) + '</div><div class="model-meta">' +
                (f.quant ? '<span class="badge">' + esc(f.quant) + "</span>" : "") + '<span class="badge">' + fmtBytes(f.size_bytes) + "</span>" +
                (f.split ? '<span class="badge bad">' + t("splitFile") + "</span>" : fitBadge(f.fit)) +
                (f.installed ? '<span class="badge ok">' + t("installed") + "</span>" : "") + "</div></div>" +
                '<div class="model-actions">' + (f.split ? "" : (f.installed
                    ? '<button class="btn primary small" data-iload="' + i + '">' + ICONS.play + t("load") + "</button>"
                    : '<button class="btn small" data-idl="' + i + '">' + ICONS.download + t("download") + '</button><button class="btn primary small" data-idl-load="' + i + '">' + t("downloadAndLoad") + "</button>")) + "</div></div>").join("");
        }
        html += "</div>";
        $("#modelsBody").innerHTML = html;
        $("#inspectBack").onclick = () => { state.inspect = null; renderSearch(); };
        $$("#modelsBody [data-sugg]").forEach((b) => { b.onclick = () => openRepo(r.suggestions[Number(b.dataset.sugg)].repo_id); });

        const filesFor = (f) => {
            const files = [{ filename: f.filename, size_bytes: f.size_bytes, role: "model" }];
            const sel = $("#projSelect");
            if (sel && sel.value) {
                const p = projectors.find((x) => x.filename === sel.value);
                if (p) files.push({ filename: p.filename, size_bytes: p.size_bytes, role: "projector" });
            }
            return files;
        };
        $$("#modelsBody [data-idl]").forEach((b) => { b.onclick = () => startDownload(r.repo_id, filesFor(models[Number(b.dataset.idl)]), false); });
        $$("#modelsBody [data-idl-load]").forEach((b) => { b.onclick = () => startDownload(r.repo_id, filesFor(models[Number(b.dataset["idlLoad"])]), true); });
        $$("#modelsBody [data-iload]").forEach((b) => { b.onclick = () => loadModel(models[Number(b.dataset.iload)].local_name); });
    }

    // ---- installed

    async function renderInstalled() {
        const body = $("#modelsBody");
        body.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
        try { state.installed = await api("/api/models"); } catch (e) { return; }
        drawInstalled();
    }

    function drawInstalled() {
        if (state.view !== "models" || state.modelsTab !== "installed") return;
        const data = state.installed;
        const body = $("#modelsBody");
        if (!data.models.length && !data.projectors.length) {
            body.innerHTML = '<div class="empty">' + t("noInstalled") + '<div class="small mono" style="margin-top:8px">' + esc(data.models_dir) + "</div></div>";
            return;
        }
        const busy = state.status && state.status.model.is_loading;
        let html = '<div class="small muted" style="margin-bottom:10px">' + t("installedTitle") + ": <span class=\"mono\">" + esc(data.models_dir) + "</span></div>";
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
        body.innerHTML = html;
        $$("#modelsBody [data-iload]").forEach((b) => { b.onclick = () => loadModel(data.models[Number(b.dataset.iload)].filename); });
        $$("#modelsBody [data-idel]").forEach((b) => {
            b.onclick = async () => {
                const name = b.dataset.idel;
                if (!confirm(t("confirmDelete", { f: name }))) return;
                await api("/api/models/" + encodeURIComponent(name), { method: "DELETE" }).catch((e) => toast(e.message));
                delete state.rec.chat; delete state.rec.vision;
                renderInstalled();
                refreshStatus();
            };
        });
    }

    // ---- actions

    async function startDownload(repoId, files, loadAfter) {
        try {
            await api("/api/downloads", { method: "POST", body: { repo_id: repoId, files, load_after: loadAfter } });
            refreshStatus();
        } catch (e) {
            if (e.status === 409) toast(t("dlBusy"));
            else if (e.status === 507) toast(t("dlDisk"));
            else toast(e.message || t("error"));
        }
    }

    async function loadModel(model, projector) {
        try {
            await api("/api/models/load", { method: "POST", body: { model, projector } });
            state.sig = {};
            setView("home");
            refreshStatus();
        } catch (e) {
            toast(e.status === 409 ? t("errBusy") : (e.message || t("error")));
        }
    }

    // ------------------------------------------------------------------ download bar

    function renderDownload() {
        const bar = $("#downloadBar");
        const d = state.status && state.status.download;
        if (!d) { bar.hidden = true; state.lastDownloadState = ""; return; }
        bar.hidden = false;
        let html;
        if (d.status === "downloading") {
            const speed = d.speed_bps ? (d.speed_bps / 1048576).toFixed(1) + " MB/s" : "";
            html = '<div class="download-inner"><div class="download-info"><div><strong>' + esc(t("dlDownloading", { f: d.current })) + '</strong> <span class="muted small">' +
                esc(t("dlFile", { i: d.index, n: d.count })) + "</span></div>" +
                '<div class="progress"><span style="width:' + d.percent + '%"></span></div>' +
                '<div class="small muted" style="margin-top:6px">' + d.percent + "% - " + fmtBytes(d.downloaded_bytes) + " / " + fmtBytes(d.total_bytes) +
                (speed ? " - " + speed : "") + (d.eta_sec !== null && d.eta_sec !== undefined ? " - " + esc(t("dlEta", { t: fmtEta(d.eta_sec) })) : "") + "</div></div>" +
                '<button class="btn danger" id="dlCancel">' + t("dlCancel") + "</button></div>";
        } else {
            const text = d.status === "completed" ? t("dlCompleted") : d.status === "cancelled" ? t("dlCancelled") : t("dlFailed", { e: d.error || "" });
            html = '<div class="download-inner"><div class="download-info"><strong>' + esc(text) + "</strong></div></div>";
            if (state.lastDownloadState === "downloading") {
                delete state.rec.chat; delete state.rec.vision;
                if (state.view === "models") enterModels();
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
        try { state.hw = await api("/api/hardware"); state.hw = Object.assign({}, state.hw.hardware, { profile: state.hw.profile }); } catch (e) { return; }
        if (state.view === "system") renderHardware();
    }

    function renderHardware() {
        const hw = state.hw;
        if (!hw || !$("#sysHardware")) return;
        const tiers = { ultra: "tierUltra", high: "tierHigh", mid: "tierMid", low: "tierLow", cpu: "tierCpu" };
        const rows = [
            [t("cpu"), t("cpuValue", { c: hw.cpu.cores, t: hw.cpu.threads })],
            [t("ram"), t("ramValue", { t: fmtGb(hw.ram_total), a: fmtGb(hw.ram_available) })],
            [t("gpu"), hw.gpu.has_gpu ? hw.gpu.name : t("gpuNone")],
        ];
        if (hw.gpu.has_gpu) rows.push([t("vram"), t("vramValue", { t: fmtGb(hw.gpu.vram_total), f: fmtGb(hw.gpu.vram_free) })]);
        if (hw.gpu.driver) rows.push([t("driver"), hw.gpu.driver]);
        rows.push([t("tier"), t(tiers[hw.profile.tier] || "tierCpu")]);
        $("#sysHardware").innerHTML = '<div class="card-head"><h2>' + t("hardware") + "</h2></div>" +
            '<dl class="kv">' + rows.map((r) => "<dt>" + esc(r[0]) + "</dt><dd>" + esc(r[1]) + "</dd>").join("") + "</dl>";
        renderEngine();
    }

    function renderEngine() {
        const s = state.status;
        if (!s || !$("#sysEngine")) return;
        const e = s.engine;
        const backend = !e.available ? t("backendNone") : e.gpu_offload ? t("backendGpu") : t("backendCpu");
        let html = '<div class="card-head"><h2>' + t("engineTitle") + "</h2></div>" +
            '<dl class="kv"><dt>llama-cpp-python</dt><dd>' + esc(e.version || "-") + "</dd><dt>" + t("engineBackend") + "</dt><dd>" + esc(backend) + "</dd><dt>Hub</dt><dd>" + esc(s.version) + "</dd></dl>";
        if (!e.available) html += '<div class="note bad" style="margin-top:12px">' + t("stepEngineBad") + "</div><details><summary>" + t("errTechnical") + "</summary><pre>" + esc(e.error) + "</pre></details>";
        else if (state.hw && state.hw.gpu.kind === "cuda" && !e.gpu_offload) html += '<div class="note warn" style="margin-top:12px">' + t("stepEngineGpuMissing") + "</div>";
        $("#sysEngine").innerHTML = html;
    }

    async function loadSettings() {
        try { state.settings = await api("/api/settings"); } catch (e) { /* keep previous */ }
    }

    function renderSettings() {
        const st = state.settings;
        const box = $("#sysSettings");
        if (!st || !box) return;
        const ctxOptions = ["auto", 4096, 8192, 16384, 32768, 65536];
        const layerOptions = [["auto", t("setAuto")], ["0", t("setLayersCpu")], ["-1", t("setLayersAll")]];
        box.innerHTML = '<div class="card-head"><div><h2>' + t("settingsTitle") + '</h2><div class="small muted">' + t("settingsHint") + "</div></div></div>" +
            '<div class="form-grid"><div><span class="field-label">' + t("setCtx") + '</span><select id="setCtx">' +
            ctxOptions.map((o) => '<option value="' + o + '"' + (String(st.ctx_mode) === String(o) ? " selected" : "") + ">" + (o === "auto" ? t("setAuto") : fmtNum(o)) + "</option>").join("") + "</select></div>" +
            '<div><span class="field-label">' + t("setLayers") + '</span><select id="setLayers">' +
            layerOptions.map((o) => '<option value="' + o[0] + '"' + (String(st.gpu_layers_mode) === o[0] ? " selected" : "") + ">" + esc(o[1]) + "</option>").join("") + "</select></div>" +
            '<div><span class="field-label">' + t("setCap") + '</span><select id="setCap">' +
            [8192, 16384, 32768, 65536].map((o) => '<option value="' + o + '"' + (Number(st.ctx_cap) === o ? " selected" : "") + ">" + fmtNum(o) + "</option>").join("") + "</select></div></div>" +
            '<div class="stack" style="gap:12px;margin-bottom:16px"><label class="check"><input type="checkbox" id="setKv"' + (st.kv_quant ? " checked" : "") + "><span>" + t("setKv") + "</span></label>" +
            '<label class="check"><input type="checkbox" id="setAutoLoad"' + (st.auto_load_last ? " checked" : "") + "><span>" + t("setAutoLoad") + "</span></label></div>" +
            '<div class="row" style="align-items:center"><button class="btn primary" id="setSave">' + t("save") + '</button><span class="small muted" id="setMsg"></span></div>';
        $("#setSave").onclick = async () => {
            const layers = $("#setLayers").value;
            const body = {
                ctx_mode: $("#setCtx").value,
                gpu_layers_mode: layers,
                ctx_cap: Number($("#setCap").value),
                kv_quant: $("#setKv").checked,
                auto_load_last: $("#setAutoLoad").checked,
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
            renderDownload();
            if (state.view === "home") updateHome();
            if (state.view === "system") renderEngine();
            const was = previous && previous.model;
            const now = state.status.model;
            if (state.view === "models" && was && (was.is_loading !== now.is_loading || was.model !== now.model)) {
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
        if (state.view === "models") enterModels();
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

    async function start() {
        bindGlobal();
        renderAll();
        await refreshStatus();
        refreshHardware().then(() => { if (state.view === "home") updateHome(); });
        setInterval(refreshStatus, 1500);
        setInterval(() => { if (state.view === "system") { refreshHardware(); refreshLogs(); } }, 5000);
    }

    start();
})();
