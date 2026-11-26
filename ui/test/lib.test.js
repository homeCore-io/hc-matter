// The screen's logic, on the built modules (npm run build first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatManualCode, looksLikeCode, pairingView, qrSvg, timeLeft, updateWords } from '../dist/lib.js';

test('prints manual codes the way Matter does', () => {
	assert.equal(formatManualCode('34970112332'), '3497-011-2332');
	assert.equal(formatManualCode('749701123365521327694'), '7497-011-2336-55213-27694');
});

test('knows a setup code when it sees one', () => {
	assert.ok(looksLikeCode('MT:Y.K90AFN00KA0648G00'));
	assert.ok(looksLikeCode('3497-011-2332'));
	assert.ok(!looksLikeCode('hello'));
	assert.ok(!looksLikeCode('1234'));
});

test('draws a QR code with a light ground and a quiet zone', () => {
	const svg = qrSvg('MT:Y.K90AFN00KA0648G00');
	assert.match(svg, /^<svg /);
	assert.match(svg, /fill="#fff"/);
	// Version 2 (25 modules) for this text at level M, plus 4 on each side.
	assert.match(svg, /viewBox="0 0 33 33"/);
});

test('follows a pairing run to its end', () => {
	const v = pairingView([
		{ stage: 'progress', percent: 5, message: 'Looking for the device on the network' },
		{ stage: 'item', op: 'add', data: { id: 'a', name: 'Lamp' } },
		{ stage: 'item', op: 'add', data: { id: 'a', name: 'Lamp' } },
		{ stage: 'complete', data: {} },
	]);
	assert.deepEqual([v.running, v.done, v.devices.length, v.message], [false, true, 1, 'Paired: 1 device']);
	assert.equal(pairingView([{ stage: 'error', message: 'No device answered.' }]).error, 'No device answered.');
	assert.equal(pairingView([{ stage: 'busy' }]).error, 'Another pairing is already running.');
});

test('counts down a share window, and words a firmware update', () => {
	assert.equal(timeLeft(1_000_000 + 899_400, 1_000_000), '14:59');
	assert.equal(timeLeft(0, 1), '0:00');
	assert.equal(updateWords({ update_state: 'downloading', update_percent: 40 }), 'Downloading firmware 40%');
	assert.equal(updateWords({ update_state: 'idle' }), null);
});
