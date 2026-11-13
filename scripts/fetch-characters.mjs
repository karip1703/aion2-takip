#!/usr/bin/env node
// AION 2 karakter verisini resmi siteden (aion2.plaync.com) çekip data/data.json'a yazar.
// Harici bağımlılık yok (Node 20+ yerleşik fetch).
//
// Kullanım:
//   node scripts/fetch-characters.mjs              → çek + önbelleğe yaz + data.json'a uygula
//   node scripts/fetch-characters.mjs --apply-only → çekmeden, önbellekteki sonucu güncel data.json'a uygula
//                                                    (workflow push çakışmasında kullanır)
//   node scripts/fetch-characters.mjs --dry-run    → çek ve sonucu göster, dosyaya yazma
//   node scripts/fetch-characters.mjs --only Kyrakia → sadece bir karakter ("fetch": false olsa bile)
//
// Kurallar:
//   * Sadece `game`, `ref`, `lastError`, `sample` alanlarına dokunur; `energy` ASLA değiştirilmez.
//   * Bir karakter çekilemezse eski verisi kalır, hata loglanır.
//   * Gerçek değişiklik yoksa dosya yazılmaz (boş commit oluşmaz).

import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_FILE = path.join(ROOT, 'data', 'data.json');
const CACHE_FILE = process.env.FETCH_CACHE || path.join(ROOT, '.cache', 'fetched.json');

const args = process.argv.slice(2);
const APPLY_ONLY = args.includes('--apply-only');
const DRY_RUN = args.includes('--dry-run');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// =====================================================================
// Resmi sitenin kullandığı uç noktalar
// (aion2.plaync.com/en-us/characters/index sayfasının index.js'inden çıkarıldı)
// =====================================================================
const SITE = 'https://aion2.plaync.com';
const SEARCH_URL = 'https://api-search.plaync.com/aion2global/search/v2/character';
const LANG = 'en-US';

const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

const api = {
  servers: (region) => `${SITE}/api/gameinfo/servers?${qs({ lang: LANG, region })}`,
  search: (name, serverId, region) =>
    `${SEARCH_URL}?${qs({ keyword: name, serverId, region, localeInfo: LANG, page: 1, size: 40 })}`,
  info: (ref, region) => `${SITE}/api/character/info?${qs({ lang: LANG, characterId: ref.characterId, serverId: ref.serverId, region })}`,
  equipment: (ref, region) => `${SITE}/api/character/equipment?${qs({ lang: LANG, characterId: ref.characterId, serverId: ref.serverId, region })}`,
  item: (ref, it, region) => `${SITE}/api/character/equipment/item?${qs({
    id: it.id, enchantLevel: it.enchantLevel, characterId: ref.characterId, serverId: ref.serverId, slotPos: it.slotPos, lang: LANG, region,
  })}`,
};

// Sunucu adı → serverId (config.serverId boşsa bir kez çözülür)
async function resolveServerId(config) {
  if (config.serverId) return config.serverId;
  const j = await fetchJson(api.servers(config.regionCode));
  const s = (j.serverList || []).find((x) => x.serverName.toLowerCase() === String(config.server).toLowerCase());
  if (!s) throw new Error(`"${config.server}" sunucusu ${config.regionCode} bölgesinde bulunamadı`);
  config.serverId = s.serverId;
  return s.serverId;
}

const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '');

async function searchCharacter(ch, config) {
  const serverId = await resolveServerId(config);
  const j = await fetchJson(api.search(ch.name, serverId, config.regionCode));
  const hit = (j.list || []).find((x) =>
    stripTags(x.name).toLowerCase() === ch.name.toLowerCase() && Number(x.serverId) === Number(serverId));
  if (!hit) {
    const names = (j.list || []).slice(0, 5).map((x) => stripTags(x.name)).join(', ');
    throw new Error(`"${ch.name}" ${config.server} sunucusunda bulunamadı${names ? ` (benzerler: ${names})` : ''}`);
  }
  // Arama yanıtındaki id URL-kodlu geliyor ("…%3D"); diğer uç noktalar çözülmüş halini istiyor.
  return { characterId: decodeURIComponent(hit.characterId), serverId: Number(hit.serverId) };
}

