// hc-matter's screen needs no bundler: its modules are written as they ship.
// "Building" copies them, the QR encoder (qrcode-generator, MIT) and the
// manifest into dist/, which the plugin serves and the release carries. The
// encoder's copyright and MIT notice are in its own header.
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist');
cpSync('src', 'dist', { recursive: true });
cpSync('public', 'dist', { recursive: true });
cpSync('node_modules/qrcode-generator/dist/qrcode.mjs', 'dist/qrcode.mjs');
console.log('built dist/');
