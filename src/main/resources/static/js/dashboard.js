/* ==========================================================================
   UPI Offline Mesh — dashboard logic
   Talks only to the existing REST API (no backend changes needed):
     GET  /api/server-key  /api/mesh/state  /api/accounts  /api/transactions
     POST /api/demo/send   /api/mesh/gossip /api/mesh/flush /api/mesh/reset
     POST /api/bridge/ingest
   ========================================================================== */
(function () {
    'use strict';

    // ---------------------------------------------------------------- helpers
    const $ = (id) => document.getElementById(id);
    const NS = 'http://www.w3.org/2000/svg';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const inr = (n) => '₹' + Number(n || 0).toLocaleString('en-IN',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    function toDate(v) {
        if (typeof v === 'number') return new Date(v < 1e11 ? v * 1000 : v);
        return new Date(v);
    }
    const timeOf = (v) => toDate(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

    function fmtDuration(ms) {
        if (!isFinite(ms) || ms < 0) return '—';
        const s = Math.round(ms / 1000);
        if (s < 1) return '< 1s';
        if (s < 60) return s + 's';
        const m = Math.floor(s / 60);
        if (m < 60) return m + 'm ' + (s % 60) + 's';
        return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
    }

    function hash(str) {
        let h = 0;
        for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
        return Math.abs(h);
    }
    const PACKET_COLORS = ['#4f46e5', '#0ea5e9', '#f97316', '#d946ef', '#14b8a6', '#eab308', '#ef4444', '#84cc16'];
    const packetColor = (id) => PACKET_COLORS[hash(id) % PACKET_COLORS.length];
    const AVATAR_COLORS = ['#6366f1', '#0ea5e9', '#f97316', '#d946ef', '#10b981', '#ef4444'];
    const avatarColor = (s) => AVATAR_COLORS[hash(s) % AVATAR_COLORS.length];

    function prettyDevice(id) {
        const s = id.replace(/^phone-/, '').replace(/(\D)(\d+)$/, '$1 $2');
        return s.charAt(0).toUpperCase() + s.slice(1);
    }

    function el(tag, attrs, parent) {
        const e = document.createElementNS(NS, tag);
        for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
        if (parent) parent.appendChild(e);
        return e;
    }

    async function api(path, opts) {
        const res = await fetch(path, opts);
        if (!res.ok) {
            let detail = '';
            try { const j = await res.json(); detail = j.message || j.error || ''; } catch (e) { /* ignore */ }
            throw new Error('HTTP ' + res.status + (detail ? ' — ' + detail : ''));
        }
        return res.json();
    }
    const post = (path, body, headers) => api(path, {
        method: 'POST',
        headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
        body: body === undefined ? undefined : JSON.stringify(body)
    });

    // ----------------------------------------------------------------- state
    const state = {
        mesh: null,           // last /api/mesh/state
        accounts: [],
        txs: [],
        prevBalances: null,   // vpa -> balance
        seenTx: null,         // Set of tx ids already rendered
        busy: false,          // an animated action is running
        uploaded: false,      // session progress flags for the stepper
        settled: false,
        lastUpload: null,
        meshKey: '',
        pos: {}               // node positions, by device id
    };

    // --------------------------------------------------------------- toasts/log
    const ICONS = {
        ok: '<svg class="t-icon" viewBox="0 0 24 24"><path d="M5 12.5 10 17.5 19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        bad: '<svg class="t-icon" viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
        warn: '<svg class="t-icon" viewBox="0 0 24 24"><path d="M12 4 2.5 20h19L12 4Zm0 6v5m0 2.5v.01" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
    };

    function toast(html, kind) {
        const t = document.createElement('div');
        t.className = 'toast ' + (kind || 'ok');
        t.innerHTML = (ICONS[kind || 'ok'] || '') + '<div>' + html + '</div>';
        $('toasts').appendChild(t);
        setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 260); }, 4200);
        while ($('toasts').children.length > 4) $('toasts').firstChild.remove();
    }

    function logEntry(msg, kind, detail) {
        const list = $('log');
        const empty = list.querySelector('.log-empty');
        if (empty) empty.remove();
        const li = document.createElement('li');
        if (kind) li.className = kind;
        li.innerHTML = '<time>' + new Date().toLocaleTimeString([], { hour12: false }) + '</time><div><div class="l-msg">' +
            msg + '</div>' + (detail ? '<div class="l-detail">' + esc(detail) + '</div>' : '') + '</div>';
        list.insertBefore(li, list.firstChild);
        while (list.children.length > 120) list.lastChild.remove();
    }
    function resetLog() {
        $('log').innerHTML = '<li class="log-empty">Nothing yet — compose a payment to begin.</li>';
    }

    // ---------------------------------------------------------------- loading
    function setLoading(btn, on) {
        btn.classList.toggle('is-loading', on);
        btn.disabled = on;
    }
    const ACTION_BTNS = ['sendBtn', 'gossipBtn', 'flushBtn', 'autoBtn', 'resetBtn', 'forgeBtn', 'replayBtn'];
    function lockUi(on) {
        state.busy = on;
        ACTION_BTNS.forEach((id) => { $(id).disabled = on; });
        if (!on) $('replayBtn').disabled = !state.lastUpload;
    }

    // ----------------------------------------------------------------- refresh
    async function refresh(force) {
        if (state.busy && !force) return;
        try {
            const [mesh, accounts, txs] = await Promise.all([
                api('/api/mesh/state'), api('/api/accounts'), api('/api/transactions')
            ]);
            state.mesh = mesh;
            state.accounts = accounts;
            state.txs = txs;
            setConn('ok');
            render();
        } catch (e) {
            setConn('down');
        }
    }

    function setConn(s) {
        const pill = $('connPill');
        pill.dataset.state = s;
        $('connText').textContent = s === 'ok' ? 'Backend live' : s === 'down' ? 'Backend unreachable' : 'Connecting…';
    }

    function render() {
        renderKpis();
        renderForm();
        renderMesh();
        renderAccounts();
        renderLedger();
        renderStepper();
    }

    // -------------------------------------------------------------------- KPIs
    function renderKpis() {
        const { mesh, accounts, txs } = state;
        const total = accounts.reduce((s, a) => s + parseFloat(a.balance), 0);
        $('kpiTotal').textContent = inr(total);
        $('kpiTotalSub').textContent = 'conserved across ' + accounts.length + ' accounts';

        const settled = txs.filter((t) => t.status === 'SETTLED');
        const rejected = txs.filter((t) => t.status === 'REJECTED');
        $('kpiSettled').textContent = settled.length;
        $('kpiSettledSub').textContent = inr(settled.reduce((s, t) => s + parseFloat(t.amount), 0)) + ' moved';
        $('kpiRejected').textContent = rejected.length;

        const ids = new Set();
        let copies = 0;
        mesh.devices.forEach((d) => d.packetIds.forEach((p) => { ids.add(p); copies++; }));
        $('kpiPackets').textContent = ids.size;
        $('kpiPacketsSub').textContent = copies + ' cop' + (copies === 1 ? 'y' : 'ies') + ' on ' + mesh.devices.length + ' phones';
        $('kpiCache').textContent = mesh.idempotencyCacheSize;
    }

    // -------------------------------------------------------------------- form
    function fillSelect(sel, items, wanted) {
        const key = items.map((i) => i.value).join('|');
        if (sel.dataset.key === key) return;
        const keep = sel.value || wanted;
        sel.innerHTML = items.map((i) => '<option value="' + esc(i.value) + '">' + esc(i.label) + '</option>').join('');
        sel.dataset.key = key;
        if (items.some((i) => i.value === keep)) sel.value = keep;
        else if (items.some((i) => i.value === wanted)) sel.value = wanted;
    }

    function renderForm() {
        const accItems = state.accounts
            .slice().sort((a, b) => a.vpa.localeCompare(b.vpa))
            .map((a) => ({ value: a.vpa, label: a.holderName + ' (' + a.vpa + ')' }));
        const firstRun = !$('senderVpa').dataset.key;
        fillSelect($('senderVpa'), accItems, 'alice@demo');
        fillSelect($('receiverVpa'), accItems, 'bob@demo');
        if (firstRun && $('senderVpa').value === $('receiverVpa').value && accItems.length > 1) {
            $('receiverVpa').value = accItems.find((i) => i.value !== $('senderVpa').value).value;
        }
        const devItems = state.mesh.devices
            .slice().sort((a, b) => (a.hasInternet - b.hasInternet) || a.deviceId.localeCompare(b.deviceId))
            .map((d) => ({ value: d.deviceId, label: prettyDevice(d.deviceId) + (d.hasInternet ? ' (4G)' : '') }));
        fillSelect($('startDevice'), devItems, 'phone-alice');
        updateHints();
    }

    function balanceOf(vpa) {
        const a = state.accounts.find((x) => x.vpa === vpa);
        return a ? parseFloat(a.balance) : null;
    }

    function updateHints() {
        const s = balanceOf($('senderVpa').value), r = balanceOf($('receiverVpa').value);
        $('senderHint').textContent = s == null ? '' : 'Balance ' + inr(s);
        $('receiverHint').textContent = r == null ? '' : 'Balance ' + inr(r);
        validateForm(false);
    }

    function validateForm(strict) {
        const msg = $('amountMsg'), amountEl = $('amount');
        const amount = parseFloat(amountEl.value);
        const sender = $('senderVpa').value, receiver = $('receiverVpa').value;
        let err = '', warn = '';
        if (!isFinite(amount) || amount <= 0) { if (strict || amountEl.value !== '') err = 'Enter an amount greater than ₹0.'; }
        else if (sender && sender === receiver) err = 'Sender and receiver must be different accounts.';
        else {
            const bal = balanceOf(sender);
            if (bal != null && amount > bal) warn = 'Exceeds ' + inr(bal) + ' balance — it will be recorded as REJECTED at settlement.';
        }
        if (!err && strict && !/^\d{4}$/.test($('pin').value)) err = 'PIN must be exactly 4 digits.';
        msg.textContent = err || warn;
        msg.className = 'form-msg' + (err ? ' err' : warn ? ' warn' : '');
        amountEl.setAttribute('aria-invalid', err && /amount/i.test(err) ? 'true' : 'false');
        $('pin').setAttribute('aria-invalid', err && /PIN/.test(err) ? 'true' : 'false');
        return !err;
    }

    // -------------------------------------------------------------------- mesh
    function layout(devices) {
        const offline = devices.filter((d) => !d.hasInternet)
            .sort((a, b) => (b.deviceId === 'phone-alice') - (a.deviceId === 'phone-alice') || a.deviceId.localeCompare(b.deviceId));
        const online = devices.filter((d) => d.hasInternet).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
        const pos = {};
        const cx = 222, cy = 168, rx = 148, ry = 80;
        offline.forEach((d, i) => {
            if (offline.length === 1) { pos[d.deviceId] = { x: cx, y: cy }; return; }
            const a = Math.PI + (i * 2 * Math.PI) / offline.length;
            pos[d.deviceId] = { x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) };
        });
        online.forEach((d, i) => {
            const y = online.length === 1 ? 172 : 90 + (i * 164) / (online.length - 1);
            pos[d.deviceId] = { x: 528, y };
        });
        pos.backend = { x: 655, y: 172 };
        return { pos, offline, online };
    }

    function renderMesh() {
        const devices = state.mesh.devices;
        const key = JSON.stringify(devices.map((d) => [d.deviceId, d.hasInternet, d.packetIds.slice().sort()]));
        if (key === state.meshKey) return;
        state.meshKey = key;

        const { pos } = layout(devices);
        state.pos = pos;
        const zones = $('meshZones'), edges = $('meshEdges'), nodes = $('meshNodes');
        zones.innerHTML = edges.innerHTML = nodes.innerHTML = '';

        // zones
        el('rect', { x: 10, y: 10, width: 440, height: 320, rx: 14, class: 'zone-basement' }, zones);
        el('rect', { x: 10, y: 10, width: 440, height: 320, rx: 14, fill: 'url(#hatch)' }, zones);
        el('rect', { x: 462, y: 10, width: 248, height: 320, rx: 14, class: 'zone-outside' }, zones);
        el('text', { x: 26, y: 32, class: 'zone-label' }, zones).textContent = 'Basement · no signal';
        el('text', { x: 478, y: 32, class: 'zone-label' }, zones).textContent = 'Outside · 4G';

        // Bluetooth edges (gossip is all-to-all in the simulator)
        const ids = devices.map((d) => d.deviceId);
        for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
            const a = pos[ids[i]], b = pos[ids[j]];
            el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'edge-ble' }, edges);
        }
        // 4G edges to backend
        devices.filter((d) => d.hasInternet).forEach((d) => {
            const a = pos[d.deviceId], b = pos.backend;
            el('line', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: 'edge-net' }, edges);
        });

        // device nodes
        devices.forEach((d) => {
            const p = pos[d.deviceId];
            const g = el('g', { class: 'node' + (d.hasInternet ? ' bridge' : '') + (d.packetCount ? ' has-packets' : ''), transform: 'translate(' + p.x + ',' + p.y + ')' }, nodes);
            el('title', {}, g).textContent = prettyDevice(d.deviceId) + ' — ' + (d.hasInternet ? 'has 4G (bridge)' : 'offline') + ' — holding ' + d.packetCount + ' packet(s)';
            el('circle', { r: 26, class: 'node-body' }, g);
            el('rect', { x: -7, y: -12, width: 14, height: 24, rx: 3.2, class: 'node-icon' }, g);
            el('path', { d: 'M-2.5 8.5h5', class: 'node-icon' }, g);
            el('text', { y: 44, class: 'node-label' }, g).textContent = prettyDevice(d.deviceId);
            el('text', { y: 57, class: 'node-sub' }, g).textContent = d.hasInternet ? 'bridge · 4G' : 'offline';
            if (d.hasInternet) {
                el('rect', { x: -12, y: -37, width: 24, height: 12, rx: 6, class: 'node-tag' }, g);
                el('text', { y: -31, class: 'node-tag-text' }, g).textContent = '4G';
            }
            if (d.packetCount) {
                el('circle', { cx: 20, cy: -20, r: 9, class: 'node-badge' }, g);
                el('text', { x: 20, y: -20, class: 'node-badge-text' }, g).textContent = d.packetCount;
                // one coloured square per packet held
                const shown = d.packetIds.slice().sort().slice(0, 6);
                shown.forEach((pid, i) => {
                    el('rect', { x: -((shown.length * 11) / 2) + i * 11 + 1, y: 31 + 33, width: 9, height: 9, rx: 2.5, fill: packetColor(pid) }, g);
                });
            }
        });

        // backend node
        const b = pos.backend;
        const g = el('g', { class: 'node', transform: 'translate(' + b.x + ',' + b.y + ')' }, nodes);
        el('title', {}, g).textContent = 'UPI backend — decrypts, deduplicates and settles';
        el('rect', { x: -28, y: -30, width: 56, height: 60, rx: 12, class: 'backend-body' }, g);
        el('rect', { x: -16, y: -18, width: 32, height: 11, rx: 3, class: 'backend-icon' }, g);
        el('rect', { x: -16, y: -3, width: 32, height: 11, rx: 3, class: 'backend-icon' }, g);
        el('path', { d: 'M-10 -12.5h.01M-10 2.5h.01M-16 16h32', class: 'backend-icon' }, g);
        el('text', { y: 50, class: 'node-label' }, g).textContent = 'UPI backend';
        el('text', { y: 63, class: 'node-sub' }, g).textContent = 'settles ledger';
    }

    // ---- animation primitives
    function flyPacket(fromId, toId, color, opts) {
        opts = opts || {};
        const a = state.pos[fromId], b = state.pos[toId];
        if (!a || !b || reduceMotion) return Promise.resolve();
        const g = el('g', {}, $('meshFx'));
        el('rect', { x: -8, y: -6, width: 16, height: 12, rx: 3, fill: color, stroke: '#fff', 'stroke-width': 1.5 }, g);
        el('path', { d: 'M-2.5 -1.5v-1.2a2.5 2.5 0 0 1 5 0v1.2M-3.5 -1.5h7v5h-7Z', fill: 'none', stroke: '#fff', 'stroke-width': 1, 'stroke-linejoin': 'round', transform: 'scale(.72)' }, g);
        const lift = opts.arc === false ? 0 : -18;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + lift;
        const t = (p) => 'translate(' + p.x + 'px,' + p.y + 'px)';
        g.style.transform = t(a);
        g.style.opacity = '0';
        const anim = g.animate([
            { transform: t(a), opacity: 0 },
            { transform: t(a), opacity: 1, offset: .08 },
            { transform: t({ x: mx, y: my }), opacity: 1, offset: .5 },
            { transform: t(b), opacity: 1, offset: .92 },
            { transform: t(b), opacity: 0 }
        ], { duration: opts.duration || 800, delay: opts.delay || 0, easing: 'ease-in-out', fill: 'both' });
        return anim.finished.catch(() => {}).then(() => g.remove());
    }

    function pulseNode(id, color) {
        const p = state.pos[id];
        if (!p || reduceMotion) return;
        const c = el('circle', { cx: p.x, cy: p.y, r: 26, class: 'fx-ring', stroke: color }, $('meshFx'));
        c.style.transformBox = 'fill-box';
        c.style.transformOrigin = 'center';
        c.animate([{ transform: 'scale(1)', opacity: .9 }, { transform: 'scale(2.1)', opacity: 0 }],
            { duration: 800, easing: 'ease-out' }).finished.catch(() => {}).then(() => c.remove());
    }

    function chipAt(id, text, color, slot) {
        const p = state.pos[id];
        if (!p) return;
        const w = Math.max(54, text.length * 6.4 + 16);
        const g = el('g', { class: 'fx-chip' }, $('meshFx'));
        el('rect', { x: -w / 2, y: -10, width: w, height: 20, rx: 10, fill: color }, g);
        el('text', { x: 0, y: 0 }, g).textContent = text;
        const y0 = p.y - 54 - slot * 24;
        g.style.transform = 'translate(' + p.x + 'px,' + y0 + 'px)';
        if (reduceMotion) { setTimeout(() => g.remove(), 2400); return; }
        g.animate([
            { transform: 'translate(' + p.x + 'px,' + (y0 + 10) + 'px)', opacity: 0 },
            { transform: 'translate(' + p.x + 'px,' + y0 + 'px)', opacity: 1, offset: .15 },
            { transform: 'translate(' + p.x + 'px,' + y0 + 'px)', opacity: 1, offset: .8 },
            { transform: 'translate(' + p.x + 'px,' + (y0 - 8) + 'px)', opacity: 0 }
        ], { duration: 2400 }).finished.catch(() => {}).then(() => g.remove());
    }

    // ------------------------------------------------------------------ stepper
    function renderStepper() {
        const devices = state.mesh.devices;
        const counts = {};
        devices.forEach((d) => d.packetIds.forEach((p) => { counts[p] = (counts[p] || 0) + 1; }));
        const any = Object.keys(counts).length > 0;
        const spread = Object.values(counts).some((c) => c > 1);
        const done = [any || state.uploaded, spread || state.uploaded, state.uploaded, state.settled];
        const firstOpen = done.indexOf(false);
        document.querySelectorAll('#stepper li').forEach((li, i) => {
            li.classList.toggle('done', done[i]);
            li.classList.toggle('current', i === firstOpen);
        });
    }

    // ----------------------------------------------------------------- accounts
    const acctEls = new Map();
    function renderAccounts() {
        const box = $('accounts');
        const accounts = state.accounts.slice().sort((a, b) => a.vpa.localeCompare(b.vpa));
        const first = state.prevBalances === null;
        const prev = state.prevBalances || {};
        if (accounts.map((a) => a.vpa).join() !== Array.from(acctEls.keys()).join()) {
            box.innerHTML = '';
            acctEls.clear();
            accounts.forEach((a) => {
                const d = document.createElement('div');
                d.className = 'acct';
                d.innerHTML = '<div class="avatar" style="background:' + avatarColor(a.vpa) + '">' + esc(a.holderName.charAt(0).toUpperCase()) +
                    '</div><div><div class="acct-name">' + esc(a.holderName) + '</div><div class="acct-vpa">' + esc(a.vpa) +
                    '</div></div><div class="acct-bal"></div><div class="acct-delta"></div>';
                box.appendChild(d);
                acctEls.set(a.vpa, d);
            });
        }
        const next = {};
        accounts.forEach((a) => {
            const bal = parseFloat(a.balance);
            next[a.vpa] = bal;
            const d = acctEls.get(a.vpa);
            d.querySelector('.acct-bal').textContent = inr(bal);
            if (!first && prev[a.vpa] != null && Math.abs(prev[a.vpa] - bal) > 0.001) {
                const diff = bal - prev[a.vpa];
                d.querySelector('.acct-delta').textContent = (diff > 0 ? '+' : '−') + inr(Math.abs(diff));
                d.classList.remove('flash-up', 'flash-down');
                void d.offsetWidth; // restart animation
                d.classList.add(diff > 0 ? 'flash-up' : 'flash-down');
            }
        });
        state.prevBalances = next;
    }

    // ------------------------------------------------------------------- ledger
    let ledgerKey = '';
    function renderLedger() {
        const txs = state.txs;
        $('ledgerEmpty').hidden = txs.length > 0;
        document.querySelector('table.ledger').hidden = txs.length === 0;
        const key = txs.map((t) => t.id + t.status).join();
        if (key === ledgerKey) return;
        ledgerKey = key;
        const firstLoad = state.seenTx === null;
        const seen = state.seenTx || new Set();
        $('ledgerBody').innerHTML = txs.map((t) => {
            const isNew = !firstLoad && !seen.has(t.id);
            const offlineFor = fmtDuration(toDate(t.settledAt) - toDate(t.signedAt));
            return '<tr' + (isNew ? ' class="new-row"' : '') + '>' +
                '<td class="muted">' + esc(t.id) + '</td>' +
                '<td><span class="pay"><b>' + esc(t.senderVpa.replace('@demo', '')) + '</b>' +
                '<svg viewBox="0 0 24 24"><path d="M4 12h15m-5-5 5 5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
                '<b>' + esc(t.receiverVpa.replace('@demo', '')) + '</b></span></td>' +
                '<td class="num">' + inr(t.amount) + '</td>' +
                '<td><span class="badge badge-' + esc(t.status) + '">' + esc(t.status.charAt(0) + t.status.slice(1).toLowerCase()) + '</span></td>' +
                '<td>' + esc(prettyDevice(t.bridgeNodeId)) + '</td>' +
                '<td>' + esc(t.hopCount) + '</td>' +
                '<td class="muted">' + esc(offlineFor) + '</td>' +
                '<td class="muted">' + esc(timeOf(t.settledAt)) + '</td></tr>';
        }).join('');
        state.seenTx = new Set(txs.map((t) => t.id));
    }

    // ------------------------------------------------------------------ actions
    function readCompose() {
        return {
            senderVpa: $('senderVpa').value,
            receiverVpa: $('receiverVpa').value,
            amount: Math.round(parseFloat($('amount').value) * 100) / 100,
            pin: $('pin').value,
            ttl: 5,
            startDevice: $('startDevice').value || 'phone-alice'
        };
    }

    async function doSend() {
        if (!validateForm(true)) { toast('Fix the highlighted field first.', 'warn'); return false; }
        const body = readCompose();
        let r;
        try {
            r = await post('/api/demo/send', body);
        } catch (e) {
            logEntry('Could not create packet — ' + esc(e.message), 'bad');
            toast('Could not create packet.<br>' + esc(e.message), 'bad');
            return false;
        }
        const id8 = r.packetId.substring(0, 8), color = packetColor(id8);
        state.uploaded = false; state.settled = false;

        $('receipt').hidden = false;
        $('receiptSwatch').style.background = color;
        $('receiptId').textContent = id8;
        $('receiptTtl').textContent = 'TTL ' + r.ttl;
        $('receiptRoute').textContent = body.senderVpa + ' → ' + body.receiverVpa + ' · ' + inr(body.amount);
        $('receiptDevice').textContent = r.injectedAt;
        $('receiptCipher').textContent = r.ciphertextPreview;

        logEntry('Encrypted <b>' + inr(body.amount) + '</b> ' + esc(body.senderVpa) + ' → ' + esc(body.receiverVpa) +
            ' and injected packet <span class="mono">' + esc(id8) + '</span> at ' + esc(prettyDevice(r.injectedAt)) + ' (TTL ' + r.ttl + ')',
            '', 'ciphertext: ' + r.ciphertextPreview);
        await refresh(true);
        pulseNode(r.injectedAt, color);
        return true;
    }

    async function doGossip() {
        const before = {};
        (state.mesh ? state.mesh.devices : []).forEach((d) => { before[d.deviceId] = new Set(d.packetIds); });
        const r = await post('/api/mesh/gossip');
        const mesh = await api('/api/mesh/state');
        // work out which packet copies moved, so we can animate them
        const flights = [];
        mesh.devices.forEach((d) => d.packetIds.forEach((pid) => {
            if (before[d.deviceId] && before[d.deviceId].has(pid)) return;
            const src = Object.keys(before).find((id) => id !== d.deviceId && before[id].has(pid));
            if (src) flights.push([src, d.deviceId, packetColor(pid)]);
        }));
        flights.slice(0, 24).forEach((f, i) => flyPacket(f[0], f[1], f[2], { delay: i * 35, duration: 750 }));
        logEntry('Gossip round — <b>' + r.transfers + '</b> packet cop' + (r.transfers === 1 ? 'y' : 'ies') + ' exchanged',
            r.transfers ? 'ok' : '',
            r.transfers ? '' : 'Nothing new to share: every device already holds every packet (or the mesh is empty).');
        if (!reduceMotion && flights.length) await sleep(800 + Math.min(flights.length, 24) * 35);
        await refresh(true);
        return r;
    }

    const OUTCOME = {
        SETTLED: { label: 'SETTLED', color: '#0f9d6b' },
        DUPLICATE_DROPPED: { label: 'DUPLICATE', color: '#b7791f' },
        INVALID: { label: 'INVALID', color: '#dc3545' }
    };

    async function doFlush(isReplay) {
        const r = await post('/api/mesh/flush');
        if (!r.uploadsAttempted) {
            logEntry('Bridge upload — no bridge phone is holding any packet yet.', 'warn');
            toast('The bridge phone has nothing to upload yet.<br>Inject a payment and run a gossip round first.', 'warn');
            return r;
        }
        const results = r.results.slice().sort((a, b) => a.packetId.localeCompare(b.packetId));
        const slotUsed = {};
        results.forEach((res, i) => {
            flyPacket(res.bridgeNode, 'backend', packetColor(res.packetId), { delay: i * 160, duration: 900, arc: false })
                .then(() => {
                    const o = OUTCOME[res.outcome] || { label: res.outcome, color: '#64748b' };
                    slotUsed.n = (slotUsed.n || 0) + 1;
                    chipAt('backend', o.label, o.color, (slotUsed.n - 1) % 4);
                    pulseNode('backend', o.color);
                });
        });
        logEntry((isReplay ? 'Replay: ' : '') + '<b>' + r.uploadsAttempted + '</b> bridge upload' + (r.uploadsAttempted === 1 ? '' : 's') + ' sent in parallel');
        results.forEach((res) => {
            const kind = res.outcome === 'SETTLED' ? 'ok' : res.outcome === 'DUPLICATE_DROPPED' ? 'warn' : 'bad';
            logEntry('&nbsp;&nbsp;' + esc(prettyDevice(res.bridgeNode)) + ' · packet <span class="mono">' + esc(res.packetId) + '</span> → <b>' + esc(res.outcome) + '</b>' +
                (res.reason ? ' (' + esc(res.reason) + ')' : ''), kind);
        });

        const counts = { SETTLED: 0, DUPLICATE_DROPPED: 0, INVALID: 0 };
        results.forEach((x) => { counts[x.outcome] = (counts[x.outcome] || 0) + 1; });
        state.lastUpload = results;
        state.uploaded = true;
        if (counts.SETTLED) state.settled = true;
        renderUploads(results);

        const parts = [];
        if (counts.SETTLED) parts.push('<b>' + counts.SETTLED + '</b> settled');
        if (counts.DUPLICATE_DROPPED) parts.push('<b>' + counts.DUPLICATE_DROPPED + '</b> duplicate' + (counts.DUPLICATE_DROPPED > 1 ? 's' : '') + ' dropped');
        if (counts.INVALID) parts.push('<b>' + counts.INVALID + '</b> invalid');
        toast(parts.join(' · '), counts.INVALID ? 'bad' : counts.SETTLED ? 'ok' : 'warn');

        if (!reduceMotion) await sleep(900 + results.length * 160);
        await refresh(true);
        return r;
    }

    function renderUploads(results) {
        const list = $('uploadList');
        const s = results.filter((x) => x.outcome === 'SETTLED').length;
        const d = results.filter((x) => x.outcome === 'DUPLICATE_DROPPED').length;
        const i = results.filter((x) => x.outcome === 'INVALID').length;
        $('uploadsSummary').textContent = results.length + ' upload' + (results.length === 1 ? '' : 's') + ' · ' + s + ' settled · ' + d + ' duplicate · ' + i + ' invalid';
        list.innerHTML = results.map((x) => {
            return '<li><i class="packet-swatch" style="background:' + packetColor(x.packetId) + '"></i>' +
                '<span class="mono">' + esc(x.packetId) + '</span>' +
                '<span class="badge badge-' + esc(x.outcome) + '">' + esc((OUTCOME[x.outcome] || { label: x.outcome }).label) + '</span>' +
                '<span class="u-meta">via ' + esc(prettyDevice(x.bridgeNode)) + (x.reason ? ' · ' + esc(x.reason) : '') +
                (x.transactionId > 0 ? ' · tx #' + esc(x.transactionId) : '') + '</span></li>';
        }).join('');
    }

    async function doReset() {
        await post('/api/mesh/reset');
        state.uploaded = false; state.settled = false; state.lastUpload = null;
        $('receipt').hidden = true;
        $('uploadList').innerHTML = '';
        $('uploadsSummary').textContent = 'No uploads yet';
        logEntry('Mesh and idempotency cache cleared. Balances and the ledger are kept.', 'warn');
        await refresh(true);
    }

    async function doForge() {
        const bytes = new Uint8Array(320);
        crypto.getRandomValues(bytes);
        let bin = '';
        bytes.forEach((b) => { bin += String.fromCharCode(b); });
        const packet = { packetId: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()), ttl: 5, createdAt: Date.now(), ciphertext: btoa(bin) };
        const r = await post('/api/bridge/ingest', packet, { 'X-Bridge-Node-Id': 'attacker', 'X-Hop-Count': '0' });
        const refused = r.outcome !== 'SETTLED';
        logEntry('Forged packet posted by <b>attacker</b> → <b>' + esc(r.outcome) + '</b>' + (r.reason ? ' (' + esc(r.reason) + ')' : ''),
            refused ? 'ok' : 'bad', 'hash: ' + r.packetHash);
        toast(refused ? '<b>Forgery refused</b><br>' + esc(r.reason || r.outcome) + ' — the ledger is untouched.'
                      : '<b>Forgery was accepted?!</b>', refused ? 'ok' : 'bad');
        const o = OUTCOME[r.outcome] || { label: r.outcome, color: '#64748b' };
        chipAt('backend', o.label, o.color, 0);
        pulseNode('backend', o.color);
        await refresh(true);
    }

    // run an async action with UI locking + error handling
    async function guarded(btn, fn) {
        if (state.busy) return;
        lockUi(true);
        if (btn) btn.classList.add('is-loading');
        try {
            await fn();
        } catch (e) {
            logEntry('Request failed — ' + esc(e.message), 'bad');
            toast('Request failed.<br>' + esc(e.message), 'bad');
        } finally {
            if (btn) btn.classList.remove('is-loading');
            lockUi(false);
            renderStepper();
        }
    }

    async function fullJourney() {
        logEntry('<b>Full journey</b> started — compose, gossip ×2, bridge upload');
        if (!(await doSend())) return;
        await sleep(reduceMotion ? 0 : 700);
        await doGossip();
        await sleep(reduceMotion ? 0 : 400);
        await doGossip();
        await sleep(reduceMotion ? 0 : 400);
        await doFlush(false);
    }

    // ------------------------------------------------------------------- theme
    function currentTheme() {
        const t = document.documentElement.getAttribute('data-theme');
        if (t) return t;
        return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }

    // -------------------------------------------------------------------- init
    function init() {
        resetLog();

        $('composeForm').addEventListener('submit', (e) => { e.preventDefault(); guarded($('sendBtn'), doSend); });
        $('gossipBtn').addEventListener('click', () => guarded($('gossipBtn'), doGossip));
        $('flushBtn').addEventListener('click', () => guarded($('flushBtn'), () => doFlush(false)));
        $('autoBtn').addEventListener('click', () => guarded($('autoBtn'), fullJourney));
        $('resetBtn').addEventListener('click', () => guarded($('resetBtn'), doReset));
        $('forgeBtn').addEventListener('click', () => guarded($('forgeBtn'), doForge));
        $('replayBtn').addEventListener('click', () => guarded($('replayBtn'), () => doFlush(true)));
        $('clearLogBtn').addEventListener('click', resetLog);
        $('replayBtn').disabled = true;

        ['senderVpa', 'receiverVpa', 'amount', 'pin'].forEach((id) => $(id).addEventListener('input', updateHints));
        $('senderVpa').addEventListener('change', updateHints);
        $('receiverVpa').addEventListener('change', updateHints);
        $('swapBtn').addEventListener('click', () => {
            const s = $('senderVpa'), r = $('receiverVpa');
            const t = s.value; s.value = r.value; r.value = t;
            updateHints();
        });
        document.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', () => {
            $('amount').value = c.dataset.amount;
            updateHints();
        }));
        $('pin').addEventListener('input', () => { $('pin').value = $('pin').value.replace(/\D/g, '').slice(0, 4); });

        $('themeToggle').addEventListener('click', () => {
            const next = currentTheme() === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('upimesh-theme', next); } catch (e) { /* storage may be blocked */ }
        });

        api('/api/server-key').then((k) => {
            $('cryptoText').textContent = String(k.algorithm || '').replace(/\s*\/\s*/g, ' · ');
            $('cryptoPill').title = k.hybridScheme || '';
        }).catch(() => {});

        refresh(true);
        setInterval(() => { if (!document.hidden) refresh(false); }, 3000);
        document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
    }

    init();
})();
