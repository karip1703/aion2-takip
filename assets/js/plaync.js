// AION 2 resmi sitesinden (aion2.plaync.com) karakter verisi — masaüstü uygulamasında tarayıcıdan çalışır.
// İstekler uygulamanın aracısından geçer (/api/plaync?u=…; yalnızca resmi site alan adlarına izin verir).
// Mantık scripts/fetch-characters.mjs ile aynıdır (o GitHub Actions'ta çalışır).

const SITE = 'https://aion2.plaync.com';
const SEARCH_URL = 'https://api-search.plaync.com/aion2global/search/v2/character';
const LANG = 'en-US';
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();
const api = {
  servers: (region) => `${SITE}/api/gameinfo/servers?${qs({ lang: LANG, region })}`,
  search: (name, serverId, region) => `${SEARCH_URL}?${qs({ keyword: name, serverId, region, localeInfo: LANG, page: 1, size: 40 })}`,
  info: (ref, region) => `${SITE}/api/character/info?${qs({ lang: LANG, characterId: ref.characterId, serverId: ref.serverId, region })}`,
  equipment: (ref, region) => `${SITE}/api/character/equipment?${qs({ lang: LANG, characterId: ref.characterId, serverId: ref.serverId, region })}`,
  item: (ref, it, region) => `${SITE}/api/character/equipment/item?${qs({
    id: it.id, enchantLevel: it.enchantLevel, characterId: ref.characterId, serverId: ref.serverId, slotPos: it.slotPos, lang: LANG, region,
  })}`,
};
export const REGIONS = [{ code: 'eu', name: 'Avrupa (EU)' }];   // NA: bölge kodu doğrulanınca eklenecek

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stripTags = (s) => String(s ?? '').replace(/<[^>]*>/g, '');
const arr = (x) => (Array.isArray(x) ? x : []);

