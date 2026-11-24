use std::path::Path;
use std::sync::{Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};

use crate::engine::comet::CometElements;
use crate::engine::time::calendar_to_jd;

/// Stored satellite TLE entry (persisted in SQLite).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SatelliteRecord {
    pub id: String,
    pub norad_id: u32,
    pub name: String,
    pub line1: String,
    pub line2: String,
    pub category: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

impl SatelliteRecord {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("衛星名を入力してください".into());
        }
        let l1 = self.line1.trim();
        let l2 = self.line2.trim();
        if !l1.starts_with('1') || !l2.starts_with('2') || l1.len() < 68 || l2.len() < 68 {
            return Err(format!("{} のTLE形式が不正です", self.name));
        }
        sgp4::Elements::from_tle(Some(self.name.clone()), l1.as_bytes(), l2.as_bytes())
            .map_err(|e| format!("{} のTLE解析に失敗: {e}", self.name))?;
        Ok(())
    }
}

pub fn default_satellites() -> Vec<SatelliteRecord> {
    vec![
        SatelliteRecord {
            id: "sat:25544".into(),
            norad_id: 25544,
            name: "ISS (ZARYA)".into(),
            line1: "1 25544U 98067A   26327.25000000  .00016717  00000-0  29800-3 0  9991".into(),
            line2: "2 25544  51.6416 142.3000 0004200  95.4000 264.7000 15.50200000483219".into(),
            category: "stations".into(),
            enabled: true,
        },
        SatelliteRecord {
            id: "sat:48274".into(),
            norad_id: 48274,
            name: "CSS (TIANHE)".into(),
            line1: "1 48274U 21035A   26327.25000000  .00021000  00000-0  24000-3 0  9995".into(),
            line2: "2 48274  41.4740  85.2000 0005100 130.0000 230.1000 15.61200000321009".into(),
            category: "stations".into(),
            enabled: true,
        },
        SatelliteRecord {
            id: "sat:20580".into(),
            norad_id: 20580,
            name: "HST (ハッブル宇宙望遠鏡)".into(),
            line1: "1 20580U 90037B   26327.25000000  .00004500  00000-0  18000-3 0  9992".into(),
            line2: "2 20580  28.4690 210.5000 0002800  60.2000 299.9000 15.19000000900006".into(),
            category: "visual".into(),
            enabled: true,
        },
        SatelliteRecord {
            id: "sat:33591".into(),
            norad_id: 33591,
            name: "NOAA 19".into(),
            line1: "1 33591U 09005A   26327.25000000  .00000120  00000-0  89000-4 0  9996".into(),
            line2: "2 33591  99.1000 310.4000 0014000 120.5000 239.8000 14.12500000920009".into(),
            category: "weather".into(),
            enabled: false,
        },
    ]
}

fn row_to_satellite(row: &rusqlite::Row<'_>) -> rusqlite::Result<SatelliteRecord> {
    let norad_i: i64 = row.get(1)?;
    let enabled_i: i32 = row.get(6)?;
    Ok(SatelliteRecord {
        id: row.get(0)?,
        norad_id: norad_i.max(0) as u32,
        name: row.get(2)?,
        line1: row.get(3)?,
        line2: row.get(4)?,
        category: row.get(5)?,
        enabled: enabled_i != 0,
    })
}

