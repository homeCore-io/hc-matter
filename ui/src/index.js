// hc-matter's page (plugin.page): pair a device, see what is paired, share a
// device to another app, and the rest of looking after Matter devices.
//
// Everything goes through the plugin's own actions (src/admin.ts in the
// plugin) via `host` (core/sdk/ui/index.d.ts): nothing here talks Matter.

import { filterCandidates, formatManualCode, looksLikeCode, pairingView, qrSvg, timeLeft, updateWords, vendorName } from './lib.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:host { display: block; }
.stack { display: grid; gap: 16px; }
.hc-card { padding: 16px; }
.hc-card h3 { margin: 0 0 8px; }
p { margin: 4px 0; }
.quiet { color: var(--ink-muted); font-size: 14px; }
.bar { height: 6px; border-radius: 3px; background: var(--line); overflow: hidden; margin: 8px 0; }
.bar > span { display: block; height: 100%; background: var(--accent); transition: width .3s; }
.node { border-top: 1px solid var(--line); padding: 12px 0; display: grid; gap: 8px; }
.node:first-of-type { border-top: none; }
.node-head { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.node-head strong { font-size: 16px; }
.devices { display: flex; flex-wrap: wrap; gap: 6px; }
.devices button { font: inherit; font-size: 13px; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 999px; padding: 3px 10px; cursor: pointer; }
.share { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; padding: 12px; border-radius: var(--radius, 12px); background: var(--surface-2); }
.share svg { border-radius: 8px; flex: none; }
.code { font-family: var(--font-num, ui-monospace, monospace); font-size: 22px; letter-spacing: .04em; user-select: all; }
.mt { font-family: ui-monospace, monospace; font-size: 12px; word-break: break-all; user-select: all; }
.error { color: var(--alert); }
form.hc-row > .hc-field { flex: 1 1 220px; }
details summary { cursor: pointer; font-weight: 600; }
table.hc-table { width: 100%; }
`;

class MatterPage extends HTMLElement {
	#host;
	#stopDevices;
	#nodes = [];
	#status = null;
	#pair = null;
	#share = new Map(); // node_id → { manual_code, qr_code, until }
	#fabrics = new Map(); // node_id → fabrics | 'loading' | { error }
	#notes = new Map(); // node_id → a line to show under it
	#busy = new Set();
	#tick;
	#refreshing = null;
	#bridge = null;
	#candidates = [];
	#bridgeNote = null;
	#bridgeBusy = false;

	constructor() {
		super();
		this.attachShadow({ mode: 'open' });
	}

	set host(h) {
		if (this.#host === h) return;
		this.#host = h;
		const own = new CSSStyleSheet();
		own.replaceSync(STYLE);
		this.shadowRoot.adoptedStyleSheets = [h.theme.sheet, own];
		this.#skeleton();
		this.#stopDevices?.();
		// A device's name or availability changed: the node list shows both.
		this.#stopDevices = h.devices.subscribe(() => this.#refreshSoon());
		this.#refresh();
	}
	get host() {
		return this.#host;
	}

	connectedCallback() {
		this.#tick = setInterval(() => this.#tickShares(), 1000);
	}
	disconnectedCallback() {
		clearInterval(this.#tick);
		this.#stopDevices?.();
		this.#stopDevices = undefined;
	}

	// ── Data ─────────────────────────────────────────────────────────────

	async #refresh() {
		const h = this.#host;
		const [status, nodes] = await Promise.all([h.action('server_status'), h.action('nodes')]);
		this.#status = status.ok ? status.data : { connected: false, error: status.error };
		if (nodes.ok) this.#nodes = nodes.data.nodes ?? [];
		this.#drawStatus();
		this.#drawNodes();
		await this.#refreshBridge();
	}

	async #refreshBridge() {
		const h = this.#host;
		const b = await h.action('bridge_status');
		this.#bridge = b.ok ? b.data : { error: b.error };
		if (this.#bridge?.enabled) {
			const c = await h.action('bridge_devices');
			if (c.ok) {
				this.#candidates = c.data.devices ?? [];
				this.#bridgeNote = c.data.note ?? null;
			}
		} else {
			this.#candidates = [];
		}
		this.#drawBridge();
	}

	#refreshSoon() {
		if (this.#refreshing) return;
		this.#refreshing = setTimeout(() => {
			this.#refreshing = null;
			this.#refresh();
		}, 400);
	}

	// ── Drawing ──────────────────────────────────────────────────────────

	#skeleton() {
		this.shadowRoot.innerHTML = `
			<div class="stack">
				<section class="hc-card" id="status"></section>
				<section class="hc-card">
					<h3>Pair a device</h3>
					<p class="quiet">Enter the device's setup code: the text under its QR code, or the code another app shows when you share the device from it (Apple Home: <em>Turn On Pairing Mode</em>; Google Home: <em>Linked Matter apps &amp; services</em>; Alexa: <em>Other assistants and apps</em>).</p>
					<form class="hc-row" id="pair-form">
						<label class="hc-field"><span class="hc-label">Setup code</span>
							<input name="code" autocomplete="off" spellcheck="false" placeholder="3497-011-2332 or MT:…" /></label>
						<button class="hc-pill go" type="submit">Pair</button>
					</form>
					<div id="pair"></div>
				</section>
				<section class="hc-card">
					<div class="hc-head"><h3>Paired devices</h3><span class="hc-quiet" id="count"></span></div>
					<div id="nodes"></div>
				</section>
				<section class="hc-card">
					<h3>Share with other apps</h3>
					<p class="quiet">Show homeCore devices to Apple Home, Google Home, Alexa or another Matter app, through one bridge they pair. Only the devices you choose.</p>
					<div id="bridge-head"></div>
					<div id="bridge-list" hidden>
						<label class="hc-field"><span class="hc-label">Find a device</span><input id="bridge-find" autocomplete="off" placeholder="Name or kind" /></label>
						<div id="bridge-rows"></div>
					</div>
				</section>
				<section class="hc-card">
					<details>
						<summary>Networks for new devices</summary>
						<p class="quiet">Only for a device that is not on your network yet. A device shared from another app, or already on Wi-Fi or Thread, needs neither.</p>
						<form class="hc-row" id="wifi-form">
							<label class="hc-field"><span class="hc-label">Wi-Fi network</span><input name="ssid" autocomplete="off" /></label>
							<label class="hc-field"><span class="hc-label">Password</span><input name="password" type="password" autocomplete="new-password" /></label>
							<button class="hc-pill" type="submit">Save Wi-Fi</button>
						</form>
						<form class="hc-row" id="thread-form">
							<label class="hc-field"><span class="hc-label">Thread dataset (hex, from your border router)</span><input name="dataset" type="password" autocomplete="off" spellcheck="false" /></label>
							<button class="hc-pill" type="submit">Save Thread</button>
						</form>
						<p class="quiet" id="net-note"></p>
					</details>
				</section>
			</div>`;
		const $ = (id) => this.shadowRoot.getElementById(id);
		$('pair-form').addEventListener('submit', (e) => {
			e.preventDefault();
			this.#startPair(e.target.code.value);
		});
		$('wifi-form').addEventListener('submit', (e) => {
			e.preventDefault();
			const f = e.target;
			this.#saveNetwork('set_wifi', { ssid: f.ssid.value.trim(), password: f.password.value }, f, 'Wi-Fi saved.');
		});
		$('thread-form').addEventListener('submit', (e) => {
			e.preventDefault();
			const f = e.target;
			this.#saveNetwork('set_thread_dataset', { dataset: f.dataset.value.trim() }, f, 'Thread dataset saved.');
		});
		$('nodes').addEventListener('click', (e) => this.#onNodeClick(e));
		$('bridge-head').addEventListener('click', (e) => this.#onBridgeClick(e));
		$('bridge-rows').addEventListener('click', (e) => this.#onBridgeClick(e));
		$('bridge-find').addEventListener('input', () => this.#drawBridgeRows());
	}

	#drawStatus() {
		const s = this.#status;
		const el = this.shadowRoot.getElementById('status');
		if (!el) return;
		if (!s?.connected) {
			el.innerHTML = `<div class="hc-row"><span class="hc-dot ${s?.problem === 'failing' ? 'bad' : 'warn'}"></span>
				<strong>${s?.problem === 'failing' ? 'The Matter server keeps stopping' : 'The Matter server is starting'}</strong></div>
				<p class="quiet">${esc(s?.error ?? (s?.problem === 'failing' ? "See the plugin's log, and its notices above." : 'This takes a few seconds.'))}</p>`;
			return;
		}
		const tags = [
			`<span class="hc-tag ${s.wifi_credentials_set ? 'good' : ''}">Wi-Fi ${s.wifi_credentials_set ? 'set' : 'not set'}</span>`,
			`<span class="hc-tag ${s.thread_credentials_set ? 'good' : ''}">Thread ${s.thread_credentials_set ? 'set' : 'not set'}</span>`,
			s.allow_test_devices ? '<span class="hc-tag warn">Test devices allowed</span>' : '',
		].join(' ');
		el.innerHTML = `<div class="hc-row"><span class="hc-dot good"></span><strong>Matter is running</strong>
			<span class="quiet">${esc(s.version)}</span></div><div class="hc-row">${tags}</div>`;
	}

	#drawPair() {
		const el = this.shadowRoot.getElementById('pair');
		const v = this.#pair && pairingView(this.#pair);
		if (!v) {
			el.innerHTML = '';
			return;
		}
		const devices = v.devices.map((d) => `<button data-open="${esc(d.id)}">${esc(d.name)}</button>`).join('');
		el.innerHTML = `
			${v.running || v.done ? `<div class="bar"><span style="width:${v.percent}%"></span></div>` : ''}
			<p class="${v.error ? 'error' : ''}">${esc(v.error ?? v.message)}</p>
			${devices ? `<div class="devices">${devices}</div>` : ''}`;
		el.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => this.#host.ui.openDevice(b.dataset.open)));
		this.shadowRoot.querySelector('#pair-form button').disabled = v.running;
	}

	#drawNodes() {
		const el = this.shadowRoot.getElementById('nodes');
		const count = this.shadowRoot.getElementById('count');
		if (!el) return;
		count.textContent = this.#nodes.length ? String(this.#nodes.length) : '';
		if (!this.#nodes.length) {
			el.innerHTML = '<p class="quiet">Nothing paired yet.</p>';
			return;
		}
		el.innerHTML = this.#nodes.map((n) => this.#nodeHtml(n)).join('');
	}

	#nodeHtml(n) {
		const id = esc(n.node_id);
		const busy = this.#busy.has(n.node_id);
		const what = [n.vendor, n.product !== n.name ? n.product : null, n.firmware ? `firmware ${n.firmware}` : null].filter(Boolean).map(esc).join(' · ');
		const devices = n.devices
			.map((d) => `<button data-open="${esc(d.id)}" title="${esc(d.type)}">${d.available ? '' : '⚠ '}${esc(this.#deviceLabel(d))}</button>`)
			.join('');
		const share = this.#share.get(n.node_id);
		const fabrics = this.#fabrics.get(n.node_id);
		const update = updateWords(n);
		const note = this.#notes.get(n.node_id);
		return `<div class="node" data-node="${id}">
			<div class="node-head">
				<span class="hc-dot ${n.available ? 'good' : 'bad'}" title="${n.available ? 'Answering' : 'Not answering'}"></span>
				<strong>${esc(n.name)}</strong>
				${n.is_bridge ? '<span class="hc-tag">Bridge</span>' : ''}
				${n.available ? '' : '<span class="hc-tag bad">Not answering</span>'}
				${update ? `<span class="hc-tag warn">${esc(update)}</span>` : ''}
			</div>
			${what ? `<p class="quiet">${what}</p>` : ''}
			${devices ? `<div class="devices">${devices}</div>` : ''}
			<div class="hc-row">
				<button class="hc-pill" data-do="share" ${busy || !n.available ? 'disabled' : ''}>Share</button>
				<button class="hc-pill" data-do="fabrics" ${busy || !n.available ? 'disabled' : ''}>Shared with</button>
				<button class="hc-pill" data-do="update" ${busy || !n.available ? 'disabled' : ''}>Check firmware</button>
				<button class="hc-pill" data-do="reinterview" ${busy || !n.available ? 'disabled' : ''}>Read again</button>
				<button class="hc-pill danger" data-do="remove" ${busy ? 'disabled' : ''}>Remove</button>
			</div>
			${note ? `<p class="${note.error ? 'error' : 'quiet'}">${esc(note.text)}</p>` : ''}
			${share ? this.#shareHtml(n, share) : ''}
			${fabrics ? this.#fabricsHtml(n, fabrics) : ''}
		</div>`;
	}

	#deviceLabel(d) {
		const live = this.#host.devices.get?.(d.id);
		return live ? this.#host.devices.label(live) : d.name;
	}

	#shareHtml(n, s) {
		return `<div class="share" data-share="${esc(n.node_id)}">
			${qrSvg(s.qr_code, { size: 168 })}
			<div>
				<p><strong>Add ${esc(n.name)} in the other app</strong></p>
				<p class="quiet">Choose to add a Matter device there and scan this code, or type:</p>
				<p class="code">${esc(formatManualCode(s.manual_code))}</p>
				<p class="mt">${esc(s.qr_code)}</p>
				<p class="quiet">Open for <span data-left>${timeLeft(s.until)}</span>. It stays in homeCore either way.</p>
			</div>
		</div>`;
	}

	#fabricsHtml(n, f) {
		if (f === 'loading') return '<p class="quiet">Asking the device…</p>';
		if (f.error) return `<p class="error">${esc(f.error)}</p>`;
		const rows = f
			.map((x) => `<tr>
				<td>${esc(x.this_controller ? 'homeCore (this one)' : (x.vendor ?? x.label ?? `Controller ${x.vendor_id ?? ''}`))}</td>
				<td class="quiet">${esc(x.label ?? '')}</td>
				<td>${x.this_controller ? '' : `<button class="hc-pill danger" data-do="unshare" data-fabric="${x.fabric_index}">Remove</button>`}</td>
			</tr>`)
			.join('');
		return `<table class="hc-table"><thead><tr><th>Paired with</th><th>Label</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
	}

	#drawBridge() {
		const head = this.shadowRoot.getElementById('bridge-head');
		const list = this.shadowRoot.getElementById('bridge-list');
		if (!head) return;
		const b = this.#bridge;
		const busy = this.#bridgeBusy ? 'disabled' : '';
		// No answer at all (the request failed), as against a bridge reporting a problem.
		if (!b || b.enabled === undefined) {
			head.innerHTML = `<p class="error">${esc(b?.error ?? 'The bridge did not answer.')}</p>`;
			list.hidden = true;
			return;
		}
		const problem = b.error ? `<p class="error">${esc(b.error)}</p>` : '';
		if (!b.enabled) {
			head.innerHTML = `<button class="hc-pill go" data-bridge="on" ${busy}>Turn on</button>`;
			list.hidden = true;
			return;
		}
		let pairing;
		if (!b.running) {
			pairing = b.error ? '' : '<p class="quiet">Starting…</p>';
		} else if (!b.commissioned && b.qr_code) {
			pairing = `<div class="share">${qrSvg(b.qr_code, { size: 168 })}<div>
				<p><strong>Pair homeCore in your other app</strong></p>
				<p class="quiet">Add a Matter device there and scan this code, or type:</p>
				<p class="code">${esc(formatManualCode(b.manual_code))}</p>
				<p class="quiet">It is not a certified Matter product, so the app may warn you before adding it.</p>
			</div></div>`;
		} else {
			const apps = (b.fabrics ?? []).map((f) => `<span class="hc-tag good">${esc(vendorName(f.vendor_id, f.label))}</span>`).join(' ');
			pairing = `<div class="hc-row"><span class="hc-dot good"></span><strong>Paired with</strong> ${apps || '—'}</div>
				<p class="quiet">To add it to another app too, share "homeCore" from the app it is in (as for any Matter device).</p>`;
		}
		const note = b.has_access && !b.following_homecore ? '<p class="quiet">Connecting to homeCore…</p>' : '';
		head.innerHTML = `${problem}${pairing}${note}
			<div class="hc-row">
				<span class="quiet">${b.shared} shared</span>
				<button class="hc-pill danger" data-bridge="reset" ${busy}>Reset</button>
				<button class="hc-pill" data-bridge="off" ${busy}>Turn off</button>
			</div>`;
		list.hidden = false;
		this.#drawBridgeRows();
	}

	#drawBridgeRows() {
		const rows = this.shadowRoot.getElementById('bridge-rows');
		if (!rows) return;
		if (this.#bridgeNote) {
			rows.innerHTML = `<p class="quiet">${esc(this.#bridgeNote)}</p>`;
			return;
		}
		const find = this.shadowRoot.getElementById('bridge-find').value;
		const all = filterCandidates(this.#candidates, find);
		const can = all.filter((c) => c.can_share);
		const cannot = all.filter((c) => !c.can_share);
		const row = (c) => `<tr>
			<td>${esc(c.name)}${c.available ? '' : ' <span class="hc-tag bad">offline</span>'}${c.needs_confirm ? ' <span class="hc-tag warn">security</span>' : ''}</td>
			<td class="quiet">${esc(c.shows_as)}</td>
			<td><button class="hc-pill ${c.shared ? '' : 'go'}" data-share="${esc(c.device_id)}" data-on="${c.shared ? '0' : '1'}" ${this.#bridgeBusy ? 'disabled' : ''}>${c.shared ? 'Stop sharing' : 'Share'}</button></td>
		</tr>`;
		rows.innerHTML = `
			${can.length ? `<table class="hc-table"><thead><tr><th>Device</th><th>Shows as</th><th></th></tr></thead><tbody>${can.map(row).join('')}</tbody></table>` : '<p class="quiet">No device matches.</p>'}
			${cannot.length ? `<details><summary>${cannot.length} can't be shared</summary><table class="hc-table"><tbody>${cannot.map((c) => `<tr><td>${esc(c.name)}</td><td class="quiet">${esc(c.reason)}</td></tr>`).join('')}</tbody></table></details>` : ''}`;
	}

	async #onBridgeClick(e) {
		const h = this.#host;
		const act = e.target.closest('[data-bridge]')?.dataset.bridge;
		const shareBtn = e.target.closest('[data-share]');
		if (!act && !shareBtn) return;
		let action;
		let params = {};
		if (act === 'on' || act === 'off') {
			action = 'bridge_enable';
			params = { on: act === 'on' };
		} else if (act === 'reset') {
			const ok = await h.ui.confirm({
				title: 'Reset the bridge?',
				body: 'Every app it is paired with loses homeCore\'s devices, and it gets a new pairing code. The devices it shares stay chosen.',
				go: 'Reset',
				danger: true,
			});
			if (!ok) return;
			action = 'bridge_reset';
		} else {
			const id = shareBtn.dataset.share;
			const on = shareBtn.dataset.on === '1';
			const c = this.#candidates.find((x) => x.device_id === id);
			params = { device_id: id, shared: on };
			if (on && c?.needs_confirm) {
				const ok = await h.ui.confirm({
					title: `Share ${c.name} with other apps?`,
					body: 'Anyone who can use an app the bridge is paired with, and its voice assistant, could then unlock or open it, without homeCore asking.',
					go: 'Share it',
					danger: true,
				});
				if (!ok) return;
				params.confirm_security = true;
			}
			action = 'bridge_share';
		}
		this.#bridgeBusy = true;
		this.#drawBridge();
		const r = await h.action(action, params);
		this.#bridgeBusy = false;
		if (!r.ok) {
			this.#bridge = { ...this.#bridge };
			this.#drawBridge();
			this.shadowRoot.getElementById('bridge-head').insertAdjacentHTML('beforeend', `<p class="error">${esc(r.error)}</p>`);
			return;
		}
		await this.#refreshBridge();
	}

	#tickShares() {
		const now = Date.now();
		let expired = false;
		for (const [id, s] of this.#share) {
			if (s.until <= now) {
				this.#share.delete(id);
				expired = true;
				continue;
			}
			const left = this.shadowRoot.querySelector(`[data-share="${CSS.escape(id)}"] [data-left]`);
			if (left) left.textContent = timeLeft(s.until, now);
		}
		if (expired) this.#drawNodes();
	}

	// ── Doing ────────────────────────────────────────────────────────────

	#startPair(code) {
		const h = this.#host;
		if (!looksLikeCode(code)) {
			this.#pair = [{ stage: 'error', message: 'That is not a Matter setup code: the text of its QR code (MT:…) or 11 or 21 digits.' }];
			return this.#drawPair();
		}
		if (typeof h.stream !== 'function') {
			this.#pair = [{ stage: 'error', message: 'Pairing here needs a newer homeCore app.' }];
			return this.#drawPair();
		}
		this.#pair = [{ stage: 'progress', percent: 2, message: 'Starting' }];
		this.#drawPair();
		const run = h.stream('pair', { code: code.trim() }, (e) => {
			this.#pair.push(e);
			this.#drawPair();
		});
		run.done.then((end) => {
			if (end.stage === 'complete') this.shadowRoot.querySelector('#pair-form').reset();
			this.#refresh();
		});
	}

	async #saveNetwork(action, params, form, said) {
		const note = this.shadowRoot.getElementById('net-note');
		const r = await this.#host.action(action, params);
		note.textContent = r.ok ? said : r.error;
		note.className = r.ok ? 'quiet' : 'error';
		if (r.ok) {
			form.reset();
			this.#refresh();
		}
	}

	async #onNodeClick(e) {
		const open = e.target.closest('[data-open]');
		if (open) return this.#host.ui.openDevice(open.dataset.open);
		const btn = e.target.closest('[data-do]');
		const nodeEl = e.target.closest('[data-node]');
		if (!btn || !nodeEl) return;
		const nodeId = nodeEl.dataset.node;
		const n = this.#nodes.find((x) => x.node_id === nodeId);
		if (!n) return;
		const h = this.#host;
		const run = async (action, params, after) => {
			this.#busy.add(nodeId);
			this.#notes.delete(nodeId);
			this.#drawNodes();
			const r = await h.action(action, { node_id: nodeId, ...params });
			this.#busy.delete(nodeId);
			if (!r.ok) this.#notes.set(nodeId, { error: true, text: r.error });
			else after?.(r.data);
			this.#drawNodes();
			return r;
		};
		switch (btn.dataset.do) {
			case 'share':
				if (this.#share.has(nodeId)) {
					this.#share.delete(nodeId);
					return this.#drawNodes();
				}
				return run('share_node', {}, (d) =>
					this.#share.set(nodeId, { ...d, until: Date.now() + (d.expires_in_secs ?? 900) * 1000 })
				);
			case 'fabrics':
				if (this.#fabrics.has(nodeId)) {
					this.#fabrics.delete(nodeId);
					return this.#drawNodes();
				}
				this.#fabrics.set(nodeId, 'loading');
				return run('fabrics', {}, (d) => this.#fabrics.set(nodeId, d.fabrics ?? [])).then((r) => {
					if (!r.ok) this.#fabrics.set(nodeId, { error: r.error });
					this.#drawNodes();
				});
			case 'unshare': {
				const fabric = Number(btn.dataset.fabric);
				const f = this.#fabrics.get(nodeId);
				const who = Array.isArray(f) ? f.find((x) => x.fabric_index === fabric) : null;
				const ok = await h.ui.confirm({
					title: `Unshare ${n.name}?`,
					body: `${who?.vendor ?? who?.label ?? 'That app'} will no longer be able to reach it. homeCore keeps it.`,
					go: 'Unshare',
					danger: true,
				});
				if (!ok) return;
				return run('remove_fabric', { fabric_index: fabric }, () => {
					this.#fabrics.delete(nodeId);
					this.#notes.set(nodeId, { text: 'Unshared.' });
				});
			}
			case 'update':
				return run('check_update', {}, async (d) => {
					if (!d.available) return this.#notes.set(nodeId, { text: 'Its firmware is up to date.' });
					const ok = await h.ui.confirm({
						title: `Update ${n.name} to ${d.version_string}?`,
						body: 'It keeps working while the update downloads, and restarts at the end.',
						go: 'Update',
					});
					if (!ok) return this.#notes.set(nodeId, { text: `Firmware ${d.version_string} is available.` });
					const r = await h.action('update_firmware', { node_id: nodeId, version: d.version });
					this.#notes.set(nodeId, r.ok ? { text: `Updating to ${d.version_string}.` } : { error: true, text: r.error });
					this.#drawNodes();
				});
			case 'reinterview':
				return run('reinterview', {}, () => {
					this.#notes.set(nodeId, { text: 'Read again.' });
					this.#refresh();
				});
			case 'remove': {
				const ok = await h.ui.confirm({
					title: `Remove ${n.name}?`,
					body: 'It is taken out of homeCore and off this controller. Apps it is shared with keep it.',
					lost: n.devices.map((d) => this.#deviceLabel(d)),
					go: 'Remove',
					danger: true,
				});
				if (!ok) return;
				return run('remove_node', {}, () => {
					this.#share.delete(nodeId);
					this.#fabrics.delete(nodeId);
					this.#refresh();
				});
			}
		}
	}
}

customElements.define('hc-matter-page', MatterPage);
