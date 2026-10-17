#!/usr/bin/env node
// Generates a short sample clip for every OpenRouter speech model and voice that has no file
// in samples/ yet, then rewrites samples/manifest.js from the files on disk. Run with --help.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import readline from 'node:readline/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const USAGE = `Generate voice samples for the Voices page.

  OPENROUTER_API_KEY=sk-or-... node scripts/generate-samples.mjs
  node scripts/generate-samples.mjs --dry-run

Samples that already exist in samples/ are skipped, so rerun this whenever
OpenRouter adds models or voices. It shows the estimated cost and asks before
spending anything.

Options:
  --dry-run          Show what is missing and the estimated cost. Needs no key and changes nothing.
  --yes              Skip the confirmation prompt.
  --provider=a,b     Only these providers, e.g. --provider=elevenlabs,google
  --model=id,id      Only these model IDs, e.g. --model=deepgram/aura-2
  --limit=N          Generate at most N samples in this run.
  --concurrency=N    Requests in parallel (default 4, max 16).
  --force            Regenerate samples that already exist, within the filters above.
  --no-transcode     Keep PCM-only models' samples as WAV. By default they are
                     converted to MP3 with ffmpeg when it is installed.
  --sync             Only rebuild samples/manifest.js from the files on disk.
  --help             Show this message.`;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.OPENROUTER_API_BASE || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
const SAMPLES_DIR = path.join(ROOT, 'samples');
const MANIFEST_PATH = path.join(SAMPLES_DIR, 'manifest.js');
const AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'flac', 'aac'];

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'voice-catalog.js'), 'utf8'), { filename: 'voice-catalog.js' });
const { sampleText, sampleBase, sampleKey, voicesFor, responseFormat, learnFormatFromError } = globalThis.VoiceCatalog;

// ---------- options ----------
function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

const KNOWN_OPTIONS = new Set(['dry-run', 'yes', 'force', 'sync', 'help', 'provider', 'model', 'limit', 'concurrency', 'no-transcode']);
const opts = { provider: [], model: [] };
for (const arg of process.argv.slice(2)) {
  const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
  if (!m || !KNOWN_OPTIONS.has(m[1])) fail(`Unknown option "${arg}". Run with --help to see the options.`);
  const [, name, value] = m;
  if (name === 'provider' || name === 'model') opts[name].push(...(value || '').split(',').map(s => s.trim()).filter(Boolean));
  else opts[name] = value ?? true;
}
const dryRun = !!opts['dry-run'];
const concurrency = Math.max(1, Math.min(16, parseInt(opts.concurrency ?? '4', 10) || 4));
const limit = opts.limit != null ? Math.max(0, parseInt(opts.limit, 10) || 0) : Infinity;
const transcode = !opts['no-transcode'] && spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

// ---------- helpers ----------
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const rel = file => path.relative(ROOT, file).split(path.sep).join('/');
const fmtUsd = x => (x < 0.01 ? `$${x.toFixed(4)}` : `$${x.toFixed(2)}`);
const fmtKb = n => `${Math.max(1, Math.round(n / 1024))} KB`;

function existingFile(base) {
  for (const ext of AUDIO_EXTS) {
    const file = path.join(ROOT, `${base}.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

function listAudioFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listAudioFiles(full);
    return AUDIO_EXTS.includes(path.extname(entry.name).slice(1)) ? [full] : [];
  });
}

// Rough cost: most models bill per character; Seed bills per second of audio; Gemini bills tokens.
function estimateCost(model, text) {
  const p = +model.pricing?.prompt || 0;
  const c = +model.pricing?.completion || 0;
  const seconds = Math.max(2, text.length / 15);
  if (!p && !c) return 0;
  if (p && !c) return p * text.length;
  if (!p) return c * seconds;
  return p * Math.ceil(text.length / 4) + c * seconds * 32;
}

function wrapWav(pcm, rate, channels) {
  const len = pcm.length - (pcm.length % (2 * channels));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(36 + len, 4);
  head.write('WAVE', 8, 'latin1');
  head.write('fmt ', 12, 'latin1');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'latin1');
  head.writeUInt32LE(len, 40);
  return Buffer.concat([head, pcm.subarray(0, len)]);
}

function pcmToMp3(pcm, rate, channels) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 's16le', '-ar', String(rate), '-ac', String(channels),
      '-i', 'pipe:0', '-codec:a', 'libmp3lame', '-q:a', '4', '-f', 'mp3', 'pipe:1']);
    const out = [];
    let err = '';
    ff.stdout.on('data', d => out.push(d));
    ff.stderr.on('data', d => { err += d; });
    ff.on('error', reject);
    ff.on('close', code => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(err.trim() || `ffmpeg exited with code ${code}`))));
    ff.stdin.on('error', () => { /* reported through close */ });
    ff.stdin.end(pcm);
  });
}

