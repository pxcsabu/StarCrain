use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use rayon::prelude::*;
use serde::{Deserialize, Serialize};
use thiserror::Error;

const STARS_MAGIC: &[u8; 4] = b"SCST";
const STARS_VERSION: u16 = 1;
const STARS_HEADER_LEN: usize = 14;
const STAR_RECORD_LEN: usize = 54;

pub const IAU_CONSTELLATIONS: [&str; 88] = [
    "And", "Ant", "Aps", "Aql", "Aqr", "Ara", "Ari", "Aur", "Boo", "CMa", "CMi", "CVn", "Cae",
    "Cam", "Cap", "Car", "Cas", "Cen", "Cep", "Cet", "Cha", "Cir", "Cnc", "Col", "Com", "CrA",
    "CrB", "Crt", "Cru", "Crv", "Cyg", "Del", "Dor", "Dra", "Equ", "Eri", "For", "Gem", "Gru",
    "Her", "Hor", "Hya", "Hyi", "Ind", "LMi", "Lac", "Leo", "Lep", "Lib", "Lup", "Lyn", "Lyr",
    "Men", "Mic", "Mon", "Mus", "Nor", "Oct", "Oph", "Ori", "Pav", "Peg", "Per", "Phe", "Pic",
    "PsA", "Psc", "Pup", "Pyx", "Ret", "Scl", "Sco", "Sct", "Ser", "Sex", "Sge", "Sgr", "Tau",
    "Tel", "TrA", "Tri", "Tuc", "UMa", "UMi", "Vel", "Vir", "Vol", "Vul",
];

