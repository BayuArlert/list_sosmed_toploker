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
let isManualLoginRunning = false;

let lastSyncTime   = null;
let lastSyncStats  = null;   // { total, active, newAccount, nonaktif, error }
let lastSyncResults = [];    // hasil scrape terakhir untuk export
let sseClients     = [];     // Server-Sent Events clients

const IS_RAILWAY   = !!process.env.RAILWAY_ENVIRONMENT;
const COOKIES_FILE = IS_RAILWAY
  ? path.join('/tmp', 'ig_cookies.json')
  : path.join(__dirname, 'ig_cookies.json');

function ensureCookiesFromEnv() {
  if (!process.env.IG_COOKIES_JSON || fs.existsSync(COOKIES_FILE)) return;
  try {
    fs.writeFileSync(COOKIES_FILE, process.env.IG_COOKIES_JSON.trim());
    console.log('🍪 Cookies Instagram dimuat dari IG_COOKIES_JSON');
  } catch (err) {
    console.warn('Gagal menulis cookies dari env:', err.message);
  }
}

function normalizeInstagramCookies(cookies) {
  if (!Array.isArray(cookies)) throw new Error('Cookies harus berupa array JSON');
  return cookies.map((c) => ({
    name: c.name,
    value: c.value,
    domain: c.domain || '.instagram.com',
    path: c.path || '/',
    expires: c.expires ?? c.expirationDate ?? -1,
    httpOnly: !!c.httpOnly,
    secure: c.secure !== false,
    sameSite: c.sameSite || 'Lax',
  }));
}

async function saveInstagramCookies() {
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  loggedIn = true;
}

async function hasInstagramSessionCookies(targetPage = page) {
  if (!targetPage) {
    if (fs.existsSync(COOKIES_FILE)) {
      try {
        const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8'));
        return cookies.some((c) => c.name === 'sessionid' && c.value);
      } catch {
        return false;
      }
    }
    return false;
  }

  try {
    const cookies = await targetPage.cookies('https://www.instagram.com');
    return cookies.some((c) => c.name === 'sessionid' && c.value);
  } catch {
    return false;
  }
}

async function isInstagramLoggedIn(targetPage = page) {
  if (!targetPage) return hasInstagramSessionCookies();

  try {
    const url = targetPage.url();
    if (url.includes('/accounts/login') || url.includes('/challenge')) {
      return false;
    }

    if (await hasInstagramSessionCookies(targetPage)) {
      return true;
    }

    return await targetPage.evaluate(() => {
      const onLogin = location.pathname.includes('/accounts/login');
      const hasLoginForm = !!document.querySelector('input[name="username"]');
      if (onLogin || hasLoginForm) return false;

      const loggedInHints = [
        'a[href="/direct/inbox/"]',
        'svg[aria-label="Home"]',
        'svg[aria-label="Beranda"]',
        'svg[aria-label="New post"]',
        'svg[aria-label="Buat"]',
        'a[href*="/accounts/edit/"]',
        '[data-testid="mobile-nav-home-link"]',
        'nav',
      ];
      return loggedInHints.some((sel) => document.querySelector(sel));
    });
  } catch {
    return hasInstagramSessionCookies(targetPage);
  }
}

async function dismissInstagramPopups(targetPage = page) {
  if (!targetPage) return;
  try {
    await targetPage.evaluate(() => {
      const clickMatch = (pattern) => {
        const els = Array.from(document.querySelectorAll('button, div[role="button"]'));
        const el = els.find((node) => pattern.test((node.innerText || '').trim()));
        if (el) el.click();
      };
      clickMatch(/not now|bukan sekarang|nanti/i);
      clickMatch(/save info|simpan info|save login/i);
    });
  } catch {}
}

async function verifyInstagramSession() {
  if (!page) return false;
  try {
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(2500);
    loggedIn = await isInstagramLoggedIn();
    return loggedIn;
  } catch {
    loggedIn = false;
    return false;
  }
}