async function fetchJson(url, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`/api/plaync?u=${encodeURIComponent(url)}`, { cache: 'no-store' });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 160)}`);
      if (/^\s*</.test(text)) throw new Error('JSON yerine HTML döndü (resmi site geçici olarak yanıt vermiyor olabilir)');
      return JSON.parse(text);
    } catch (e) {
      lastErr = e;
      if (i < retries) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Açık EU sunucuları (1xxx Elyos, 2xxx Asmodian). Resmi sitenin sunucu listesi uç noktası artık yanıt vermiyor (404).
// Kaynak: NCSOFT "New Server and Matchmaking Information" duyurusu, Ekim 2026 (23 sunucu, iki taraf).
const SERVERS = { eu: [[1301,"Siel"],[1302,"Nezekan"],[1303,"Vaizel"],[1304,"Kaisinel"],[1305,"Yustiel"],[1306,"Ariel"],[1307,"Fregion"],[1308,"Meslamtaeda"],[1309,"Hithanya"],[1310,"Nania"],[1311,"Tahabata"],[1312,"Luteros"],[1313,"Phernos"],[1314,"Daminu"],[1315,"Kasika"],[1316,"Bakarma"],[1317,"Tsenka"],[1318,"Kochi"],[1319,"Ishtar"],[1320,"Tiamat"],[1321,"Poeta"],[1322,"Verteron"],[1323,"Nathara"],[2301,"Israphel"],[2302,"Zikel"],[2303,"Triniel"],[2304,"Lumiel"],[2305,"Marchutan"],[2306,"Azphel"],[2307,"Ereshkigal"],[2308,"Beritra"],[2309,"Nemon"],[2310,"Hadala"],[2311,"Ludra"],[2312,"Ulgorn"],[2313,"Munin"],[2314,"Odar"],[2315,"Zemurru"],[2316,"Kromede"],[2317,"Quai"],[2318,"Baba"],[2319,"Fafnir"],[2320,"Indnath"],[2321,"Ishalgen"],[2322,"Altgard"],[2323,"Agnita"]] };

/** Bölgenin sunucuları: [{ id, name, faction }] */
export async function listServers(region) {
  return (SERVERS[region] || []).map(([id, name]) => ({ id, name: `${name} (${id < 2000 ? 'Elyos' : 'Asmodian'})`, faction: id < 2000 ? 'Elyos' : 'Asmodian' }));
}

/** Karakter arama: tam ad eşleşmesi → { characterId, serverId } ; benzerler hata mesajında */
export async function searchCharacter(name, serverId, region) {
  const j = await fetchJson(api.search(name, serverId, region));
  const hit = (j.list || []).find((x) => stripTags(x.name).toLowerCase() === name.toLowerCase() && Number(x.serverId) === Number(serverId));
  if (!hit) {
    const names = (j.list || []).slice(0, 5).map((x) => stripTags(x.name)).join(', ');
    throw new Error(`"${name}" bu sunucuda bulunamadı${names ? ` (benzerler: ${names})` : ''}`);
  }
  return { characterId: decodeURIComponent(hit.characterId), serverId: Number(hit.serverId) };
}

/** Ada tam uyan karakterler (sunucu verilmezse bütün sunucularda): [{ ref, serverName, level, pcId }] */
export async function findCandidates(name, region, serverId) {
  const j = await fetchJson(api.search(name, serverId || undefined, region));
  return (j.list || [])
    .filter((x) => stripTags(x.name).toLowerCase() === name.toLowerCase() && (!serverId || Number(x.serverId) === Number(serverId)))
    .map((x) => ({ ref: { characterId: decodeURIComponent(x.characterId), serverId: Number(x.serverId) }, serverName: x.serverName || '', level: x.level ?? null, pcId: x.pcId ?? null }));
}

function slimDetail(d) {
  return {
    category: d.categoryName ?? null, equipLevel: d.equipLevel ?? null, maxEnchant: d.maxEnchantLevel ?? null,
    maxExceed: d.maxExceedEnchantLevel ?? null, soulBind: d.soulBindRate ?? null,
    main: arr(d.mainStats).map((s) => ({ name: s.name, value: s.value ?? null, extra: s.extra && s.extra !== '0' ? s.extra : null, min: s.minValue ?? null })),
    sub: arr(d.subStats).map((s) => ({ name: s.name, value: s.value ?? null, added: !!s.added })),
    subSkills: arr(d.subSkills).map((s) => ({ name: s.name, level: s.level ?? null, icon: s.icon ?? null, added: !!s.added })),
    subSkillMax: d.subSkillCountMax ?? null, desc: d.desc ?? null,
    set: d.set ? { name: d.set.name, equipped: d.set.equippedCount ?? 0, items: arr(d.set.items).map((i) => ({ name: i.name, equipped: !!i.equipped })),
      bonuses: arr(d.set.bonuses).map((b) => ({ degree: b.degree, text: arr(b.descriptions) })) } : null,
    magicSlots: d.magicStoneSlotCount ?? 0,
    magicStones: arr(d.magicStoneStat).map((s) => ({ name: s.name, value: s.value ?? null, grade: s.grade ?? null, icon: s.icon ?? null })),
    godSlots: d.godStoneSlotCount ?? 0,
    godStones: arr(d.godStoneStat).map((s) => ({ name: s.name, desc: s.desc ?? null, grade: s.grade ?? null, icon: s.icon ?? null })),
  };
}
const wingOf = (w) => (w ? { name: w.name, grade: w.grade ?? null, enchant: w.enchantLevel ?? 0, icon: w.icon ?? null } : null);
const prettySlot = (s) => String(s || '').replace(/([a-z])([A-Z0-9])/g, '$1 $2');

async function normalize(info, equip, oldGame, ref, region, details, onItem) {
  const p = info.profile || {};
  const itemLevel = (info.stat?.statList || []).find((s) => s.type === 'ItemLevel')?.value ?? null;
  const oldBySlot = new Map((oldGame?.gear || []).map((g) => [`${g.slotPos}:${g.id}`, g]));
  const list = [...(equip.equipment?.equipmentList || [])].sort((a, b) => a.slotPos - b.slotPos);
  let done = 0;
  const gear = await mapLimit(list, 4, async (it) => {
    const old = oldBySlot.get(`${it.slotPos}:${it.id}`);
    let lvl = old?.itemLevel ?? null, detail = old?.detail ?? null;
    if (details) {
      try { const d = await fetchJson(api.item(ref, it, region), { retries: 1 }); lvl = d.level ?? lvl; detail = slimDetail(d); await sleep(120); } catch { /* eski detay kalır */ }
    }
    onItem?.(++done, list.length);
    return { slot: prettySlot(it.slotPosName), slotPos: it.slotPos, id: it.id, name: it.name, grade: it.grade || null,
      enchant: it.enchantLevel ?? 0, exceed: it.exceedLevel ?? 0, itemLevel: lvl, icon: it.icon || null, detail };
  });
  return {
    class: p.className ?? null, level: p.characterLevel ?? null, itemLevel, combatPower: p.combatPower ?? null,
    race: p.raceName ?? null, title: p.titleName ?? null, profileImage: p.profileImage ?? null, gear,
    skills: arr(equip.skill?.skillList).map((s) => ({ id: s.id, name: s.name, category: s.category ?? null, level: s.skillLevel ?? null,
      icon: s.icon ?? null, equip: !!s.equip, acquired: !!s.acquired })),
    pet: equip.petwing?.pet ? { name: equip.petwing.pet.name, level: equip.petwing.pet.level ?? null, icon: equip.petwing.pet.icon ?? null } : null,
    wing: wingOf(equip.petwing?.wing), wingSkin: wingOf(equip.petwing?.wingSkin),
  };
}

/** Bir karakterin oyun verisi. ch: { name, ref?, region?, serverId? }; config: varsayılan bölge/sunucu */
export async function fetchCharacter(ch, config, onItem) {
  const region = ch.region || config.regionCode || 'eu';
  const serverId = ch.ref?.serverId || ch.serverId || config.serverId;
  let ref = ch.ref?.characterId ? ch.ref : null;
  let info;
  if (ref) {
    try { info = await fetchJson(api.info(ref, region), { retries: 0 }); } catch { ref = null; }   // id değişmiş olabilir → yeniden ara
  }
  if (!ref) { ref = await searchCharacter(ch.name, serverId, region); info = await fetchJson(api.info(ref, region)); }
  const equip = await fetchJson(api.equipment(ref, region));
  const game = await normalize(info, equip, ch.game, ref, region, config.fetchItemDetails !== false, onItem);
  return { ref, game };
}
