/**
 * ============================================================
 *  WAR TIKET TST GO KASUARI — Backend (Google Apps Script)
 * ============================================================
 *  Spreadsheet : Permintaan_TST_GO_Kasuari
 *  Sheet 1 Manifest_Jadwal        : No | Mapel | Tanggal | Jam | Kuota | Pengajar | Id Tst
 *                                   (Id Tst = kolom G, auto-generate oleh trigger onEdit di bawah)
 *  Sheet 2 List_Pendaftar_TST     : No | Mapel | Tanggal | Jam | Nomor Registrasi | Nama Lengkap | Asal Kelas | Id Pendaftar Tst | Status Kehadiran
 *  Sheet 3 List_Asal_Kelas        : No | Asal Kelas
 *  Sheet 4 List_Token_Pendaftar_TST : No | Id Tst | Id Pendaftar Tst | Token | Status Kehadiran
 *
 *  KENAPA TOKEN DIPINDAH KE SHEET SENDIRI (List_Token_Pendaftar_TST):
 *  Supaya List_Pendaftar_TST (yang boleh dilihat semua editor) tidak lagi
 *  memuat Token (kode rahasia QR). Token cuma ada di sheet terpisah ini,
 *  yang aksesnya bisa dibatasi lebih ketat (lihat diskusi proteksi sheet
 *  sebelumnya). "Id Pendaftar Tst" di List_Pendaftar_TST cuma kunci
 *  penghubung (join key) — aman dilihat siapa pun, tidak bisa dipakai
 *  utk absen palsu tanpa Token aslinya.
 *
 *  PENTING - SETUP MANUAL SEKALI SAJA:
 *  - Manifest_Jadwal sel G1: header "Id Tst" (kalau belum ada).
 *  - List_Pendaftar_TST sel H1: ganti jadi "Id Pendaftar Tst" (bukan "Token" lagi).
 *  - List_Pendaftar_TST sel I1: header "Status Kehadiran" (kalau belum ada).
 *  - Buat sheet BARU "List_Token_Pendaftar_TST" dengan header persis:
 *    No | Id Tst | Id Pendaftar Tst | Token | Status Kehadiran
 *
 *  ARSITEKTUR — Apps Script ini BACKEND API MURNI, tidak menyajikan HTML.
 *  Frontend (form pendaftaran & scanner) di-host terpisah di Netlify (repo
 *  GitHub), memanggil endpoint di bawah lewat JSONP (BUKAN fetch() biasa,
 *  krn Apps Script tidak mengirim header CORS yg dibutuhkan fetch()/XHR
 *  lintas domain):
 *
 *    .../exec?action=initial&callback=NAMA_FUNGSI
 *      -> dipanggil form saat halaman dimuat. Balikan: { tstOptions, kelasOptions }
 *      -> tstOptions HANYA berisi sesi HARI INI yang kuotanya masih ada.
 *
 *    .../exec?action=daftar&nama=...&noreg=...&kelas=...&mapel=...&tanggal=...&jam=...&callback=NAMA_FUNGSI
 *      -> dipanggil form saat submit. Balikan: { success, data } atau { success:false, reason }
 *
 *    .../exec?action=sesi&callback=NAMA_FUNGSI
 *      -> dipanggil scanner saat halaman dimuat. Balikan: daftar SEMUA sesi (semua tanggal) utk dropdown
 *
 *    .../exec?action=scan&token=...&idTst=...&callback=NAMA_FUNGSI
 *      -> dipanggil scanner tiap berhasil scan 1 QR. Balikan: { success, data/reason }
 * ============================================================
 *  CATATAN DEBUG:
 *  Kode ini sudah ditambahi Logger.log('[DEBUG] ...') di titik-titik penting.
 *  Cara melihatnya: di editor Apps Script, klik ikon jam (Executions) di
 *  sidebar kiri setelah ada yang submit form / scan, lalu klik salah satu
 *  baris eksekusi untuk lihat detail log & variabelnya.
 * ============================================================
 */