#[derive(Debug, Error)]
pub enum CatalogError {
    #[error("Failed to locate StarCrane assets directory")]
    AssetsNotFound,
    #[error("IO error reading {0}: {1}")]
    Io(String, #[source] std::io::Error),
    #[error("JSON parse error in {0}: {1}")]
    Json(String, #[source] serde_json::Error),
    #[error("Invalid stars.bin format: {0}")]
    InvalidStarsBinary(String),
}

#[derive(Debug, Clone, Copy)]
pub struct StarRecord {
    pub id: u32,
    pub hip: u32,
    pub ra_rad: f32,
    pub dec_rad: f32,
    pub mag: f32,
    pub ci: f32,
    pub pm_ra: f32,
    pub pm_dec: f32,
    pub dist_pc: f32,
    pub con_idx: u8,
    pub spect_code: u8,
    pub flags: u16,
    proper_off: u32,
    proper_len: u16,
    bayer_off: u32,
    bayer_len: u16,
    pub flam_num: u16,
}

const HIP_DENSE_LIMIT: usize = 131_072;

#[derive(Debug)]
pub struct StarCatalog {
    pub stars: Vec<StarRecord>,
    string_pool: String,
    hip_dense: Vec<u32>,
    hip_overflow: HashMap<u32, usize>,
}

impl StarCatalog {
    pub fn load(path: &Path) -> Result<Self, CatalogError> {
        let bytes = fs::read(path).map_err(|e| CatalogError::Io(path.display().to_string(), e))?;
        Self::from_bytes(&bytes)
    }

    pub fn from_bytes(bytes: &[u8]) -> Result<Self, CatalogError> {
        if bytes.len() < STARS_HEADER_LEN {
            return Err(CatalogError::InvalidStarsBinary("file too short".into()));
        }
        if &bytes[0..4] != STARS_MAGIC {
            return Err(CatalogError::InvalidStarsBinary("bad magic header".into()));
        }
        let version = u16::from_le_bytes([bytes[4], bytes[5]]);
        if version != STARS_VERSION {
            return Err(CatalogError::InvalidStarsBinary(format!(
                "unsupported version {version}"
            )));
        }
        let count = u32::from_le_bytes([bytes[6], bytes[7], bytes[8], bytes[9]]) as usize;
        let pool_len = u32::from_le_bytes([bytes[10], bytes[11], bytes[12], bytes[13]]) as usize;
        let records_end = STARS_HEADER_LEN + count * STAR_RECORD_LEN;
        let expected_len = records_end + pool_len;
        if bytes.len() != expected_len {
            return Err(CatalogError::InvalidStarsBinary(format!(
                "expected {expected_len} bytes, got {}",
                bytes.len()
            )));
        }

        let string_pool = std::str::from_utf8(&bytes[records_end..])
            .map_err(|e| CatalogError::InvalidStarsBinary(format!("invalid UTF-8 pool: {e}")))?
            .to_owned();

        let stars: Vec<StarRecord> = bytes[STARS_HEADER_LEN..records_end]
            .as_chunks::<STAR_RECORD_LEN>()
            .0
            .par_iter()
            .map(|chunk| StarRecord {
                id: u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]),
                hip: u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]),
                ra_rad: f32::from_le_bytes([chunk[8], chunk[9], chunk[10], chunk[11]]),
                dec_rad: f32::from_le_bytes([chunk[12], chunk[13], chunk[14], chunk[15]]),
                mag: f32::from_le_bytes([chunk[16], chunk[17], chunk[18], chunk[19]]),
                ci: f32::from_le_bytes([chunk[20], chunk[21], chunk[22], chunk[23]]),
                pm_ra: f32::from_le_bytes([chunk[24], chunk[25], chunk[26], chunk[27]]),
                pm_dec: f32::from_le_bytes([chunk[28], chunk[29], chunk[30], chunk[31]]),
                dist_pc: f32::from_le_bytes([chunk[32], chunk[33], chunk[34], chunk[35]]),
                con_idx: chunk[36],
                spect_code: chunk[37],
                flags: u16::from_le_bytes([chunk[38], chunk[39]]),
                proper_off: u32::from_le_bytes([chunk[40], chunk[41], chunk[42], chunk[43]]),
                proper_len: u16::from_le_bytes([chunk[44], chunk[45]]),
                bayer_off: u32::from_le_bytes([chunk[46], chunk[47], chunk[48], chunk[49]]),
                bayer_len: u16::from_le_bytes([chunk[50], chunk[51]]),
                flam_num: u16::from_le_bytes([chunk[52], chunk[53]]),
            })
            .collect();

        let _ = count;
        let mut hip_dense = vec![u32::MAX; HIP_DENSE_LIMIT];
        let mut hip_overflow = HashMap::new();
        for (idx, star) in stars.iter().enumerate() {
            if star.hip == 0 {
                continue;
            }
            let h = star.hip as usize;
            if let Some(slot) = hip_dense.get_mut(h) {
                if *slot == u32::MAX {
                    *slot = idx as u32;
                }
            } else {
                hip_overflow.entry(star.hip).or_insert(idx);
            }
        }

        Ok(Self {
            stars,
            string_pool,
            hip_dense,
            hip_overflow,
        })
    }

    pub fn proper_name(&self, star: &StarRecord) -> &str {
        self.slice_pool(star.proper_off, star.proper_len)
    }

    pub fn bayer(&self, star: &StarRecord) -> &str {
        self.slice_pool(star.bayer_off, star.bayer_len)
    }

    pub fn constellation_code(&self, star: &StarRecord) -> Option<&'static str> {
        IAU_CONSTELLATIONS.get(star.con_idx as usize).copied()
    }

    pub fn find_by_hip(&self, hip: u32) -> Option<&StarRecord> {
        if let Some(&idx) = self.hip_dense.get(hip as usize) {
            if idx != u32::MAX {
                return self.stars.get(idx as usize);
            }
            return None;
        }
        self.hip_overflow
            .get(&hip)
            .and_then(|&idx| self.stars.get(idx))
    }

    fn slice_pool(&self, off: u32, len: u16) -> &str {
        if len == 0 {
            return "";
        }
        let start = off as usize;
        let end = start + len as usize;
        self.string_pool.get(start..end).unwrap_or("")
    }
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct DsoEntry {
    pub id: String,
    pub messier: Option<u16>,
    pub obj_type: String,
    pub name_en: String,
    pub name_ja: Option<String>,
    pub constellation: String,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub mag: Option<f32>,
    pub maj_ax_arcmin: Option<f32>,
    pub min_ax_arcmin: Option<f32>,
    pub pos_ang_deg: Option<f32>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConstellationEntry {
    pub id: String,
    pub name_la: String,
    pub name_en: String,
    pub name_ja: String,
    pub genitive: String,
    pub rank: u8,
    pub center_ra_deg: f64,
    pub center_dec_deg: f64,
    pub lines_simple: Vec<Vec<[f64; 2]>>,
    pub lines_standard: Vec<Vec<[f64; 2]>>,
    pub lines_detailed: Vec<Vec<[f64; 2]>>,
    pub bounds: Vec<Vec<[f64; 2]>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct AsterismEntry {
    pub id: String,
    pub name_en: String,
    pub name_ja: String,
    pub priority: u8,
    pub lines: Vec<Vec<[f64; 2]>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConstellationsBundle {
    pub constellations: Vec<ConstellationEntry>,
    pub asterisms: Vec<AsterismEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MilkyWayLevel {
    pub level: String,
    pub polygons: Vec<Vec<Vec<[f64; 2]>>>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct LocationPreset {
    pub id: String,
    pub name_ja: String,
    pub name_en: String,
    pub country_ja: String,
    pub region: String,
    pub lat_deg: f64,
    pub lon_deg: f64,
    pub alt_m: f64,
    pub tz_offset_min: i32,
    pub tz_name: String,
    pub category: String,
    #[serde(default)]
    pub is_default: bool,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct MeteorShower {
    pub code: String,
    pub iau_no: u32,
    pub name_ja: String,
    pub name_en: String,
    pub constellation: String,
    pub active_start: String,
    pub active_end: String,
    pub peak_date: String,
    pub peak_solar_lon_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub drift_ra_deg: f64,
    pub drift_dec_deg: f64,
    pub velocity_km_s: f64,
    pub zhr: u32,
    pub parent_body: String,
    pub description_ja: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct VariableStar {
    pub id: String,
    pub name_ja: String,
    pub name_en: String,
    pub constellation: String,
    pub hip: u32,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub var_type: String,
    pub mag_max: f32,
    pub mag_min: f32,
    pub period_days: Option<f64>,
    pub spectrum: String,
    pub description_ja: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ConstellationMyth {
    pub id: String,
    pub name_ja: String,
    pub name_la: String,
    pub season: String,
    pub summary: String,
    pub how_to_find: String,
    pub mythology: String,
    pub notable_objects: Vec<String>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct StarGuide {
    pub hip: u32,
    pub name_ja: String,
    pub name_en: String,
    pub constellation: String,
    pub bayer: String,
    pub mag: f32,
    pub dist_ly: f32,
    pub spectrum: String,
    pub summary_ja: String,
    pub commentary_ja: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogLoadBreakdown {
    pub stars_ms: f64,
    pub dso_ms: f64,
    pub constellations_ms: f64,
    pub milky_way_ms: f64,
    pub locations_ms: f64,
    pub meteors_ms: f64,
    pub variables_ms: f64,
    pub mythology_ms: f64,
    pub star_guides_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct CatalogStatus {
    pub total_load_ms: f64,
    pub within_budget_100ms: bool,
    pub star_count: usize,
    pub dso_count: usize,
    pub messier_count: usize,
    pub constellation_count: usize,
    pub asterism_count: usize,
    pub milky_way_levels: usize,
    pub location_count: usize,
    pub meteor_shower_count: usize,
    pub variable_star_count: usize,
    pub constellation_myth_count: usize,
    pub star_guide_count: usize,
    pub default_location_name: String,
    pub assets_root: String,
    pub breakdown: CatalogLoadBreakdown,
}

#[derive(Debug)]
pub struct CatalogStore {
    pub stars: StarCatalog,
    pub dsos: Vec<DsoEntry>,
    pub constellations: Vec<ConstellationEntry>,
    pub asterisms: Vec<AsterismEntry>,
    pub milky_way: Vec<MilkyWayLevel>,
    pub locations: Vec<LocationPreset>,
    pub meteor_showers: Vec<MeteorShower>,
    pub variable_stars: Vec<VariableStar>,
    pub constellation_myths: Vec<ConstellationMyth>,
    pub star_guides: Vec<StarGuide>,
    pub assets_root: PathBuf,
    pub total_load_ms: f64,
    pub breakdown: CatalogLoadBreakdown,
}

const EMBEDDED_STARS_BIN: &[u8] = include_bytes!("../../../assets/catalogs/stars.bin");
const EMBEDDED_DSO_JSON: &[u8] = include_bytes!("../../../assets/catalogs/dso.json");
const EMBEDDED_CONSTELLATIONS_JSON: &[u8] =
    include_bytes!("../../../assets/catalogs/constellations.json");
const EMBEDDED_MILKYWAY_JSON: &[u8] = include_bytes!("../../../assets/catalogs/milkyway.json");
const EMBEDDED_LOCATIONS_JSON: &[u8] = include_bytes!("../../../assets/locations/locations.json");
const EMBEDDED_METEORS_JSON: &[u8] = include_bytes!("../../../assets/catalogs/meteors.json");
const EMBEDDED_VARIABLES_JSON: &[u8] = include_bytes!("../../../assets/catalogs/variables.json");
const EMBEDDED_MYTHS_JA_JSON: &[u8] =
    include_bytes!("../../../assets/mythology/constellations_ja.json");
const EMBEDDED_STAR_GUIDES_JA_JSON: &[u8] =
    include_bytes!("../../../assets/mythology/stars_ja.json");

enum AssetSource {
    File(PathBuf),
    Embedded {
        label: &'static str,
        bytes: &'static [u8],
    },
}

fn parse_json_slice_timed<T: serde::de::DeserializeOwned>(
    label: &str,
    bytes: &[u8],
) -> Result<(T, f64), CatalogError> {
    let start = Instant::now();
    let parsed: T =
        serde_json::from_slice(bytes).map_err(|e| CatalogError::Json(label.to_string(), e))?;
    Ok((parsed, start.elapsed().as_secs_f64() * 1000.0))
}

fn load_json_source_timed<T: serde::de::DeserializeOwned>(
    source: AssetSource,
) -> Result<(T, f64), CatalogError> {
    match source {
        AssetSource::File(path) => {
            let start = Instant::now();
            let bytes =
                fs::read(&path).map_err(|e| CatalogError::Io(path.display().to_string(), e))?;
            let (parsed, _) = parse_json_slice_timed(&path.display().to_string(), &bytes)?;
            Ok((parsed, start.elapsed().as_secs_f64() * 1000.0))
        }
        AssetSource::Embedded { label, bytes } => parse_json_slice_timed(label, bytes),
    }
}

fn load_stars_source_timed(source: AssetSource) -> Result<(StarCatalog, f64), CatalogError> {
    let start = Instant::now();
    let stars = match source {
        AssetSource::File(path) => StarCatalog::load(&path)?,
        AssetSource::Embedded { bytes, .. } => StarCatalog::from_bytes(bytes)?,
    };
    Ok((stars, start.elapsed().as_secs_f64() * 1000.0))
}

struct CatalogAssetSources {
    assets_root: PathBuf,
    stars: AssetSource,
    dso: AssetSource,
    constellations: AssetSource,
    milky_way: AssetSource,
    locations: AssetSource,
    meteors: AssetSource,
    variables: AssetSource,
    myths: AssetSource,
    star_guides: AssetSource,
}

impl CatalogStore {
    pub fn load_from_dir(assets_dir: &Path) -> Result<Self, CatalogError> {
        Self::load_from_sources(CatalogAssetSources {
            assets_root: assets_dir.to_path_buf(),
            stars: AssetSource::File(assets_dir.join("catalogs/stars.bin")),
            dso: AssetSource::File(assets_dir.join("catalogs/dso.json")),
            constellations: AssetSource::File(assets_dir.join("catalogs/constellations.json")),
            milky_way: AssetSource::File(assets_dir.join("catalogs/milkyway.json")),
            locations: AssetSource::File(assets_dir.join("locations/locations.json")),
            meteors: AssetSource::File(assets_dir.join("catalogs/meteors.json")),
            variables: AssetSource::File(assets_dir.join("catalogs/variables.json")),
            myths: AssetSource::File(assets_dir.join("mythology/constellations_ja.json")),
            star_guides: AssetSource::File(assets_dir.join("mythology/stars_ja.json")),
        })
    }

    pub fn load_embedded() -> Result<Self, CatalogError> {
        Self::load_from_sources(CatalogAssetSources {
            assets_root: PathBuf::from("embedded://assets"),
            stars: AssetSource::Embedded {
                label: "embedded://assets/catalogs/stars.bin",
                bytes: EMBEDDED_STARS_BIN,
            },
            dso: AssetSource::Embedded {
                label: "embedded://assets/catalogs/dso.json",
                bytes: EMBEDDED_DSO_JSON,
            },
            constellations: AssetSource::Embedded {
                label: "embedded://assets/catalogs/constellations.json",
                bytes: EMBEDDED_CONSTELLATIONS_JSON,
            },
            milky_way: AssetSource::Embedded {
                label: "embedded://assets/catalogs/milkyway.json",
                bytes: EMBEDDED_MILKYWAY_JSON,
            },
            locations: AssetSource::Embedded {
                label: "embedded://assets/locations/locations.json",
                bytes: EMBEDDED_LOCATIONS_JSON,
            },
            meteors: AssetSource::Embedded {
                label: "embedded://assets/catalogs/meteors.json",
                bytes: EMBEDDED_METEORS_JSON,
            },
            variables: AssetSource::Embedded {
                label: "embedded://assets/catalogs/variables.json",
                bytes: EMBEDDED_VARIABLES_JSON,
            },
            myths: AssetSource::Embedded {
                label: "embedded://assets/mythology/constellations_ja.json",
                bytes: EMBEDDED_MYTHS_JA_JSON,
            },
            star_guides: AssetSource::Embedded {
                label: "embedded://assets/mythology/stars_ja.json",
                bytes: EMBEDDED_STAR_GUIDES_JA_JSON,
            },
        })
    }

    fn load_from_sources(sources: CatalogAssetSources) -> Result<Self, CatalogError> {
        let total_start = Instant::now();

        let (
            (stars_res, dso_res),
            ((const_res, mw_res), (small_a, small_b)),
        ) = rayon::join(
            || {
                rayon::join(
                    || load_stars_source_timed(sources.stars),
                    || load_json_source_timed::<Vec<DsoEntry>>(sources.dso),
                )
            },
            || {
                rayon::join(
                    || {
                        rayon::join(
                            || load_json_source_timed::<ConstellationsBundle>(sources.constellations),
                            || load_json_source_timed::<Vec<MilkyWayLevel>>(sources.milky_way),
                        )
                    },
                    || {
                        rayon::join(
                            || {
                                rayon::join(
                                    || load_json_source_timed::<Vec<LocationPreset>>(sources.locations),
                                    || load_json_source_timed::<Vec<MeteorShower>>(sources.meteors),
                                )
                            },
                            || {
                                rayon::join(
                                    || load_json_source_timed::<Vec<VariableStar>>(sources.variables),
                                    || {
                                        rayon::join(
                                            || {
                                                load_json_source_timed::<Vec<ConstellationMyth>>(
                                                    sources.myths,
                                                )
                                            },
                                            || {
                                                load_json_source_timed::<Vec<StarGuide>>(
                                                    sources.star_guides,
                                                )
                                            },
                                        )
                                    },
                                )
                            },
                        )
                    },
                )
            },
        );

        let (stars, stars_ms) = stars_res?;
        let (dsos, dso_ms) = dso_res?;
        let (const_bundle, constellations_ms) = const_res?;
        let (milky_way, milky_way_ms) = mw_res?;
        let (loc_res, met_res) = small_a;
        let (var_res, (myth_res, guide_res)) = small_b;
        let (locations, locations_ms) = loc_res?;
        let (meteor_showers, meteors_ms) = met_res?;
        let (variable_stars, variables_ms) = var_res?;
        let (constellation_myths, mythology_ms) = myth_res?;
        let (star_guides, star_guides_ms) = guide_res?;

        let total_load_ms = total_start.elapsed().as_secs_f64() * 1000.0;

        Ok(Self {
            stars,
            dsos,
            constellations: const_bundle.constellations,
            asterisms: const_bundle.asterisms,
            milky_way,
            locations,
            meteor_showers,
            variable_stars,
            constellation_myths,
            star_guides,
            assets_root: sources.assets_root,
            total_load_ms,
            breakdown: CatalogLoadBreakdown {
                stars_ms,
                dso_ms,
                constellations_ms,
                milky_way_ms,
                locations_ms,
                meteors_ms,
                variables_ms,
                mythology_ms,
                star_guides_ms,
            },
        })
    }

    pub fn status(&self) -> CatalogStatus {
        let messier_count = self.dsos.iter().filter(|d| d.messier.is_some()).count();
        let default_location_name = self
            .locations
            .iter()
            .find(|l| l.is_default)
            .or_else(|| self.locations.first())
            .map(|l| l.name_ja.clone())
            .unwrap_or_else(|| "明石市".to_string());

        CatalogStatus {
            total_load_ms: self.total_load_ms,
            within_budget_100ms: self.total_load_ms < 100.0,
            star_count: self.stars.stars.len(),
            dso_count: self.dsos.len(),
            messier_count,
            constellation_count: self.constellations.len(),
            asterism_count: self.asterisms.len(),
            milky_way_levels: self.milky_way.len(),
            location_count: self.locations.len(),
            meteor_shower_count: self.meteor_showers.len(),
            variable_star_count: self.variable_stars.len(),
            constellation_myth_count: self.constellation_myths.len(),
            star_guide_count: self.star_guides.len(),
            default_location_name,
            assets_root: self.assets_root.display().to_string(),
            breakdown: self.breakdown.clone(),
        }
    }
}

fn has_stars_bin(dir: &Path) -> bool {
    dir.join("catalogs/stars.bin").is_file()
}

pub fn resolve_assets_dir(resource_dir: Option<&Path>) -> Result<PathBuf, CatalogError> {
    if let Some(res) = resource_dir {
        for candidate in [res.join("assets"), res.join("_up_").join("assets"), res.to_path_buf()] {
            if has_stars_bin(&candidate) {
                return Ok(candidate);
            }
        }
    }

    if let Some(exe_dir) = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
    {
        for candidate in [exe_dir.join("assets"), exe_dir.join("_up_").join("assets")] {
            if has_stars_bin(&candidate) {
                return Ok(candidate);
            }
        }
    }

    if let Ok(cwd) = std::env::current_dir() {
        for candidate in [cwd.join("assets"), cwd.join("../assets")] {
            if has_stars_bin(&candidate) {
                return Ok(candidate);
            }
        }
    }

    if let Some(workspace_assets) = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("assets"))
        && has_stars_bin(&workspace_assets)
    {
        return Ok(workspace_assets);
    }

    Err(CatalogError::AssetsNotFound)
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn loads_all_catalogs_under_100ms() {
        let assets_dir = resolve_assets_dir(None).expect("assets directory should exist");
        let store = CatalogStore::load_from_dir(&assets_dir).expect("catalog load should succeed");
        let status = store.status();

        println!(
            "CatalogStore load total={:.2}ms | stars={:.2}ms, dso={:.2}ms, const={:.2}ms, mw={:.2}ms, loc={:.2}ms, met={:.2}ms, var={:.2}ms, myth={:.2}ms, guide={:.2}ms",
            status.total_load_ms,
            status.breakdown.stars_ms,
            status.breakdown.dso_ms,
            status.breakdown.constellations_ms,
            status.breakdown.milky_way_ms,
            status.breakdown.locations_ms,
            status.breakdown.meteors_ms,
            status.breakdown.variables_ms,
            status.breakdown.mythology_ms,
            status.breakdown.star_guides_ms,
        );

        assert!(
            status.total_load_ms < 100.0,
            "Catalog load took {:.2} ms, exceeding 100ms DoD budget",
            status.total_load_ms
        );
        assert!(status.star_count >= 100_000, "star_count={}", status.star_count);
        assert!(status.dso_count >= 10_000, "dso_count={}", status.dso_count);
        assert_eq!(status.messier_count, 110);
        assert_eq!(status.constellation_count, 88);
        assert!(status.asterism_count > 10);
        assert_eq!(status.milky_way_levels, 5);
        assert!(status.location_count >= 60);
        assert!(status.meteor_shower_count >= 21);
        assert!(status.variable_star_count >= 40);
        assert_eq!(status.constellation_myth_count, 88);
        assert!(status.star_guide_count >= 40);
    }

    fn assert_store_integrity(store: &CatalogStore) {
        let sirius = store
            .stars
            .find_by_hip(32349)
            .expect("Sirius HIP 32349 must exist");
        assert_eq!(store.stars.proper_name(sirius), "Sirius");
        assert_eq!(store.stars.constellation_code(sirius), Some("CMa"));
        assert!(sirius.mag < -1.0);

        let polaris = store
            .stars
            .find_by_hip(11767)
            .expect("Polaris HIP 11767 must exist");
        assert_eq!(store.stars.proper_name(polaris), "Polaris");
        assert_eq!(store.stars.constellation_code(polaris), Some("UMi"));

        let messier_nums: HashSet<u16> = store.dsos.iter().filter_map(|d| d.messier).collect();
        for m in 1..=110 {
            assert!(messier_nums.contains(&m), "Missing Messier object M{m}");
        }

        for c in &store.constellations {
            assert!(!c.name_ja.is_empty());
            assert!(!c.lines_simple.is_empty());
            assert!(!c.lines_standard.is_empty());
            assert!(!c.lines_detailed.is_empty());
            assert!(!c.bounds.is_empty());
        }

        let pref_count = store
            .locations
            .iter()
            .filter(|l| l.category == "prefecture")
            .count();
        assert_eq!(pref_count, 47);
        assert!(
            store
                .locations
                .iter()
                .any(|l| l.is_default && l.name_ja.contains("明石"))
        );
    }

    #[test]
    fn verifies_real_star_and_messier_and_location_integrity() {
        let assets_dir = resolve_assets_dir(None).expect("assets directory should exist");
        let store = CatalogStore::load_from_dir(&assets_dir).expect("catalog load should succeed");
        assert_store_integrity(&store);
    }

    #[test]
    fn loads_embedded_catalogs_with_full_integrity() {
        let store = CatalogStore::load_embedded().expect("embedded catalog load should succeed");
        let status = store.status();
        assert_eq!(status.assets_root, "embedded://assets");
        assert!(status.star_count >= 100_000, "star_count={}", status.star_count);
        assert_eq!(status.messier_count, 110);
        assert_eq!(status.constellation_count, 88);
        assert_store_integrity(&store);
    }
}
