Saya setuju. Kita **jangan langsung memperbaiki eksperimen atau source code**. Kita harus mengaudit ide penelitian terlebih dahulu, karena jika ide, gap, novelty, dan pertanyaan penelitian belum solid, eksperimen yang benar pun belum tentu menghasilkan kontribusi ilmiah.

Saya akan membagi 45 pertanyaan tadi menjadi dua kelompok, dengan beberapa pertanyaan yang saling terkait.

## **1. Kelompok A — Masalah pada ide penelitian**

Pertanyaan-pertanyaan ini dapat dan harus kita selesaikan **tanpa melihat source code terlebih dahulu**.

| No. | Pertanyaan kritis                                                        | Apa yang perlu diputuskan                           |
| --- | ------------------------------------------------------------------------ | --------------------------------------------------- |
| 4   | Apa yang sudah dan belum dijawab penelitian terdahulu?                   | Research gap yang benar-benar berbasis literatur    |
| 7   | Siapa attacker dan threat model-nya?                                     | Apakah masalah relevan dalam threat model realistis |
| 10  | Mengapa DPoP-Nonce tidak dibandingkan?                                   | Ruang lingkup dan posisi mekanisme alternatif       |
| 11  | Apakah memory restart dan SIGKILL merupakan eksperimen yang bernilai?    | Peran baseline vs kontribusi                        |
| 12  | Mengapa RDB/AOF tidak diuji?                                             | Ruang lingkup durability mechanism                  |
| 17  | Apa makna durability dan acknowledgment secara konseptual?               | Definisi konstruk durability yang tepat             |
| 29  | Apakah novelty didukung literature review yang memadai?                  | Validitas klaim kebaruan                            |
| 30  | Apa hubungan penelitian dengan literatur distributed systems dan Jepsen? | Posisi terhadap penelitian sistem terdistribusi     |
| 31  | Apa kontribusi ilmiah selain demonstrasi state loss?                     | Pengetahuan baru yang dihasilkan                    |
| 32  | Apakah RFC 9700 tepat dijadikan dasar masalah?                           | Kekuatan dan jenis sumber literatur                 |
| 33  | Apakah masalah nyata di praktik atau hanya skenario laboratorium?        | Relevansi masalah                                   |
| 34  | Apakah RQ1 dan RQ2 tumpang tindih?                                       | Struktur dan fokus RQ                               |
| 39  | Apakah hasil berlaku untuk backend selain Redis?                         | Scope dan generalisasi                              |
| 43  | Apa pertanyaan yang hanya dapat dijawab melalui penelitian ini?          | Justifikasi empiris                                 |
| 44  | Bagaimana hipotesis dapat difalsifikasi?                                 | Logika hipotesis dan desain pengujian               |
| 45  | Apa kesimpulan paling defensible?                                        | Batas klaim penelitian                              |

### **Inti masalah kelompok A**

Ada empat persoalan fundamental:

1. **Research gap belum terbukti.**
2. **Novelty belum jelas.**
3. **Kontribusi ilmiah belum jelas, dan berisiko hanya menjadi demonstrasi fenomena yang sudah diketahui.**
4. **RQ belum cukup tajam dan belum jelas apakah jawabannya benar-benar membutuhkan penelitian baru.**

Ini harus kita selesaikan dahulu.

## **2. Kelompok B — Masalah pada eksperimen dan source code**

Kelompok ini **belum kita audit sekarang**. Kita simpan sebagai backlog setelah ide penelitian disepakati.

### **B1. Validitas desain eksperimen**

| No. | Pertanyaan                                         | Yang nanti perlu dilakukan                      |
| --- | -------------------------------------------------- | ----------------------------------------------- |
| 1   | Apa nilai 10–15 repetisi jika hasil deterministik? | Evaluasi unit eksperimen dan tujuan repetisi    |
| 2   | H1/H2 falsifiable atau tautologis?                 | Operasionalisasi hipotesis dan counterexample   |
| 3   | Mengapa jumlah repetisi berbeda?                   | Justifikasi sample size dan desain              |
| 4   | Bagaimana CI untuk 0/10 atau 0/15?                 | Hitung interval confidence                      |
| 5   | Apa unit eksperimen dan independensinya?           | Definisikan unit dan reset procedure            |
| 6   | Mengapa tidak ada uji statistik?                   | Rencana analisis statistik                      |
| 8   | Apakah replay berada dalam valid `iat` window?     | Verifikasi proof lifetime dan timing            |
| 9   | Apakah proof dan binding benar-benar identik?      | Audit `ath`, `htm`, `htu`, dan proof replay     |
| 13  | Primary detached berbeda dari SIGKILL?             | Definisikan fault scenario dan independensinya  |
| 18  | Replica mana yang dipromosikan?                    | Audit failover dan pemilihan replica            |
| 37  | Apakah WAIT/WAITAOF diuji setelah failure?         | Verifikasi failure coverage                     |
| 38  | Apakah baseline 0% valid untuk H2?                 | Reinterpretasi hasil berdasarkan kondisi aktual |

