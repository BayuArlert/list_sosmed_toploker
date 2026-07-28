/**
 * sheets.js — Google Sheets API integration
 * Membaca link akun dari SPS dan menulis hasil scrape kembali
 */
const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');
require('dotenv').config();

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID || '1g9J5nx5GJXANj0Vs_-MYuULnuTeD9zDNC2PVWCYu_2k';
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');

function loadGoogleCredentials() {
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      return JSON.parse(process.env.GOOGLE_CREDENTIALS);
    } catch {
      throw new Error('GOOGLE_CREDENTIALS tidak valid (harus JSON service account)');
    }
  }
  if (fs.existsSync(CREDENTIALS_FILE)) {
    return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
  }
  return null;
}

// Dynamic sheet names will be fetched directly using getSpreadsheetInfo()

const MONTHS_ID = [
  'JANUARI','FEBRUARI','MARET','APRIL','MEI','JUNI',
  'JULI','AGUSTUS','SEPTEMBER','OKTOBER','NOVEMBER','DESEMBER',
];

// Konversi angka kolom (1-based) ke huruf (A, B, ... Z, AA, ...)
function columnToLetter(col) {
  let letter = '';
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

function checkCredentials() {
  return !!loadGoogleCredentials();
}

async function getAuth() {
  const credentials = loadGoogleCredentials();
  if (!credentials) {
    throw new Error(
      'Google credentials tidak ditemukan! ' +
      'Set GOOGLE_CREDENTIALS di Railway, atau letakkan credentials.json di folder project.'
    );
  }
  return new google.auth.GoogleAuth({
    credentials,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
}

async function getSheetsClient() {
  const auth = await getAuth();
  return google.sheets({ version: 'v4', auth });
}

/**
 * Temukan kolom target (0-based index) berdasarkan baris bulan & tanggal di sheet.
 * Mode default: cari tanggal hari ini, kalau tidak ada pakai tanggal terdekat <= hari ini.
 * Env SHEETS_DATE_MODE:
 *   - closest (default): kolom tanggal terdekat ke hari ini (mundur atau maju)
 *   - nearest: tanggal hari ini, fallback ke tanggal terdekat <= hari ini
 *   - upcoming: tanggal hari ini, fallback ke tanggal terdekat >= hari ini
 *   - exact: hanya tanggal persis hari ini
 *   - latest: kolom tanggal terbaru di bulan ini
 */
async function findTodayColumn(sheetsClient, sheetName) {
  const meta = await findTodayColumnMeta(sheetsClient, sheetName);
  return meta?.col ?? null;
}

async function findTodayColumnMeta(sheetsClient, sheetName) {
  const today     = new Date();
  const todayDate = today.getDate();
  const monthName = MONTHS_ID[today.getMonth()];

  let rows;
  try {
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A1:ZZ1`, // baca baris pertama
    });
    rows = resp.data.values || [];
  } catch {
    return null;
  }

  const row1 = rows[0] || [];
  let monthStart = -1;

  // Cari kolom yang memiliki nama bulan (karena merge, teks hanya ada di kolom awal merge)
  for (let c = 3; c < row1.length; c++) {
    const cell = (row1[c] || '').toString().toUpperCase().trim();
    if (cell.includes(monthName)) {
      monthStart = c;
      break;
    }
  }

  if (monthStart === -1) return null;

  // Tentukan offset berdasarkan tanggal hari ini
  // 1-7: minggu 1 (offset +0)
  // 8-14: minggu 2 (offset +1)
  // 15-21: minggu 3 (offset +2)
  // 22+: minggu 4 (offset +3)
  let weekOffset = 0;
  if (todayDate <= 7) weekOffset = 0;
  else if (todayDate <= 14) weekOffset = 1;
  else if (todayDate <= 21) weekOffset = 2;
  else weekOffset = 3;

  const targetCol = monthStart + weekOffset;

  return { col: targetCol, week: weekOffset + 1, monthName };
}

/**
 * Baca semua link akun dari semua sheet.
 * Mengembalikan array objek: { sheetName, rowIndex, namaArea, link, todayCol }
 */
async function readAllLinks(onProgress) {
  const sheetsClient = await getSheetsClient();
  const allLinks = [];

  let sheetNames = [];
  try {
    const info = await getSpreadsheetInfo();
    sheetNames = info.sheets;
  } catch (err) {
    if (onProgress) onProgress(`⚠️ Gagal mengambil info spreadsheet: ${err.message}`);
    return allLinks;
  }

  for (const sheetName of sheetNames) {
    if (sheetName.toLowerCase().includes('dashboard')) {
      if (onProgress) onProgress(`Lewati sheet: ${sheetName}`);
      continue;
    }


    try {
      if (onProgress) onProgress(`\n📄 Membaca sheet: ${sheetName}...`);

      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A:D`, // Kolom A, B, C, D
      });
      const rows = resp.data.values || [];

      const todayMeta = await findTodayColumnMeta(sheetsClient, sheetName);
      const todayCol = todayMeta?.col ?? null;

      if (onProgress && todayMeta) {
        onProgress(`📅 ${sheetName}: kolom target adalah Minggu ke-${todayMeta.week} di bulan ${todayMeta.monthName}`);
      } else if (onProgress) {
        onProgress(`⚠️  ${sheetName}: kolom bulan ${MONTHS_ID[new Date().getMonth()]} tidak ditemukan — scrape tetap jalan, tulis ke sheet dilewati`);
      }

      // Mulai iterasi dari indeks 3 (Baris ke-4 di Excel/SPS), karena 3 baris pertama adalah header
      for (let i = 3; i < rows.length; i++) {
        const row      = rows[i] || [];
        const noCell   = (row[0] || '').toString().trim(); // Kolom A: NO
        const namaArea = (row[1] || '').toString().trim(); // Kolom B: Nama Akun / Kota
        const link     = (row[2] || '').toString().trim(); // Kolom C: Link Akun

        // Lewati baris tanpa nomor urut atau tanpa link
        if (!noCell || !link) continue;
        
        // Cek apakah sel dimulai dengan angka (mengizinkan "1.", "1)", " 1 ", dll)
        if (!/^\d+/.test(noCell)) continue;
        
        if (/total|rata|jumlah/i.test(namaArea)) continue;

        allLinks.push({
          sheetName,
          rowIndex: i + 1,  // 1-indexed untuk penulisan A1 notation
          rowNumber: noCell,
          namaArea,
          link,
          todayCol,
          targetDate: `Minggu ${todayMeta?.week || '?'}`,
          targetDateMode: 'week',
        });
      }
    } catch (err) {
      if (onProgress) onProgress(`⚠️  Gagal baca sheet "${sheetName}": ${err.message}`);
    }
  }

  return allLinks;
}

/**
 * Tulis satu nilai ke sel tertentu.
 * colIndex: 0-based column index
 * rowIndex: 1-based row number
 */
async function writeResult(sheetName, rowIndex, colIndex, value) {
  if (colIndex == null) return;

  const sheetsClient = await getSheetsClient();
  const colLetter    = columnToLetter(colIndex + 1);
  const range        = `'${sheetName}'!${colLetter}${rowIndex}`;

  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[value]] },
  });
}

/**
 * Ambil info spreadsheet (nama, jumlah sheet)
 */
async function getSpreadsheetInfo() {
  const sheetsClient = await getSheetsClient();
  const resp = await sheetsClient.spreadsheets.get({
    spreadsheetId: SPREADSHEET_ID,
  });
  return {
    title : resp.data.properties.title,
    sheets: resp.data.sheets.map(s => s.properties.title),
  };
}

module.exports = {
  checkCredentials,
  readAllLinks,
  writeResult,
  getSpreadsheetInfo,
  SPREADSHEET_ID,
};