// Same detection as the playground: trust the bytes first, then the content type.
// Raw PCM gets converted to MP3 when ffmpeg is available, otherwise wrapped as WAV.
async function toAudioFile(bytes, contentType, requested) {
  const ct = contentType.toLowerCase();
  const magic = bytes.subarray(0, 4).toString('latin1');
  if (magic === 'RIFF') return { ext: 'wav', data: bytes };
  if (/mpeg|mp3/.test(ct)) return { ext: 'mp3', data: bytes };
  if (/ogg|opus/.test(ct)) return { ext: 'ogg', data: bytes };
  if (/flac/.test(ct)) return { ext: 'flac', data: bytes };
  if (/aac/.test(ct)) return { ext: 'aac', data: bytes };
  if (/pcm|l16|raw/.test(ct) || (requested === 'pcm' && !/audio\/(mpeg|mp3|ogg|opus|flac|aac)/.test(ct))) {
    const rateMatch = ct.match(/(?:sample_?rate|rate)=(\d+)/);
    const rate = rateMatch ? +rateMatch[1] : 24000;
    const channels = +(ct.match(/channels=(\d+)/) || [])[1] || 1;
    const pcm = { rate, channels, rateGuessed: !rateMatch };
    if (transcode) {
      try {
        return { ext: 'mp3', data: await pcmToMp3(bytes, rate, channels), pcm };
      } catch (e) {
        console.log(`  ffmpeg could not convert PCM (${e.message}), so saving WAV instead.`);
      }
    }
    return { ext: 'wav', data: wrapWav(bytes, rate, channels), pcm };
  }
  if (magic.startsWith('ID3') || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return { ext: 'mp3', data: bytes };
  if (magic === 'OggS') return { ext: 'ogg', data: bytes };
  if (magic === 'fLaC') return { ext: 'flac', data: bytes };
  return { ext: 'mp3', data: bytes };
}

// ---------- manifest ----------
function readManifest() {
  try {
    const text = fs.readFileSync(MANIFEST_PATH, 'utf8');
    const data = JSON.parse(text.match(/window\.VOICE_SAMPLES\s*=\s*([\s\S]*?);\s*$/)[1]);
    return { samples: data.samples || {}, failures: data.failures || {} };
  } catch {
    return { samples: {}, failures: {} };
  }
}

function writeManifest(samples, failures) {
  const block = obj => {
    const keys = Object.keys(obj).sort();
    return keys.length ? `\n${keys.map(k => `    ${JSON.stringify(k)}: ${JSON.stringify(obj[k])}`).join(',\n')}\n  ` : '';
  };
  const text = [
    '// Written by scripts/generate-samples.mjs from the files in samples/. Do not edit by hand.',
    'window.VOICE_SAMPLES = {',
    '  "version": 1,',
    `  "updated": ${JSON.stringify(new Date().toISOString())},`,
    `  "samples": {${block(samples)}},`,
    `  "failures": {${block(failures)}}`,
    '};',
    '',
  ].join('\n');
  fs.mkdirSync(SAMPLES_DIR, { recursive: true });
  fs.writeFileSync(`${MANIFEST_PATH}.tmp`, text);
  fs.renameSync(`${MANIFEST_PATH}.tmp`, MANIFEST_PATH);
}

// The manifest always describes what is on disk for the voices OpenRouter lists today.
function rebuildManifest(targets, previous, results, newFailures) {
  const samples = {};
  const failures = {};
  for (const t of targets) {
    const file = existingFile(t.base);
    if (file) {
      const known = results.get(t.key) || previous.samples[t.key];
      const stat = fs.statSync(file);
      samples[t.key] = {
        file: rel(file),
        text: known?.text ?? t.text,
        bytes: stat.size,
        created: known?.created ?? stat.mtime.toISOString(),
        ...(known?.provider ? { provider: known.provider } : {}),
        ...(known?.contentType ? { contentType: known.contentType } : {}),
      };
    } else {
      const failure = newFailures.get(t.key) || previous.failures[t.key];
      if (failure) failures[t.key] = failure;
    }
  }
  writeManifest(samples, failures);
  return { samples, failures };
}

// ---------- API ----------
async function keyUsage(key) {
  const res = await fetch(`${API}/key`, { headers: { Authorization: `Bearer ${key}` } });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401) fail(`OpenRouter rejected the key: ${json.error?.message || 'unauthorized'}`);
  return res.ok ? +json.data?.usage : NaN;
}

const notedPcm = new Set();

