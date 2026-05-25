/**
 * server.js — IG Follower Scraper + Google Sheets Integration
 * Fitur: Login IG, scrape followers, sync ke SPS, scheduler jam 7 WIB
 */

const express  = require('express');
const puppeteer = require('puppeteer');
const cron     = require('node-cron');
const fs       = require('fs');
const path     = require('path');
require('dotenv').config();

const { checkCredentials, readAllLinks, writeResult, getSpreadsheetInfo } = require('./sheets');

const app = express();
app.use(express.json());
app.use(require('cors')());
app.use(express.static(__dirname));

// ═══════════════════════════════════════════════
//  STATE GLOBAL
// ═══════════════════════════════════════════════
let browser   = null;
let page      = null;
let loggedIn  = false;
let isSyncing = false;
let stopRequested = false;

let lastSyncTime   = null;
let lastSyncStats  = null;   // { total, active, newAccount, nonaktif, error }
let sseClients     = [];     // Server-Sent Events clients

const COOKIES_FILE = path.join(__dirname, 'ig_cookies.json');
const USER_AGENT   =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
  'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Helpers ──────────────────────────────────────
const sleep     = (ms)       => new Promise(r => setTimeout(r, ms));
const randDelay = (min, max) => sleep(min + Math.random() * (max - min));

function broadcast(type, payload) {
  const data = JSON.stringify({ type, ...payload });
  sseClients.forEach(res => {
    try { res.write(`data: ${data}\n\n`); } catch {}
  });
  if (type === 'log') console.log(payload.message);
}

// ═══════════════════════════════════════════════
//  BROWSER
// ═══════════════════════════════════════════════
async function initBrowser() {
  if (browser && browser.isConnected()) return;
  broadcast('log', { message: '🚀 Membuka browser Puppeteer...' });
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
  });
  page = await browser.newPage();
  await page.setUserAgent(USER_AGENT);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
      await page.setCookie(...cookies);
      loggedIn = true;
      broadcast('log', { message: '🍪 Cookies dimuat — sesi Instagram aktif' });
    } catch {
      broadcast('log', { message: '⚠️  Gagal load cookies, perlu login ulang' });
    }
  }
}

// ═══════════════════════════════════════════════
//  LOGIN INSTAGRAM
// ═══════════════════════════════════════════════
async function loginInstagram(username, password) {
  await initBrowser();
  try {
    broadcast('log', { message: '🔐 Mencoba login Instagram...' });
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle2', timeout: 60000 });
    await sleep(4000);

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn  = btns.find(b => b.innerText.match(/allow|accept|setuju/i));
      if (btn) btn.click();
    }).catch(() => {});
    await sleep(1000);

    // Coba temukan form login. Kadang Instagram menampilkan landing page dengan tombol "Log in" dulu.
    let userSel = await page.evaluate(() => {
      if (document.querySelector('input[name="username"]')) return 'input[name="username"]';
      return null;
    });

    if (!userSel) {
      // Cari dan klik tombol "Log in" jika form tidak langsung terlihat
      await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('span, button, a')).filter(el => /log in|login|masuk/i.test(el.innerText || ''));
        if (btns.length > 0) btns[btns.length - 1].click(); // Biasa tombol paling spesifik ada di akhir
      }).catch(() => {});
      await sleep(3000);
      userSel = await page.evaluate(() => {
        if (document.querySelector('input[name="username"]')) return 'input[name="username"]';
        return null;
      });
    }
    
    if (!userSel) throw new Error('Form login tidak ditemukan. Coba lagi atau gunakan auth manual.');

    await page.click(userSel);
    await page.type(userSel, username, { delay: 80 });
    await sleep(500);

    const passSel = await page.evaluate(() => {
      if (document.querySelector('input[name="password"]')) return 'input[name="password"]';
      return null;
    });
    if (passSel) {
      await page.click(passSel);
      await page.type(passSel, password, { delay: 80 });
      await sleep(500);
    }

    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /log in|login|masuk/i.test(b.innerText));
      if (btn) btn.click();
    });

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
    await sleep(5000);

    const url = page.url();
    if (url.includes('/accounts/login/')) {
      const msg = await page.evaluate(() => {
        const el = document.querySelector('p[id^="slfErrorAlert"], div[class*="error"]');
        return el ? el.innerText : 'Login gagal. Cek username/password.';
      });
      return { success: false, message: msg };
    }
    if (url.includes('/challenge/')) {
      return { success: false, message: 'Instagram meminta verifikasi 2FA. Selesaikan di browser biasa dulu.' };
    }

    const cookies = await page.cookies();
    fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
    loggedIn = true;
    broadcast('log', { message: '✅ Login Instagram berhasil!' });
    return { success: true, message: 'Login berhasil!' };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ═══════════════════════════════════════════════
