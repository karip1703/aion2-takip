#!/usr/bin/env node
// data/inbox/*.json dosyalarındaki işlemleri (op) data/data.json'a uygular ve dosyaları siler.
// Ekran okuma programı (tools/izleyici) her olayı buraya küçük bir dosya olarak bırakır;
// böylece program data.json'u hiç yeniden yazmaz, çakışma olmaz. Kurallar sitenin kullandığı
// assets/js/ops.js'ten gelir (tek kaynak).
//
// Inbox dosyası: { "by": "karip", "source": "izleyici", "ops": [ { "type": "...", ... } ] }
// Dosyalar ada göre (zaman damgası ile başlar) sırayla uygulanır.
//
// Kullanım: node scripts/apply-inbox.mjs   → değiştirilen data.json + silinen inbox dosyaları;
//           commit mesajı .cache/inbox-message.txt'ye yazılır.

import { readFile, writeFile, readdir, unlink, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'data.json');
const INBOX = path.join(ROOT, 'data', 'inbox');
const MSG_FILE = path.join(ROOT, '.cache', 'inbox-message.txt');

const { applyOp, opMessage } = await import(pathToFileURL(path.join(ROOT, 'assets', 'js', 'ops.js')).href);

// Program sadece bu işlemleri gönderebilir (yapılacaklar listesi vb. değil).
const ALLOWED = new Set(['energySync', 'dungeonSet', 'dungeonOpen', 'energyRefund']);

async function main() {
  let files = [];
  try { files = (await readdir(INBOX)).filter((f) => f.endsWith('.json')).sort(); } catch { /* klasör yok */ }
  if (!files.length) { console.log('Inbox boş.'); return; }

  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  const messages = [];
  let changed = false;

  for (const f of files) {
    const full = path.join(INBOX, f);
    try {
      const raw = (await readFile(full, 'utf8')).replace(/^﻿/, ''); // PowerShell BOM'u
      const box = JSON.parse(raw);
      const ops = Array.isArray(box.ops) ? box.ops : [box];
      for (const op of ops) {
        if (!ALLOWED.has(op?.type)) { console.log(`::warning::${f}: izin verilmeyen işlem atlandı (${op?.type})`); continue; }
        const o = { ...op, by: op.by || box.by || null, at: op.at || new Date().toISOString() };
        if (applyOp(data, o)) {
          changed = true;
          messages.push(opMessage(o, data, o.by));
          console.log(`✔ ${messages.at(-1)}`);
        } else {
          console.log(`– değişiklik yok: ${o.type} ${o.charId || ''} ${o.name || ''}`);
        }
      }
    } catch (e) {
      console.log(`::warning::${f} okunamadı, atlandı: ${e.message}`);
    }
    await unlink(full); // işlenen (ya da bozuk) dosya her durumda silinir
  }

  if (changed) await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
  await mkdir(path.dirname(MSG_FILE), { recursive: true });
  const title = messages.length === 1 ? messages[0] : `Otomatik: ${messages.length} kayıt (izleyici)`;
  await writeFile(MSG_FILE, [title, '', ...(messages.length > 1 ? messages.map((m) => `- ${m}`) : [])].join('\n'));
  console.log(`${files.length} inbox dosyası işlendi, ${messages.length} değişiklik.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
