// Zamanlı etkinlikler (EU sunucuları). Hatırlatıcı bunları bosslarla aynı şekilde hesaplar (bosses.js → nextScheduled).
// Saatler sunucu saatine (Europe/Paris) göredir; tz: 'UTC' olanlar UTC'ye sabittir.
// Kaynak: topluluk zamanlayıcıları (daevaguides.com/en/guides/timers, Kasım 2026). Oyunda farklıysa buradan düzeltilir.

const everyHour = (mm) => Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, '0')}:${mm}`);

export const EVENTS = [
  { id: 'event-shugo', name: 'Shugo Festivali', area: 'Her saat başı · 10 dk', kind: 'schedule', days: null, times: everyHour('00'), duration: 10 },
  { id: 'event-invasion', name: 'Boyutsal İstila', area: 'Her saat :30 · giriş 3 dk', kind: 'schedule', days: null, times: everyHour('30'), duration: 3 },
  { id: 'event-rift', name: 'Spacetime Rift', area: '3 saatte bir · giriş 10 dk', kind: 'schedule', days: null,
    times: ['02:00', '05:00', '08:00', '11:00', '14:00', '17:00', '20:00', '23:00'], duration: 10 },
  { id: 'event-daily-reset', name: 'Günlük sıfırlama', area: 'Her gün', kind: 'schedule', tz: 'UTC', days: null, times: ['07:00'], duration: 1 },
  { id: 'event-weekly-reset', name: 'Haftalık sıfırlama', area: 'Çarşamba', kind: 'schedule', tz: 'UTC', days: [3], times: ['07:00'], duration: 1 },
];
