// SHA çakışmasında birleştirme.
// Site sadece karakterlerin `energy` alanını değiştirir. Bu yüzden birleştirme şöyle yapılır:
// uzaktaki EN GÜNCEL dosya alınır ve bizim bekleyen enerji düzenlemelerimiz onun üstüne uygulanır.
// Aynı karakteri diğer kişi bizden SONRA düzenlediyse (editedAt daha yeni) onunki kalır.

export const editTime = (en) => Date.parse(en?.editedAt || en?.setAt || 0) || 0;

export function applyEnergyEdits(remoteData, edits) {
  const data = structuredClone(remoteData);
  const applied = [];
  const skipped = [];
  for (const [id, edit] of Object.entries(edits)) {
    const ch = data.characters?.find((c) => c.id === id);
    if (!ch) { skipped.push({ id, reason: 'karakter dosyada yok' }); continue; }
    if (editTime(ch.energy) > editTime(edit)) {
      skipped.push({ id, name: ch.name, reason: 'diğer kullanıcı daha yeni bir değer kaydetmiş' });
      continue;
    }
    ch.energy = { ...edit };
    const bonus = Math.round(Number(edit.bonus) || 0);
    applied.push({ id, name: ch.name, value: bonus ? `${edit.value ?? '?'}+${bonus}` : edit.value });
  }
  return { data, applied, skipped };
}
