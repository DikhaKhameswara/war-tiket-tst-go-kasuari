/**
 * ============================================================
 *  WAR TIKET TST GO KASUARI — Backend (Google Apps Script)
 * ============================================================
 *  Spreadsheet : Permintaan_TST_GO_Kasuari
 *  Sheet 1 Manifest_Jadwal    : No | Mapel | Tanggal | Jam | Kuota | Pengajar
 *  Sheet 2 List_Pendaftar_TST : No | Mapel | Tanggal | Jam | Nomor Registrasi | Nama Lengkap | Asal Kelas | Token | Status Kehadiran
 *  Sheet 3 List_Asal_Kelas    : No | Asal Kelas
 *
 *  PENTING - SETUP MANUAL SEKALI SAJA di sheet List_Pendaftar_TST:
 *  - Sel H1: header "Token" (kolom ke-8) — diisi otomatis oleh script (kode
 *    acak unik per pendaftar, dipakai sbg isi QR code), tidak perlu diisi manual.
 *  - Sel I1: header "Status Kehadiran" (kolom ke-9) — otomatis "Tidak Hadir"
 *    saat daftar, berubah jadi "Hadir" saat berhasil di-scan.
 *
 *  ARSITEKTUR SEKARANG — Apps Script ini BACKEND API MURNI, tidak menyajikan
 *  HTML sama sekali. Frontend (form pendaftaran & scanner) di-host terpisah
 *  di Netlify (repo GitHub), dan memanggil endpoint di bawah lewat JSONP
 *  (BUKAN fetch() biasa, karena Apps Script tidak mengirim header CORS yang
 *  dibutuhkan fetch()/XHR lintas domain):
 *
 *    .../exec?action=initial&callback=NAMA_FUNGSI
 *      -> dipanggil form saat halaman dimuat. Balikan: { tstOptions, kelasOptions }
 *
 *    .../exec?action=daftar&nama=...&noreg=...&kelas=...&mapel=...&tanggal=...&jam=...&callback=NAMA_FUNGSI
 *      -> dipanggil form saat submit. Balikan: { success, data } atau { success:false, reason }
 *
 *    .../exec?action=sesi&callback=NAMA_FUNGSI
 *      -> dipanggil scanner saat halaman dimuat. Balikan: daftar sesi utk dropdown
 *
 *    .../exec?action=scan&token=...&mapel=...&tanggal=...&jam=...&callback=NAMA_FUNGSI
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
    Logger.log('[DEBUG] doGet - action=scan dipanggil (dari scanner Netlify), token=' + e.parameter.token);
    const hasil = scanKehadiran(e.parameter.token, {
      mapel: e.parameter.mapel,
      tanggal: e.parameter.tanggal,
      jam: e.parameter.jam
    });
    return jsonpResponse_(hasil, callback);
  }

  // Tidak ada action yang cocok -> backend API murni, tidak ada tampilan di sini.
  return ContentService.createTextOutput(
    'Ini backend API War Tiket TST GO Kasuari. Form pendaftaran & scanner ada di halaman terpisah (Netlify).'
  ).setMimeType(ContentService.MimeType.TEXT);
}

// Bungkus data sbg respons JSONP (kalau ada param callback) atau JSON biasa.
// JSONP dipakai supaya scanner di domain lain (Netlify) bisa ambil data ini
// TANPA kena masalah CORS Apps Script (lihat catatan di atas doGet).
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

// Tipe sebuah nilai, buat keperluan debug (Date / String / Number / dll)
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

function getAvailableTST_() {
  const manifestRows  = readSheet_(SHEET_MANIFEST).rows;
  const pendaftarRows = readSheet_(SHEET_PENDAFTAR).rows;

  Logger.log('[DEBUG] getAvailableTST_ - jumlah baris Manifest_Jadwal: ' + manifestRows.length);
  Logger.log('[DEBUG] getAvailableTST_ - jumlah baris List_Pendaftar_TST: ' + pendaftarRows.length);

  // Hitung jumlah pendaftar per kombinasi Mapel+Tanggal+Jam
  const countMap = {};
  pendaftarRows.forEach(function (r) {
    const mapel = r[1];
    if (!mapel) return;
    const key = mapel + '|' + keyDate_(r[2]) + '|' + displayTime_(r[3]);
    countMap[key] = (countMap[key] || 0) + 1;
  });

  // Kalau semua sesi ada di 1 tanggal yang sama (event 1 hari),
  // dropdown cukup tampilkan Mapel + Jam saja (sesuai aturan).
  // Kalau ada beberapa tanggal berbeda, tanggal ikut ditampilkan
  // supaya siswa tidak salah pilih sesi.
  const tanggalSet = new Set(
    manifestRows.filter(function (r) { return r[1]; }).map(function (r) { return keyDate_(r[2]); })
  );
  const singleDateEvent = tanggalSet.size <= 1;

  const options = [];
  manifestRows.forEach(function (r, idx) {
    const mapel = r[1], tanggal = r[2], jam = r[3], kuota = r[4];
    if (!mapel) return;

    const tglKey     = keyDate_(tanggal);
    const jamDisplay = displayTime_(jam);
    const key         = mapel + '|' + tglKey + '|' + jamDisplay;
    const terisi      = countMap[key] || 0;
    const sisa        = Number(kuota) - terisi;

    if (sisa > 0) {
      const label = singleDateEvent
        ? (mapel + ' — ' + jamDisplay)
        : (mapel + ' — ' + jamDisplay + ' (' + displayDate_(tanggal) + ')');

      options.push({
        label: label,
        mapel: mapel,
        tanggal: tglKey,
        tanggalDisplay: displayDate_(tanggal),
        jam: jamDisplay,
        sisa: sisa
      });
    }
  });

  Logger.log('[DEBUG] getAvailableTST_ - options yang dikirim ke dropdown: ' + JSON.stringify(options));
  return options;
}

function getDaftarKelas_() {
  const rows = readSheet_(SHEET_KELAS).rows;
  const hasil = rows
    .map(function (r) { return r[1]; })
    .filter(function (v) { return v !== '' && v !== null && v !== undefined; })
    .map(function (v) { return String(v).trim(); });
  return hasil;
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
    // Model ANTREAN: tiap submit menunggu giliran mendapatkan lock (bukan langsung
    // dicek/ditolak dari data yang lama). Begitu dapat giliran, kuota & duplikasi
    // dicek ulang dari data ter-update saat itu juga — jadi validasi murni terjadi
    // saat submit, satu per satu, aman dari race condition.
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

    const manifestRows  = readSheet_(SHEET_MANIFEST).rows;
    const pendaftarInfo = readSheet_(SHEET_PENDAFTAR);
    const pendaftarSheet = pendaftarInfo.sheet;
    const pendaftarRows  = pendaftarInfo.rows;

    // 1) Pastikan jadwal (mapel+tanggal+jam) valid & ambil kuotanya
    let kuota = null;
    let tanggalDisplay = tglKey;
    let tanggalValue = tglKey; // nilai ASLI dari Manifest_Jadwal (Date object), dipakai saat menulis baris baru
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
        Logger.log('[DEBUG] submitPendaftaran - MATCH ditemukan di baris #' + (i + 2) + ' | kuota=' + kuota);
        break;
      }
    }
    if (kuota === null) {
      Logger.log('[DEBUG] submitPendaftaran - GAGAL: tidak ada baris Manifest_Jadwal yang cocok utk mapel/tanggal/jam ini');
      return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'jadwal_tidak_valid' };
    }

    // 2) Cek: nomor registrasi ini sudah daftar TST lain di tanggal yang sama?
    //    (Aturan: 1 siswa hanya boleh ikut 1 TST per hari)
    const sudahDaftarHariIni = pendaftarRows.some(function (r) {
      return String(r[4]).trim() === noreg && keyDate_(r[2]) === tglKey;
    });
    Logger.log('[DEBUG] submitPendaftaran - sudahDaftarHariIni: ' + sudahDaftarHariIni);
    if (sudahDaftarHariIni) {
      return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'sudah_daftar_hari_ini' };
    }

    // 3) Cek kuota utk sesi (mapel+tanggal+jam) ini — dicek ULANG di dalam lock
    //    supaya aman dari race condition (bukan cuma mengandalkan data saat page load).
    const terisi = pendaftarRows.filter(function (r) {
      return r[1] === mapel && keyDate_(r[2]) === tglKey && displayTime_(r[3]) === jam;
    }).length;
    Logger.log('[DEBUG] submitPendaftaran - terisi=' + terisi + ' / kuota=' + kuota);
    if (terisi >= kuota) {
      return { success: false, message: 'MOHON MAAF, ANDA BELUM BISA MENGIKUTI TST INI', reason: 'kuota_penuh' };
    }

    // 4) Lolos semua validasi -> simpan pendaftaran
    // Nomor Registrasi & Jam diberi awalan apostrof (') supaya Sheets memperlakukannya
    // sebagai TEKS MURNI, tanpa perlu setNumberFormat() (lihat catatan versi sebelumnya
    // soal kenapa setNumberFormat dihindari). Tanggal tetap objek Date asli.
    //
    // Token: kode acak unik (UUID) yang jadi ISI QR CODE siswa. QR TIDAK lagi berisi
    // data terbaca (nama/kelas/dst) — cuma kode ini. Data asli baru terbuka lewat
    // pencarian di spreadsheet saat di-scan oleh scanner.html (lihat scanKehadiran).
    const token = Utilities.getUuid();

    const newNo = pendaftarRows.filter(function (r) { return r[1]; }).length + 1;
    const barisBaru = [newNo, mapel, tanggalValue, "'" + jam, "'" + noreg, nama, kelas, token, 'Tidak Hadir'];
    Logger.log('[DEBUG] submitPendaftaran - BERHASIL, menulis baris baru: ' + JSON.stringify(barisBaru));
    pendaftarSheet.appendRow(barisBaru);

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
 *  DIPANGGIL DARI HALAMAN SCANNER (scanner.html)
 * ---------------------------------------------------------- */

