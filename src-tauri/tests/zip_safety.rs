//! 备份包安全校验：真实重复条目、路径穿越、清单与哈希。

use std::fs::File;
use std::io::Write;
use std::path::Path;

use minidesk::backup::zip_read::{self, Manifest, ManifestFile};
use sha2::{Digest, Sha256};

fn sha_hex(data: &[u8]) -> String {
    Sha256::digest(data).iter().map(|b| format!("{b:02x}")).collect()
}

fn manifest_for(files: &[(&str, &[u8])]) -> Manifest {
    let entries: Vec<ManifestFile> = files
        .iter()
        .map(|(path, data)| ManifestFile {
            path: (*path).to_string(),
            bytes: data.len() as u64,
            sha256: sha_hex(data),
        })
        .collect();
    Manifest {
        format: zip_read::FORMAT_NAME.to_string(),
        format_version: zip_read::FORMAT_VERSION,
        app_version: "0.1.0".into(),
        schema_version: 1,
        created_at: "2026-11-16T00:00:00.000Z".into(),
        working_timezone: "Asia/Shanghai".into(),
        number_high_water: vec![zip_read::YearWatermark { year: 2026, last_allocated: 7 }],
        total_files: entries.len(),
        total_bytes: entries.iter().map(|e| e.bytes).sum(),
        files: entries,
    }
}

fn write_zip(path: &Path, files: &[(&str, Vec<u8>)]) {
    let file = File::create(path).unwrap();
    let mut writer = zip::ZipWriter::new(file);
    let options: zip::write::FileOptions<'_, '_, ()> =
        zip::write::FileOptions::default().compression_method(zip::CompressionMethod::Stored);
    for (name, data) in files {
        writer.start_file(*name, options).unwrap();
        writer.write_all(data).unwrap();
    }
    writer.finish().unwrap();
}

fn good_backup(dir: &Path) -> std::path::PathBuf {
    let db = b"SQLite format 3\0fake-database".to_vec();
    let image = b"\x89PNG\r\n\x1a\nfake".to_vec();
    let manifest = manifest_for(&[
        ("database.sqlite", &db),
        (
            "attachments/originals/11111111-1111-1111-1111-111111111111.png",
            &image,
        ),
    ]);
    let manifest_raw = serde_json::to_vec_pretty(&manifest).unwrap();
    let path = dir.join("good.zip");
    write_zip(
        &path,
        &[
            ("manifest.json", manifest_raw),
            ("database.sqlite", db),
            (
                "attachments/originals/11111111-1111-1111-1111-111111111111.png",
                image,
            ),
        ],
    );
    path
}

#[test]
fn valid_backup_passes_inspection() {
    let dir = tempfile::tempdir().unwrap();
    let zip = good_backup(dir.path());
    let report = zip_read::inspect(&zip).unwrap();
    assert_eq!(report.entries, 3);
    assert_eq!(report.attachment_files, 1);
    assert_eq!(report.manifest.number_high_water[0].last_allocated, 7);
    assert_eq!(report.manifest.working_timezone, "Asia/Shanghai");
    assert!(report.database_bytes > 0);
}

#[test]
fn missing_manifest_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("no-manifest.zip");
    write_zip(&path, &[("database.sqlite", b"x".to_vec())]);
    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert_eq!(err.code, "ZIP");
    assert!(err.message.contains("manifest"), "{}", err.message);
}

#[test]
fn checksum_mismatch_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let db = b"real-database".to_vec();
    let mut manifest = manifest_for(&[("database.sqlite", &db)]);
    manifest.files[0].sha256 = "0".repeat(64);
    let raw = serde_json::to_vec(&manifest).unwrap();
    let path = dir.path().join("bad-hash.zip");
    write_zip(
        &path,
        &[("manifest.json", raw), ("database.sqlite", db)],
    );
    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert!(err.message.contains("SHA-256"), "{}", err.message);
}

#[test]
fn manifest_and_entries_must_agree() {
    let dir = tempfile::tempdir().unwrap();
    let db = b"db".to_vec();
    let manifest = manifest_for(&[("database.sqlite", &db)]);
    let raw = serde_json::to_vec(&manifest).unwrap();
    let path = dir.path().join("extra-entry.zip");
    write_zip(
        &path,
        &[
            ("manifest.json", raw),
            ("database.sqlite", db),
            ("attachments/originals/stray.png", b"s".to_vec()),
        ],
    );
    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert!(err.message.contains("不一致"), "{}", err.message);
}

#[test]
fn newer_format_version_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = b"db".to_vec();
    let mut manifest = manifest_for(&[("database.sqlite", &db)]);
    manifest.format_version = zip_read::FORMAT_VERSION + 1;
    let raw = serde_json::to_vec(&manifest).unwrap();
    let path = dir.path().join("future.zip");
    write_zip(&path, &[("manifest.json", raw), ("database.sqlite", db)]);
    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert!(err.message.contains("格式版本"), "{}", err.message);
}

#[test]
fn missing_working_timezone_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let db = b"db".to_vec();
    let mut manifest = manifest_for(&[("database.sqlite", &db)]);
    manifest.working_timezone = "  ".into();
    let raw = serde_json::to_vec(&manifest).unwrap();
    let path = dir.path().join("no-tz.zip");
    write_zip(&path, &[("manifest.json", raw), ("database.sqlite", db)]);
    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert!(err.message.contains("工作时区"), "{}", err.message);
}

