'use strict';
// Netlify build step: bakes the address of your SunFlix server into the hosted web app.
// Set SUNFLIX_SERVER in the Netlify site's environment variables, e.g. https://sunflix.example.com
const fs = require('node:fs');
const path = require('node:path');

const raw = (process.env.SUNFLIX_SERVER || '').trim().replace(/\/+$/, '');
let url;
try { url = new URL(raw); } catch { url = null; }
if (!url || url.protocol !== 'https:') {
  console.error('Set SUNFLIX_SERVER to the https:// address of your SunFlix server (Site settings > Environment variables).');
  console.error('It has to be https: browsers refuse to let an https page load video from a plain http server.');
  process.exit(1);
}
const out = path.join(__dirname, '..', 'public', 'config.js');
fs.writeFileSync(out, `window.SUNFLIX_SERVER = ${JSON.stringify(url.origin)};\n`);
console.log(`SunFlix web app will use the server at ${url.origin}`);
