/**
 * apps-script.gs
 * Google Apps Script untuk trigger manual sync dari Google Sheets.
 *
 * CARA PASANG:
 * 1. Buka Spreadsheet → Extensions → Apps Script
 * 2. Hapus isi default, paste semua kode ini
 * 3. Klik Save (💾)
 * 4. Reload Spreadsheet → akan muncul menu "IG Sync" di menu bar
 *
 * CATATAN: Trigger otomatis jam 07:00 WIB sudah ditangani oleh
 * server Node.js (node-cron). Apps Script ini hanya untuk trigger
 * manual jika diperlukan langsung dari Sheets.
 */

// ── Ganti dengan URL server jika sudah di-deploy ke VPS/server ──
// Untuk lokal + ngrok: paste ngrok URL di sini
const SERVER_URL = 'http://localhost:3000';

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📊 IG Sync')
    .addItem('🔄 Sync Sekarang', 'triggerSyncNow')
    .addItem('📋 Cek Status Server', 'checkServerStatus')
    .addSeparator()
    .addItem('ℹ️ Tentang', 'showAbout')
    .addToUi();
}

function triggerSyncNow() {
  const ui = SpreadsheetApp.getUi();
  try {
    const response = UrlFetchApp.fetch(SERVER_URL + '/sync', {
      method: 'POST',
      contentType: 'application/json',
      payload: JSON.stringify({}),
      muteHttpExceptions: true,
    });
    const code   = response.getResponseCode();
    const result = JSON.parse(response.getContentText());
    if (code === 200 && result.success) {
      ui.alert('✅ Sync Dimulai', 'Proses scraping sudah berjalan di server.\nBuka dashboard untuk memantau progres: ' + SERVER_URL, ui.ButtonSet.OK);
    } else {
      ui.alert('⚠️ Info', result.message || 'Respon tidak dikenal dari server.', ui.ButtonSet.OK);
    }
  } catch (e) {
    ui.alert('❌ Gagal', 'Tidak bisa menghubungi server di:\n' + SERVER_URL + '\n\nPastikan server Node.js sudah berjalan.\n\nError: ' + e.message, ui.ButtonSet.OK);
  }
}

function checkServerStatus() {
  const ui = SpreadsheetApp.getUi();
  try {
    const response = UrlFetchApp.fetch(SERVER_URL + '/status', { muteHttpExceptions: true });
    const code     = response.getResponseCode();
    const data     = JSON.parse(response.getContentText());

    const loginSt = data.loggedIn ? '✅ Login' : '❌ Belum Login';
    const credSt  = data.credentialsReady ? '✅ Siap' : '❌ Belum Ada';
    const syncSt  = data.isSyncing ? '🔄 Sedang Sync...' : '⏸️ Idle';
    const lastSync = data.lastSyncTime
      ? new Date(data.lastSyncTime).toLocaleString('id-ID')
      : 'Belum pernah sync';

    let statsText = '';
    if (data.lastSyncStats) {
      const s = data.lastSyncStats;
      statsText = `\n\n📊 Hasil Sync Terakhir:\n` +
        `  Total: ${s.total} akun\n` +
        `  ✅ Aktif: ${s.active}\n` +
        `  🆕 NEW: ${s.newAccount}\n` +
        `  ❌ Nonaktif: ${s.nonaktif}\n` +
        `  ⚠️ Error: ${s.error}`;
    }

    ui.alert(
      '📋 Status Server',
      `Instagram Login : ${loginSt}\n` +
      `Credentials     : ${credSt}\n` +
      `Status Sync     : ${syncSt}\n` +
      `Sync Terakhir   : ${lastSync}\n` +
      `Jadwal Otomatis : ${data.nextSync || '07:00 WIB setiap hari'}` +
      statsText,
      ui.ButtonSet.OK
    );
  } catch (e) {
    ui.alert('❌ Server Offline', 'Tidak bisa menghubungi server di:\n' + SERVER_URL + '\n\nError: ' + e.message, ui.ButtonSet.OK);
  }
}

function showAbout() {
  SpreadsheetApp.getUi().alert(
    'ℹ️ IG Follower Sync',
    'Sistem otomatis scrape followers Instagram.\n\n' +
    '• Scraping berjalan di server Node.js lokal\n' +
    '• Jadwal otomatis: setiap pagi jam 07:00 WIB\n' +
    '• Indikator: angka = aktif, NEW = 0 followers, NONAKTIF = akun mati\n\n' +
    'Dashboard: ' + SERVER_URL,
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}