const SPREADSHEET_ID  = '17wXmC9HihtpZJuKS_6zcXoS392-NStNmmZfwVLyvHlU';
const SHEET_MANIFEST   = 'Manifest_Jadwal';
const SHEET_PENDAFTAR  = 'List_Pendaftar_TST';
const SHEET_KELAS      = 'List_Asal_Kelas';
const SHEET_TOKEN      = 'List_Token_Pendaftar_TST';
const TIMEZONE         = Session.getScriptTimeZone();

/** Entry point Web App. */
function doGet(e) {
  const action   = e && e.parameter && e.parameter.action;
  const callback = e && e.parameter && e.parameter.callback;

  if (action === 'initial') {
    Logger.log('[DEBUG] doGet - action=initial dipanggil (dari form Netlify)');
    return jsonpResponse_(getInitialData(), callback);
  }

  if (action === 'daftar') {
    Logger.log('[DEBUG] doGet - action=daftar dipanggil (dari form Netlify)');
    const formData = {
      nama: e.parameter.nama,
      noreg: e.parameter.noreg,
      kelas: e.parameter.kelas,
      mapel: e.parameter.mapel,
      tanggal: e.parameter.tanggal,
      jam: e.parameter.jam
    };
    const hasil = submitPendaftaran(formData);
    return jsonpResponse_(hasil, callback);
  }

  if (action === 'sesi') {
    Logger.log('[DEBUG] doGet - action=sesi dipanggil (dari scanner Netlify)');
    return jsonpResponse_(getSesiUntukScan(), callback);
  }

  if (action === 'scan') {
    Logger.log('[DEBUG] doGet - action=scan dipanggil, token=' + e.parameter.token + ', idTst=' + e.parameter.idTst);
    const hasil = scanKehadiran(e.parameter.token, e.parameter.idTst);
    return jsonpResponse_(hasil, callback);
  }

  // Tidak ada action yang cocok -> backend API murni, tidak ada tampilan di sini.
  return ContentService.createTextOutput(
    'Ini backend API War Tiket TST GO Kasuari. Form pendaftaran & scanner ada di halaman terpisah (Netlify).'
  ).setMimeType(ContentService.MimeType.TEXT);
}

