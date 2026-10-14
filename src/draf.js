const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

function wajib(nama) {
  const v = process.env[nama];
  if (!v) {
    console.error(`Secret/variabel ${nama} belum diisi.`);
    process.exit(1);
  }
  return v;
}

const GEMINI_API_KEY = wajib('GEMINI_API_KEY');
const BOT_TOKEN = wajib('TELEGRAM_BOT_TOKEN');
const CHAT_ID = wajib('TELEGRAM_CHAT_ID');

const baca = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

const PETUNJUK = {
  tips_digital_marketing:
    'Tulis SATU tips digital marketing yang praktis dan bisa langsung dicoba pemilik UMKM. Beri langkah konkret, bukan teori.',
  sejarah_digital:
    'Tulis SATU fakta sejarah teknologi digital yang menarik, lalu kaitkan singkat dengan manfaatnya bagi usaha kecil.',
  mitos_vs_fakta:
    'Tulis SATU mitos umum tentang website atau pemasaran digital untuk UMKM, lalu jelaskan faktanya.',
};

function buatPrompt(brand, jenis, riwayat) {
  const terpakai = riwayat.topik.slice(-100);
  return [
    `Kamu penulis konten media sosial untuk ${brand.nama_bisnis} (${brand.deskripsi}).`,
    `Bahasa: ${brand.bahasa}. Gaya: ${brand.gaya}.`,
    PETUNJUK[jenis] || PETUNJUK.tips_digital_marketing,
    jenis === 'sejarah_digital' ? brand.arahan_topik_sejarah || '' : '',
    `Panjang caption maksimal ${brand.panjang_maks_karakter} karakter. Awali dengan kalimat pembuka yang menarik.`,
    `Aturan tahun: ${brand.aturan_tahun}`,
    `Hindari: ${brand.hindari.join('; ')}.`,
    'Jangan menulis hashtag, ajakan penutup, atau kata "GAMBAR:" di dalam caption. Emoji boleh, paling banyak dua.',
    'Caption harus utuh dan selesai di akhir kalimat. Jangan memakai daftar bernomor; gunakan paragraf pendek atau poin dengan tanda •.',
    terpakai.length
      ? `Topik yang SUDAH dipakai, jangan diulang atau dibuat mirip: ${terpakai.join(' | ')}.`
      : '',
    'Balas HANYA dengan JSON: {"topik": "judul topik singkat maksimal 8 kata", "caption": "isi caption", "ide_visual": "judul singkat untuk ditulis di gambar (maksimal 7 kata), lalu satu atau dua kalimat gambaran visual yang cocok"}',
  ]
    .filter(Boolean)
    .join('\n');
}

async function tanyaGemini(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
  for (let percobaan = 1; percobaan <= 3; percobaan++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.9, responseMimeType: 'application/json' },
      }),
    });
    if (res.ok) {
      const data = await res.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      return parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
    }
    if ((res.status === 429 || res.status >= 500) && percobaan < 3) {
      await new Promise((r) => setTimeout(r, 15000 * percobaan));
      continue;
    }
    throw new Error(`Gemini gagal: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}

const bersih = (t) => String(t || '').replace(/GAMBAR:/gi, 'Gambar').trim();

async function kirimTelegram(teks) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: CHAT_ID,
      text: teks,
      link_preview_options: { is_disabled: true },
    }),
  });
  if (!res.ok) throw new Error(`Telegram gagal: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
}

(async () => {
  const brand = baca('brand.json');
  const riwayat = baca('riwayat.json');
  riwayat.topik = riwayat.topik || [];

  const jenis = brand.jenis_konten[riwayat.topik.length % brand.jenis_konten.length];

  const hasil = JSON.parse(
    (await tanyaGemini(buatPrompt(brand, jenis, riwayat))).replace(/```json|```/g, '').trim()
  );
  if (!hasil.topik || !hasil.caption) throw new Error('Balasan Gemini tidak lengkap.');

let caption = bersih(hasil.caption);
if (caption.length > brand.panjang_maks_karakter) {
  const ulang = await tanyaGemini(
    `Persingkat caption berikut menjadi maksimal ${brand.panjang_maks_karakter} karakter tanpa memotong kalimat dan tanpa daftar bernomor. Pertahankan makna dan gaya bahasanya. Balas HANYA dengan JSON: {"caption": "..."}\n\n${caption}`
  );
  try {
    const pendek = bersih(JSON.parse(ulang.replace(/```json|```/g, '').trim()).caption);
    if (pendek && pendek.length < caption.length) caption = pendek;
  } catch (e) {
    // kalau gagal diparse, pakai caption asli
  }
}
  const ide = bersih(hasil.ide_visual) || 'Belum ada ide visual dari Gemini.';

  const teks = [
    caption,
    brand.ajakan,
    brand.hashtag.join(' '),
    `--- IDE VISUAL (tidak ikut diposting) ---\n${ide}`,
    'Balas dengan nama file gambar (misalnya promosikita-07.jpg), atau balas OK untuk memakai gambar default.',
  ].join('\n\n');

  await kirimTelegram(teks);

  riwayat.topik.push(String(hasil.topik).trim());
  fs.writeFileSync(path.join(ROOT, 'riwayat.json'), JSON.stringify(riwayat, null, 2) + '\n');

  console.log(`Draf terkirim. Jenis: ${jenis}. Topik: ${hasil.topik}`);
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