#[test]
fn path_traversal_entries_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("traversal.zip");
    write_zip(
        &path,
        &[
            ("manifest.json", b"{}".to_vec()),
            ("../../etc/passwd", b"x".to_vec()),
        ],
    );
    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert_eq!(err.code, "ZIP");
}

// ---------------------------------------------------------- 真实重复条目

fn crc32(data: &[u8]) -> u32 {
    let mut table = [0u32; 256];
    for (i, slot) in table.iter_mut().enumerate() {
        let mut c = i as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { 0xEDB8_8320 ^ (c >> 1) } else { c >> 1 };
        }
        *slot = c;
    }
    let mut crc = 0xFFFF_FFFFu32;
    for b in data {
        crc = table[((crc ^ *b as u32) & 0xFF) as usize] ^ (crc >> 8);
    }
    crc ^ 0xFFFF_FFFF
}

/// `zip` 写入库拒绝同名条目，重复样本必须手写中央目录。
fn raw_zip(path: &Path, entries: &[(String, Vec<u8>)]) {
    let mut out: Vec<u8> = Vec::new();
    let mut offsets: Vec<u32> = Vec::new();
    for (name, data) in entries {
        offsets.push(out.len() as u32);
        let crc = crc32(data);
        out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
        out.extend_from_slice(data);
    }
    let cd_start = out.len() as u32;
    for ((name, data), offset) in entries.iter().zip(offsets.iter()) {
        let crc = crc32(data);
        out.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&20u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&crc.to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(data.len() as u32).to_le_bytes());
        out.extend_from_slice(&(name.len() as u16).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u32.to_le_bytes());
        out.extend_from_slice(&offset.to_le_bytes());
        out.extend_from_slice(name.as_bytes());
    }
    let cd_size = out.len() as u32 - cd_start;
    out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&(entries.len() as u16).to_le_bytes());
    out.extend_from_slice(&cd_size.to_le_bytes());
    out.extend_from_slice(&cd_start.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    File::create(path).unwrap().write_all(&out).unwrap();
}

fn good_entries(dir: &Path) -> Vec<(String, Vec<u8>)> {
    let zip = good_backup(dir);
    let mut archive = zip::ZipArchive::new(File::open(&zip).unwrap()).unwrap();
    let mut out = Vec::new();
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).unwrap();
        let name = entry.name().unwrap().to_string();
        let mut data = Vec::new();
        std::io::Read::read_to_end(&mut entry, &mut data).unwrap();
        out.push((name, data));
    }
    out
}

#[test]
fn real_duplicate_entries_are_detected_in_the_central_directory() {
    let dir = tempfile::tempdir().unwrap();
    let mut entries = good_entries(dir.path());
    let db = entries
        .iter()
        .find(|(n, _)| n == "database.sqlite")
        .unwrap()
        .clone();
    entries.push(db);

    let path = dir.path().join("duplicate.zip");
    raw_zip(&path, &entries);

    // 中央目录真的有两个同名条目……
    let names = zip_read::central_directory_names(&path).unwrap();
    assert_eq!(
        names.iter().filter(|n| *n == "database.sqlite").count(),
        2,
        "夹具必须真的包含两个同名中央目录条目"
    );
    // ……而 zip 解析库只看到一个，所以检测不能依赖它。
    let mut archive = zip::ZipArchive::new(File::open(&path).unwrap()).unwrap();
    let visible = (0..archive.len())
        .filter(|i| {
            archive
                .by_index(*i)
                .ok()
                .and_then(|e| e.name().ok().map(|n| n == "database.sqlite"))
                .unwrap_or(false)
        })
        .count();
    assert_eq!(visible, 1, "解析库按名称去重");

    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert_eq!(err.code, "ZIP");
    assert!(err.message.contains("重复"), "{}", err.message);
}

#[test]
fn case_only_conflict_is_rejected() {
    let dir = tempfile::tempdir().unwrap();
    let mut entries = good_entries(dir.path());
    entries.push(("DATABASE.SQLITE".to_string(), b"x".to_vec()));
    let path = dir.path().join("case.zip");
    raw_zip(&path, &entries);
    let err = zip_read::inspect(&path).err().expect("必须拒绝");
    assert!(err.message.contains("大小写"), "{}", err.message);
}

#[test]
fn backslash_and_non_ascii_names_are_rejected() {
    let dir = tempfile::tempdir().unwrap();
    for (index, bad) in ["attachments\\evil.png", "attachments/中文.png"]
        .into_iter()
        .enumerate()
    {
        let mut entries = good_entries(dir.path());
        entries.push((bad.to_string(), b"x".to_vec()));
        let path = dir.path().join(format!("bad-{index}.zip"));
        raw_zip(&path, &entries);
        let err = zip_read::inspect(&path).err().expect("必须拒绝");
        assert_eq!(err.code, "ZIP");
    }
}

#[test]
fn inspection_does_not_modify_the_archive() {
    let dir = tempfile::tempdir().unwrap();
    let zip = good_backup(dir.path());
    let before = std::fs::read(&zip).unwrap();
    let _ = zip_read::inspect(&zip).unwrap();
    let after = std::fs::read(&zip).unwrap();
    assert_eq!(sha_hex(&before), sha_hex(&after), "校验必须只读");
}