### **B2. Source code dan implementasi**

| No. | Pertanyaan                                                 | Yang nanti perlu dilakukan                  |
| --- | ---------------------------------------------------------- | ------------------------------------------- |
| 14  | WAIT timeout menyebabkan fail-open?                        | Trace logic timeout dan acceptance          |
| 15  | Apakah WAIT insufficient adalah anomaly atau hasil?        | Investigasi timeline dan log                |
| 16  | Apakah acknowledgment failure seharusnya fail-closed?      | Audit kebijakan error handling              |
| 19  | Konfigurasi WAITAOF lengkap?                               | Audit config dan command                    |
| 20  | Redis versi berapa?                                        | Verifikasi environment                      |
| 21  | Operasi `jti` atomik?                                      | Audit source dan race condition             |
| 22  | TTL dan eviction policy?                                   | Audit konfigurasi replay state              |
| 35  | Mana data acknowledged-write loss dan duplicate operation? | Trace raw data dan schema                   |
| 36  | Apakah first-use valid request diterima?                   | Audit false-positive / availability control |
| 40  | Apakah hasil spesifik implementasi?                        | Evaluasi validitas implementasi             |
| 41  | Apakah eksperimen reproducible?                            | Audit artifact dan prosedur                 |
| 42  | Apakah cost operational diukur?                            | Tentukan metrik cost jika relevan           |

### **B3. Validitas pengukuran performa**

| No. | Pertanyaan                           | Yang nanti perlu dilakukan                |
| --- | ------------------------------------ | ----------------------------------------- |
| 23  | Mengapa tail latency WAITAOF tinggi? | Analisis distribusi dan penyebab          |
| 24  | Apakah p95/p99 valid dengan n kecil? | Perbaiki sample size dan pelaporan        |
| 25  | Latency yang diukur apa?             | Definisikan measurement boundary          |
| 26  | Apakah single-host representatif?    | Batasi generalisasi atau ubah environment |
| 27  | Mengapa tidak concurrent load?       | Evaluasi workload                         |
| 28  | Apakah H3 layak disebut hipotesis?   | Tentukan analisis performance yang layak  |

## **3. Urutan yang seharusnya kita lakukan untuk bagian ide**

Saya menyarankan **jangan mulai dari memperbaiki RQ atau hipotesis terlebih dahulu**. Kita mulai dari literatur dan masalah.

#### **Tahap 1 — Audit literature**

**Tujuan:** memastikan masalah dan research gap memang ada.

Yang dilakukan:

1. Identifikasi paper tentang DPoP replay prevention.
2. Identifikasi paper tentang distributed replay cache/shared state.
3. Identifikasi paper tentang Redis replication dan acknowledged-write loss.
4. Identifikasi paper tentang durability dan consistency guarantees.
5. Identifikasi paper tentang failure recovery dan replay/security consequences.
6. Buat literature matrix dengan kolom:
   - Paper
   - Tahun
   - Masalah
   - Metode
   - System/environment
   - Temuan
   - Limitasi
   - Relevansi terhadap penelitian kita
   - Apa yang belum diteliti

**Output:** evidence-based literature review dan research gap, bukan gap berdasarkan asumsi kita.

#### **Tahap 2 — Putuskan apakah masalahnya cukup penting**

Kita harus menjawab:

- Apakah ini masalah yang benar-benar relevan bagi sistem nyata?
- Apakah failure scenario masuk akal?
- Apakah threat model realistis?
- Apakah problem ini sudah cukup diselesaikan oleh praktik yang ada?
- Apakah terdapat konsekuensi keamanan yang belum diteliti?
- Apakah hasilnya bermanfaat bagi developer atau operator?

**Output:** satu problem statement yang didukung literatur dan argumentasi relevansi.

#### **Tahap 3 — Tentukan research gap**

Gap harus berbentuk sesuatu yang belum dijawab oleh penelitian terdahulu, bukan sekadar:

> "Belum ada yang menggunakan metode X pada sistem Y."

Kita perlu menemukan gap substantif, misalnya:

- Belum ada pemahaman empiris tentang fenomena tertentu.
- Hasil penelitian terdahulu belum mencakup failure mode tertentu.
- Dua mekanisme yang diketahui belum dibandingkan pada kondisi yang relevan.
- Terdapat konflik atau ketidakpastian pada hasil literatur.
- Asumsi keamanan suatu mekanisme belum diuji dalam kondisi tertentu.

**Output:** satu atau beberapa gap, masing-masing didukung paper yang relevan.

#### **Tahap 4 — Tentukan novelty dan kontribusi**

Kita pisahkan:

- **Novelty:** apa yang baru dibandingkan penelitian sebelumnya?
- **Contribution:** apa pengetahuan, evidence, metode, atau artifact yang dihasilkan?
- **Practical significance:** siapa yang akan memperoleh manfaat dan bagaimana?

Kita tidak akan menggunakan kalimat "novel karena belum pernah dilakukan" sebelum literature review membuktikannya.

**Output:** novelty statement dan contribution statement yang defensible.

#### **Tahap 5 — Bentuk RQ**

RQ harus berasal dari gap, bukan dari eksperimen yang kebetulan sudah tersedia.

Kita cek:

- Apakah setiap RQ menjawab gap yang spesifik?
- Apakah RQ saling berbeda?
- Apakah RQ bisa dijawab dengan data?
- Apakah jawabannya memberikan kontribusi ilmiah?
- Apakah scope-nya dapat dikerjakan dengan resources kita?

**Output:** RQ final.

#### **Tahap 6 — Bentuk hipotesis, jika memang diperlukan**

Tidak semua penelitian perlu hipotesis formal.

Kita akan memutuskan apakah penelitian kita:

- Hypothesis-driven experiment.
- Comparative empirical study.
- Exploratory experiment.
- Characterization study.

Jika hipotesis digunakan, harus memiliki prediksi terukur dan kondisi yang memungkinkan hipotesis ditolak.

**Output:** hipotesis yang falsifiable atau keputusan bahwa penelitian tidak membutuhkan hipotesis formal.

## **4. Gate sebelum kita masuk ke eksperimen**

Kita **belum boleh masuk ke audit source code atau merancang eksperimen ulang** sampai semua pertanyaan berikut dapat dijawab dengan evidence:

#### **Research Idea Gate**

- Masalah penelitian didukung literatur, bukan hanya asumsi.
- Literature review mencakup penelitian relevan dan tidak hanya RFC.
- Research gap dapat ditunjukkan melalui perbandingan paper.
- Novelty jelas dan tidak overclaim.
- Kontribusi ilmiah jelas.
- Relevansi praktis atau ilmiah dapat dijelaskan.
- Threat model ditetapkan secara konseptual.
- Scope penelitian realistis.
- RQ tidak tumpang tindih dan dapat dijawab.
- Hipotesis, jika digunakan, falsifiable.
- Ada penjelasan mengapa penelitian ini membutuhkan eksperimen.
- Ada penjelasan hasil seperti apa yang tetap bernilai ilmiah, bahkan jika hipotesis tidak didukung.

Jika satu atau lebih poin fundamental gagal, kita **revisi atau bahkan ganti ide penelitian**, bukan memaksakan eksperimen yang sudah terlanjur dibuat.

## **5. Setelah ide lolos, baru kita audit eksperimen dan source code**

Urutannya nanti:

1. **Audit desain eksperimen** — apakah eksperimen benar-benar dapat menjawab RQ.
2. **Audit threat model dan fault scenario** — apakah kondisi failure relevan dan realistis.
3. **Audit source code** — apakah implementasi menguji konstruk yang kita maksud.
4. **Audit data dan raw logs** — apakah hasil dapat diverifikasi.
5. **Revisi eksperimen** — tambah, buang, atau ubah kondisi.
6. **Rencana statistik** — unit eksperimen, sample size, CI, test, dan effect size.
7. **Eksekusi ulang bila diperlukan.**
8. **Analisis hasil dan kesimpulan.**

### **Keputusan yang saya sarankan sekarang**

Kita mulai **Tahap 1: Audit literature**, dan untuk sementara tidak mengubah source code, tidak menambah eksperimen, dan tidak memperbaiki notebook.

Tujuan tahap ini adalah menjawab satu pertanyaan fundamental:

> **Apakah ide penelitian DPoP replay-state durability ini benar-benar memiliki research gap dan kontribusi ilmiah yang layak, atau sebenarnya hanya mendemonstrasikan konsekuensi yang sudah diketahui dari kehilangan state?**

Jika jawabannya ternyata ide ini tidak cukup kuat, lebih baik kita mengetahuinya sekarang daripada menghabiskan waktu memperbaiki eksperimen yang fondasi ilmiahnya lemah.