// Bungkus data sbg respons JSONP (kalau ada param callback) atau JSON biasa.
function jsonpResponse_(data, callback) {
  const json = JSON.stringify(data);
  if (callback) {
    return ContentService.createTextOutput(callback + '(' + json + ');')
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  return ContentService.createTextOutput(json).setMimeType(ContentService.MimeType.JSON);
}

/* ---------------------------------------------------------- *
 *  UTIL
 * ---------------------------------------------------------- */

function isDate_(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function tipeDebug_(v) {
  return Object.prototype.toString.call(v) + ' -> ' + v;
}

// Kunci internal utk pencocokan tanggal, contoh: "2026-09-24"
function keyDate_(v) {
  return isDate_(v) ? Utilities.formatDate(v, TIMEZONE, 'yyyy-MM-dd') : String(v).trim();
}

// Tampilan tanggal utk manusia, contoh: "24 September 2026"
function displayDate_(v) {
  return isDate_(v) ? Utilities.formatDate(v, TIMEZONE, 'dd MMMM yyyy') : String(v).trim();
}

// Tampilan jam, contoh: "09:00"
function displayTime_(v) {
  return isDate_(v) ? Utilities.formatDate(v, TIMEZONE, 'HH:mm') : String(v).trim();
}

function readSheet_(sheetName) {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Sheet "' + sheetName + '" tidak ditemukan.');
  const values = sheet.getDataRange().getValues();
  return { sheet: sheet, rows: values.slice(1) }; // baris 0 = header, dibuang
}

/* ---------------------------------------------------------- *
 *  DIPANGGIL DARI CLIENT SAAT HALAMAN FORM DIMUAT (index.html)
 * ---------------------------------------------------------- */

function getInitialData() {
  return {
    tstOptions: getAvailableTST_(),
    kelasOptions: getDaftarKelas_()
  };
}

// Sesi yang tertampil di form pendaftaran: HANYA yang (1) kuotanya masih ada
// DAN (2) tanggalnya = HARI INI (tanggal server saat fungsi ini dipanggil).
function getAvailableTST_() {
  const manifestRows  = readSheet_(SHEET_MANIFEST).rows;
  const pendaftarRows = readSheet_(SHEET_PENDAFTAR).rows;

  const hariIniKey = keyDate_(new Date());
  Logger.log('[DEBUG] getAvailableTST_ - hariIniKey (tanggal server): ' + hariIniKey);

  const countMap = {};
  pendaftarRows.forEach(function (r) {
    const mapel = r[1];
    if (!mapel) return;
    const key = mapel + '|' + keyDate_(r[2]) + '|' + displayTime_(r[3]);
    countMap[key] = (countMap[key] || 0) + 1;
  });

  const options = [];
  manifestRows.forEach(function (r) {
    const mapel = r[1], tanggal = r[2], jam = r[3], kuota = r[4];
    if (!mapel) return;

    const tglKey = keyDate_(tanggal);
    if (tglKey !== hariIniKey) return; // BUKAN hari ini -> jangan tampilkan

    const jamDisplay = displayTime_(jam);
    const key = mapel + '|' + tglKey + '|' + jamDisplay;
    const terisi = countMap[key] || 0;
    const sisa = Number(kuota) - terisi;

    if (sisa > 0) {
      options.push({
        label: mapel + ' — ' + jamDisplay,
        mapel: mapel,
        tanggal: tglKey,
        tanggalDisplay: displayDate_(tanggal),
        jam: jamDisplay,
        sisa: sisa
      });
    }
  });

  Logger.log('[DEBUG] getAvailableTST_ - options (hari ini & kuota tersedia): ' + JSON.stringify(options));
  return options;
}

function getDaftarKelas_() {
  const rows = readSheet_(SHEET_KELAS).rows;
  return rows
    .map(function (r) { return r[1]; })
    .filter(function (v) { return v !== '' && v !== null && v !== undefined; })
    .map(function (v) { return String(v).trim(); });
}

/* ---------------------------------------------------------- *
 *  DIPANGGIL DARI CLIENT SAAT SUBMIT FORM (index.html)
 *  formData: { nama, noreg, kelas, mapel, tanggal, jam }
 * ---------------------------------------------------------- */

function submitPendaftaran(formData) {
  Logger.log('[DEBUG] submitPendaftaran - formData mentah diterima: ' + JSON.stringify(formData));

  const lock = LockService.getScriptLock();
  let acquired = false;

  try {
    acquired = lock.tryLock(4 * 60 * 1000);
    if (!acquired) {
      Logger.log('[DEBUG] submitPendaftaran - GAGAL dapat lock (antrean kepenuhan)');
      return { success: false, message: 'Antrean sedang sangat panjang. Silakan coba submit ulang.', reason: 'server_sibuk' };
    }

    const nama    = String(formData.nama || '').trim();
    const noreg   = String(formData.noreg || '').trim();
    const kelas   = String(formData.kelas || '').trim();
    const mapel   = String(formData.mapel || '').trim();
    const tglKey  = String(formData.tanggal || '').trim();
    const jam     = String(formData.jam || '').trim();

    Logger.log('[DEBUG] submitPendaftaran - setelah parsing: nama="' + nama + '", noreg="' + noreg
      + '", kelas="' + kelas + '", mapel="' + mapel + '", tglKey="' + tglKey + '", jam="' + jam + '"');

    if (!nama || !noreg || !kelas || !mapel || !tglKey || !jam) {
      Logger.log('[DEBUG] submitPendaftaran - GAGAL: ada field kosong');
      return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'data_tidak_lengkap' };
    }

    const manifestInfo   = readSheet_(SHEET_MANIFEST);
    const manifestSheet  = manifestInfo.sheet;
    const manifestRows   = manifestInfo.rows;
    const pendaftarInfo  = readSheet_(SHEET_PENDAFTAR);
    const pendaftarSheet = pendaftarInfo.sheet;
    const pendaftarRows  = pendaftarInfo.rows;

    // 1) Pastikan jadwal (mapel+tanggal+jam) valid, ambil kuota & Id Tst-nya
    let kuota = null;
    let tanggalDisplay = tglKey;
    let tanggalValue = tglKey;
    let idTst = '';
    let manifestRowIdx = -1;
    for (let i = 0; i < manifestRows.length; i++) {
      const r = manifestRows[i];
      if (!r[1]) continue;

      const cocokMapel = r[1] === mapel;
      const cocokTanggal = keyDate_(r[2]) === tglKey;
      const cocokJam = displayTime_(r[3]) === jam;

      if (cocokMapel && cocokTanggal && cocokJam) {
        kuota = Number(r[4]);
        tanggalDisplay = displayDate_(r[2]);
        tanggalValue = r[2];
        idTst = String(r[6] || '').trim(); // kolom G: Id Tst
        manifestRowIdx = i;
        Logger.log('[DEBUG] submitPendaftaran - MATCH ditemukan di baris #' + (i + 2) + ' | kuota=' + kuota + ' | idTst="' + idTst + '"');
        break;
      }
    }
    if (kuota === null) {
      Logger.log('[DEBUG] submitPendaftaran - GAGAL: tidak ada baris Manifest_Jadwal yang cocok utk mapel/tanggal/jam ini');
      return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'jadwal_tidak_valid' };
    }

    // Jaring pengaman: kalau Id Tst di Manifest_Jadwal ternyata masih kosong
    // (mis. trigger onEdit belum sempat jalan utk baris ini), generate sendiri
    // di sini dgn pola yang sama, lalu tulis balik ke Manifest_Jadwal kolom G
    // supaya sesi ini konsisten utk pendaftar berikutnya juga.
    if (!idTst) {
      idTst = (mapel + '-' + tanggalDisplay + '-' + jam + '-' + Utilities.getUuid().split('-')[0].toUpperCase()).replace(/\s+/g, '');
      manifestSheet.getRange(manifestRowIdx + 2, 7).setValue(idTst);
      Logger.log('[DEBUG] submitPendaftaran - Id Tst kosong, generate fallback & tulis balik ke Manifest_Jadwal: ' + idTst);
    }

    // 2) Cek: nomor registrasi ini sudah daftar TST lain di tanggal yang sama?
    const sudahDaftarHariIni = pendaftarRows.some(function (r) {
      return String(r[4]).trim() === noreg && keyDate_(r[2]) === tglKey;
    });
    Logger.log('[DEBUG] submitPendaftaran - sudahDaftarHariIni: ' + sudahDaftarHariIni);
    if (sudahDaftarHariIni) {
      return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'sudah_daftar_hari_ini' };
    }

    // 3) Cek kuota utk sesi (mapel+tanggal+jam) ini — dicek ULANG di dalam lock
    const terisi = pendaftarRows.filter(function (r) {
      return r[1] === mapel && keyDate_(r[2]) === tglKey && displayTime_(r[3]) === jam;
    }).length;
    Logger.log('[DEBUG] submitPendaftaran - terisi=' + terisi + ' / kuota=' + kuota);
    if (terisi >= kuota) {
      return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'kuota_penuh' };
    }

    // 4) Lolos semua validasi -> simpan pendaftaran di 2 sheet:
    //    - List_Pendaftar_TST   : data siswa + Id Pendaftar Tst (join key, AMAN dilihat siapa saja)
    //    - List_Token_Pendaftar_TST : Id Tst + Id Pendaftar Tst + Token RAHASIA (isi QR) + Status Kehadiran
    const idPendaftar = Utilities.getUuid();
    const token = Utilities.getUuid();

    const newNoPendaftar = pendaftarRows.filter(function (r) { return r[1]; }).length + 1;
    const barisPendaftar = [newNoPendaftar, mapel, tanggalValue, "'" + jam, "'" + noreg, nama, kelas, idPendaftar, 'Tidak Hadir'];
    Logger.log('[DEBUG] submitPendaftaran - tulis List_Pendaftar_TST: ' + JSON.stringify(barisPendaftar));
    pendaftarSheet.appendRow(barisPendaftar);

    const tokenInfo  = readSheet_(SHEET_TOKEN);
    const tokenSheet = tokenInfo.sheet;
    const tokenRows  = tokenInfo.rows;
    const newNoToken = tokenRows.filter(function (r) { return r[1]; }).length + 1;
    const barisToken = [newNoToken, idTst, idPendaftar, token, 'Tidak Hadir'];
    Logger.log('[DEBUG] submitPendaftaran - tulis List_Token_Pendaftar_TST: ' + JSON.stringify(barisToken));
    tokenSheet.appendRow(barisToken);

    return {
      success: true,
      data: {
        noreg: noreg,
        nama: nama,
        kelas: kelas,
        mapel: mapel,
        tanggal: tanggalDisplay,
        jam: jam,
        token: token
      }
    };

  } catch (err) {
    Logger.log('[DEBUG] submitPendaftaran - ERROR: ' + err.message + ' | stack: ' + err.stack);
    return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'error_sistem: ' + err.message };
  } finally {
    if (acquired) lock.releaseLock();
  }
}