fn insert_satellite_stmt(
    conn: &Connection,
    s: &SatelliteRecord,
    now: i64,
) -> Result<(), String> {
    conn.execute(
        "INSERT INTO satellites (
            id, norad_id, name, line1, line2, category, enabled, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        ON CONFLICT(id) DO UPDATE SET
            norad_id = excluded.norad_id,
            name = excluded.name,
            line1 = excluded.line1,
            line2 = excluded.line2,
            category = excluded.category,
            enabled = excluded.enabled,
            updated_at = excluded.updated_at",
        params![
            s.id,
            i64::from(s.norad_id),
            s.name,
            s.line1,
            s.line2,
            s.category,
            i32::from(s.enabled),
            now,
        ],
    )
    .map_err(|e| format!("人工衛星データの保存に失敗: {e}"))?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CometRecord {
    pub id: String,
    pub name: String,
    pub epoch_perihelion_jd: f64,
    pub perihelion_dist_au: f64,
    pub eccentricity: f64,
    pub inclination_deg: f64,
    pub arg_periapsis_deg: f64,
    pub ascending_node_deg: f64,
    pub abs_mag_h: f64,
    pub slope_param_k: f64,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub notes: String,
}

fn default_true() -> bool {
    true
}

impl CometRecord {
    pub fn to_elements(&self) -> CometElements {
        CometElements {
            id: self.id.clone(),
            name: self.name.clone(),
            epoch_perihelion_jd: self.epoch_perihelion_jd,
            perihelion_dist_au: self.perihelion_dist_au,
            eccentricity: self.eccentricity,
            inclination_deg: self.inclination_deg,
            arg_periapsis_deg: self.arg_periapsis_deg,
            ascending_node_deg: self.ascending_node_deg,
            abs_mag_h: self.abs_mag_h,
            slope_param_k: self.slope_param_k,
        }
    }

    pub fn validate(&self) -> Result<(), String> {
        if self.name.trim().is_empty() {
            return Err("彗星名を入力してください".into());
        }
        if !self.epoch_perihelion_jd.is_finite()
            || self.epoch_perihelion_jd < 0.0
            || self.epoch_perihelion_jd > 5_000_000.0
        {
            return Err("近日点通過時刻 (JD) が有効範囲 (0 〜 5,000,000) を超えています".into());
        }
        if !self.perihelion_dist_au.is_finite()
            || self.perihelion_dist_au < 0.0001
            || self.perihelion_dist_au > 500.0
        {
            return Err("近日点距離 q (AU) は 0.0001 〜 500.0 の範囲で指定してください".into());
        }
        if !self.eccentricity.is_finite() || self.eccentricity < 0.0 || self.eccentricity > 10.0 {
            return Err("離心率 e は 0.0 〜 10.0 の範囲で指定してください".into());
        }
        if !self.inclination_deg.is_finite()
            || self.inclination_deg < 0.0
            || self.inclination_deg > 180.0
        {
            return Err("軌道傾斜角 i は 0° 〜 180° の範囲で指定してください".into());
        }
        if !self.arg_periapsis_deg.is_finite() || !self.ascending_node_deg.is_finite() {
            return Err("近日点引数 ω および昇交点黄経 Ω は有限の数値で指定してください".into());
        }
        if !self.abs_mag_h.is_finite() || self.abs_mag_h < -10.0 || self.abs_mag_h > 35.0 {
            return Err("絶対等級 H は -10.0 〜 35.0 の範囲で指定してください".into());
        }
        if !self.slope_param_k.is_finite()
            || self.slope_param_k < 0.0
            || self.slope_param_k > 30.0
        {
            return Err("光度係数 K は 0.0 〜 30.0 の範囲で指定してください".into());
        }
        Ok(())
    }
}

/// Built-in default comets seeded into SQLite on first run (also used as fallback in tests).
pub fn default_comets() -> Vec<CometRecord> {
    vec![
        CometRecord {
            id: "comet:C2023A3".into(),
            name: "C/2023 A3 (紫金山・アトラス)".into(),
            epoch_perihelion_jd: calendar_to_jd(2024, 9, 27.74),
            perihelion_dist_au: 0.3914,
            eccentricity: 1.0001,
            inclination_deg: 139.11,
            arg_periapsis_deg: 308.49,
            ascending_node_deg: 21.56,
            abs_mag_h: 4.5,
            slope_param_k: 8.5,
            enabled: true,
            notes: "2024年秋に肉眼で観測された明るい非周期彗星".into(),
        },
        CometRecord {
            id: "comet:12P".into(),
            name: "12P/ポンス・ブルックス彗星".into(),
            epoch_perihelion_jd: calendar_to_jd(2024, 4, 21.14),
            perihelion_dist_au: 0.7808,
            eccentricity: 0.9547,
            inclination_deg: 74.19,
            arg_periapsis_deg: 199.03,
            ascending_node_deg: 255.89,
            abs_mag_h: 4.2,
            slope_param_k: 9.0,
            enabled: true,
            notes: "公転周期約71年のハレー型周期彗星".into(),
        },
        CometRecord {
            id: "comet:2P".into(),
            name: "2P/エンケ彗星 (2027近日点)".into(),
            epoch_perihelion_jd: calendar_to_jd(2027, 2, 10.3),
            perihelion_dist_au: 0.336,
            eccentricity: 0.848,
            inclination_deg: 11.78,
            arg_periapsis_deg: 186.5,
            ascending_node_deg: 334.6,
            abs_mag_h: 9.8,
            slope_param_k: 12.0,
            enabled: true,
            notes: "公転周期約3.3年・おうし座流星群の母天体".into(),
        },
        CometRecord {
            id: "comet:67P".into(),
            name: "67P/チュリュモフ・ゲラシメンコ".into(),
            epoch_perihelion_jd: calendar_to_jd(2028, 4, 6.0),
            perihelion_dist_au: 1.21,
            eccentricity: 0.650,
            inclination_deg: 3.87,
            arg_periapsis_deg: 22.1,
            ascending_node_deg: 36.3,
            abs_mag_h: 10.5,
            slope_param_k: 10.0,
            enabled: true,
            notes: "探査機ロゼッタの目標天体・公転周期約6.4年".into(),
        },
        CometRecord {
            id: "comet:1P".into(),
            name: "1P/ハレー彗星".into(),
            epoch_perihelion_jd: calendar_to_jd(1986, 2, 9.4589),
            perihelion_dist_au: 0.5871,
            eccentricity: 0.96727,
            inclination_deg: 162.24,
            arg_periapsis_deg: 111.85,
            ascending_node_deg: 58.86,
            abs_mag_h: 5.5,
            slope_param_k: 11.0,
            enabled: true,
            notes: "最も有名な周期彗星（周期約76年・次回近日点は2061年）".into(),
        },
    ]
}

fn now_unix_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

fn row_to_comet(row: &rusqlite::Row<'_>) -> rusqlite::Result<CometRecord> {
    let enabled_i: i32 = row.get(10)?;
    Ok(CometRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        epoch_perihelion_jd: row.get(2)?,
        perihelion_dist_au: row.get(3)?,
        eccentricity: row.get(4)?,
        inclination_deg: row.get(5)?,
        arg_periapsis_deg: row.get(6)?,
        ascending_node_deg: row.get(7)?,
        abs_mag_h: row.get(8)?,
        slope_param_k: row.get(9)?,
        enabled: enabled_i != 0,
        notes: row.get(11)?,
    })
}