//  PARSE ANGKA FOLLOWERS
// ═══════════════════════════════════════════════
function parseFollowers(raw) {
  if (!raw) return null;
  const s = raw.toString().trim();
  const rb = s.match(/([\d]+[,\.]?[\d]*)\s*rb/i);
  if (rb) return Math.round(parseFloat(rb[1].replace(',', '.')) * 1000);
  const jt = s.match(/([\d]+[,\.]?[\d]*)\s*jt/i);
  if (jt) return Math.round(parseFloat(jt[1].replace(',', '.')) * 1_000_000);
  const km = s.match(/^([\d]+[,\.]?[\d]*)\s*([KkMm])$/);
  if (km) return Math.round(parseFloat(km[1].replace(',', '.')) * (/[Mm]/.test(km[2]) ? 1_000_000 : 1_000));
  const d = s.replace(/[.,\s]/g, '').replace(/[^0-9]/g, '');
  if (d && d.length <= 12) return parseInt(d);
  return null;
}

// ═══════════════════════════════════════════════
//  SCRAPE SATU AKUN
//  Return: { status: 'active'|'new'|'nonaktif'|'error', followers: number|null }
// ═══════════════════════════════════════════════
async function scrapeAccount(rawLink) {
  // Normalisasi URL
  let url = rawLink.trim();
  if (!url.startsWith('http')) url = 'https://' + url;

  // Jika bukan URL Instagram, langsung konstruksi instagram.com/[hostname]
  // supaya tidak buang waktu 30 detik timeout di domain .top yang mati
  if (!url.includes('instagram.com')) {
    const hostname = url.replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
    url = `https://www.instagram.com/${hostname}`;
  }

  // Ekstrak username untuk memfilter hanya endpoint spesifik profil ini
  const igUsername = url.replace(/^https?:\/\/(www\.)?instagram\.com\//i, '').replace(/\/$/, '').split('?')[0].toLowerCase();

  let exactFollowersApi = null;
  const onResponse = async (r) => {
    const rUrl = r.url();
    try {
      // Prioritas 1: web_profile_info — endpoint khusus untuk profil yg diminta
      if (rUrl.includes('web_profile_info')) {
        const text = await r.text();
        const m = text.match(/"follower_count":(\d+)/);
        if (m) { exactFollowersApi = m[1]; return; }
      }
      // Prioritas 2: graphql edge_followed_by — selalu dari 1 profil spesifik
      if (rUrl.includes('graphql') || rUrl.includes('api/v1')) {
        const text = await r.text();
        const m = text.match(/"edge_followed_by":\{"count":(\d+)\}/);
        if (m && !exactFollowersApi) exactFollowersApi = m[1];
      }
    } catch (e) {}
  };

  page.on('response', onResponse);

  let gotoError = false;
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(1500);
  } catch {
    gotoError = true;
    await sleep(2000); // Tunggu sebentar siapa tahu DOM halaman "Sorry" sudah dirender
  }

  const finalUrl = page.url();

  // ── Jika bukan di instagram.com, coba langsung ke instagram.com/[username] ──
  if (!finalUrl.includes('instagram.com')) {
    // Cari link IG di halaman dulu
    const igLink = await page.evaluate(() => {
      const a = Array.from(document.querySelectorAll('a[href]'))
        .find(el => el.href && el.href.includes('instagram.com'));
      return a ? a.href : null;
    }).catch(() => null);

    if (igLink) {
      try {
        await page.goto(igLink, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(1500);
      } catch {
        gotoError = true;
        await sleep(2000);
      }
    } else {
      // Tidak ada link IG di halaman → coba konstruksi instagram.com/[domain]
      // mis. lokerbanyuwangi.top → instagram.com/lokerbanyuwangi.top
      let hostname = rawLink.trim().replace(/^https?:\/\//i, '').replace(/^www\./i, '').split('/')[0];
      const igDirect = `https://www.instagram.com/${hostname}`;
      try {
        await page.goto(igDirect, { waitUntil: 'networkidle2', timeout: 30000 });
        await sleep(1500);
      } catch {
        gotoError = true;
        await sleep(2000);
      }
      // Jika setelah goto langsung ke IG, halaman still not IG → nonaktif
      if (!page.url().includes('instagram.com')) {
        page.off('response', onResponse);
        return { status: 'nonaktif', followers: null };
      }
    } // end else
  } // end if (!finalUrl.includes('instagram.com'))

  // ── Cek apakah terlempar ke halaman Login atau Sesi Habis (Logged Out) ──
  // Jika Instagram me-load profil tetapi kita dalam state Logged Out, IG tidak akan memberikan exact number.
  const isLoginPage = await page.evaluate(() => {
    const hasLoginButton = Array.from(document.querySelectorAll('a, button, span')).some(el => {
      const text = (el.innerText || '').toLowerCase();
      return (text === 'log in' || text === 'login' || text === 'masuk') && el.offsetHeight > 0;
    });
    const urlRedirect = window.location.href.includes('/accounts/login') || window.location.href.includes('/challenge');
    const hasLoginForm = !!document.querySelector('input[name="username"]');
    return hasLoginButton || urlRedirect || hasLoginForm;
  });

  if (isLoginPage) {
    page.off('response', onResponse);
    return { status: 'error', followers: null, reason: 'login_required' };
  }

  // ── Cek apakah halaman "tidak tersedia" ──
  const isNotAvailable = await page.evaluate(() => {
    const body = (document.body && document.body.innerText) || '';
    return /sorry.*page.*isn.*t available|halaman ini tidak tersedia|page not found/i.test(body) ||
      (document.title && /page not found|not available/i.test(document.title));
  }).catch(() => false);

  if (isNotAvailable) {
    page.off('response', onResponse);
    return { status: 'nonaktif', followers: null };
  }

  // Jika error timeout dan bukan halaman nonaktif, berarti benar-benar gagal load
  if (gotoError) {
    page.off('response', onResponse);
    return { status: 'error', followers: null };
  }

  // ── Coba ambil angka followers ──
  await page.waitForSelector('main', { timeout: 6000 }).catch(() => {});
  // Tunggu spesifik elemen title muncul di React (angka riil)
  await page.waitForSelector('span[title]', { timeout: 4000 }).catch(() => {});
  await sleep(500);

  if (exactFollowersApi !== null) {
    page.off('response', onResponse);
    const count = parseInt(exactFollowersApi);
    if (count === 0) return { status: 'new', followers: 0 };
    return { status: 'active', followers: count };
  }

  // ── Fetch internal API for exact follower count ──
  // Melakukan request langsung dari browser context menggunakan kredensial aktif
  const directApiCount = await page.evaluate(async (username) => {
    try {
      const res = await fetch(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${username}`, {
        headers: {
          'x-ig-app-id': '936619743392459',
        }
      });
      if (res.ok) {
        const json = await res.json();
        if (json && json.data && json.data.user && json.data.user.edge_followed_by) {
          return json.data.user.edge_followed_by.count;
        }
      }
    } catch (e) {}
    return null;
  }, igUsername).catch(() => null);

  if (directApiCount !== null) {
    page.off('response', onResponse);
    if (directApiCount === 0) return { status: 'new', followers: 0 };
    return { status: 'active', followers: directApiCount };
  }

  const candidates = await page.evaluate(() => {
    const results = [];

    // 1. JSON di script tag
    for (const s of Array.from(document.querySelectorAll('script'))) {
      const t = s.textContent || '';
      if (!t.includes('follower')) continue;
      for (const pat of [
        /"edge_followed_by":\{"count":(\d+)\}/,
        /"follower_count":(\d+)/,
        /"followers":(\d+)/,
      ]) {
        const m = t.match(pat);
        if (m && parseInt(m[1]) >= 0) { results.push(m[1]); break; }
      }
      if (results.length) break;
    }

    // 2. span[title] dekat "followers"
    if (!results.length) {
      for (const el of Array.from(document.querySelectorAll('span[title]'))) {
        const title = (el.getAttribute('title') || '').trim();
        if (!/^[\d,\.]+$/.test(title)) continue;
        let node = el.parentElement;
        for (let i = 0; i < 6 && node && node.tagName !== 'BODY'; i++) {
          if (/follower|pengikut/i.test(node.textContent || '')) { results.push(title); break; }
          node = node.parentElement;
        }
        if (results.length) break;
      }
    }

    // 3. Meta description
    if (!results.length) {
      const meta = document.querySelector('meta[name="description"]');
      const c    = meta ? meta.getAttribute('content') || '' : '';
      const m    = c.match(/([\d,\.]+[\s]*(rb|jt|[KkMm])?)[^\d]*(Followers|followers|pengikut)/i);
      if (m) results.push(m[1].trim());
    }

    // 4. Body text fallback
    if (!results.length) {
      const txt = (document.body && document.body.innerText) || '';
      const m = txt.match(/([\d,\.]+[\s]*(rb|jt|[KkMm])?)\s*(followers|pengikut)/i);
      if (m) results.push(m[1].trim());
    }

    return results;
  }).catch(() => []);

  // Retry sekali jika kosong
  if (candidates.length === 0 && exactFollowersApi === null) {
    await sleep(2000);
    await page.reload({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(3000);
    
    // Cek API lagi
    if (exactFollowersApi !== null) {
      page.off('response', onResponse);
      const count = parseInt(exactFollowersApi);
      if (count === 0) return { status: 'new', followers: 0 };
      return { status: 'active', followers: count };
    }

    // Evaluate ulang
    const newCandidates = await page.evaluate(() => {
      const results = [];
      const meta = document.querySelector('meta[name="description"]');
      const c = meta ? meta.getAttribute('content') || '' : '';
      const m = c.match(/([\d,\.]+[\s]*(rb|jt|[KkMm])?)[^\d]*(Followers|followers|pengikut)/i);
      if (m) results.push(m[1].trim());

      const txt = (document.body && document.body.innerText) || '';
      const m2 = txt.match(/([\d,\.]+[\s]*(rb|jt|[KkMm])?)\s*(followers|pengikut)/i);
      if (m2) results.push(m2[1].trim());
      
      return results;
    }).catch(() => []);
    candidates.push(...newCandidates);
  }

  page.off('response', onResponse);
  for (const c of candidates) {
    const parsed = parseFollowers(c);
    if (parsed !== null) {
      if (parsed === 0) return { status: 'new', followers: 0 };
      return { status: 'active', followers: parsed };
    }
  }

  return { status: 'error', followers: null };
}

// ═══════════════════════════════════════════════
//  MAIN SYNC — baca SPS → scrape → tulis balik
// ═══════════════════════════════════════════════
async function runSync() {
  if (isSyncing) {
    broadcast('log', { message: '⚠️  Sync sedang berjalan, lewati.' });
    return;
  }
  if (!checkCredentials()) {
    broadcast('log', { message: '❌ credentials.json tidak ditemukan! Setup Google Cloud dulu.' });
    return;
  }

  isSyncing = true;
  stopRequested = false;
  broadcast('syncStart', { message: '🔄 Memulai sinkronisasi...' });
  broadcast('log',       { message: '🔄 Memulai sinkronisasi dengan Google Sheets...' });

  const stats = { total: 0, active: 0, newAccount: 0, nonaktif: 0, error: 0 };

  try {
    await initBrowser();

    // Baca semua link dari semua sheet
    broadcast('log', { message: '📊 Membaca data dari Google Sheets...' });
    const links = await readAllLinks(msg => broadcast('log', { message: msg }));
    stats.total = links.length;
    broadcast('log', { message: `📋 Total akun ditemukan: ${links.length}` });
    broadcast('progress', { current: 0, total: links.length });

    for (let i = 0; i < links.length; i++) {
      // Cek apakah user minta stop
      if (stopRequested) {
        broadcast('log', { message: '⛔ Sync dihentikan oleh pengguna.' });
        break;
      }

      const item = links[i];
      broadcast('log', {
        message: `[${i + 1}/${links.length}] 🔍 ${item.namaArea} — ${item.link}`,
      });

      const result = await scrapeAccount(item.link);

      let cellValue;
      switch (result.status) {
        case 'active':
          cellValue = result.followers.toString();
          stats.active++;
          broadcast('log', { message: `  ✅ Aktif — ${result.followers.toLocaleString('id-ID')} followers` });
          break;
        case 'new':
          cellValue = 'NEW';
          stats.newAccount++;
          broadcast('log', { message: `  🆕 Aktif tapi 0 followers → NEW` });
          break;
        case 'nonaktif':
          cellValue = 'NONAKTIF';
          stats.nonaktif++;
          broadcast('log', { message: `  ❌ Akun tidak aktif → NONAKTIF` });
          break;
        default:
          // Gagal load atau minta login
          if (result.reason === 'login_required') {
             cellValue = 'ERROR';
             stats.error++;
             broadcast('log', { message: `  🔒 Sesi Habis! Instagram meminta login. Harap login ulang di dashboard.` });
             
             // Update status global & hapus cookie kedaluwarsa
             loggedIn = false;
             if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
             
             // Stop otomatis karena percuma lanjut jika minta login
             stopRequested = true;
          } else {
             cellValue = 'ERROR';
             stats.error++;
             broadcast('log', { message: `  ⚠️  Gagal load (timeout/jaringan) → ERROR` });
          }
      }

      // Tulis ke SPS
      if (item.todayCol != null) {
        try {
          await writeResult(item.sheetName, item.rowIndex, item.todayCol, cellValue);
        } catch (err) {
          broadcast('log', { message: `  ⚠️  Gagal tulis ke Sheets: ${err.message}` });
        }
      } else {
        broadcast('log', { message: `  ⚠️  Kolom hari ini tidak ditemukan di sheet ${item.sheetName}` });
      }

      broadcast('progress', { current: i + 1, total: links.length });

      // Jeda acak agar tidak terblokir Instagram
      if (i < links.length - 1) await randDelay(2000, 5000);
    }
  } catch (err) {
    broadcast('log', { message: `❌ Error saat sync: ${err.message}` });
  }

  lastSyncTime  = new Date().toISOString();
  lastSyncStats = stats;
  isSyncing     = false;

  broadcast('syncEnd', {
    message : `✅ Sinkronisasi selesai! Aktif: ${stats.active}, NEW: ${stats.newAccount}, Nonaktif: ${stats.nonaktif}, Error: ${stats.error}`,
    stats,
    lastSyncTime,
  });
  broadcast('log', {
    message: `✅ Selesai — Aktif: ${stats.active} | NEW: ${stats.newAccount} | Nonaktif: ${stats.nonaktif} | Error: ${stats.error}`,
  });
}

// ═══════════════════════════════════════════════
//  SCHEDULER — jam 07:00 WIB setiap hari
//  Karena server berjalan di mesin lokal WIB, cukup pakai '0 7 * * *'
// ═══════════════════════════════════════════════
cron.schedule('0 7 * * *', () => {
  broadcast('log', { message: '⏰ Scheduler: memulai sync otomatis jam 07:00 WIB' });
  runSync();
}, { timezone: 'Asia/Jakarta' });

console.log('⏰ Scheduler aktif: sync otomatis setiap pagi jam 07:00 WIB (Asia/Jakarta)');

// ═══════════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════════

// SSE — stream log & progress ke UI
app.get('/events', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();
  res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);
  sseClients.push(res);
  req.on('close', () => {
    sseClients = sseClients.filter(c => c !== res);
  });
});

// Status umum
app.get('/status', (req, res) => {
  res.json({
    loggedIn,
    isSyncing,
    lastSyncTime,
    lastSyncStats,
    credentialsReady: checkCredentials(),
    nextSync: '07:00 WIB setiap hari',
  });
});

// Login Instagram
app.post('/instagram-login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ success: false, message: 'Username/password wajib' });
  const result = await loginInstagram(username, password);
  res.json(result);
});

// Logout Instagram
app.post('/instagram-logout', async (req, res) => {
  try {
    if (page) await page.deleteCookie(...(await page.cookies()));
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    loggedIn = false;
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// Login status
app.get('/login-status', (req, res) => res.json({ loggedIn }));

// Manual trigger sync
app.post('/sync', async (req, res) => {
  if (isSyncing) return res.json({ success: false, message: 'Sync sedang berjalan' });
  res.json({ success: true, message: 'Sync dimulai, pantau log di bawah.' });
  runSync();
});

// Stop sync
app.post('/sync/stop', (req, res) => {
  if (!isSyncing) return res.json({ success: false, message: 'Tidak ada sync yang berjalan' });
  stopRequested = true;
  broadcast('log', { message: '⛔ Permintaan stop diterima, menghentikan setelah akun ini selesai...' });
  res.json({ success: true, message: 'Sync akan dihentikan setelah akun saat ini selesai.' });
});

// Info spreadsheet
app.get('/spreadsheet-info', async (req, res) => {
  try {
    const info = await getSpreadsheetInfo();
    res.json({ success: true, ...info });
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
});

// ── Start ──
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Server berjalan di http://localhost:${PORT}`);
  await initBrowser();
});