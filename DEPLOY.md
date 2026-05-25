# Deploy ke Railway

## 1. Push ke GitHub

Pastikan file sensitif **tidak** ikut commit (sudah ada di `.gitignore`):

- `.env`
- `credentials.json`
- `ig_cookies.json`

```bash
git init
git add .
git commit -m "Setup deploy Railway"
git remote add origin https://github.com/USERNAME/list_sosmed_toploker.git
git push -u origin main
```

## 2. Buat project di Railway

1. Buka [railway.app](https://railway.app) → login
2. **New Project** → **Deploy from GitHub repo**
3. Pilih repository ini
4. Railway otomatis mendeteksi Node.js dan menjalankan `npm start`

## 3. Environment Variables (wajib)

Di Railway: project → **Variables** → tambahkan:

| Variable | Nilai |
|----------|--------|
| `SPREADSHEET_ID` | ID spreadsheet Google Sheets Anda |
| `GOOGLE_CREDENTIALS` | Isi **seluruh** file `credentials.json` dalam **satu baris** JSON |

### Cara copy GOOGLE_CREDENTIALS

PowerShell (dari folder project):

```powershell
(Get-Content credentials.json -Raw) -replace "`r`n", "" -replace "`n", ""
```

Salin output ke variable `GOOGLE_CREDENTIALS` di Railway.

### Opsional: cookies Instagram

| Variable | Nilai |
|----------|--------|
| `IG_COOKIES_JSON` | Isi file `ig_cookies.json` (satu baris JSON) |

Berguna agar tidak perlu login Instagram ulang setiap redeploy.

## 4. Public URL

1. Klik service → **Settings** → **Networking**
2. **Generate Domain** (mis. `list-sosmed-production.up.railway.app`)
3. Buka URL tersebut → dashboard muncul

## 5. Setelah deploy

1. Buka URL Railway di browser
2. Login Instagram lewat dashboard (jika belum ada `IG_COOKIES_JSON`)
3. Pastikan badge **Google Credentials** hijau
4. Klik **Sync Sekarang** untuk uji

Scheduler sync otomatis tetap jam **07:00 WIB** selama service Railway aktif (tidak sleep).

## Troubleshooting

| Masalah | Solusi |
|---------|--------|
| Credentials merah | Cek `GOOGLE_CREDENTIALS` valid JSON satu baris |
| Login IG gagal | Instagram sering blokir datacenter; coba login ulang atau set `IG_COOKIES_JSON` dari lokal |
| Browser error | Redeploy; pastikan plan Railway cukup RAM (min. ~512MB) |
| Sheet tidak terbaca | Share spreadsheet ke email service account di `client_email` credentials |