async function generateOne(t, key) {
  const body = { model: t.model.id, input: t.text, response_format: responseFormat(t.model.id, 'mp3') };
  if (t.voice) body.voice = t.voice;
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(`${API}/audio/speech`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch (e) {
      if (attempt < 3) { await sleep(1500 * attempt); continue; }
      throw new Error(`Network error: ${e.message}`);
    }
    const ct = res.headers.get('content-type') || '';
    if (res.ok && !/json/i.test(ct)) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (!bytes.length) throw new Error('The response contained no audio.');
      const { ext, data, pcm } = await toAudioFile(bytes, ct, body.response_format);
      if (pcm && !notedPcm.has(t.model.id)) {
        notedPcm.add(t.model.id);
        console.log(`  ${t.model.id} returns raw PCM (${ct || 'no content type'}${pcm.rateGuessed ? ', no sample rate given, read as 24 kHz' : ''}). Saving as ${ext.toUpperCase()}.`);
      }
      const file = path.join(ROOT, `${t.base}.${ext}`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, data);
      fs.renameSync(`${file}.tmp`, file);
      // With --force the format can change; drop the older copy so there is one file per voice.
      for (const other of AUDIO_EXTS) {
        const old = path.join(ROOT, `${t.base}.${other}`);
        if (other !== ext && fs.existsSync(old)) fs.unlinkSync(old);
      }
      return {
        text: t.text,
        created: new Date().toISOString(),
        provider: res.headers.get('x-provider-name') || undefined,
        contentType: ct || undefined,
        bytes: data.length,
      };
    }
    const text = await res.text();
    let message = text.slice(0, 300) || `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      message = j.error?.message || message;
      const raw = j.error?.metadata?.raw;
      if (typeof raw === 'string' && !message.includes(raw)) message += ` (${raw.slice(0, 200)})`;
    } catch { /* not JSON */ }
    // A model that rejects the format says which one it wants: switch to it for this and later voices.
    const wanted = res.status === 400 && learnFormatFromError(t.model.id, message);
    if (wanted && wanted !== body.response_format) {
      body.response_format = wanted;
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && attempt < 4) {
      await sleep(Math.min(30_000, 2000 * 2 ** (attempt - 1)));
      continue;
    }
    const err = new Error(message);
    err.status = res.status;
    throw err;
  }
}

// ---------- main ----------
async function main() {
  if (opts.help) { console.log(USAGE); return; }
  const key = (process.env.OPENROUTER_API_KEY || '').trim();
  if (!dryRun && !opts.sync && !key) fail('Set OPENROUTER_API_KEY to your OpenRouter key, or use --dry-run to see what would be generated.');

  process.stdout.write('Loading speech models from OpenRouter… ');
  let models;
  try {
    const res = await fetch(`${API}/models?output_modalities=speech`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    models = (await res.json()).data || [];
  } catch (e) {
    console.log('');
    fail(`Could not load the model list: ${e.message}`);
  }
  console.log(`${models.length} models.`);

  const targets = models.flatMap(m => voicesFor(m).map(voice => ({
    model: m, voice, key: sampleKey(m.id, voice), base: sampleBase(m.id, voice), text: sampleText(m.id, voice),
  })));
  const previous = readManifest();

  if (opts.sync) {
    const { samples } = rebuildManifest(targets, previous, new Map(), new Map());
    console.log(`Wrote samples/manifest.js: ${Object.keys(samples).length} of ${targets.length} voices have samples.`);
    return;
  }

  const providers = new Set(models.map(m => m.id.split('/')[0]));
  for (const p of opts.provider) if (!providers.has(p)) fail(`No speech models from "${p}". Providers: ${[...providers].sort().join(', ')}`);
  for (const id of opts.model) if (!models.some(m => m.id === id)) fail(`No speech model called "${id}".`);
  // --provider and --model add up: the named providers plus the named models.
  const filtered = opts.provider.length || opts.model.length;
  const scoped = targets.filter(t => !filtered || opts.provider.includes(t.model.id.split('/')[0]) || opts.model.includes(t.model.id));
  const todo = scoped.filter(t => opts.force || !existingFile(t.base)).slice(0, limit);

  // Summary per model
  const rows = new Map();
  for (const t of scoped) {
    const row = rows.get(t.model.id) || { voices: 0, have: 0, todo: 0, cost: 0 };
    row.voices++;
    if (existingFile(t.base)) row.have++;
    rows.set(t.model.id, row);
  }
  for (const t of todo) {
    const row = rows.get(t.model.id);
    row.todo++;
    row.cost += estimateCost(t.model, t.text);
  }
  const pending = [...rows].filter(([, r]) => r.todo);
  const totalCost = todo.reduce((sum, t) => sum + estimateCost(t.model, t.text), 0);
  const have = scoped.filter(t => existingFile(t.base)).length;
  console.log(`${have} of ${scoped.length} voices${opts.provider.length || opts.model.length ? ' in scope' : ''} already have samples.`);

  if (!todo.length) {
    rebuildManifest(targets, previous, new Map(), new Map());
    console.log('Nothing to generate. samples/manifest.js is up to date.');
    return;
  }

  const idWidth = Math.max(24, ...pending.map(([id]) => id.length));
  console.log('');
  console.log(`${'Model'.padEnd(idWidth)}  ${'Voices'.padStart(6)}  ${'Have'.padStart(5)}  ${'To make'.padStart(7)}  ${'Est. cost'.padStart(9)}`);
  for (const [id, r] of pending) {
    console.log(`${id.padEnd(idWidth)}  ${String(r.voices).padStart(6)}  ${String(r.have).padStart(5)}  ${String(r.todo).padStart(7)}  ${fmtUsd(r.cost).padStart(9)}`);
  }
  console.log(`${'Total'.padEnd(idWidth)}  ${''.padStart(6)}  ${''.padStart(5)}  ${String(todo.length).padStart(7)}  ${fmtUsd(totalCost).padStart(9)}`);
  console.log('Estimates are rough, especially for models billed per token or per second.\n');

  if (dryRun) { console.log('Dry run: nothing was generated.'); return; }

  if (!opts.yes) {
    if (!process.stdin.isTTY) fail('Pass --yes to generate without a confirmation prompt.');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`Generate ${todo.length} samples for about ${fmtUsd(totalCost)}? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') { console.log('Nothing generated.'); return; }
  }

  const usageBefore = await keyUsage(key);
  const results = new Map();
  const newFailures = new Map();
  let next = 0;
  let done = 0;
  let stopping = false;
  const width = String(todo.length).length;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nStopping after the requests in flight finish. Press Ctrl+C again to quit at once.');
  };
  process.on('SIGINT', onSigint);

  async function worker() {
    while (!stopping && next < todo.length) {
      const t = todo[next++];
      const label = `${t.model.id} · ${t.voice || 'default voice'}`;
      try {
        const r = await generateOne(t, key);
        results.set(t.key, r);
        console.log(`[${String(++done).padStart(width)}/${todo.length}] ✓ ${label} (${fmtKb(r.bytes)})`);
      } catch (e) {
        newFailures.set(t.key, { status: e.status || 0, error: e.message.slice(0, 300), at: new Date().toISOString() });
        console.log(`[${String(++done).padStart(width)}/${todo.length}] ✗ ${label}: ${e.status ? `HTTP ${e.status}, ` : ''}${e.message}`);
        if (e.status === 401 || e.status === 402) {
          stopping = true;
          console.log(e.status === 402 ? 'Out of OpenRouter credits, so stopping.' : 'The key was rejected, so stopping.');
        }
      }
      if (done % 25 === 0) rebuildManifest(targets, previous, results, newFailures);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  process.off('SIGINT', onSigint);

  const { samples, failures } = rebuildManifest(targets, previous, results, newFailures);
  console.log('');
  console.log(`Generated ${results.size} sample${results.size === 1 ? '' : 's'}${newFailures.size ? `, ${newFailures.size} failed` : ''}.`);
  console.log(`samples/manifest.js now lists ${Object.keys(samples).length} of ${targets.length} voices.`);
  const failedNow = [...newFailures];
  if (failedNow.length) {
    console.log('Failures are recorded in the manifest and shown on the Voices page. Rerun the script to retry them.');
    for (const [k, f] of failedNow.slice(0, 15)) console.log(`  ${k.replace('|', ' · ') || k}: ${f.status ? `HTTP ${f.status}, ` : ''}${f.error}`);
    if (failedNow.length > 15) console.log(`  …and ${failedNow.length - 15} more.`);
  }
  const usageAfter = await keyUsage(key).catch(() => NaN);
  if (Number.isFinite(usageBefore) && Number.isFinite(usageAfter)) {
    console.log(`Key usage went from ${fmtUsd(usageBefore)} to ${fmtUsd(usageAfter)} (+${fmtUsd(Math.max(0, usageAfter - usageBefore))}). OpenRouter can take a minute to catch up.`);
  }
  const listed = new Set(Object.values(samples).map(s => s.file));
  const stray = listAudioFiles(SAMPLES_DIR).map(rel).filter(f => !listed.has(f));
  if (stray.length) console.log(`${stray.length} file${stray.length === 1 ? '' : 's'} in samples/ no longer match a voice on OpenRouter. They are left in place.`);
  if (Object.keys(failures).length > failedNow.length) console.log(`${Object.keys(failures).length - failedNow.length} earlier failures are still missing.`);
}

main().catch(e => fail(e.stack || e.message));