async function fetchCharacter(ch, config) {
  let ref = ch.ref?.characterId ? ch.ref : null;
  let fromCache = !!ref;
  if (!ref) ref = await searchCharacter(ch, config);

  let info, equip;
  try {
    info = await fetchJson(api.info(ref, config.regionCode), { retries: fromCache ? 0 : 2 });
  } catch (e) {
    if (!fromCache) throw e;
    // Kayıtlı id artık geçersiz olabilir (isim değişikliği vb.) → yeniden ara.
    ref = await searchCharacter(ch, config);
    fromCache = false;
    info = await fetchJson(api.info(ref, config.regionCode));
  }
  equip = await fetchJson(api.equipment(ref, config.regionCode));

  const game = await normalize(info, equip, ch.game, ref, config);
  return { ref, game };
}

// Eşya detay yanıtından sitede gösterilecek kısımlar (dosya boyutu küçük kalsın diye).
const arr = (x) => (Array.isArray(x) ? x : []);
function slimDetail(d) {
  return {
    category: d.categoryName ?? null,
    equipLevel: d.equipLevel ?? null,
    maxEnchant: d.maxEnchantLevel ?? null,
    maxExceed: d.maxExceedEnchantLevel ?? null,
    soulBind: d.soulBindRate ?? null,
    main: arr(d.mainStats).map((s) => ({
      name: s.name, value: s.value ?? null, extra: s.extra && s.extra !== '0' ? s.extra : null, min: s.minValue ?? null,
    })),
    sub: arr(d.subStats).map((s) => ({ name: s.name, value: s.value ?? null, added: !!s.added })),
    // Ek skill'ler (zırh, aksesuar, arcana): ek statların yanında gösterilir
    subSkills: arr(d.subSkills).map((s) => ({ name: s.name, level: s.level ?? null, icon: s.icon ?? null, added: !!s.added })),
    subSkillMax: d.subSkillCountMax ?? null,
    desc: d.desc ?? null,
    set: d.set ? {
      name: d.set.name,
      equipped: d.set.equippedCount ?? 0,
      items: arr(d.set.items).map((i) => ({ name: i.name, equipped: !!i.equipped })),
      bonuses: arr(d.set.bonuses).map((b) => ({ degree: b.degree, text: arr(b.descriptions) })),
    } : null,
    magicSlots: d.magicStoneSlotCount ?? 0,
    magicStones: arr(d.magicStoneStat).map((s) => ({ name: s.name, value: s.value ?? null, grade: s.grade ?? null, icon: s.icon ?? null })),
    godSlots: d.godStoneSlotCount ?? 0,
    godStones: arr(d.godStoneStat).map((s) => ({ name: s.name, desc: s.desc ?? null, grade: s.grade ?? null, icon: s.icon ?? null })),
  };
}

const wingOf = (w) => (w ? { name: w.name, grade: w.grade ?? null, enchant: w.enchantLevel ?? 0, icon: w.icon ?? null } : null);

// "MainHand" → "Main Hand", "Earring1" → "Earring 1"
const prettySlot = (s) => String(s || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2');

async function normalize(info, equip, oldGame, ref, config) {
  const p = info.profile || {};
  const stats = info.stat?.statList || [];
  const itemLevel = stats.find((s) => s.type === 'ItemLevel')?.value ?? null;

  // Parça seviyesi ve statlar/taşlar sadece eşya detayında var. Ek statlar ve taşlar aynı
  // eşyada da değişebildiği için her çalıştırmada yeniden çekilir. Çekilemezse eski detay kalır.
  const oldBySlot = new Map((oldGame?.gear || []).map((g) => [`${g.slotPos}:${g.id}`, g]));
  const list = [...(equip.equipment?.equipmentList || [])].sort((a, b) => a.slotPos - b.slotPos);

  const gear = await mapLimit(list, 4, async (it) => {
    const old = oldBySlot.get(`${it.slotPos}:${it.id}`);
    let lvl = old?.itemLevel ?? null;
    let detail = old?.detail ?? null;
    if (config.fetchItemDetails !== false) {
      try {
        const d = await fetchJson(api.item(ref, it, config.regionCode), { retries: 1 });
        lvl = d.level ?? lvl;
        detail = slimDetail(d);
        await sleep(150);
      } catch (e) {
        console.log(`  (uyarı) ${it.name} detay alınamadı: ${e.message}`);
      }
    }
    return {
      slot: prettySlot(it.slotPosName),
      slotPos: it.slotPos,
      id: it.id,
      name: it.name,
      grade: it.grade || null,
      enchant: it.enchantLevel ?? 0,
      exceed: it.exceedLevel ?? 0,
      itemLevel: lvl,
      icon: it.icon || null,
      detail,
    };
  });

  return {
    class: p.className ?? null,
    level: p.characterLevel ?? null,
    itemLevel,
    combatPower: p.combatPower ?? null,
    race: p.raceName ?? null,
    title: p.titleName ?? null,
    profileImage: p.profileImage ?? null,
    gear,
    skills: arr(equip.skill?.skillList).map((s) => ({
      id: s.id,
      name: s.name,
      category: s.category ?? null,   // Active | Passive | Dp
      level: s.skillLevel ?? null,
      icon: s.icon ?? null,
      equip: !!s.equip,
      acquired: !!s.acquired,
    })),
    pet: equip.petwing?.pet ? {
      name: equip.petwing.pet.name, level: equip.petwing.pet.level ?? null, icon: equip.petwing.pet.icon ?? null,
    } : null,
    wing: wingOf(equip.petwing?.wing),
    wingSkin: wingOf(equip.petwing?.wingSkin),
  };
}

// =====================================================================
// HTTP yardımcıları
// =====================================================================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sırayı koruyarak en fazla `limit` işi aynı anda çalıştırır.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function fetchJson(url, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20_000),
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
          Referer: `${SITE}/en-us/characters/index`,
          Origin: SITE,
        },
      });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      if (/^\s*</.test(text)) throw new Error('JSON yerine HTML döndü (bot koruması/yönlendirme olabilir)');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