function getPuppeteerLaunchOpts({ manual = false } = {}) {
  const headlessEnv = process.env.IG_HEADLESS;
  const headless =
    manual && !IS_RAILWAY
      ? false
      : headlessEnv === 'false'
        ? false
        : 'new';

  const launchOpts = {
    headless,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
    ],
  };

  if (process.env.IG_PROXY_SERVER) {
    launchOpts.args.push(`--proxy-server=${process.env.IG_PROXY_SERVER}`);
  }

  const chromePaths = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter(Boolean);

  for (const chromePath of chromePaths) {
    if (fs.existsSync(chromePath)) {
      launchOpts.executablePath = chromePath;
      break;
    }
  }

  return launchOpts;
}

async function setupInstagramPage(targetPage) {
  await targetPage.setUserAgent(USER_AGENT);
  await targetPage.setViewport({ width: 1366, height: 768 });
  await targetPage.setExtraHTTPHeaders({
    'accept-language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  });
  await targetPage.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  if (process.env.IG_PROXY_USERNAME && process.env.IG_PROXY_PASSWORD) {
    try {
      await targetPage.authenticate({
        username: process.env.IG_PROXY_USERNAME,
        password: process.env.IG_PROXY_PASSWORD,
      });
    } catch {}
  }
}

async function loadInstagramCookies() {
  if (!page || !fs.existsSync(COOKIES_FILE)) return false;
  try {
    const cookies = normalizeInstagramCookies(JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf8')));
    await page.setCookie(...cookies);
    return true;
  } catch {
    broadcast('log', { message: '⚠️  Gagal load cookies, perlu login ulang' });
    return false;
  }
}
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
  browser = await puppeteer.launch(getPuppeteerLaunchOpts());
  page = await browser.newPage();
  await setupInstagramPage(page);

  if (await loadInstagramCookies()) {
    const ok = await verifyInstagramSession();
    if (ok) {
      broadcast('log', { message: '🍪 Sesi Instagram aktif (cookies valid)' });
    } else {
      broadcast('log', { message: '⚠️  Cookies expired — silakan login manual atau import cookies di dashboard.' });
      loggedIn = false;
    }
  } else {
    broadcast('log', { message: '⚠️  Tidak ada cookies — silakan login manual atau import cookies di dashboard.' });
  }
}

// ═══════════════════════════════════════════════
//  LOGIN INSTAGRAM
// ═══════════════════════════════════════════════
async function loginInstagram(username, password) {
  await initBrowser();
  try {
    broadcast('log', { message: '🔐 Mencoba login Instagram...' });

    if (await verifyInstagramSession()) {
      broadcast('log', { message: '✅ Sudah login — sesi Instagram masih aktif' });
      return { success: true, message: 'Sudah login. Sesi Instagram masih aktif.' };
    }

    // Bersihkan cookies lama supaya login baru tidak bentrok
    if (page) {
      try {
        await page.deleteCookie(...(await page.cookies()));
      } catch {}
    }
    if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
    loggedIn = false;

    const resp = await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    if (resp && resp.status && resp.status() === 429) {
      throw new Error(
        'Instagram membalas HTTP 429 (rate limit / blokir IP).\n' +
        'Solusi: login manual di browser, import cookies, atau pakai proxy residential.'
      );
    }

    // IG kadang redirect ke home jika sesi masih ada
    if (await isInstagramLoggedIn()) {
      await saveInstagramCookies();
      broadcast('log', { message: '✅ Login Instagram berhasil!' });
      return { success: true, message: 'Login berhasil!' };
    }

    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn  = btns.find(b => b.innerText.match(/allow|accept|setuju/i));
      if (btn) btn.click();
    }).catch(() => {});
    await sleep(1000);

    const userSelectors = [
      'input[name="username"]',
      'input[autocomplete="username"]',
      'input[aria-label*="username" i]',
      'input[aria-label*="nama pengguna" i]',
      'input[aria-label*="nomor ponsel" i]',
      'input[aria-label*="phone" i]',
      'input[aria-label*="email" i]',
      'form input[type="text"]:first-of-type',
      'input[type="text"]',
    ];
    const passSelectors = [
      'input[name="password"]',
      'input[type="password"]',
      'input[autocomplete="current-password"]',
      'input[aria-label*="password" i]',
      'input[aria-label*="kata sandi" i]',
    ];

    // Tunggu lebih lama agar React selesai render
    await sleep(4000);

    let userSel = null;

    // Coba klik tombol login jika perlu
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('span, button, a')).filter(el => /log in|login|masuk/i.test(el.innerText || ''));
      if (btns.length > 0) btns[btns.length - 1].click();
    }).catch(() => {});
    await sleep(2000);

    for (const sel of userSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000, visible: true });
        userSel = sel;
        break;
      } catch {}
    }

    // Fallback: coba langsung via evaluate jika selector biasa tidak work
    if (!userSel) {
      const found = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const textInput = inputs.find(i => i.type === 'text' || i.type === 'email' || i.type === 'tel' || i.name === 'username');
        return textInput ? (textInput.name || textInput.type || 'unknown') : null;
      });
      if (found) {
        // Isi langsung via JavaScript sebagai last resort
        broadcast('log', { message: `🔧 Mengisi form via JS evaluate (selector fallback: ${found})...` });
        const filled = await page.evaluate((u, p) => {
          const inputs = Array.from(document.querySelectorAll('input'));
          const userInput = inputs.find(i => i.type === 'text' || i.type === 'email' || i.type === 'tel' || i.name === 'username');
          const passInput = inputs.find(i => i.type === 'password');
          if (!userInput || !passInput) return false;
          const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeInputValueSetter.call(userInput, u);
          userInput.dispatchEvent(new Event('input', { bubbles: true }));
          nativeInputValueSetter.call(passInput, p);
          passInput.dispatchEvent(new Event('input', { bubbles: true }));
          return true;
        }, username, password);

        if (filled) {
          await sleep(1000);
          await page.evaluate(() => {
            const btn = document.querySelector('button[type="submit"]') ||
              Array.from(document.querySelectorAll('button')).find(b => /log in|login|masuk/i.test(b.innerText));
            if (btn) btn.click();
          });
          await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
          await sleep(5000);
          if (await isInstagramLoggedIn()) {
            await saveInstagramCookies();
            broadcast('log', { message: '✅ Login Instagram berhasil (via JS evaluate)!' });
            return { success: true, message: 'Login berhasil!' };
          }
        }
      }
    }

    if (!userSel) {
      if (await isInstagramLoggedIn()) {
        await saveInstagramCookies();
        return { success: true, message: 'Login berhasil (redirect ke beranda).' };
      }
      const diag = await getPageDiag();
      throw new Error(
        'Form login tidak ditemukan.\n' +
        `Diag: ${diag}\n` +
        'Coba: (1) Login Manual di dashboard, atau (2) Import cookies dari Chrome.'
      );
    }

    await page.click(userSel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(userSel, username, { delay: 80 });
    await sleep(500);

    let passSel = null;
    for (const sel of passSelectors) {
      try {
        await page.waitForSelector(sel, { timeout: 8000, visible: true });
        passSel = sel;
        break;
      } catch {}
    }
    if (!passSel) throw new Error('Field password tidak ditemukan.');

    await page.click(passSel, { clickCount: 3 });
    await page.keyboard.press('Backspace');
    await page.type(passSel, password, { delay: 80 });
    await sleep(500);

    await page.evaluate(() => {
      const btn = document.querySelector('button[type="submit"]') ||
        Array.from(document.querySelectorAll('button')).find(b => /log in|login|masuk/i.test(b.innerText));
      if (btn) btn.click();
    });

    await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await sleep(5000);

    if (await isInstagramLoggedIn()) {
      await saveInstagramCookies();
      broadcast('log', { message: '✅ Login Instagram berhasil!' });
      if (IS_RAILWAY) {
        broadcast('log', {
          message:
            '💡 Supaya sesi tetap setelah redeploy: salin isi ig_cookies.json ke variable IG_COOKIES_JSON di Railway.',
        });
      }
      return { success: true, message: 'Login berhasil!' };
    }

    const url = page.url();
    if (url.includes('/accounts/login/')) {
      const msg = await page.evaluate(() => {
        const el = document.querySelector('p[id^="slfErrorAlert"], div[class*="error"]');
        return el ? el.innerText : 'Login gagal. Cek username/password atau gunakan Login Manual.';
      });
      return { success: false, message: msg };
    }
    if (url.includes('/challenge/')) {
      return { success: false, message: 'Instagram meminta verifikasi. Gunakan Login Manual di browser.' };
    }

    const diag = await getPageDiag();
    return { success: false, message: `Login belum terkonfirmasi. ${diag}` };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

async function loginInstagramManual() {
  if (IS_RAILWAY) {
    throw new Error('Login manual hanya tersedia saat server dijalankan di PC lokal (bukan Railway).');
  }

  if (browser && browser.isConnected()) {
    try { await browser.close(); } catch {}
    browser = null;
    page = null;
  }

  broadcast('log', { message: '🪟 Membuka browser Chrome untuk login manual...' });
  try {
    browser = await puppeteer.launch(getPuppeteerLaunchOpts({ manual: true }));
  } catch (err) {
    throw new Error(`Gagal membuka Chrome: ${err.message}. Pastikan Google Chrome terinstall.`);
  }

  page = await browser.newPage();
  await setupInstagramPage(page);

  if (fs.existsSync(COOKIES_FILE)) fs.unlinkSync(COOKIES_FILE);
  loggedIn = false;

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  broadcast('log', { message: '👤 Login di jendela Chrome yang muncul. Script menunggu sampai sukses (max 5 menit)...' });

  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    await sleep(2000);
    await dismissInstagramPopups(page);
    if (await isInstagramLoggedIn(page)) {
      await saveInstagramCookies();
      loggedIn = true;
      broadcast('log', { message: '✅ Login manual berhasil! Cookies disimpan.' });
      return { success: true, message: 'Login manual berhasil! Cookies disimpan.' };
    }
  }

  throw new Error('Timeout 5 menit. Login manual belum selesai.');
}