/* ---------------------------------------------------------- *
 *  DIPANGGIL DARI HALAMAN SCANNER (scanner.html, di Netlify)
 * ---------------------------------------------------------- */

// Daftar SEMUA sesi di Manifest_Jadwal (tanpa filter kuota/tanggal) — utk dropdown
// pemilihan sesi yang sedang berlangsung di halaman scanner. Tiap sesi bawa idTst,
// yang nanti dikirim balik saat scan utk dicocokkan.
function getSesiUntukScan() {
  const manifestRows = readSheet_(SHEET_MANIFEST).rows;

  const tanggalSet = new Set(
    manifestRows.filter(function (r) { return r[1]; }).map(function (r) { return keyDate_(r[2]); })
  );
  const singleDateEvent = tanggalSet.size <= 1;

  const sesi = [];
  manifestRows.forEach(function (r) {
    const mapel = r[1], tanggal = r[2], jam = r[3], pengajar = r[5], idTst = r[6];
    if (!mapel) return;

    const jamDisplay = displayTime_(jam);
    const label = singleDateEvent
      ? (mapel + ' — ' + jamDisplay)
      : (mapel + ' — ' + jamDisplay + ' (' + displayDate_(tanggal) + ')');

    sesi.push({
      label: label,
      mapel: mapel,
      tanggal: keyDate_(tanggal),
      tanggalDisplay: displayDate_(tanggal),
      jam: jamDisplay,
      idTst: String(idTst || '').trim(),
      pengajar: pengajar ? String(pengajar).trim() : ''
    });
  });

  Logger.log('[DEBUG] getSesiUntukScan - jumlah sesi: ' + sesi.length);
  return sesi;
}

