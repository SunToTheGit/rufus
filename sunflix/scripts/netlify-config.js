'use strict';
// Netlify build step: writes public/config.js from the site's environment variables.
//
//   SUNFLIX_MEDIA_URL  the public address of your storage bucket. The site is then a plain
//                      website: videos are added on /admin.html and live in the bucket.
//   SUNFLIX_SERVER     the https address of a SunFlix server you run yourself. The site is
//                      then just the pages, and everything else comes from that server.
const fs = require('node:fs');
const path = require('node:path');

function httpsOrigin(name, keepPath) {
  const raw = (process.env[name] || '').trim().replace(/\/+$/, '');
  if (!raw) return null;
  let url;
  try { url = new URL(raw); } catch { url = null; }
  if (!url || url.protocol !== 'https:') {
    console.error(`${name} has to be an https:// address. Browsers refuse to load video over plain http on an https site.`);
    process.exit(1);
  }
  return keepPath ? raw : url.origin;
}

const media = httpsOrigin('SUNFLIX_MEDIA_URL', true);
const server = httpsOrigin('SUNFLIX_SERVER', false);
let lines;
if (media) {
  lines = ['window.SUNFLIX_STATIC = true;', `window.SUNFLIX_MEDIA = ${JSON.stringify(media)};`, "window.SUNFLIX_LIBRARY = '/api/library';", 'window.SUNFLIX_ADMIN = true;'];
  console.log(`SunFlix will run as a plain website, with videos in the bucket at ${media}`);
  const needed = ['SUNFLIX_ADMIN_PASSWORD', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((n) => !process.env[n]);
  if (!process.env.R2_ACCOUNT_ID && !process.env.S3_ENDPOINT) needed.push('R2_ACCOUNT_ID');
  if (needed.length) console.warn(`Uploading will not work until these are set too: ${needed.join(', ')}`);
} else if (server) {
  lines = [`window.SUNFLIX_SERVER = ${JSON.stringify(server)};`];
  console.log(`SunFlix web app will use the server at ${server}`);
} else {
  console.error('Set SUNFLIX_MEDIA_URL (videos in a storage bucket) or SUNFLIX_SERVER (your own SunFlix server) in Site settings > Environment variables.');
  process.exit(1);
}
fs.writeFileSync(path.join(__dirname, '..', 'public', 'config.js'), `${lines.join('\n')}\n`);

// The upload page converts files in the browser with a build of ffmpeg. Netlify installs it
// from package.json (devDependencies); copy it to where the page loads it from.
if (media) {
  const modules = path.join(__dirname, '..', 'node_modules', '@ffmpeg');
  const vendor = path.join(__dirname, '..', 'public', 'vendor', 'ffmpeg');
  try {
    fs.mkdirSync(vendor, { recursive: true });
    for (const dir of [path.join(modules, 'ffmpeg', 'dist', 'umd'), path.join(modules, 'core', 'dist', 'umd')]) {
      for (const name of fs.readdirSync(dir)) if (/\.(js|wasm)$/.test(name)) fs.copyFileSync(path.join(dir, name), path.join(vendor, name));
    }
    console.log('Converter for the upload page is in place.');
  } catch {
    console.warn('The converter could not be copied (was npm install run?). The upload page will only accept MP4 and WebM.');
  }
}