// =====================================================================
// Çekme ve uygulama
// =====================================================================
async function fetchAll(data) {
  const config = data.config || {};
  const results = [];
  for (const ch of data.characters || []) {
    if (ONLY) { if (ch.name.toLowerCase() !== ONLY.toLowerCase() && ch.id !== ONLY) continue; }
    else if (ch.fetch === false) continue;

    const at = new Date().toISOString();
    try {
      const { ref, game } = await fetchCharacter(ch, config);
      results.push({ id: ch.id, ok: true, at, ref, game });
      console.log(`✔ ${ch.name}: ${game.class} Lv${game.level}, iLvl ${game.itemLevel ?? '?'}, CP ${game.combatPower ?? '?'}, ${game.gear.length} parça`);
    } catch (e) {
      results.push({ id: ch.id, ok: false, at, error: e.message });
      console.log(`::warning title=${ch.name} çekilemedi::${e.message}`);
    }
    await sleep(800); // siteye nazik ol
  }
  return results;
}

const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function apply(data, results) {
  let changed = false;
  for (const r of results) {
    const ch = data.characters.find((c) => c.id === r.id);
    if (!ch) continue;

    if (r.ok) {
      const { updatedAt: _ignore, ...oldGame } = ch.game || {};
      if (!sameJson(oldGame, r.game)) {
        ch.game = { ...r.game, updatedAt: r.at };
        changed = true;
      }
      if (r.ref && !sameJson(ch.ref, r.ref)) { ch.ref = r.ref; changed = true; }
      if (ch.lastError) { delete ch.lastError; changed = true; }
      if (ch.sample) { delete ch.sample; changed = true; }
    } else if (ch.lastError?.message !== r.error) {
      // Aynı hata tekrar ediyorsa dosyaya dokunma (her çalıştırmada commit olmasın).
      ch.lastError = { message: r.error, at: r.at };
      changed = true;
    }
  }
  if (changed) data.lastFetch = new Date().toISOString();
  return changed;
}

async function summary(results) {
  if (!process.env.GITHUB_STEP_SUMMARY) return;
  const lines = ['| Karakter | Durum |', '|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.ok ? `✔ iLvl ${r.game.itemLevel ?? '?'} · CP ${r.game.combatPower ?? '?'}` : `✖ ${r.error}`} |`)];
  await appendFile(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n');
}

async function main() {
  const data = JSON.parse(await readFile(DATA_FILE, 'utf8'));
  let results;

  if (APPLY_ONLY) {
    results = JSON.parse(await readFile(CACHE_FILE, 'utf8'));
    console.log(`Önbellekten ${results.length} sonuç uygulanıyor.`);
  } else {
    results = await fetchAll(data);
    if (!results.length) { console.log('Çekilecek karakter yok ("fetch": false olmayan karakter bulunamadı).'); return; }
    if (!DRY_RUN) {
      await mkdir(path.dirname(CACHE_FILE), { recursive: true });
      await writeFile(CACHE_FILE, JSON.stringify(results, null, 2));
    }
    await summary(results);
  }

  if (DRY_RUN) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (apply(data, results)) {
    await writeFile(DATA_FILE, JSON.stringify(data, null, 2) + '\n');
    console.log('data.json güncellendi.');
  } else {
    console.log('Değişiklik yok.');
  }

  if (results.length && results.every((r) => !r.ok)) {
    console.log('::error::Hiçbir karakter çekilemedi.');
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