// Dipanggil setiap kali scanner berhasil membaca 1 QR.
// token: string dari isi QR (dicari di List_Token_Pendaftar_TST).
// idTstDipilih: Id Tst dari sesi yang sedang dipilih pengawas di scanner.
function scanKehadiran(token, idTstDipilih) {
  Logger.log('[DEBUG] scanKehadiran - token diterima: "' + token + '" | idTstDipilih: "' + idTstDipilih + '"');

  const lock = LockService.getScriptLock();
  let acquired = false;

  try {
    acquired = lock.tryLock(30 * 1000);
    if (!acquired) {
      return { success: false, message: 'Server sedang sibuk, coba scan ulang.', reason: 'server_sibuk' };
    }

    const tokenBersih = String(token || '').trim();
    const idTstBersih = String(idTstDipilih || '').trim();

    if (!tokenBersih) {
      return { success: false, message: 'QR TIDAK TERBACA', reason: 'token_kosong' };
    }
    if (!idTstBersih) {
      return { success: false, message: 'SESI BELUM DIPILIH', reason: 'sesi_belum_dipilih' };
    }

    // 1) Cari token ini di List_Token_Pendaftar_TST
    const tokenInfo  = readSheet_(SHEET_TOKEN);
    const tokenSheet = tokenInfo.sheet;
    const tokenRows  = tokenInfo.rows;

    let tokenRow = null, tokenRowIdx = -1;
    for (let i = 0; i < tokenRows.length; i++) {
      if (String(tokenRows[i][3] || '').trim() === tokenBersih) { // kolom D: Token
        tokenRow = tokenRows[i];
        tokenRowIdx = i;
        break;
      }
    }

    if (!tokenRow) {
      Logger.log('[DEBUG] scanKehadiran - token tidak ditemukan di List_Token_Pendaftar_TST');
      return { success: false, message: 'QR TIDAK VALID / TIDAK DIKENALI', reason: 'token_tidak_valid' };
    }

    const rowIdTst       = String(tokenRow[1] || '').trim(); // kolom B: Id Tst
    const rowIdPendaftar = String(tokenRow[2] || '').trim(); // kolom C: Id Pendaftar Tst
    const rowStatus      = String(tokenRow[4] || '').trim(); // kolom E: Status Kehadiran

    // 2) Ambil data siswa dari List_Pendaftar_TST via Id Pendaftar Tst (join key)
    const pendaftarInfo  = readSheet_(SHEET_PENDAFTAR);
    const pendaftarSheet = pendaftarInfo.sheet;
    const pendaftarRows  = pendaftarInfo.rows;

    let pendaftar = null, pendaftarRowIdx = -1;
    for (let i = 0; i < pendaftarRows.length; i++) {
      if (String(pendaftarRows[i][7] || '').trim() === rowIdPendaftar) { // kolom H: Id Pendaftar Tst
        pendaftar = pendaftarRows[i];
        pendaftarRowIdx = i;
        break;
      }
    }

    if (!pendaftar) {
      Logger.log('[DEBUG] scanKehadiran - GAGAL: Id Pendaftar Tst "' + rowIdPendaftar + '" tidak ditemukan di List_Pendaftar_TST (data tidak konsisten)');
      return { success: false, message: 'DATA PENDAFTAR TIDAK DITEMUKAN', reason: 'data_tidak_konsisten' };
    }

    const pMapel   = pendaftar[1];
    const pTanggal = pendaftar[2];
    const pJam     = displayTime_(pendaftar[3]);
    const pNoreg   = String(pendaftar[4]).trim();
    const pNama    = pendaftar[5];
    const pKelas   = pendaftar[6];

    Logger.log('[DEBUG] scanKehadiran - rowIdTst="' + rowIdTst + '" vs idTstDipilih="' + idTstBersih
      + '" | rowStatus="' + rowStatus + '" | siswa=' + pNama);

    // 3) Cocokkan Id Tst -> kalau beda, siswa ini bukan dari sesi yang sedang di-scan
    if (rowIdTst !== idTstBersih) {
      return {
        success: false,
        reason: 'sesi_tidak_cocok',
        message: 'SISWA INI BUKAN DARI SESI INI',
        data: {
          nama: pNama,
          noreg: pNoreg,
          kelas: pKelas,
          mapelAsli: pMapel,
          tanggalAsli: displayDate_(pTanggal),
          jamAsli: pJam
        }
      };
    }

    // 4) Anti double-scan: cek status yang SUDAH ADA di List_Token_Pendaftar_TST
    if (rowStatus === 'Hadir') {
      Logger.log('[DEBUG] scanKehadiran - GAGAL: status sudah Hadir sebelumnya');
      return {
        success: false,
        reason: 'sudah_absen',
        message: 'SUDAH TERCATAT HADIR SEBELUMNYA',
        data: { nama: pNama, noreg: pNoreg, kelas: pKelas }
      };
    }

    // 5) Lolos semua validasi -> update Status Kehadiran di KEDUA sheet
    //    (List_Token_Pendaftar_TST = sumber utama, List_Pendaftar_TST = ikutan sinkron)
    const barisToken = tokenRowIdx + 2;
    tokenSheet.getRange(barisToken, 5).setValue('Hadir'); // kolom E: Status Kehadiran

    const barisPendaftar = pendaftarRowIdx + 2;
    pendaftarSheet.getRange(barisPendaftar, 9).setValue('Hadir'); // kolom I: Status Kehadiran

    Logger.log('[DEBUG] scanKehadiran - BERHASIL, Status Kehadiran diubah jadi Hadir di baris token ' + barisToken + ' & baris pendaftar ' + barisPendaftar);

    return {
      success: true,
      message: 'KEHADIRAN TERCATAT',
      data: {
        noreg: pNoreg,
        nama: pNama,
        kelas: pKelas,
        mapel: pMapel,
        tanggal: displayDate_(pTanggal),
        jam: pJam
      }
    };

  } catch (err) {
    Logger.log('[DEBUG] scanKehadiran - ERROR: ' + err.message + ' | stack: ' + err.stack);
    return { success: false, message: 'Terjadi kesalahan sistem.', reason: 'error_sistem: ' + err.message };
  } finally {
    if (acquired) lock.releaseLock();
  }
}