fn insert_comet_stmt(conn: &Connection, c: &CometRecord, now: i64) -> Result<(), String> {
    conn.execute(
        "INSERT INTO comets (
            id, name, epoch_perihelion_jd, perihelion_dist_au, eccentricity,
            inclination_deg, arg_periapsis_deg, ascending_node_deg,
            abs_mag_h, slope_param_k, enabled, notes, updated_at
        ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            epoch_perihelion_jd = excluded.epoch_perihelion_jd,
            perihelion_dist_au = excluded.perihelion_dist_au,
            eccentricity = excluded.eccentricity,
            inclination_deg = excluded.inclination_deg,
            arg_periapsis_deg = excluded.arg_periapsis_deg,
            ascending_node_deg = excluded.ascending_node_deg,
            abs_mag_h = excluded.abs_mag_h,
            slope_param_k = excluded.slope_param_k,
            enabled = excluded.enabled,
            notes = excluded.notes,
            updated_at = excluded.updated_at",
        params![
            c.id,
            c.name,
            c.epoch_perihelion_jd,
            c.perihelion_dist_au,
            c.eccentricity,
            c.inclination_deg,
            c.arg_periapsis_deg,
            c.ascending_node_deg,
            c.abs_mag_h,
            c.slope_param_k,
            i32::from(c.enabled),
            c.notes,
            now,
        ],
    )
    .map_err(|e| format!("彗星データの書き込みに失敗: {e}"))?;
    Ok(())
}