// Daftar SEMUA sesi di Manifest_Jadwal (tanpa filter kuota) — utk dropdown pemilihan
// sesi yang sedang berlangsung di halaman scanner.
function getSesiUntukScan() {
  const manifestRows = readSheet_(SHEET_MANIFEST).rows;

  const tanggalSet = new Set(
    manifestRows.filter(function (r) { return r[1]; }).map(function (r) { return keyDate_(r[2]); })
  );
  const singleDateEvent = tanggalSet.size <= 1;

  const sesi = [];
  manifestRows.forEach(function (r) {
    const mapel = r[1], tanggal = r[2], jam = r[3], pengajar = r[5];
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
      pengajar: pengajar ? String(pengajar).trim() : ''
    });
  });

  Logger.log('[DEBUG] getSesiUntukScan - jumlah sesi: ' + sesi.length);
  return sesi;
}

// Dipanggil setiap kali scanner berhasil membaca 1 QR.
// token: string dari isi QR. sesi: { mapel, tanggal, jam } sesi yg sedang dipilih pengawas.
function scanKehadiran(token, sesi) {
  Logger.log('[DEBUG] scanKehadiran - token diterima: "' + token + '" | sesi: ' + JSON.stringify(sesi));

  const lock = LockService.getScriptLock();
  let acquired = false;

  try {
    acquired = lock.tryLock(30 * 1000);
    if (!acquired) {
      return { success: false, message: 'Server sedang sibuk, coba scan ulang.', reason: 'server_sibuk' };
    }

    const tokenBersih = String(token || '').trim();
    if (!tokenBersih) {
      return { success: false, message: 'QR TIDAK TERBACA', reason: 'token_kosong' };
    }

    const sesiMapel   = String((sesi && sesi.mapel) || '').trim();
    const sesiTanggal = String((sesi && sesi.tanggal) || '').trim();
    const sesiJam     = String((sesi && sesi.jam) || '').trim();

    if (!sesiMapel || !sesiTanggal || !sesiJam) {
      return { success: false, message: 'SESI BELUM DIPILIH', reason: 'sesi_belum_dipilih' };
    }

    const pendaftarInfo  = readSheet_(SHEET_PENDAFTAR);
    const pendaftarSheet = pendaftarInfo.sheet;
    const pendaftarRows  = pendaftarInfo.rows;

    // Cari pendaftar dengan token ini (kolom H / index ke-7 setelah header dibuang)
    let pendaftar = null;
    let rowIndex = -1; // index di array (0-based, sebelum header dibuang)
    for (let i = 0; i < pendaftarRows.length; i++) {
      if (String(pendaftarRows[i][7] || '').trim() === tokenBersih) {
        pendaftar = pendaftarRows[i];
        rowIndex = i;
        break;
      }
    }

    if (!pendaftar) {
      Logger.log('[DEBUG] scanKehadiran - token tidak ditemukan di List_Pendaftar_TST');
      return { success: false, message: 'QR TIDAK VALID / TIDAK DIKENALI', reason: 'token_tidak_valid' };
    }

    const pMapel   = pendaftar[1];
    const pTanggal = pendaftar[2];
    const pJam     = displayTime_(pendaftar[3]);
    const pNoreg   = String(pendaftar[4]).trim();
    const pNama    = pendaftar[5];
    const pKelas   = pendaftar[6];
    const pStatus  = String(pendaftar[8] || '').trim(); // kolom I: Status Kehadiran

    const cocokMapel   = pMapel === sesiMapel;
    const cocokTanggal = keyDate_(pTanggal) === sesiTanggal;
    const cocokJam     = pJam === sesiJam;

    Logger.log('[DEBUG] scanKehadiran - data pendaftar: mapel=' + pMapel + ', tanggal=' + keyDate_(pTanggal)
      + ', jam=' + pJam + ', status=' + pStatus + ' | sesi dipilih: mapel=' + sesiMapel
      + ', tanggal=' + sesiTanggal + ', jam=' + sesiJam
      + ' | cocokMapel=' + cocokMapel + ', cocokTanggal=' + cocokTanggal + ', cocokJam=' + cocokJam);

    if (!cocokMapel || !cocokTanggal || !cocokJam) {
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

    // Anti double-scan: cek status yang SUDAH ADA di baris pendaftar ini
    if (pStatus === 'Hadir') {
      Logger.log('[DEBUG] scanKehadiran - GAGAL: status sudah Hadir sebelumnya');
      return {
        success: false,
        reason: 'sudah_absen',
        message: 'SUDAH TERCATAT HADIR SEBELUMNYA',
        data: { nama: pNama, noreg: pNoreg, kelas: pKelas }
      };
    }

    // Lolos semua validasi -> update kolom Status Kehadiran (I) di BARIS YANG SAMA
    // jadi 'Hadir'. Tidak menambah baris/sheet baru sama sekali.
    const barisSheet = rowIndex + 2; // +1 krn header dibuang saat slice, +1 lagi krn sheet mulai baris 1
    pendaftarSheet.getRange(barisSheet, 9).setValue('Hadir');
    Logger.log('[DEBUG] scanKehadiran - BERHASIL, status baris ' + barisSheet + ' (noreg ' + pNoreg + ') diubah jadi Hadir');

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