// ============================================================
// FUNGSI OTOMATIS: PEMBUAT UNIQUE ID DI MANIFEST_JADWAL
// (sudah ada sebelumnya, dipertahankan apa adanya)
// ============================================================
function onEdit(e) {
  if (!e || !e.range) return;

  var sheet = e.source.getActiveSheet();

  // Script HANYA berjalan di sheet "Manifest_Jadwal"
  if (sheet.getName() !== "Manifest_Jadwal") return;

  var range = e.range;
  var row = range.getRow();
  var col = range.getColumn();

  // Asumsi Kolom G (Kolom ke-7) adalah tempat Id Tst
  var targetCol = 7;

  // Mengecek jika yang diedit adalah baris 2 ke atas, dan di kolom B (2) sampai F (6)
  if (row > 1 && col >= 2 && col <= 6) {
    var cellID = sheet.getRange(row, targetCol);
    var currentValue = cellID.getValue();

    // Hanya buat ID jika kolom Id Tst masih kosong
    if (currentValue === "") {

      var mapel = sheet.getRange(row, 2).getDisplayValue();
      var tanggal = sheet.getRange(row, 3).getDisplayValue();
      var jam = sheet.getRange(row, 4).getDisplayValue();

      // Syarat ID terbuat: Mapel, Tanggal, dan Jam harus sudah diisi
      if (mapel !== "" && tanggal !== "" && jam !== "") {

        var randomHash = Utilities.getUuid().split('-')[0].toUpperCase();

        // Membuat Unique ID
        var uniqueID = mapel + "-" + tanggal + "-" + jam + "-" + randomHash;

        // Membersihkan spasi pada ID agar rapi
        uniqueID = uniqueID.replace(/\s+/g, "");

        // Cetak ID ke kolom Id Tst
        cellID.setValue(uniqueID);
      }
    }
  }
}