pub struct CometDb {
    conn: Mutex<Connection>,
    enabled_cache: RwLock<Option<Vec<CometElements>>>,
}

impl CometDb {
    fn invalidate_comet_cache(&self) {
        if let Ok(mut guard) = self.enabled_cache.write() {
            *guard = None;
        }
    }

    pub fn open_file(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("DBディレクトリの作成に失敗: {e}"))?;
        }
        let conn = Connection::open(path).map_err(|e| format!("SQLite オープン失敗: {e}"))?;
        let db = Self {
            conn: Mutex::new(conn),
            enabled_cache: RwLock::new(None),
        };
        db.init_schema()?;
        Ok(db)
    }

    pub fn open_in_memory() -> Result<Self, String> {
        let conn = Connection::open_in_memory()
            .map_err(|e| format!("インメモリ SQLite 初期化失敗: {e}"))?;
        let db = Self {
            conn: Mutex::new(conn),
            enabled_cache: RwLock::new(None),
        };
        db.init_schema()?;
        Ok(db)
    }

    fn init_schema(&self) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        conn.execute_batch(
            "
            PRAGMA journal_mode = WAL;
            CREATE TABLE IF NOT EXISTS app_meta (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS comets (
                id                  TEXT PRIMARY KEY,
                name                TEXT NOT NULL,
                epoch_perihelion_jd REAL NOT NULL,
                perihelion_dist_au  REAL NOT NULL,
                eccentricity        REAL NOT NULL,
                inclination_deg     REAL NOT NULL,
                arg_periapsis_deg   REAL NOT NULL,
                ascending_node_deg  REAL NOT NULL,
                abs_mag_h           REAL NOT NULL,
                slope_param_k       REAL NOT NULL,
                enabled             INTEGER NOT NULL DEFAULT 1,
                notes               TEXT NOT NULL DEFAULT '',
                updated_at          INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS satellites (
                id                  TEXT PRIMARY KEY,
                norad_id            INTEGER NOT NULL,
                name                TEXT NOT NULL,
                line1               TEXT NOT NULL,
                line2               TEXT NOT NULL,
                category            TEXT NOT NULL DEFAULT 'stations',
                enabled             INTEGER NOT NULL DEFAULT 1,
                updated_at          INTEGER NOT NULL DEFAULT 0
            );
            ",
        )
        .map_err(|e| format!("テーブル初期化失敗: {e}"))?;

        let seeded: Option<String> = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'comets_seeded'",
                [],
                |row| row.get(0),
            )
            .ok();

        if seeded.is_none() {
            let now = now_unix_secs();
            for c in default_comets() {
                insert_comet_stmt(&conn, &c, now)?;
            }
            conn.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('comets_seeded', '1')",
                [],
            )
            .map_err(|e| format!("初期フラグ保存に失敗: {e}"))?;
        }

        let sat_seeded: Option<String> = conn
            .query_row(
                "SELECT value FROM app_meta WHERE key = 'satellites_seeded'",
                [],
                |row| row.get(0),
            )
            .ok();

        if sat_seeded.is_none() {
            let now = now_unix_secs();
            for s in default_satellites() {
                insert_satellite_stmt(&conn, &s, now)?;
            }
            conn.execute(
                "INSERT OR REPLACE INTO app_meta (key, value) VALUES ('satellites_seeded', '1')",
                [],
            )
            .map_err(|e| format!("衛星初期フラグ保存に失敗: {e}"))?;
        }
        Ok(())
    }

    pub fn list_all(&self) -> Result<Vec<CometRecord>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, name, epoch_perihelion_jd, perihelion_dist_au, eccentricity,
                        inclination_deg, arg_periapsis_deg, ascending_node_deg,
                        abs_mag_h, slope_param_k, enabled, notes
                 FROM comets
                 ORDER BY enabled DESC, abs_mag_h ASC, name ASC",
            )
            .map_err(|e| format!("彗星一覧クエリ準備失敗: {e}"))?;

        let rows = stmt
            .query_map([], row_to_comet)
            .map_err(|e| format!("彗星一覧取得失敗: {e}"))?;

        let mut out = Vec::new();
        for item in rows {
            out.push(item.map_err(|e| format!("彗星レコード読込失敗: {e}"))?);
        }
        Ok(out)
    }

    pub fn list_enabled_elements(&self) -> Vec<CometElements> {
        if let Ok(guard) = self.enabled_cache.read() {
            if let Some(cached) = guard.as_ref() {
                return cached.clone();
            }
        }
        let elems: Vec<CometElements> = self
            .list_all()
            .unwrap_or_else(|_| default_comets())
            .into_iter()
            .filter(|c| c.enabled)
            .map(|c| c.to_elements())
            .collect();
        if let Ok(mut guard) = self.enabled_cache.write() {
            *guard = Some(elems.clone());
        }
        elems
    }

    pub fn list_all_elements(&self) -> Vec<CometElements> {
        self.list_all()
            .unwrap_or_else(|_| default_comets())
            .into_iter()
            .map(|c| c.to_elements())
            .collect()
    }

    pub fn find_by_id(&self, id: &str) -> Option<CometRecord> {
        let conn = self.conn.lock().ok()?;
        conn.query_row(
            "SELECT id, name, epoch_perihelion_jd, perihelion_dist_au, eccentricity,
                    inclination_deg, arg_periapsis_deg, ascending_node_deg,
                    abs_mag_h, slope_param_k, enabled, notes
             FROM comets WHERE lower(id) = lower(?1)",
            params![id],
            row_to_comet,
        )
        .ok()
    }

    pub fn upsert(&self, mut record: CometRecord) -> Result<CometRecord, String> {
        record.name = record.name.trim().to_owned();
        if record.id.trim().is_empty() {
            let slug: String = record
                .name
                .chars()
                .filter(|ch| ch.is_ascii_alphanumeric())
                .take(18)
                .collect();
            let ts = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis())
                .unwrap_or(0);
            record.id = if slug.is_empty() {
                format!("comet:custom_{ts}")
            } else {
                format!("comet:{slug}_{ts}")
            };
        } else {
            record.id = record.id.trim().to_owned();
            if !record.id.starts_with("comet:") {
                record.id = format!("comet:{}", record.id);
            }
        }
        record.arg_periapsis_deg = record.arg_periapsis_deg.rem_euclid(360.0);
        record.ascending_node_deg = record.ascending_node_deg.rem_euclid(360.0);
        record.validate()?;

        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        insert_comet_stmt(&conn, &record, now_unix_secs())?;
        self.invalidate_comet_cache();
        Ok(record)
    }

    pub fn set_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        conn.execute(
            "UPDATE comets SET enabled = ?1, updated_at = ?2 WHERE lower(id) = lower(?3)",
            params![i32::from(enabled), now_unix_secs(), id],
        )
        .map_err(|e| format!("彗星表示フラグ更新失敗: {e}"))?;
        self.invalidate_comet_cache();
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        let n = conn
            .execute("DELETE FROM comets WHERE lower(id) = lower(?1)", params![id])
            .map_err(|e| format!("彗星削除失敗: {e}"))?;
        self.invalidate_comet_cache();
        Ok(n > 0)
    }

    pub fn import_records(
        &self,
        records: Vec<CometRecord>,
        replace_all: bool,
    ) -> Result<usize, String> {
        let mut normalized = Vec::with_capacity(records.len());
        let base_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        for (idx, mut rec) in records.into_iter().enumerate() {
            rec.name = rec.name.trim().to_owned();
            if rec.id.trim().is_empty() {
                rec.id = format!("comet:imp_{base_ts}_{idx}");
            } else {
                rec.id = rec.id.trim().to_owned();
                if !rec.id.starts_with("comet:") {
                    rec.id = format!("comet:{}", rec.id);
                }
            }
            rec.arg_periapsis_deg = rec.arg_periapsis_deg.rem_euclid(360.0);
            rec.ascending_node_deg = rec.ascending_node_deg.rem_euclid(360.0);
            rec.validate()
                .map_err(|e| format!("{} 件目 ({}) のエラー: {e}", idx + 1, rec.name))?;
            normalized.push(rec);
        }

        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("トランザクション開始失敗: {e}"))?;

        if replace_all {
            tx.execute("DELETE FROM comets", [])
                .map_err(|e| format!("既存彗星クリア失敗: {e}"))?;
        }

        let now = now_unix_secs();
        for c in &normalized {
            insert_comet_stmt(&tx, c, now)?;
        }

        tx.commit()
            .map_err(|e| format!("トランザクションコミット失敗: {e}"))?;
        self.invalidate_comet_cache();
        Ok(normalized.len())
    }

    pub fn restore_defaults(&self, replace_all: bool) -> Result<usize, String> {
        self.import_records(default_comets(), replace_all)
    }

    // -----------------------------------------------------------------
    // Artificial Satellites (TLE) CRUD
    // -----------------------------------------------------------------

    pub fn list_satellites(&self) -> Result<Vec<SatelliteRecord>, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        let mut stmt = conn
            .prepare(
                "SELECT id, norad_id, name, line1, line2, category, enabled
                 FROM satellites
                 ORDER BY enabled DESC, norad_id ASC, name ASC",
            )
            .map_err(|e| format!("衛星一覧クエリ準備失敗: {e}"))?;

        let rows = stmt
            .query_map([], row_to_satellite)
            .map_err(|e| format!("衛星一覧取得失敗: {e}"))?;

        let mut out = Vec::new();
        for item in rows {
            out.push(item.map_err(|e| format!("衛星レコード読込失敗: {e}"))?);
        }
        Ok(out)
    }

    pub fn list_enabled_satellites(&self) -> Vec<SatelliteRecord> {
        self.list_satellites()
            .unwrap_or_else(|_| default_satellites())
            .into_iter()
            .filter(|s| s.enabled)
            .collect()
    }

    pub fn upsert_satellite(&self, mut rec: SatelliteRecord) -> Result<SatelliteRecord, String> {
        rec.name = rec.name.trim().to_owned();
        rec.line1 = rec.line1.trim().to_owned();
        rec.line2 = rec.line2.trim().to_owned();
        if rec.id.trim().is_empty() {
            rec.id = format!("sat:{}", rec.norad_id);
        }
        rec.validate()?;
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        insert_satellite_stmt(&conn, &rec, now_unix_secs())?;
        Ok(rec)
    }

    pub fn upsert_satellites_batch(
        &self,
        records: Vec<SatelliteRecord>,
        replace_category: Option<&str>,
    ) -> Result<usize, String> {
        for rec in &records {
            rec.validate()?;
        }
        let mut conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        let tx = conn
            .transaction()
            .map_err(|e| format!("衛星トランザクション開始失敗: {e}"))?;

        if let Some(cat) = replace_category {
            tx.execute("DELETE FROM satellites WHERE category = ?1", params![cat])
                .map_err(|e| format!("既存カテゴリ衛星削除失敗: {e}"))?;
        }

        let now = now_unix_secs();
        for s in &records {
            insert_satellite_stmt(&tx, s, now)?;
        }
        tx.commit()
            .map_err(|e| format!("衛星トランザクションコミット失敗: {e}"))?;
        Ok(records.len())
    }

    pub fn set_satellite_enabled(&self, id: &str, enabled: bool) -> Result<(), String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        conn.execute(
            "UPDATE satellites SET enabled = ?1, updated_at = ?2 WHERE lower(id) = lower(?3)",
            params![i32::from(enabled), now_unix_secs(), id],
        )
        .map_err(|e| format!("衛星表示切替失敗: {e}"))?;
        Ok(())
    }

    pub fn delete_satellite(&self, id: &str) -> Result<bool, String> {
        let conn = self
            .conn
            .lock()
            .map_err(|_| "DBロックの取得に失敗しました".to_owned())?;
        let n = conn
            .execute(
                "DELETE FROM satellites WHERE lower(id) = lower(?1)",
                params![id],
            )
            .map_err(|e| format!("衛星削除失敗: {e}"))?;
        Ok(n > 0)
    }

    pub fn restore_default_satellites(&self) -> Result<usize, String> {
        self.upsert_satellites_batch(default_satellites(), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sqlite_comet_crud_and_import_work() {
        let db = CometDb::open_in_memory().expect("open in-memory db");
        let initial = db.list_all().expect("list initial");
        assert_eq!(initial.len(), 5);

        // Add custom comet
        let added = db
            .upsert(CometRecord {
                id: String::new(),
                name: "C/2025 Test".into(),
                epoch_perihelion_jd: calendar_to_jd(2026, 6, 15.0),
                perihelion_dist_au: 0.72,
                eccentricity: 0.995,
                inclination_deg: 45.2,
                arg_periapsis_deg: 120.0,
                ascending_node_deg: 210.0,
                abs_mag_h: 6.5,
                slope_param_k: 10.0,
                enabled: true,
                notes: "unit test comet".into(),
            })
            .expect("upsert");
        assert!(added.id.starts_with("comet:"));
        assert_eq!(db.list_all().unwrap().len(), 6);
        assert!(db.find_by_id(&added.id).is_some());

        // Toggle enabled
        db.set_enabled(&added.id, false).expect("disable");
        assert_eq!(db.list_enabled_elements().len(), 5);
        assert_eq!(db.list_all_elements().len(), 6);

        // Delete
        assert!(db.delete(&added.id).expect("delete"));
        assert_eq!(db.list_all().unwrap().len(), 5);

        // Replace import with 15 comets (unlimited count check)
        let batch: Vec<CometRecord> = (0..15)
            .map(|i| CometRecord {
                id: format!("comet:batch_{i}"),
                name: format!("Batch Comet #{i}"),
                epoch_perihelion_jd: calendar_to_jd(2026, 1, 1.0) + f64::from(i) * 20.0,
                perihelion_dist_au: 0.5 + f64::from(i) * 0.1,
                eccentricity: 0.85,
                inclination_deg: 15.0 + f64::from(i),
                arg_periapsis_deg: 40.0,
                ascending_node_deg: 90.0,
                abs_mag_h: 7.0,
                slope_param_k: 10.0,
                enabled: true,
                notes: String::new(),
            })
            .collect();
        let imported = db.import_records(batch, true).expect("import batch");
        assert_eq!(imported, 15);
        assert_eq!(db.list_all().unwrap().len(), 15);

        // Restore defaults
        let restored = db.restore_defaults(true).expect("restore defaults");
        assert_eq!(restored, 5);

        // Satellites seed & CRUD
        let sats = db.list_satellites().expect("list satellites");
        assert_eq!(sats.len(), 4);
        assert!(sats.iter().any(|s| s.norad_id == 25544));
        db.set_satellite_enabled("sat:25544", false).expect("disable sat");
        assert_eq!(db.list_enabled_satellites().len(), 2);
        db.set_satellite_enabled("sat:25544", true).expect("enable sat");
        assert_eq!(db.list_enabled_satellites().len(), 3);
    }
}
