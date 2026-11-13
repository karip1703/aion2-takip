// Enerji hesapları. Saf fonksiyonlar, DOM'a dokunmaz.
//
// config.energy:
//   max           : üst sınır (örn. 840)
//   regenAmount   : her tikte gelen miktar (örn. 15)
//   regenMinutes  : tik aralığı, dakika (örn. 180)
//   tickAnchorUtc : (isteğe bağlı) oyun tikleri sabit saatlerde oluyorsa bir tik anı,
//                   örn. "2026-01-01T00:00:00Z". Boşsa tikler giriş anından itibaren sayılır.
//
// energy (karakter başına): { value, setAt, bonus }
//   value/setAt : zamanla biriken (doğal) enerji → "setAt anında value kadar vardı"
//   bonus       : elle eklenen (+) enerji; zamanla değişmez, max'a sayılmaz

const MIN = 60_000;

// Karakter bazında max (ör. aboneliği olmayan hesap 560): ch.energyMax genel ayarı ezer.
export const energyCfg = (data, ch) => {
  const base = data?.config?.energy || {};
  return ch?.energyMax ? { ...base, max: ch.energyMax } : base;
};

export const bonusOf =(energy) => Math.max(0, Math.round(Number(energy?.bonus) || 0));

export function energyState(energy, cfg, now = Date.now()) {
  const st = naturalState(energy, cfg, now);
  const bonus = bonusOf(energy);
  return { ...st, bonus, total: (st.known ? st.current : 0) + bonus };
}

function naturalState(energy, cfg, now) {
  const max = Number(cfg.max) || 0;
  const amount = Number(cfg.regenAmount) || 0;
  const interval = (Number(cfg.regenMinutes) || 0) * MIN;

  if (!energy || energy.value == null || !energy.setAt) {
    return { known: false, max };
  }

  const setAt = Date.parse(energy.setAt);
  const base = Number(energy.value);
  if (!Number.isFinite(setAt) || !Number.isFinite(base) || !interval || !amount) {
    return { known: true, current: base, max, isFull: base >= max, msToFull: base >= max ? 0 : null };
  }

  const anchor = cfg.tickAnchorUtc ? Date.parse(cfg.tickAnchorUtc) : setAt;
  const idx = (t) => Math.floor((t - anchor) / interval);

  // setAt'ten şimdiye kadar geçen tik sayısı
  const ticks = Math.max(0, idx(now) - idx(setAt));
  const lastTickAt = anchor + idx(now) * interval;
  const nextTickAt = lastTickAt + interval;

  // Max'ın üstündeki değerler (ör. iksirle) korunur ama dolum yapmaz.
  const current = base >= max ? base : Math.min(max, base + ticks * amount);
  const isFull = current >= max;

  let msToFull = 0;
  let fullAt = now;
  if (!isFull) {
    const neededTicks = Math.ceil((max - current) / amount);
    fullAt = nextTickAt + (neededTicks - 1) * interval;
    msToFull = fullAt - now;
  }

  return {
    known: true,
    current, max, isFull, msToFull,
    fullAt: new Date(fullAt),
    msToNextTick: isFull ? null : nextTickAt - now,
    lastTickAt,
    ratio: max ? Math.min(1, current / max) : 0,
  };
}

// +/− butonları: hesaplanan değerin üzerine ekler. Tik fazı korunur ki
// bir sonraki dolum zamanı kaymasın.
export function adjustEnergy(energy, cfg, delta, now = Date.now()) {
  const st = energyState(energy, cfg, now);
  const current = st.known ? st.current : 0;
  const value = Math.max(0, Math.round(current + delta));
  // Anchor yoksa tikler setAt'ten sayılır; "son tik anında value vardı" diye kaydedersek
  // sonraki tik zamanı değişmez. Anchor varsa ya da enerji full/bilinmiyorsa şimdiki an yeterli.
  const keepPhase = st.known && !st.isFull && !cfg.tickAnchorUtc && st.lastTickAt != null;
  const setAt = keepPhase ? st.lastTickAt : now;
  return { value, setAt: new Date(setAt).toISOString() };
}

// Kutuya elle yazılan değer: "şu an X var".
export function setEnergy(value, now = Date.now()) {
  return { value: Math.max(0, Math.round(Number(value) || 0)), setAt: new Date(now).toISOString() };
}

// Ek (+) enerji: zaman bilgisi yok, doğal enerjinin tik fazına dokunmaz.
export const adjustBonus = (energy, delta) => ({ bonus: Math.max(0, bonusOf(energy) + Math.round(delta)) });
export const setBonus = (value) => ({ bonus: Math.max(0, Math.round(Number(value) || 0)) });

export function fmtDuration(ms) {
  if (ms == null) return '—';
  if (ms <= 0) return 'şimdi';
  const totalMin = Math.ceil(ms / MIN);
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d) return `${d}g ${h}sa`;
  if (h) return `${h}sa ${m}dk`;
  return `${m}dk`;
}