async function runManualLoginJob() {
  if (isManualLoginRunning) return;
  isManualLoginRunning = true;
  try {
    const result = await loginInstagramManual();
    broadcast('loginEnd', result);
    broadcast('loginStatus', { loggedIn: true });
  } catch (err) {
    broadcast('log', { message: `❌ Login manual gagal: ${err.message}` });
    broadcast('loginEnd', { success: false, message: err.message });
  } finally {
    isManualLoginRunning = false;
  }
}

async function importInstagramCookies(rawCookies) {
  await initBrowser();
  const cookies = normalizeInstagramCookies(rawCookies);
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  await page.deleteCookie(...(await page.cookies())).catch(() => {});
  await page.setCookie(...cookies);

  if (await verifyInstagramSession()) {
    broadcast('log', { message: '✅ Cookies diimport — sesi Instagram aktif' });
    return { success: true, message: 'Cookies berhasil diimport. Sesi Instagram aktif.' };
  }

  loggedIn = false;
  return {
    success: false,
    message: 'Cookies disimpan, tapi sesi belum valid. Pastikan export dari instagram.com saat sudah login.',
  };
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
  lastSyncResults = [];

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

      lastSyncResults.push({
        sheetName: item.sheetName,
        namaArea: item.namaArea,
        link: item.link,
        status: result.status,
        followers: result.followers ?? null,
        value: cellValue,
        writtenToSheet: item.todayCol != null,
        targetDate: item.targetDate ?? null,
        targetDateMode: item.targetDateMode ?? null,
        scrapedAt: new Date().toISOString(),
      });

      // Tulis ke SPS
      if (item.todayCol != null) {
        try {
          await writeResult(item.sheetName, item.rowIndex, item.todayCol, cellValue);
          if (item.targetDateMode === 'week') {
            broadcast('log', {
              message: `  📝 Ditulis ke kolom ${item.targetDate}`,
            });
          }
        } catch (err) {
          broadcast('log', { message: `  ⚠️  Gagal tulis ke Sheets: ${err.message}` });
        }
      } else {
        broadcast('log', {
          message: `  ℹ️  Follower: ${cellValue} — tidak ditulis ke sheet (kolom minggu tidak ditemukan)`,
        });
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

  if (lastSyncResults.length > 0) {
    try {
      const stamp = lastSyncTime.replace(/[:.]/g, '-');
      const exportPath = path.join(__dirname, `sync_export_${stamp}.json`);
      fs.writeFileSync(exportPath, JSON.stringify({
        syncedAt: lastSyncTime,
        stats,
        results: lastSyncResults,
      }, null, 2));
      broadcast('log', { message: `💾 Hasil disimpan: ${path.basename(exportPath)} (bisa download dari dashboard)` });
    } catch (err) {
      broadcast('log', { message: `⚠️  Gagal simpan file export: ${err.message}` });
    }
  }

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

// Dashboard UI
app.get('/', (req, res) => {
  res.sendFile('index.html', { root: __dirname });
});

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
app.get('/status', async (req, res) => {
  if (page) {
    loggedIn = await isInstagramLoggedIn(page);
  } else {
    loggedIn = await hasInstagramSessionCookies();
  }

  res.json({
    loggedIn,
    isSyncing,
    lastSyncTime,
    lastSyncStats,
    exportAvailable: lastSyncResults.length,
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

// Login manual via browser (PC lokal) — langsung respon, proses di background
app.post('/instagram-login-manual', (req, res) => {
  if (IS_RAILWAY) {
    return res.json({
      success: false,
      message: 'Login manual hanya tersedia saat server dijalankan di PC lokal (bukan Railway).',
    });
  }
  if (isManualLoginRunning) {
    return res.json({
      success: true,
      pending: true,
      message: 'Login manual sedang berjalan. Cek jendela Chrome yang sudah terbuka.',
    });
  }

  res.json({
    success: true,
    pending: true,
    message: 'Browser Chrome akan dibuka. Login di jendela tersebut, lalu pantau log di bawah.',
  });

  runManualLoginJob();
});

// Import cookies dari Chrome/extension
app.post('/instagram-cookies', async (req, res) => {
  const { cookies } = req.body;
  if (!cookies) return res.status(400).json({ success: false, message: 'Field cookies wajib (array JSON)' });
  try {
    const result = await importInstagramCookies(cookies);
    res.json(result);
  } catch (err) {
    res.json({ success: false, message: err.message });
  }
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
app.get('/login-status', async (req, res) => {
  if (page) await verifyInstagramSession();
  res.json({ loggedIn });
});

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

// Export hasil sync terakhir
app.get('/sync/results', (req, res) => {
  res.json({
    syncedAt: lastSyncTime,
    stats: lastSyncStats,
    results: lastSyncResults,
  });
});

app.get('/sync/export.csv', (req, res) => {
  if (!lastSyncResults.length) {
    return res.status(404).json({ success: false, message: 'Belum ada hasil sync untuk diexport.' });
  }

  const header = ['sheet', 'nama_area', 'link', 'status', 'followers', 'value', 'written_to_sheet', 'target_date', 'target_date_mode', 'scraped_at'];
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [
    header.join(','),
    ...lastSyncResults.map((r) =>
      [
        r.sheetName,
        r.namaArea,
        r.link,
        r.status,
        r.followers,
        r.value,
        r.writtenToSheet,
        r.targetDate,
        r.targetDateMode,
        r.scrapedAt,
      ].map(escape).join(',')
    ),
  ];

  const stamp = (lastSyncTime || new Date().toISOString()).slice(0, 10);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sync_export_${stamp}.csv"`);
  res.send('\uFEFF' + lines.join('\n'));
});

app.get('/sync/export.json', (req, res) => {
  if (!lastSyncResults.length) {
    return res.status(404).json({ success: false, message: 'Belum ada hasil sync untuk diexport.' });
  }

  const stamp = (lastSyncTime || new Date().toISOString()).slice(0, 10);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="sync_export_${stamp}.json"`);
  res.json({
    syncedAt: lastSyncTime,
    stats: lastSyncStats,
    results: lastSyncResults,
  });
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
app.listen(PORT, '0.0.0.0', async () => {
  const host = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : `http://localhost:${PORT}`;
  console.log(`✅ Server berjalan di ${host}`);
  ensureCookiesFromEnv();
  try {
    await initBrowser();
  } catch (err) {
    console.warn('⚠️  Browser belum siap (akan dicoba saat login/sync):', err.message);
  }
});