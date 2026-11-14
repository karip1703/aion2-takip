// Zindan garanti sayaçları (karaktere ve zindana özel):
//   characters[i].dungeons = [{ name, count, max, updatedAt, updatedBy }]
//
// Kurallar (oyundaki gibi):
//   * Kutu açıldıkça sayaç artar; sınıra (max) ulaşınca garanti ödülü verilir ve sayaç sıfırlanır.
//     Fazlası devreder: 27/28'de 2 kutu → 1/28.
//   * Enerji harcama sırası: önce doğal, sonra ek (+) — bkz. energy.js → spendEnergy.
//
// İşlemler (op) — hem site hem ekran okuma programı kullanır, her zaman güncel dosyanın üstüne uygulanır:
//   { type: 'dungeonSet',    charId, name, count, max, at, by }   elle ayarla / yeni zindan
//   { type: 'dungeonDelta',  charId, name, delta, at, by }        +1 / −1
//   { type: 'dungeonDelete', charId, name }
//   { type: 'dungeonOpen',   charId, name, boxes, cost, max?, seen?, at, by, auto? }
//        → kutu açıldı: enerjiden `cost` düşülür, sayaç `boxes` kadar ilerler.
//          `seen` = ekranda okunan sayaç (açmadan önce). Verilirse sayaç önce ona eşitlenir.
//   { type: 'energySpend',   charId, name, boxes, cost, at, by }
//        → garanti sayacı olmayan enerji harcaması (ör. Transcendence kutusu): sadece enerjiden `cost` düşülür.
//   { type: 'energyRefund',  charId, amount, at, by }   → yanlış sayılan harcamayı geri ekler (ek kısma)
//   { type: 'energySync',    charId, natural, bonus, max?, at, by } → ekrandan okunan gerçek değer (ör. 0(+845)/840)

import { spendEnergy, energyCfg, bonusOf } from './energy.js';

const norm = (s) => String(s || '').trim().toLowerCase();
export const findDungeon = (ch, name) => (ch.dungeons || []).find((d) => norm(d.name) === norm(name));

export function advance(count, max, n) {
  let c = Math.max(0, (Number(count) || 0) + (Number(n) || 0));
  if (max > 0 && c >= max) c %= max;
  return c;
}

function upsert(ch, name, patch) {
  ch.dungeons ||= [];
  let d = findDungeon(ch, name);
  if (!d) { d = { name: String(name).trim(), count: 0, max: 0 }; ch.dungeons.push(d); }
  Object.assign(d, patch);
  return d;
}

// data'yı yerinde değiştirir; bir şey değiştiyse true döner. Tanımadığı op'ta null (başka modülün işi).
export function applyDungeonOp(data, op) {
  if (!['dungeonSet', 'dungeonDelta', 'dungeonDelete', 'dungeonOpen', 'energySpend', 'energyRefund', 'energySync'].includes(op.type)) return null;
  const ch = (data.characters || []).find((c) => c.id === op.charId);
  if (!ch) return false;
  const stamp = { updatedAt: op.at || new Date().toISOString(), updatedBy: op.by || null };

  switch (op.type) {
    case 'dungeonSet': {
      const max = Math.max(0, Math.round(Number(op.max) || 0));
      const count = Math.max(0, Math.round(Number(op.count) || 0));
      const d = findDungeon(ch, op.name);
      if (d && d.count === count && d.max === max) return false;
      upsert(ch, op.name, { count: max ? Math.min(count, max) : count, max, ...stamp });
      return true;
    }
    case 'dungeonDelta': {
      const d = findDungeon(ch, op.name);
      if (!d) return false;
      const count = d.max ? advance(d.count, d.max, op.delta) : Math.max(0, d.count + op.delta);
      if (count === d.count) return false;
      Object.assign(d, { count, ...stamp });
      return true;
    }
    case 'dungeonDelete': {
      const before = (ch.dungeons || []).length;
      ch.dungeons = (ch.dungeons || []).filter((d) => norm(d.name) !== norm(op.name));
      return ch.dungeons.length !== before;
    }
    case 'dungeonOpen': {
      // Sayaç: ekranda görülen değer varsa ondan, yoksa sitedeki değerden ilerle.
      const d = upsert(ch, op.name, {});
      if (op.max) d.max = op.max;
      const base = op.seen != null ? op.seen : d.count;
      Object.assign(d, { count: advance(base, d.max, op.boxes), ...stamp });
      // Enerji: önce doğal, sonra ek.
      if (op.cost > 0) {
        const r = spendEnergy(ch.energy, energyCfg(data, ch), op.cost, Date.parse(op.at) || Date.now());
        ch.energy = { value: r.value, setAt: r.setAt, bonus: r.bonus, editedAt: stamp.updatedAt, setBy: op.by || null };
      }
      return true;
    }
    case 'energySpend': {
      if (!(op.cost > 0)) return false;
      const r = spendEnergy(ch.energy, energyCfg(data, ch), op.cost, Date.parse(op.at) || Date.now());
      ch.energy = { value: r.value, setAt: r.setAt, bonus: r.bonus, editedAt: stamp.updatedAt, setBy: op.by || null };
      return true;
    }
    case 'energySync': {
      const natural = Math.max(0, Math.round(Number(op.natural) || 0));
      const bonus = Math.max(0, Math.round(Number(op.bonus) || 0));
      const cfgMax = Number(data.config?.energy?.max) || 0;
      // Ekrandaki sınır genel ayardan farklıysa (ör. aboneliksiz 560) karaktere özel sınır olarak sakla.
      if (op.max > 0) { if (op.max !== cfgMax) ch.energyMax = op.max; else delete ch.energyMax; }
      ch.energy = { value: natural, setAt: stamp.updatedAt, bonus, editedAt: stamp.updatedAt, setBy: op.by || null };
      return true;
    }
    case 'energyRefund': {
      if (!(op.amount > 0)) return false;
      ch.energy = { ...(ch.energy || {}), bonus: bonusOf(ch.energy) + op.amount, editedAt: stamp.updatedAt, setBy: op.by || null };
      return true;
    }
    default:
      return false;
  }
}

export function dungeonOpMessage(op, data, by) {
  const ch = (data.characters || []).find((c) => c.id === op.charId);
  const who = by ? ` (${by})` : '';
  const name = ch?.name || op.charId;
  const d = ch ? findDungeon(ch, op.name) : null;
  const state = d ? ` ${d.count}/${d.max || '?'}` : '';
  switch (op.type) {
    case 'dungeonSet': case 'dungeonDelta': return `${name}: ${op.name}${state}${who}`;
    case 'dungeonDelete': return `${name}: ${op.name} sayacı silindi${who}`;
    case 'dungeonOpen': return `${name}: ${op.name} ${op.boxes} kutu, −${op.cost} enerji →${state}${op.auto ? ' (otomatik)' : ''}${who}`;
    case 'energySpend': return `${name}: ${op.name} ${op.boxes} kutu, −${op.cost} enerji (Transcendence)${op.auto ? ' (otomatik)' : ''}${who}`;
    case 'energyRefund': return `${name}: +${op.amount} enerji geri eklendi${who}`;
    case 'energySync': return `${name}: enerji ekrandan okundu ${op.natural}(+${op.bonus})${op.max ? `/${op.max}` : ''}${op.auto ? ' (otomatik)' : ''}${who}`;
    default: return `${name}: güncellendi${who}`;
  }
}
