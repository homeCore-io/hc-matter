// What hc-matter's screen works out, kept apart from the drawing so it can be
// tested with node --test (ui/test/).

import qrcode from './qrcode.mjs';

/** A manual pairing code the way Matter prints it: 4-3-4, or 4-3-4-5-5. */
export function formatManualCode(code) {
	const d = String(code ?? '').replace(/\D/g, '');
	if (d.length === 11) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7)}`;
	if (d.length === 21) return `${d.slice(0, 4)}-${d.slice(4, 7)}-${d.slice(7, 11)}-${d.slice(11, 16)}-${d.slice(16)}`;
	return d;
}

/** Whether text can be a setup code, before asking the plugin. */
export function looksLikeCode(text) {
	const t = String(text ?? '').trim();
	if (/^MT:[0-9A-Z.\-]+$/.test(t)) return true;
	const d = t.replace(/[\s-]/g, '');
	return /^\d{11}$/.test(d) || /^\d{21}$/.test(d);
}

/**
 * A QR code as an SVG string, in currentColor so it follows the theme, with
 * the quiet zone scanners need. Matter's `MT:` text is all QR alphanumeric
 * characters, which keeps the code small.
 */
export function qrSvg(text, { size = 200 } = {}) {
	const qr = qrcode(0, 'M');
	qr.addData(text, /^[0-9A-Z $%*+\-./:]+$/.test(text) ? 'Alphanumeric' : 'Byte');
	qr.make();
	const n = qr.getModuleCount();
	const quiet = 4;
	const total = n + quiet * 2;
	let path = '';
	for (let r = 0; r < n; r++) {
		for (let c = 0; c < n; c++) {
			if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
		}
	}
	// A light ground of its own: a dark-on-dark code does not scan.
	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${size}" height="${size}" role="img" aria-label="QR code" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}

/** "14:59" left of a window that closes at `until` (ms). */
export function timeLeft(until, now = Date.now()) {
	const s = Math.max(0, Math.round((until - now) / 1000));
	return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A pairing run, folded from its stream events: what to show while it goes. */
export function pairingView(events) {
	const view = { running: true, percent: 0, message: '', devices: [], error: null, done: false };
	for (const e of events) {
		if (e.stage === 'progress') {
			if (typeof e.percent === 'number') view.percent = e.percent;
			if (e.message) view.message = e.message;
		} else if (e.stage === 'item' && e.data && (e.op ?? 'add') === 'add') {
			if (!view.devices.some((d) => d.id === e.data.id)) view.devices.push(e.data);
		} else if (e.stage === 'complete') {
			view.running = false;
			view.done = true;
			view.percent = 100;
			view.message = view.devices.length ? `Paired: ${view.devices.length} device${view.devices.length === 1 ? '' : 's'}` : 'Paired';
		} else if (['error', 'timeout', 'canceled', 'busy'].includes(e.stage)) {
			view.running = false;
			view.error = e.stage === 'timeout' ? 'Pairing took too long and was stopped.'
				: e.stage === 'canceled' ? 'Pairing was stopped.'
				: e.stage === 'busy' ? 'Another pairing is already running.'
				: e.message || 'Pairing failed.';
		}
	}
	return view;
}

/** Words for a firmware update in progress, or null when none is. */
export function updateWords(node) {
	const s = node.update_state;
	if (!s || s === 'idle' || s === 'unknown') return null;
	const pct = typeof node.update_percent === 'number' ? ` ${node.update_percent}%` : '';
	return {
		querying: 'Checking for firmware',
		downloading: `Downloading firmware${pct}`,
		applying: 'Installing firmware',
		rolling_back: 'Rolling back firmware',
	}[s] ?? `Firmware: ${s.replace(/_/g, ' ')}`;
}
