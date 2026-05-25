/**
 * sheets.js — Google Sheets API integration
 * Membaca link akun dari SPS dan menulis hasil scrape kembali
 */
const { google } = require('googleapis');
const path = require('path');
const fs   = require('fs');
require('dotenv').config();

const SPREADSHEET_ID   = process.env.SPREADSHEET_ID || '1pLnRYLDW1kqu0UJm326OrAKO866Q0kFdyZFdQcGRgmU';
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

const SHEET_NAMES = [
  'JAWA 2026',
  'SULAWESI 2026',
  'SUMATERA & RIAU 2026',
  'KALIMANTAN 2026',
  'BALI, NTB & NTT 2026',
  'MALUKU & PAPUA 2026',
];

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
 * Temukan kolom hari ini (0-based index) berdasarkan baris bulan & tanggal di sheet.
 * Baris 2 (index 1) = nama bulan, Baris 3 (index 2) = angka tanggal.
 * Ambil tanggal terdekat ≤ hari ini dalam bulan yang sama.
 */
async function findTodayColumn(sheetsClient, sheetName) {
  const today     = new Date();
  const todayDate = today.getDate();
  const monthName = MONTHS_ID[today.getMonth()]; // mis. 'MEI'

  let rows;
  try {
    const resp = await sheetsClient.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `'${sheetName}'!A1:ZZ6`, // baca 6 baris pertama
    });
    rows = resp.data.values || [];
  } catch {
    return null;
  }

  // Auto-detect: cari baris yang mengandung nama bulan saat ini
  // (berbeda sheet bisa di baris 2 atau baris 4)
  let headerRowIdx = -1;
  for (let r = 0; r < rows.length; r++) {
    const rowStr = (rows[r] || []).join(' ').toUpperCase();
    if (rowStr.includes(monthName)) {
      headerRowIdx = r;
      break;
    }
  }
  if (headerRowIdx === -1) return null; // bulan tidak ditemukan di sheet ini

  const row2 = rows[headerRowIdx]     || []; // baris nama bulan
  const row3 = rows[headerRowIdx + 1] || []; // baris angka tanggal

  // Temukan kolom MULAI bulan ini dan kolom MULAI bulan berikutnya.
  // Nama bulan hanya muncul di 1 sel (merged cell), tanggal-tanggalnya di kolom sesudahnya.
  let monthStart = -1;
  let monthEnd   = row2.length;

  for (let c = 4; c < row2.length; c++) {
    const cell = (row2[c] || '').toString().toUpperCase().trim();
    if (cell.includes(monthName)) {
      monthStart = c; // kolom pertama bulan ini
    } else if (monthStart !== -1 && cell !== '') {
      // Ketemu nama bulan berikutnya → batas akhir
      monthEnd = c;
      break;
    }
  }

  if (monthStart === -1) return null;

  // Scan dari monthStart s/d monthEnd, cari tanggal === hari ini
  for (let c = monthStart; c < monthEnd; c++) {
    const d = parseInt((row3[c] || '').toString().trim());
    if (!isNaN(d) && d === todayDate) return c; // 0-based
  }

  return null; // tidak ada kolom persis hari ini → skip tulis
}

/**
 * Baca semua link akun dari semua sheet.
 * Mengembalikan array objek: { sheetName, rowIndex, namaArea, link, todayCol }
 */
async function readAllLinks(onProgress) {
  const sheetsClient = await getSheetsClient();
  const allLinks = [];

  for (const sheetName of SHEET_NAMES) {
    try {
      if (onProgress) onProgress(`📄 Membaca sheet: ${sheetName}`);

      const resp = await sheetsClient.spreadsheets.values.get({
        spreadsheetId: SPREADSHEET_ID,
        range: `'${sheetName}'!A:E`,
      });
      const rows = resp.data.values || [];

      const todayCol = await findTodayColumn(sheetsClient, sheetName);

      for (let i = 0; i < rows.length; i++) {
        const row      = rows[i] || [];
        const noCell   = (row[0] || '').toString().trim();
        // JAWA 2026: col[1]=nama, col[2]=checkbox
        // sheet lain:  col[1]=checkbox(TRUE/FALSE), col[2]=nama
        const col1 = (row[1] || '').toString().trim();
        const col2 = (row[2] || '').toString().trim();
        const namaArea = /^(TRUE|FALSE)$/i.test(col1) ? col2 : col1;
        const link     = (row[3] || '').toString().trim();

        // Lewati baris tanpa nomor urut atau tanpa link
        if (!noCell || !link) continue;
        if (!/^\d+$/.test(noCell)) continue;
        if (/total|rata|jumlah/i.test(namaArea)) continue;

        allLinks.push({
          sheetName,
          rowIndex: i + 1,  // 1-indexed
          rowNumber: noCell,
          namaArea,
          link,
          todayCol,
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
  SHEET_NAMES,
  SPREADSHEET_ID,
};
