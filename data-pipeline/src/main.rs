mod japanese_names;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

use japanese_names::{
    asterism_japanese_name, constellation_japanese_override, messier_japanese_name,
    notable_dso_japanese_name,
};

#[derive(Debug, Error)]
enum PipelineError {
    #[error("IO error at {0}: {1}")]
    Io(String, #[source] std::io::Error),
    #[error("CSV error in {0}: {1}")]
    Csv(String, #[source] csv::Error),
    #[error("JSON error in {0}: {1}")]
    Json(String, #[source] serde_json::Error),
    #[error("Validation error: {0}")]
    Validation(String),
}

const IAU_CONSTELLATIONS: [&str; 88] = [
    "And", "Ant", "Aps", "Aql", "Aqr", "Ara", "Ari", "Aur", "Boo", "CMa", "CMi", "CVn", "Cae",
    "Cam", "Cap", "Car", "Cas", "Cen", "Cep", "Cet", "Cha", "Cir", "Cnc", "Col", "Com", "CrA",
    "CrB", "Crt", "Cru", "Crv", "Cyg", "Del", "Dor", "Dra", "Equ", "Eri", "For", "Gem", "Gru",
    "Her", "Hor", "Hya", "Hyi", "Ind", "LMi", "Lac", "Leo", "Lep", "Lib", "Lup", "Lyn", "Lyr",
    "Men", "Mic", "Mon", "Mus", "Nor", "Oct", "Oph", "Ori", "Pav", "Peg", "Per", "Phe", "Pic",
    "PsA", "Psc", "Pup", "Pyx", "Ret", "Scl", "Sco", "Sct", "Ser", "Sex", "Sge", "Sgr", "Tau",
    "Tel", "TrA", "Tri", "Tuc", "UMa", "UMi", "Vel", "Vir", "Vol", "Vul",
];

fn constellation_index(code: &str) -> u8 {
    let normalized = match code.trim() {
        "Se1" | "Se2" | "Ser1" | "Ser2" => "Ser",
        other => other,
    };
    IAU_CONSTELLATIONS
        .iter()
        .position(|&c| c.eq_ignore_ascii_case(normalized))
        .map(|i| i as u8)
        .unwrap_or(255)
}

fn normalize_const_code(code: &str) -> String {
    let trimmed = code.trim();
    match trimmed {
        "Se1" | "Se2" | "Ser1" | "Ser2" => "Ser".to_string(),
        other => other.to_string(),
    }
}

fn encode_spectrum(spect: &str) -> u8 {
    match spect.trim().as_bytes().first().map(|b| b.to_ascii_uppercase()) {
        Some(b'O') => 1,
        Some(b'B') => 2,
        Some(b'A') => 3,
        Some(b'F') => 4,
        Some(b'G') => 5,
        Some(b'K') => 6,
        Some(b'M') => 7,
        Some(b'C' | b'S' | b'W' | b'N' | b'R' | b'L' | b'T') => 8,
        _ => 0,
    }
}

struct RawStar {
    id: u32,
    hip: u32,
    ra_rad: f32,
    dec_rad: f32,
    mag: f32,
    ci: f32,
    pm_ra: f32,
    pm_dec: f32,
    dist_pc: f32,
    con_idx: u8,
    spect_code: u8,
    flags: u16,
    proper: String,
    bayer: String,
    flam_num: u16,
}

fn build_stars_binary(raw_dir: &Path, out_dir: &Path) -> Result<usize, PipelineError> {
    let hyg_path = raw_dir.join("hyg.csv");
    let mut reader = csv::ReaderBuilder::new()
        .has_headers(true)
        .from_path(&hyg_path)
        .map_err(|e| PipelineError::Csv(hyg_path.display().to_string(), e))?;

    let headers = reader
        .headers()
        .map_err(|e| PipelineError::Csv(hyg_path.display().to_string(), e))?
        .clone();

    let col = |name: &str| -> Result<usize, PipelineError> {
        headers
            .iter()
            .position(|h| h == name)
            .ok_or_else(|| PipelineError::Validation(format!("Missing column '{name}' in hyg.csv")))
    };

    let i_id = col("id")?;
    let i_hip = col("hip")?;
    let i_proper = col("proper")?;
    let i_ra = col("ra")?;
    let i_dec = col("dec")?;
    let i_dist = col("dist")?;
    let i_pmra = col("pmra")?;
    let i_pmdec = col("pmdec")?;
    let i_mag = col("mag")?;
    let i_spect = col("spect")?;
    let i_ci = col("ci")?;
    let i_rarad = col("rarad")?;
    let i_decrad = col("decrad")?;
    let i_bayer = col("bayer")?;
    let i_flam = col("flam")?;
    let i_con = col("con")?;
    let i_var = col("var")?;

    let mut stars: Vec<RawStar> = Vec::with_capacity(120_000);
    let mut record = csv::StringRecord::new();

    while reader
        .read_record(&mut record)
        .map_err(|e| PipelineError::Csv(hyg_path.display().to_string(), e))?
    {
        let id: u32 = match record.get(i_id).unwrap_or("").trim().parse() {
            Ok(v) => v,
            Err(_) => continue,
        };
        if id == 0 {
            continue; // Skip Sol
        }

        let mag: f32 = match record.get(i_mag).unwrap_or("").trim().parse() {
            Ok(v) if f32::is_finite(v) => v,
            _ => continue,
        };

        let ra_rad_f64 = record
            .get(i_rarad)
            .and_then(|s| s.trim().parse::<f64>().ok())
            .or_else(|| {
                record
                    .get(i_ra)
                    .and_then(|s| s.trim().parse::<f64>().ok())
                    .map(|h| h * std::f64::consts::PI / 12.0)
            });

        let dec_rad_f64 = record
            .get(i_decrad)
            .and_then(|s| s.trim().parse::<f64>().ok())
            .or_else(|| {
                record
                    .get(i_dec)
                    .and_then(|s| s.trim().parse::<f64>().ok())
                    .map(|d| d.to_radians())
            });

        let (Some(ra_raw), Some(dec_raw)) = (ra_rad_f64, dec_rad_f64) else {
            continue;
        };
        if !ra_raw.is_finite() || !dec_raw.is_finite() {
            continue;
        }
        let ra_rad = ra_raw.rem_euclid(std::f64::consts::TAU) as f32;
        let dec_rad = dec_raw.clamp(-std::f64::consts::FRAC_PI_2, std::f64::consts::FRAC_PI_2) as f32;

        let hip: u32 = record
            .get(i_hip)
            .and_then(|s| s.trim().parse().ok())
            .unwrap_or(0);

        let ci_opt = record.get(i_ci).and_then(|s| s.trim().parse::<f32>().ok());
        let has_ci = ci_opt.is_some_and(f32::is_finite);
        let ci = if has_ci { ci_opt.unwrap_or(0.65) } else { 0.65 };

        let pm_ra = record
            .get(i_pmra)
            .and_then(|s| s.trim().parse::<f32>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);
        let pm_dec = record
            .get(i_pmdec)
            .and_then(|s| s.trim().parse::<f32>().ok())
            .filter(|v| v.is_finite())
            .unwrap_or(0.0);

        let dist_pc = record
            .get(i_dist)
            .and_then(|s| s.trim().parse::<f32>().ok())
            .filter(|&d| d.is_finite() && d > 0.0 && d < 99_999.0)
            .unwrap_or(0.0);

        let con_idx = constellation_index(record.get(i_con).unwrap_or(""));
        let spect_code = encode_spectrum(record.get(i_spect).unwrap_or(""));
        let proper = record.get(i_proper).unwrap_or("").trim().to_string();
        let bayer = record.get(i_bayer).unwrap_or("").trim().to_string();
        let flam_num: u16 = record
            .get(i_flam)
            .and_then(|s| s.trim().parse::<f32>().ok())
            .map(|v| v.round() as u16)
            .unwrap_or(0);
        let is_var = !record.get(i_var).unwrap_or("").trim().is_empty();

        let mut flags: u16 = 0;
        if has_ci {
            flags |= 1 << 0;
        }
        if is_var {
            flags |= 1 << 1;
        }
        if !proper.is_empty() {
            flags |= 1 << 2;
        }

        stars.push(RawStar {
            id,
            hip,
            ra_rad,
            dec_rad,
            mag,
            ci,
            pm_ra,
            pm_dec,
            dist_pc,
            con_idx,
            spect_code,
            flags,
            proper,
            bayer,
            flam_num,
        });
    }

    stars.sort_by(|a, b| a.mag.total_cmp(&b.mag).then_with(|| a.id.cmp(&b.id)));

    let mut string_pool: Vec<u8> = Vec::with_capacity(262_144);
    let mut intern_map: HashMap<String, (u32, u16)> = HashMap::new();
    let mut intern = |s: &str| -> Result<(u32, u16), PipelineError> {
        if s.is_empty() {
            return Ok((0, 0));
        }
        if let Some(&entry) = intern_map.get(s) {
            return Ok(entry);
        }
        let off = u32::try_from(string_pool.len())
            .map_err(|_| PipelineError::Validation("String pool exceeded u32".into()))?;
        let len = u16::try_from(s.len())
            .map_err(|_| PipelineError::Validation(format!("String too long: {s}")))?;
        string_pool.extend_from_slice(s.as_bytes());
        intern_map.insert(s.to_string(), (off, len));
        Ok((off, len))
    };

    let mut record_bytes: Vec<u8> = Vec::with_capacity(stars.len() * 54);
    for star in &stars {
        let (p_off, p_len) = intern(&star.proper)?;
        let (b_off, b_len) = intern(&star.bayer)?;
        record_bytes.extend_from_slice(&star.id.to_le_bytes());
        record_bytes.extend_from_slice(&star.hip.to_le_bytes());
        record_bytes.extend_from_slice(&star.ra_rad.to_le_bytes());
        record_bytes.extend_from_slice(&star.dec_rad.to_le_bytes());
        record_bytes.extend_from_slice(&star.mag.to_le_bytes());
        record_bytes.extend_from_slice(&star.ci.to_le_bytes());
        record_bytes.extend_from_slice(&star.pm_ra.to_le_bytes());
        record_bytes.extend_from_slice(&star.pm_dec.to_le_bytes());
        record_bytes.extend_from_slice(&star.dist_pc.to_le_bytes());
        record_bytes.push(star.con_idx);
        record_bytes.push(star.spect_code);
        record_bytes.extend_from_slice(&star.flags.to_le_bytes());
        record_bytes.extend_from_slice(&p_off.to_le_bytes());
        record_bytes.extend_from_slice(&p_len.to_le_bytes());
        record_bytes.extend_from_slice(&b_off.to_le_bytes());
        record_bytes.extend_from_slice(&b_len.to_le_bytes());
        record_bytes.extend_from_slice(&star.flam_num.to_le_bytes());
    }

    let out_path = out_dir.join("stars.bin");
    let file = File::create(&out_path)
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    let mut writer = BufWriter::new(file);

    // Header (14 bytes): magic "SCST" (4) + version u16 (2) + count u32 (4) + pool_len u32 (4)
    writer
        .write_all(b"SCST")
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    writer
        .write_all(&1u16.to_le_bytes())
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    writer
        .write_all(&(stars.len() as u32).to_le_bytes())
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    writer
        .write_all(&(string_pool.len() as u32).to_le_bytes())
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    writer
        .write_all(&record_bytes)
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    writer
        .write_all(&string_pool)
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    writer
        .flush()
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;

    Ok(stars.len())
}

#[derive(Debug, Serialize)]
struct DsoEntry {
    id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    messier: Option<u16>,
    obj_type: String,
    name_en: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    name_ja: Option<String>,
    constellation: String,
    ra_deg: f64,
    dec_deg: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    mag: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    maj_ax_arcmin: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    min_ax_arcmin: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pos_ang_deg: Option<f32>,
}

fn parse_hms_deg(s: &str) -> Option<f64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let h: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(((h + m / 60.0 + sec / 3600.0) * 15.0).rem_euclid(360.0))
}

fn parse_dms_deg(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return None;
    }
    let sign = if trimmed.starts_with('-') { -1.0 } else { 1.0 };
    let unsigned = trimmed.trim_start_matches(['+', '-']);
    let parts: Vec<&str> = unsigned.split(':').collect();
    if parts.len() != 3 {
        return None;
    }
    let d: f64 = parts[0].parse().ok()?;
    let m: f64 = parts[1].parse().ok()?;
    let sec: f64 = parts[2].parse().ok()?;
    Some(sign * (d + m / 60.0 + sec / 3600.0))
}

fn round_decimals(v: f64, factor: f64) -> f64 {
    (v * factor).round() / factor
}

fn build_dso_catalog(raw_dir: &Path, out_dir: &Path) -> Result<(usize, usize), PipelineError> {
    let mut entries: Vec<DsoEntry> = Vec::with_capacity(14_000);
    let mut seen_ids: HashSet<String> = HashSet::with_capacity(14_000);

    for filename in ["NGC.csv", "addendum.csv"] {
        let path = raw_dir.join(filename);
        let mut reader = csv::ReaderBuilder::new()
            .delimiter(b';')
            .has_headers(true)
            .from_path(&path)
            .map_err(|e| PipelineError::Csv(path.display().to_string(), e))?;
        let headers = reader
            .headers()
            .map_err(|e| PipelineError::Csv(path.display().to_string(), e))?
            .clone();

        let col = |name: &str| -> Result<usize, PipelineError> {
            headers
                .iter()
                .position(|h| h == name)
                .ok_or_else(|| PipelineError::Validation(format!("Missing '{name}' in {filename}")))
        };

        let i_name = col("Name")?;
        let i_type = col("Type")?;
        let i_ra = col("RA")?;
        let i_dec = col("Dec")?;
        let i_const = col("Const")?;
        let i_maj = col("MajAx")?;
        let i_min = col("MinAx")?;
        let i_pa = col("PosAng")?;
        let i_bmag = col("B-Mag")?;
        let i_vmag = col("V-Mag")?;
        let i_m = col("M")?;
        let i_common = col("Common names")?;

        let mut rec = csv::StringRecord::new();
        while reader
            .read_record(&mut rec)
            .map_err(|e| PipelineError::Csv(path.display().to_string(), e))?
        {
            let id = rec.get(i_name).unwrap_or("").trim().to_string();
            let obj_type = rec.get(i_type).unwrap_or("").trim().to_string();
            if id.is_empty() || obj_type == "Dup" || obj_type == "NonEx" {
                continue;
            }
            if !seen_ids.insert(id.clone()) {
                continue;
            }

            let Some(ra_deg) = parse_hms_deg(rec.get(i_ra).unwrap_or("")) else {
                continue;
            };
            let Some(dec_deg) = parse_dms_deg(rec.get(i_dec).unwrap_or("")) else {
                continue;
            };

            let messier = if id == "NGC5866" {
                Some(102)
            } else {
                rec.get(i_m)
                    .and_then(|s| s.trim().parse::<u16>().ok())
                    .filter(|&m| (1..=110).contains(&m))
            };

            let v_mag = rec
                .get(i_vmag)
                .and_then(|s| s.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite());
            let b_mag = rec
                .get(i_bmag)
                .and_then(|s| s.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite());
            let mag = v_mag.or(b_mag);

            let maj_ax_arcmin = rec
                .get(i_maj)
                .and_then(|s| s.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite());
            let min_ax_arcmin = rec
                .get(i_min)
                .and_then(|s| s.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite());
            let pos_ang_deg = rec
                .get(i_pa)
                .and_then(|s| s.trim().parse::<f32>().ok())
                .filter(|v| v.is_finite());

            let common = rec.get(i_common).unwrap_or("").trim();
            let name_en = if !common.is_empty() {
                common.split(',').next().unwrap_or(common).trim().to_string()
            } else if let Some(m) = messier {
                format!("M{m}")
            } else {
                id.clone()
            };

            let name_ja = messier
                .and_then(messier_japanese_name)
                .or_else(|| notable_dso_japanese_name(&id))
                .map(str::to_string);

            let constellation = normalize_const_code(rec.get(i_const).unwrap_or(""));

            entries.push(DsoEntry {
                id,
                messier,
                obj_type,
                name_en,
                name_ja,
                constellation,
                ra_deg: round_decimals(ra_deg, 10_000.0),
                dec_deg: round_decimals(dec_deg, 10_000.0),
                mag,
                maj_ax_arcmin,
                min_ax_arcmin,
                pos_ang_deg,
            });
        }
    }

    entries.sort_by(|a, b| {
        a.messier
            .unwrap_or(u16::MAX)
            .cmp(&b.messier.unwrap_or(u16::MAX))
            .then_with(|| a.mag.unwrap_or(99.0).total_cmp(&b.mag.unwrap_or(99.0)))
            .then_with(|| a.id.cmp(&b.id))
    });

    let messier_set: HashSet<u16> = entries.iter().filter_map(|e| e.messier).collect();
    if messier_set.len() != 110 {
        return Err(PipelineError::Validation(format!(
            "Expected 110 Messier objects, found {}",
            messier_set.len()
        )));
    }

    let out_path = out_dir.join("dso.json");
    let file = File::create(&out_path)
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    let writer = BufWriter::new(file);
    serde_json::to_writer(writer, &entries)
        .map_err(|e| PipelineError::Json(out_path.display().to_string(), e))?;

    Ok((entries.len(), messier_set.len()))
}

#[derive(Debug, Serialize)]
struct ConstellationEntry {
    id: String,
    name_la: String,
    name_en: String,
    name_ja: String,
    genitive: String,
    rank: u8,
    center_ra_deg: f64,
    center_dec_deg: f64,
    lines_simple: Vec<Vec<[f64; 2]>>,
    lines_standard: Vec<Vec<[f64; 2]>>,
    lines_detailed: Vec<Vec<[f64; 2]>>,
    bounds: Vec<Vec<[f64; 2]>>,
}

#[derive(Debug, Serialize)]
struct AsterismEntry {
    id: String,
    name_en: String,
    name_ja: String,
    priority: u8,
    lines: Vec<Vec<[f64; 2]>>,
}

#[derive(Debug, Serialize)]
struct ConstellationsBundle {
    constellations: Vec<ConstellationEntry>,
    asterisms: Vec<AsterismEntry>,
}

fn normalize_lon_lat_point(pt: &[Value], decimals: f64) -> Option<[f64; 2]> {
    let lon = pt.first()?.as_f64()?;
    let lat = pt.get(1)?.as_f64()?;
    Some([
        round_decimals(lon.rem_euclid(360.0), decimals),
        round_decimals(lat.clamp(-90.0, 90.0), decimals),
    ])
}

fn parse_polyline_list(coords: &Value, decimals: f64) -> Vec<Vec<[f64; 2]>> {
    let mut lines = Vec::new();
    let Some(arr) = coords.as_array() else {
        return lines;
    };
    for line_val in arr {
        let Some(pts) = line_val.as_array() else {
            continue;
        };
        let parsed: Vec<[f64; 2]> = pts
            .iter()
            .filter_map(|p| p.as_array().and_then(|a| normalize_lon_lat_point(a, decimals)))
            .collect();
        if parsed.len() >= 2 {
            lines.push(parsed);
        }
    }
    lines
}

fn angular_sep_deg(a: [f64; 2], b: [f64; 2]) -> f64 {
    let dra = (a[0] - b[0]).to_radians();
    let d1 = a[1].to_radians();
    let d2 = b[1].to_radians();
    let cos_d = (d1.sin() * d2.sin() + d1.cos() * d2.cos() * dra.cos()).clamp(-1.0, 1.0);
    cos_d.acos().to_degrees()
}

fn polyline_span_deg(line: &[[f64; 2]]) -> f64 {
    line.windows(2).map(|w| angular_sep_deg(w[0], w[1])).sum()
}

fn build_simple_lines(standard: &[Vec<[f64; 2]>]) -> Vec<Vec<[f64; 2]>> {
    if standard.is_empty() {
        return Vec::new();
    }
    if standard.len() == 1 {
        let line = &standard[0];
        if line.len() <= 4 {
            return vec![line.clone()];
        }
        // Keep endpoints + major turning points (drop tiny sub-3 deg hops)
        let mut simplified = vec![line[0]];
        for pt in &line[1..line.len() - 1] {
            let last = *simplified.last().unwrap();
            if angular_sep_deg(last, *pt) >= 3.0 {
                simplified.push(*pt);
            }
        }
        simplified.push(*line.last().unwrap());
        return vec![simplified];
    }

    let mut ranked: Vec<(f64, &Vec<[f64; 2]>)> = standard
        .iter()
        .map(|l| (polyline_span_deg(l), l))
        .collect();
    ranked.sort_by(|a, b| b.0.total_cmp(&a.0));
    let keep_count = (ranked.len().div_ceil(2)).clamp(1, 3);
    ranked
        .into_iter()
        .take(keep_count)
        .map(|(_, l)| l.clone())
        .collect()
}

fn build_detailed_lines(id: &str, standard: &[Vec<[f64; 2]>]) -> Vec<Vec<[f64; 2]>> {
    let mut detailed = standard.to_vec();
    // Add classic detailed astronomical connector lines (shield/club/claws/triangles)
    match id {
        "Ori" => {
            // Connect Rigel - Saiph base & Betelgeuse - Bellatrix shoulders
            detailed.push(vec![[88.7929, 7.4071], [81.2828, 6.3497]]);
            detailed.push(vec![[78.6345, -8.2016], [86.9391, -9.6696]]);
        }
        "UMa" => {
            // Close Dipper bowl (Dubhe - Merak) if not already linked in separate chain
            detailed.push(vec![[165.9323, 61.7510], [165.4603, 56.3824]]);
        }
        "Leo" => {
            // Connect Denebola - Chertan - Zosma - Algieba inner triangle
            detailed.push(vec![[154.9931, 19.8415], [168.5600, 15.4296]]);
        }
        "Sco" => {
            // Connect lower claws (Dschubba - Graffias - Pi Sco)
            detailed.push(vec![[241.3593, -19.8055], [239.7130, -26.1141]]);
        }
        "Peg" => {
            // Diagonal of Great Square for alignment reference
            detailed.push(vec![[2.0969, 29.0904], [346.1902, 15.2053]]);
        }
        _ => {}
    }
    detailed
}

fn read_json_value(path: &Path) -> Result<Value, PipelineError> {
    let text = fs::read_to_string(path)
        .map_err(|e| PipelineError::Io(path.display().to_string(), e))?;
    serde_json::from_str(&text)
        .map_err(|e| PipelineError::Json(path.display().to_string(), e))
}

fn build_constellations(raw_dir: &Path, out_dir: &Path) -> Result<(usize, usize), PipelineError> {
    let meta_json = read_json_value(&raw_dir.join("constellations.json"))?;
    let lines_json = read_json_value(&raw_dir.join("constellations.lines.json"))?;
    let bounds_json = read_json_value(&raw_dir.join("constellations.bounds.json"))?;
    let asterisms_json = read_json_value(&raw_dir.join("asterisms.json"))?;

    let mut lines_by_id: HashMap<String, Vec<Vec<[f64; 2]>>> = HashMap::new();
    if let Some(features) = lines_json["features"].as_array() {
        for f in features {
            let Some(id) = f["id"].as_str() else {
                continue;
            };
            let mut parsed = parse_polyline_list(&f["geometry"]["coordinates"], 10_000.0);
            lines_by_id.entry(id.to_string()).or_default().append(&mut parsed);
        }
    }

    let mut bounds_by_id: HashMap<String, Vec<Vec<[f64; 2]>>> = HashMap::new();
    if let Some(features) = bounds_json["features"].as_array() {
        for f in features {
            let Some(id) = f["id"].as_str() else {
                continue;
            };
            let mut parsed = parse_polyline_list(&f["geometry"]["coordinates"], 10_000.0);
            bounds_by_id
                .entry(id.to_string())
                .or_default()
                .append(&mut parsed);
        }
    }

    let mut map: BTreeMap<String, ConstellationEntry> = BTreeMap::new();
    if let Some(features) = meta_json["features"].as_array() {
        for f in features {
            let Some(id) = f["id"].as_str() else {
                continue;
            };
            if map.contains_key(id) {
                continue; // Serpens Caput + Cauda share id "Ser"
            }
            let props = &f["properties"];
            let center_pt = f["geometry"]["coordinates"]
                .as_array()
                .and_then(|a| normalize_lon_lat_point(a, 10_000.0))
                .unwrap_or([0.0, 0.0]);

            let name_ja = constellation_japanese_override(id)
                .map(str::to_string)
                .unwrap_or_else(|| props["ja"].as_str().unwrap_or(id).to_string());
            let name_la = props["la"]
                .as_str()
                .unwrap_or(props["name"].as_str().unwrap_or(id))
                .replace('\u{2005}', " ");
            let name_en = props["name"]
                .as_str()
                .unwrap_or(id)
                .replace('\u{2005}', " ");
            let genitive = props["gen"].as_str().unwrap_or("").to_string();
            let rank: u8 = props["rank"]
                .as_str()
                .and_then(|r| r.parse().ok())
                .unwrap_or(3);

            let lines_standard = lines_by_id.remove(id).unwrap_or_default();
            let lines_simple = build_simple_lines(&lines_standard);
            let lines_detailed = build_detailed_lines(id, &lines_standard);
            let bounds = bounds_by_id.remove(id).unwrap_or_default();

            map.insert(
                id.to_string(),
                ConstellationEntry {
                    id: id.to_string(),
                    name_la,
                    name_en,
                    name_ja,
                    genitive,
                    rank,
                    center_ra_deg: center_pt[0],
                    center_dec_deg: center_pt[1],
                    lines_simple,
                    lines_standard,
                    lines_detailed,
                    bounds,
                },
            );
        }
    }

    if map.len() != 88 {
        return Err(PipelineError::Validation(format!(
            "Expected 88 constellations, got {}",
            map.len()
        )));
    }

    let mut ast_map: BTreeMap<String, AsterismEntry> = BTreeMap::new();
    if let Some(features) = asterisms_json["features"].as_array() {
        for f in features {
            let Some(id) = f["id"].as_str() else {
                continue;
            };
            let props = &f["properties"];
            let mut parsed = parse_polyline_list(&f["geometry"]["coordinates"], 10_000.0);
            if let Some(existing) = ast_map.get_mut(id) {
                existing.lines.append(&mut parsed);
            } else {
                let name_en = props["n"].as_str().unwrap_or(id).to_string();
                let name_ja = asterism_japanese_name(id)
                    .map(str::to_string)
                    .unwrap_or_else(|| name_en.clone());
                let priority = props["p"].as_u64().unwrap_or(5) as u8;
                ast_map.insert(
                    id.to_string(),
                    AsterismEntry {
                        id: id.to_string(),
                        name_en,
                        name_ja,
                        priority,
                        lines: parsed,
                    },
                );
            }
        }
    }

    let constellations: Vec<ConstellationEntry> = map.into_values().collect();
    let asterisms: Vec<AsterismEntry> = ast_map.into_values().collect();
    let c_count = constellations.len();
    let a_count = asterisms.len();

    let bundle = ConstellationsBundle {
        constellations,
        asterisms,
    };

    let out_path = out_dir.join("constellations.json");
    let file = File::create(&out_path)
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    serde_json::to_writer(BufWriter::new(file), &bundle)
        .map_err(|e| PipelineError::Json(out_path.display().to_string(), e))?;

    Ok((c_count, a_count))
}

#[derive(Debug, Serialize)]
struct MilkyWayLevel {
    level: String,
    polygons: Vec<Vec<Vec<[f64; 2]>>>,
}

fn build_milky_way(raw_dir: &Path, out_dir: &Path) -> Result<usize, PipelineError> {
    let mw_json = read_json_value(&raw_dir.join("mw.json"))?;
    let features = mw_json["features"]
        .as_array()
        .ok_or_else(|| PipelineError::Validation("mw.json missing features".into()))?;

    let mut levels = Vec::with_capacity(features.len());
    for f in features {
        let level = f["id"].as_str().unwrap_or("ol1").to_string();
        let coords = &f["geometry"]["coordinates"];
        let mut polygons: Vec<Vec<Vec<[f64; 2]>>> = Vec::new();
        if let Some(poly_list) = coords.as_array() {
            for poly_val in poly_list {
                let rings = parse_polyline_list(poly_val, 100.0);
                if !rings.is_empty() {
                    polygons.push(rings);
                }
            }
        }
        levels.push(MilkyWayLevel { level, polygons });
    }

    if levels.len() != 5 {
        return Err(PipelineError::Validation(format!(
            "Expected 5 Milky Way levels, got {}",
            levels.len()
        )));
    }

    let out_path = out_dir.join("milkyway.json");
    let file = File::create(&out_path)
        .map_err(|e| PipelineError::Io(out_path.display().to_string(), e))?;
    serde_json::to_writer(BufWriter::new(file), &levels)
        .map_err(|e| PipelineError::Json(out_path.display().to_string(), e))?;

    Ok(levels.len())
}

#[derive(Debug, Deserialize)]
struct LocationCheck {
    name_ja: String,
    category: String,
    #[serde(default)]
    is_default: bool,
}

#[derive(Debug, Deserialize)]
struct MythCheck {
    id: String,
}

fn validate_curated_assets(assets_dir: &Path) -> Result<(), PipelineError> {
    let loc_val: Vec<LocationCheck> = serde_json::from_value(read_json_value(
        &assets_dir.join("locations/locations.json"),
    )?)
    .map_err(|e| PipelineError::Json("locations.json".into(), e))?;
    let pref_count = loc_val.iter().filter(|l| l.category == "prefecture").count();
    let has_akashi_default = loc_val
        .iter()
        .any(|l| l.is_default && l.name_ja.contains("明石"));
    if pref_count < 47 || !has_akashi_default {
        return Err(PipelineError::Validation(format!(
            "locations.json check failed: prefectures={pref_count}, akashi_default={has_akashi_default}"
        )));
    }

    let meteors_val = read_json_value(&assets_dir.join("catalogs/meteors.json"))?;
    let meteor_count = meteors_val.as_array().map(|a| a.len()).unwrap_or(0);
    if meteor_count < 21 {
        return Err(PipelineError::Validation(format!(
            "Expected >= 21 meteor showers, got {meteor_count}"
        )));
    }

    let vars_val = read_json_value(&assets_dir.join("catalogs/variables.json"))?;
    let var_count = vars_val.as_array().map(|a| a.len()).unwrap_or(0);
    if var_count < 40 {
        return Err(PipelineError::Validation(format!(
            "Expected >= 40 variable stars, got {var_count}"
        )));
    }

    let myths: Vec<MythCheck> = serde_json::from_value(read_json_value(
        &assets_dir.join("mythology/constellations_ja.json"),
    )?)
    .map_err(|e| PipelineError::Json("constellations_ja.json".into(), e))?;
    let myth_ids: HashSet<&str> = myths.iter().map(|m| m.id.as_str()).collect();
    if myth_ids.len() != 88 {
        return Err(PipelineError::Validation(format!(
            "constellations_ja.json must cover 88 unique constellations, got {}",
            myth_ids.len()
        )));
    }

    let star_guides = read_json_value(&assets_dir.join("mythology/stars_ja.json"))?;
    let guide_count = star_guides.as_array().map(|a| a.len()).unwrap_or(0);
    if guide_count < 40 {
        return Err(PipelineError::Validation(format!(
            "Expected >= 40 star guides, got {guide_count}"
        )));
    }

    println!(
        "Validated curated assets: locations={} (prefs={}), meteors={}, variables={}, myths={}, star_guides={}",
        loc_val.len(),
        pref_count,
        meteor_count,
        var_count,
        myth_ids.len(),
        guide_count
    );
    Ok(())
}

fn find_workspace_root() -> PathBuf {
    let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    if let Some(parent) = manifest_dir.parent()
        && parent.join("assets").exists()
    {
        return parent.to_path_buf();
    }
    std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))
}

fn main() -> Result<(), PipelineError> {
    let root = find_workspace_root();
    let raw_dir = root.join("data-pipeline/raw");
    let out_dir = root.join("assets/catalogs");
    fs::create_dir_all(&out_dir).map_err(|e| PipelineError::Io(out_dir.display().to_string(), e))?;

    println!("StarCrane data-pipeline starting in {}", root.display());

    let star_count = build_stars_binary(&raw_dir, &out_dir)?;
    println!("Generated assets/catalogs/stars.bin ({star_count} stars)");

    let (dso_count, messier_count) = build_dso_catalog(&raw_dir, &out_dir)?;
    println!(
        "Generated assets/catalogs/dso.json ({dso_count} DSOs, Messier {messier_count}/110)"
    );

    let (const_count, ast_count) = build_constellations(&raw_dir, &out_dir)?;
    println!(
        "Generated assets/catalogs/constellations.json ({const_count} constellations, {ast_count} asterisms)"
    );

    let mw_levels = build_milky_way(&raw_dir, &out_dir)?;
    println!("Generated assets/catalogs/milkyway.json ({mw_levels} levels)");

    validate_curated_assets(&root.join("assets"))?;
    println!("StarCrane data-pipeline completed successfully.");
    Ok(())
}
