use rayon::prelude::*;
use serde::{Deserialize, Serialize};

use crate::engine::catalog::CatalogStore;
use crate::engine::coords::{
    Equatorial, angular_distance_deg, apply_standard_refraction, equatorial_to_ecliptic,
    equatorial_to_horizontal, wrap_deg_180, wrap_deg_360,
};
use crate::engine::ephemeris::{
    BodyEphemeris, Planet, geocentric_to_topocentric, moon_apparent_ecliptic_lon_deg,
    moon_ephemeris, planet_ephemeris, sun_apparent_ecliptic_lon_deg, sun_ephemeris,
};
use crate::engine::precession::{
    OBLIQUITY_J2000_DEG, apply_nutation_to_equatorial, nutation, precess_j2000_to_date,
};
use crate::engine::rise_set::ObserverLocation;
use crate::engine::time::{find_new_moon_near_jd_ut, last_deg, ut_to_tt_jd};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetaryPhenomenon {
    pub planet_id: String,
    pub planet_name_ja: String,
    pub kind: String,
    pub kind_ja: String,
    pub jd_ut: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub mag: f64,
    pub elongation_deg: f64,
    pub detail_ja: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetConjunctionEvent {
    pub kind: String,
    pub title_ja: String,
    pub jd_ut: f64,
    pub separation_deg: f64,
    pub center_ra_deg: f64,
    pub center_dec_deg: f64,
    pub bodies: Vec<String>,
    pub detail_ja: String,
}

pub(crate) fn planet_id_str(planet: Planet) -> &'static str {
    match planet {
        Planet::Mercury => "mercury",
        Planet::Venus => "venus",
        Planet::Mars => "mars",
        Planet::Jupiter => "jupiter",
        Planet::Saturn => "saturn",
        Planet::Uranus => "uranus",
        Planet::Neptune => "neptune",
    }
}

fn bisect_root(mut a: f64, mut b: f64, f: impl Fn(f64) -> f64) -> f64 {
    let mut fa = f(a);
    for _ in 0..24 {
        let mid = 0.5 * (a + b);
        let fm = f(mid);
        if fa * fm <= 0.0 {
            b = mid;
        } else {
            a = mid;
            fa = fm;
        }
    }
    0.5 * (a + b)
}

fn golden_extremum_jd(mut a: f64, mut b: f64, find_max: bool, f: impl Fn(f64) -> f64) -> (f64, f64) {
    const INV_PHI: f64 = 0.618_033_988_749_894_9;
    let mut c = b - INV_PHI * (b - a);
    let mut d = a + INV_PHI * (b - a);
    let mut fc = f(c);
    let mut fd = f(d);
    for _ in 0..26 {
        let pick_left = if find_max { fc > fd } else { fc < fd };
        if pick_left {
            b = d;
            d = c;
            fd = fc;
            c = b - INV_PHI * (b - a);
            fc = f(c);
        } else {
            a = c;
            c = d;
            fc = fd;
            d = a + INV_PHI * (b - a);
            fd = f(d);
        }
    }
    let t = 0.5 * (a + b);
    (t, f(t))
}

fn build_phenomenon(
    planet: Planet,
    kind: &str,
    kind_ja: &str,
    jd_ut: f64,
    detail_extra: Option<String>,
) -> PlanetaryPhenomenon {
    let eph = planet_ephemeris(planet, ut_to_tt_jd(jd_ut));
    let detail_ja = detail_extra.unwrap_or_else(|| {
        format!(
            "{:.1}等 ・太陽離角 {:.1}° ・地心距離 {:.3} AU",
            eph.visual_magnitude, eph.elongation_deg, eph.geo_au
        )
    });
    PlanetaryPhenomenon {
        planet_id: planet_id_str(planet).to_owned(),
        planet_name_ja: planet.name_ja().to_owned(),
        kind: kind.to_owned(),
        kind_ja: kind_ja.to_owned(),
        jd_ut,
        ra_deg: eph.eq_apparent.ra_deg,
        dec_deg: eph.eq_apparent.dec_deg,
        mag: eph.visual_magnitude,
        elongation_deg: eph.elongation_deg,
        detail_ja,
    }
}

/// Search planetary phenomena (opposition, conjunction, quadratures, greatest elongations, stationary points)
/// over `[start_jd_ut, end_jd_ut]` using Rayon parallel sampling.
pub fn search_planetary_phenomena(
    start_jd_ut: f64,
    end_jd_ut: f64,
    planet_filter: Option<Planet>,
) -> Vec<PlanetaryPhenomenon> {
    if end_jd_ut <= start_jd_ut {
        return Vec::new();
    }
    let planets: Vec<Planet> = match planet_filter {
        Some(p) => vec![p],
        None => Planet::ALL.to_vec(),
    };
    let num_days = ((end_jd_ut - start_jd_ut).ceil() as usize).max(2);

    let mut all_events: Vec<PlanetaryPhenomenon> = planets
        .into_par_iter()
        .flat_map_iter(|planet| {
            let samples: Vec<(f64, BodyEphemeris, f64)> = (0..=num_days)
                .map(|i| {
                    let jd = (start_jd_ut + i as f64).min(end_jd_ut);
                    let tt = ut_to_tt_jd(jd);
                    let eph = planet_ephemeris(planet, tt);
                    let sun_lon = sun_ephemeris(tt).ecliptic_apparent.lon_deg;
                    let diff = wrap_deg_180(eph.ecliptic_apparent.lon_deg - sun_lon);
                    (jd, eph, diff)
                })
                .collect();

            let mut events = Vec::new();
            let is_inferior = matches!(planet, Planet::Mercury | Planet::Venus);

            for i in 0..(samples.len() - 1) {
                let (t0, _, d0) = samples[i];
                let (t1, _, d1) = samples[i + 1];

                // Conjunction with Sun (diff crosses 0°)
                if d0 * d1 <= 0.0 && (d0 - d1).abs() < 90.0 {
                    let exact = bisect_root(t0, t1, |t| {
                        let tt = ut_to_tt_jd(t);
                        wrap_deg_180(
                            planet_ephemeris(planet, tt).ecliptic_apparent.lon_deg
                                - sun_ephemeris(tt).ecliptic_apparent.lon_deg,
                        )
                    });
                    if is_inferior {
                        let eph_ex = planet_ephemeris(planet, ut_to_tt_jd(exact));
                        let (kind, kind_ja) = if eph_ex.geo_au < 1.0 {
                            ("inferior_conjunction", "内合")
                        } else {
                            ("superior_conjunction", "外合")
                        };
                        events.push(build_phenomenon(planet, kind, kind_ja, exact, None));
                    } else {
                        events.push(build_phenomenon(planet, "conjunction", "合", exact, None));
                    }
                }

                if !is_inferior {
                    // Opposition (diff crosses ±180°)
                    let opp0 = wrap_deg_180(d0 - 180.0);
                    let opp1 = wrap_deg_180(d1 - 180.0);
                    if opp0 * opp1 <= 0.0 && (opp0 - opp1).abs() < 90.0 {
                        let exact = bisect_root(t0, t1, |t| {
                            let tt = ut_to_tt_jd(t);
                            wrap_deg_180(
                                planet_ephemeris(planet, tt).ecliptic_apparent.lon_deg
                                    - sun_ephemeris(tt).ecliptic_apparent.lon_deg
                                    - 180.0,
                            )
                        });
                        events.push(build_phenomenon(planet, "opposition", "衝", exact, None));
                    }

                    // Eastern quadrature (+90°) & Western quadrature (-90°)
                    let eq0 = wrap_deg_180(d0 - 90.0);
                    let eq1 = wrap_deg_180(d1 - 90.0);
                    if eq0 * eq1 <= 0.0 && (eq0 - eq1).abs() < 90.0 {
                        let exact = bisect_root(t0, t1, |t| {
                            let tt = ut_to_tt_jd(t);
                            wrap_deg_180(
                                planet_ephemeris(planet, tt).ecliptic_apparent.lon_deg
                                    - sun_ephemeris(tt).ecliptic_apparent.lon_deg
                                    - 90.0,
                            )
                        });
                        events.push(build_phenomenon(
                            planet,
                            "eastern_quadrature",
                            "東矩",
                            exact,
                            None,
                        ));
                    }

                    let wq0 = wrap_deg_180(d0 + 90.0);
                    let wq1 = wrap_deg_180(d1 + 90.0);
                    if wq0 * wq1 <= 0.0 && (wq0 - wq1).abs() < 90.0 {
                        let exact = bisect_root(t0, t1, |t| {
                            let tt = ut_to_tt_jd(t);
                            wrap_deg_180(
                                planet_ephemeris(planet, tt).ecliptic_apparent.lon_deg
                                    - sun_ephemeris(tt).ecliptic_apparent.lon_deg
                                    + 90.0,
                            )
                        });
                        events.push(build_phenomenon(
                            planet,
                            "western_quadrature",
                            "西矩",
                            exact,
                            None,
                        ));
                    }
                }
            }

            // Local extrema & stationary points over interior samples
            for i in 1..(samples.len() - 1) {
                let (tm, e_prev, _) = &samples[i - 1];
                let (tc, e_curr, diff_c) = &samples[i];
                let (tp, e_next, _) = &samples[i + 1];

                // Greatest elongation for Mercury / Venus
                if is_inferior
                    && e_curr.elongation_deg >= e_prev.elongation_deg
                    && e_curr.elongation_deg > e_next.elongation_deg
                {
                    let (exact, max_elong) = golden_extremum_jd(*tm, *tp, true, |t| {
                        planet_ephemeris(planet, ut_to_tt_jd(t)).elongation_deg
                    });
                    let (kind, kind_ja) = if *diff_c >= 0.0 {
                        ("greatest_eastern_elongation", "東方最大離角 (夕空)")
                    } else {
                        ("greatest_western_elongation", "西方最大離角 (明け方)")
                    };
                    events.push(build_phenomenon(
                        planet,
                        kind,
                        kind_ja,
                        exact,
                        Some(format!("最大離角 {max_elong:.1}°")),
                    ));
                }

                // Stationary points in RA
                let v0 = wrap_deg_180(e_curr.eq_apparent.ra_deg - e_prev.eq_apparent.ra_deg);
                let v1 = wrap_deg_180(e_next.eq_apparent.ra_deg - e_curr.eq_apparent.ra_deg);
                if v0 >= 0.0 && v1 < 0.0 {
                    let exact = bisect_root(0.5 * (*tm + *tc), 0.5 * (*tc + *tp), |t| {
                        let r0 = planet_ephemeris(planet, ut_to_tt_jd(t - 0.05)).eq_apparent.ra_deg;
                        let r1 = planet_ephemeris(planet, ut_to_tt_jd(t + 0.05)).eq_apparent.ra_deg;
                        wrap_deg_180(r1 - r0)
                    });
                    events.push(build_phenomenon(
                        planet,
                        "stationary_retrograde",
                        "留 (逆行開始)",
                        exact,
                        None,
                    ));
                } else if v0 < 0.0 && v1 >= 0.0 {
                    let exact = bisect_root(0.5 * (*tm + *tc), 0.5 * (*tc + *tp), |t| {
                        let r0 = planet_ephemeris(planet, ut_to_tt_jd(t - 0.05)).eq_apparent.ra_deg;
                        let r1 = planet_ephemeris(planet, ut_to_tt_jd(t + 0.05)).eq_apparent.ra_deg;
                        wrap_deg_180(r1 - r0)
                    });
                    events.push(build_phenomenon(
                        planet,
                        "stationary_prograde",
                        "留 (順行復帰)",
                        exact,
                        None,
                    ));
                }
            }

            events
        })
        .collect();

    all_events.sort_by(|a, b| a.jd_ut.total_cmp(&b.jd_ut));
    all_events
}

#[derive(Clone, Copy)]
enum SimBody {
    Moon,
    Planet(Planet),
}

impl SimBody {
    fn id(self) -> &'static str {
        match self {
            Self::Moon => "moon",
            Self::Planet(p) => planet_id_str(p),
        }
    }

    fn name_ja(self) -> &'static str {
        match self {
            Self::Moon => "月",
            Self::Planet(p) => p.name_ja(),
        }
    }

    fn eq_mag_at(self, jd_ut: f64) -> (Equatorial, f64) {
        let tt = ut_to_tt_jd(jd_ut);
        match self {
            Self::Moon => {
                let m = moon_ephemeris(tt);
                (m.eq_apparent, m.visual_magnitude)
            }
            Self::Planet(p) => {
                let e = planet_ephemeris(p, tt);
                (e.eq_apparent, e.visual_magnitude)
            }
        }
    }
}

/// Search close conjunctions between planets (and optionally Moon) over `[start_jd_ut, end_jd_ut]`.
pub fn search_planet_planet_conjunctions(
    start_jd_ut: f64,
    end_jd_ut: f64,
    max_sep_deg: f64,
    include_moon: bool,
) -> Vec<PlanetConjunctionEvent> {
    if end_jd_ut <= start_jd_ut {
        return Vec::new();
    }
    let mut bodies: Vec<SimBody> = Planet::ALL.iter().copied().map(SimBody::Planet).collect();
    if include_moon {
        bodies.insert(0, SimBody::Moon);
    }

    // Moon moves fast (~13°/day), so sample at 0.25d when Moon is included, otherwise 1.0d
    let step_days = if include_moon { 0.25 } else { 1.0 };
    let steps = (((end_jd_ut - start_jd_ut) / step_days).ceil() as usize).max(2);

    let grid: Vec<(f64, Vec<(Equatorial, f64)>)> = (0..=steps)
        .into_par_iter()
        .map(|i| {
            let jd = (start_jd_ut + i as f64 * step_days).min(end_jd_ut);
            let pos = bodies.iter().map(|b| b.eq_mag_at(jd)).collect();
            (jd, pos)
        })
        .collect();

    let mut pairs = Vec::new();
    for a in 0..bodies.len() {
        for b in (a + 1)..bodies.len() {
            pairs.push((a, b));
        }
    }

    let mut events: Vec<PlanetConjunctionEvent> = pairs
        .into_par_iter()
        .flat_map_iter(|(ia, ib)| {
            let ba = bodies[ia];
            let bb = bodies[ib];
            let mut found = Vec::new();
            for i in 1..(grid.len() - 1) {
                let sep_m = angular_distance_deg(grid[i - 1].1[ia].0, grid[i - 1].1[ib].0);
                let sep_c = angular_distance_deg(grid[i].1[ia].0, grid[i].1[ib].0);
                let sep_p = angular_distance_deg(grid[i + 1].1[ia].0, grid[i + 1].1[ib].0);
                if sep_c <= sep_m && sep_c < sep_p && sep_c <= max_sep_deg + 3.0 {
                    let (exact_jd, min_sep) =
                        golden_extremum_jd(grid[i - 1].0, grid[i + 1].0, false, |t| {
                            let (eq1, _) = ba.eq_mag_at(t);
                            let (eq2, _) = bb.eq_mag_at(t);
                            angular_distance_deg(eq1, eq2)
                        });
                    if min_sep <= max_sep_deg {
                        let (eq1, m1) = ba.eq_mag_at(exact_jd);
                        let (eq2, m2) = bb.eq_mag_at(exact_jd);
                        let mid_ra = wrap_deg_360(eq1.ra_deg + wrap_deg_180(eq2.ra_deg - eq1.ra_deg) * 0.5);
                        let mid_dec = 0.5 * (eq1.dec_deg + eq2.dec_deg);
                        found.push(PlanetConjunctionEvent {
                            kind: "planet_planet".to_owned(),
                            title_ja: format!("{}と{}の接近 ({min_sep:.2}°)", ba.name_ja(), bb.name_ja()),
                            jd_ut: exact_jd,
                            separation_deg: min_sep,
                            center_ra_deg: mid_ra,
                            center_dec_deg: mid_dec,
                            bodies: vec![ba.id().to_owned(), bb.id().to_owned()],
                            detail_ja: format!(
                                "{} {:.1}等 / {} {:.1}等 ・最接近離角 {min_sep:.2}°",
                                ba.name_ja(),
                                m1,
                                bb.name_ja(),
                                m2
                            ),
                        });
                    }
                }
            }
            found
        })
        .collect();

    events.sort_by(|a, b| a.jd_ut.total_cmp(&b.jd_ut));
    events
}

/// Search multi-planet groupings (e.g. `>= 3` planets within `max_span_deg`) over `[start_jd_ut, end_jd_ut]`.
pub fn search_planet_clusters(
    start_jd_ut: f64,
    end_jd_ut: f64,
    max_span_deg: f64,
    min_count: usize,
) -> Vec<PlanetConjunctionEvent> {
    if end_jd_ut <= start_jd_ut || min_count < 3 {
        return Vec::new();
    }
    let steps = ((end_jd_ut - start_jd_ut).ceil() as usize).max(2);
    let naked_planets = [
        Planet::Mercury,
        Planet::Venus,
        Planet::Mars,
        Planet::Jupiter,
        Planet::Saturn,
    ];

    struct DailyClusterSample {
        jd: f64,
        span: f64,
        ra: f64,
        dec: f64,
        ids: Vec<usize>,
    }

    let build_cluster_event = |prev: DailyClusterSample| -> PlanetConjunctionEvent {
        let names: Vec<&str> = prev.ids.iter().map(|&idx| naked_planets[idx].name_ja()).collect();
        let ids: Vec<String> = prev
            .ids
            .iter()
            .map(|&idx| planet_id_str(naked_planets[idx]).to_owned())
            .collect();
        PlanetConjunctionEvent {
            kind: "planet_cluster".to_owned(),
            title_ja: format!("{}惑星集合 ({})", names.len(), names.join("・")),
            jd_ut: prev.jd,
            separation_deg: prev.span,
            center_ra_deg: prev.ra,
            center_dec_deg: prev.dec,
            bodies: ids,
            detail_ja: format!("最小包含幅 {:.1}° ({})", prev.span, names.join("・")),
        }
    };

    let daily: Vec<Option<DailyClusterSample>> = (0..=steps)
        .into_par_iter()
        .map(|i| {
            let jd = (start_jd_ut + i as f64).min(end_jd_ut);
            let tt = ut_to_tt_jd(jd);
            let mut list: Vec<(usize, Equatorial, f64)> = naked_planets
                .iter()
                .enumerate()
                .map(|(idx, &p)| {
                    let e = planet_ephemeris(p, tt);
                    (idx, e.eq_apparent, e.ecliptic_apparent.lon_deg)
                })
                .collect();
            list.sort_by(|a, b| a.2.total_cmp(&b.2));

            let n = list.len();
            let mut best: Option<(f64, f64, f64, Vec<usize>)> = None;
            for start in 0..n {
                for len in min_count..=n {
                    let mut group = Vec::with_capacity(len);
                    for k in 0..len {
                        group.push(&list[(start + k) % n]);
                    }
                    let mut max_pair = 0.0_f64;
                    for a in 0..group.len() {
                        for b in (a + 1)..group.len() {
                            max_pair = max_pair.max(angular_distance_deg(group[a].1, group[b].1));
                        }
                    }
                    if max_pair <= max_span_deg {
                        let replace = match &best {
                            None => true,
                            Some((b_span, _, _, b_ids)) => {
                                group.len() > b_ids.len()
                                    || (group.len() == b_ids.len() && max_pair < *b_span)
                            }
                        };
                        if replace {
                            let ref_ra = group[0].1.ra_deg;
                            let ra_avg = wrap_deg_360(
                                ref_ra
                                    + group.iter().map(|g| wrap_deg_180(g.1.ra_deg - ref_ra)).sum::<f64>()
                                        / group.len() as f64,
                            );
                            let dec_avg =
                                group.iter().map(|g| g.1.dec_deg).sum::<f64>() / group.len() as f64;
                            let mut ids: Vec<usize> = group.iter().map(|g| g.0).collect();
                            ids.sort_unstable();
                            best = Some((max_pair, ra_avg, dec_avg, ids));
                        }
                    }
                }
            }
            best.map(|(span, ra, dec, ids)| DailyClusterSample { jd, span, ra, dec, ids })
        })
        .collect();

    // Collapse contiguous runs sharing the same planet set into minimum-span peak events
    let mut events = Vec::new();
    let mut active_run: Option<DailyClusterSample> = None;
    for entry in daily.into_iter().flatten() {
        match &mut active_run {
            Some(cur) if cur.ids == entry.ids && (entry.jd - cur.jd).abs() <= 15.0 => {
                if entry.span < cur.span {
                    *cur = entry;
                }
            }
            Some(_) => {
                if let Some(prev) = active_run.take() {
                    events.push(build_cluster_event(prev));
                }
                active_run = Some(entry);
            }
            None => active_run = Some(entry),
        }
    }
    if let Some(prev) = active_run {
        events.push(build_cluster_event(prev));
    }
    events
}

/// Search close approaches between bright planets (`Mercury..Saturn`) and 1st-magnitude or user-specified stars.
pub fn search_planet_star_conjunctions(
    start_jd_ut: f64,
    end_jd_ut: f64,
    max_sep_deg: f64,
    star_hip: Option<u32>,
    store: &CatalogStore,
) -> Vec<PlanetConjunctionEvent> {
    if end_jd_ut <= start_jd_ut {
        return Vec::new();
    }
    let mut ja_map = std::collections::HashMap::with_capacity(store.star_guides.len());
    for g in &store.star_guides {
        ja_map.insert(g.hip, g.name_ja.as_str());
    }

    let targets: Vec<(u32, String, Equatorial, f32)> = if let Some(hip) = star_hip {
        store
            .stars
            .find_by_hip(hip)
            .map(|s| {
                let proper = store.stars.proper_name(s);
                let name = ja_map
                    .get(&s.hip)
                    .map(|j| (*j).to_owned())
                    .unwrap_or_else(|| {
                        if proper.is_empty() {
                            format!("HIP {}", s.hip)
                        } else {
                            proper.to_owned()
                        }
                    });
                vec![(
                    s.hip,
                    name,
                    Equatorial {
                        ra_deg: wrap_deg_360(f64::from(s.ra_rad).to_degrees()),
                        dec_deg: f64::from(s.dec_rad).to_degrees(),
                    },
                    s.mag,
                )]
            })
            .unwrap_or_default()
    } else {
        store
            .stars
            .stars
            .iter()
            .filter(|s| s.mag <= 1.55)
            .map(|s| {
                let proper = store.stars.proper_name(s);
                let name = ja_map
                    .get(&s.hip)
                    .map(|j| (*j).to_owned())
                    .unwrap_or_else(|| proper.to_owned());
                (
                    s.hip,
                    name,
                    Equatorial {
                        ra_deg: wrap_deg_360(f64::from(s.ra_rad).to_degrees()),
                        dec_deg: f64::from(s.dec_rad).to_degrees(),
                    },
                    s.mag,
                )
            })
            .collect()
    };

    if targets.is_empty() {
        return Vec::new();
    }

    let planets = [
        Planet::Mercury,
        Planet::Venus,
        Planet::Mars,
        Planet::Jupiter,
        Planet::Saturn,
    ];
    let steps = ((end_jd_ut - start_jd_ut).ceil() as usize).max(2);

    let grid: Vec<(f64, [BodyEphemeris; 5], Equatorial)> = (0..=steps)
        .into_par_iter()
        .map(|i| {
            let jd = (start_jd_ut + i as f64).min(end_jd_ut);
            let tt = ut_to_tt_jd(jd);
            let ephs = [
                planet_ephemeris(planets[0], tt),
                planet_ephemeris(planets[1], tt),
                planet_ephemeris(planets[2], tt),
                planet_ephemeris(planets[3], tt),
                planet_ephemeris(planets[4], tt),
            ];
            let mid_nut = nutation(tt);
            let _ = mid_nut;
            (jd, ephs, sun_ephemeris(tt).eq_apparent)
        })
        .collect();

    let mut events: Vec<PlanetConjunctionEvent> = targets
        .into_par_iter()
        .flat_map_iter(|(hip, star_name, eq_j2000, star_mag)| {
            let mid_tt = ut_to_tt_jd(0.5 * (start_jd_ut + end_jd_ut));
            let nut = nutation(mid_tt);
            let eq_star_app =
                apply_nutation_to_equatorial(precess_j2000_to_date(eq_j2000, mid_tt), &nut);
            let mut out = Vec::new();
            for (p_idx, &planet) in planets.iter().enumerate() {
                for i in 1..(grid.len() - 1) {
                    let s0 = angular_distance_deg(grid[i - 1].1[p_idx].eq_apparent, eq_star_app);
                    let sc = angular_distance_deg(grid[i].1[p_idx].eq_apparent, eq_star_app);
                    let sp = angular_distance_deg(grid[i + 1].1[p_idx].eq_apparent, eq_star_app);
                    if sc <= s0 && sc < sp && sc <= max_sep_deg + 2.0 {
                        let (exact_jd, min_sep) =
                            golden_extremum_jd(grid[i - 1].0, grid[i + 1].0, false, |t| {
                                let p_eq = planet_ephemeris(planet, ut_to_tt_jd(t)).eq_apparent;
                                angular_distance_deg(p_eq, eq_star_app)
                            });
                        if min_sep <= max_sep_deg {
                            let eph = planet_ephemeris(planet, ut_to_tt_jd(exact_jd));
                            out.push(PlanetConjunctionEvent {
                                kind: "planet_star".to_owned(),
                                title_ja: format!(
                                    "{}と{}が接近 ({min_sep:.2}°)",
                                    planet.name_ja(),
                                    star_name
                                ),
                                jd_ut: exact_jd,
                                separation_deg: min_sep,
                                center_ra_deg: eph.eq_apparent.ra_deg,
                                center_dec_deg: eph.eq_apparent.dec_deg,
                                bodies: vec![planet_id_str(planet).to_owned(), format!("HIP {hip}")],
                                detail_ja: format!(
                                    "{} ({:.1}等) / {} ({star_mag:.1}等) ・離角 {min_sep:.2}° ・太陽離角 {:.1}°",
                                    planet.name_ja(),
                                    eph.visual_magnitude,
                                    star_name,
                                    eph.elongation_deg
                                ),
                            });
                        }
                    }
                }
            }
            out
        })
        .collect();

    events.sort_by(|a, b| a.jd_ut.total_cmp(&b.jd_ut));
    events
}

// =========================================================================
// Phase 6: Solar Eclipses, Lunar Eclipses, Planetary Transits, Occultations
// =========================================================================

const SYNODIC_MONTH: f64 = 29.530_588_853;
const EARTH_RADIUS_KM: f64 = 6_378.137;

fn tangent_offset_arcmin(target: Equatorial, center: Equatorial) -> (f64, f64) {
    let dx = wrap_deg_180(target.ra_deg - center.ra_deg) * center.dec_deg.to_radians().cos() * 60.0;
    let dy = (target.dec_deg - center.dec_deg) * 60.0;
    (dx, dy)
}

fn sun_topo_pos_arcmin(jd_ut: f64, loc: &ObserverLocation) -> (Equatorial, f64, f64, f64) {
    let tt = ut_to_tt_jd(jd_ut);
    let sun = sun_ephemeris(tt);
    let lst = last_deg(jd_ut, loc.lon_deg);
    let topo = geocentric_to_topocentric(sun.eq_apparent, sun.geo_au, loc.lat_deg, loc.alt_m, lst);
    let hor = equatorial_to_horizontal(topo, loc.lat_deg, lst);
    let alt = apply_standard_refraction(hor.alt_deg);
    let radius_arcmin = sun.angular_diameter_arcsec / 120.0;
    (topo, hor.az_deg, alt, radius_arcmin)
}

fn moon_topo_pos_arcmin(jd_ut: f64, loc: &ObserverLocation) -> (Equatorial, f64, f64, f64, f64) {
    let tt = ut_to_tt_jd(jd_ut);
    let moon = moon_ephemeris(tt);
    let lst = last_deg(jd_ut, loc.lon_deg);
    let topo = geocentric_to_topocentric(moon.eq_apparent, moon.geo_au, loc.lat_deg, loc.alt_m, lst);
    let hor = equatorial_to_horizontal(topo, loc.lat_deg, lst);
    let alt_true = hor.alt_deg;
    let topo_scale = 1.0 / (1.0 - (EARTH_RADIUS_KM / moon.distance_km) * alt_true.to_radians().sin().max(-0.2));
    let radius_arcmin = (moon.angular_diameter_arcsec / 120.0) * topo_scale;
    let alt_app = apply_standard_refraction(alt_true);
    (topo, hor.az_deg, alt_app, radius_arcmin, moon.illuminated_fraction)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolarEclipseSample {
    pub jd_ut: f64,
    pub sun_az_deg: f64,
    pub sun_alt_deg: f64,
    pub moon_dx_arcmin: f64,
    pub moon_dy_arcmin: f64,
    pub local_mag: f64,
    pub sun_radius_arcmin: f64,
    pub moon_radius_arcmin: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SolarEclipseEvent {
    pub global_type: String,
    pub global_type_ja: String,
    pub local_type: String,
    pub local_type_ja: String,
    pub visible_locally: bool,
    pub global_max_jd_ut: f64,
    pub local_max_jd_ut: f64,
    pub start_jd_ut: Option<f64>,
    pub end_jd_ut: Option<f64>,
    pub local_magnitude: f64,
    pub max_sun_alt_deg: f64,
    pub max_sun_az_deg: f64,
    pub first_contact_pa_deg: Option<f64>,
    pub max_obscuration_pct: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub path_samples: Vec<SolarEclipseSample>,
}

/// Search solar eclipses over `[start_jd_ut, end_jd_ut]` with exact topocentric circumstances at `loc`.
pub fn search_solar_eclipses(
    start_jd_ut: f64,
    end_jd_ut: f64,
    loc: &ObserverLocation,
) -> Vec<SolarEclipseEvent> {
    if end_jd_ut <= start_jd_ut {
        return Vec::new();
    }
    let mut new_moons = Vec::new();
    let mut probe = find_new_moon_near_jd_ut(start_jd_ut - 15.0);
    while probe <= end_jd_ut + 15.0 {
        let exact_nm = find_new_moon_near_jd_ut(probe);
        if new_moons.last().map(|&prev: &f64| (exact_nm - prev).abs() > 15.0).unwrap_or(true) {
            new_moons.push(exact_nm);
        }
        probe = exact_nm + SYNODIC_MONTH;
    }

    let mut events: Vec<SolarEclipseEvent> = new_moons
        .into_par_iter()
        .filter_map(|nm_jd| {
            let geo_sep_at = |t: f64| -> f64 {
                let tt = ut_to_tt_jd(t);
                angular_distance_deg(moon_ephemeris(tt).eq_apparent, sun_ephemeris(tt).eq_apparent)
            };
            let (global_max_jd, geo_min_sep_deg) =
                golden_extremum_jd(nm_jd - 0.30, nm_jd + 0.30, false, geo_sep_at);
            if global_max_jd < start_jd_ut || global_max_jd > end_jd_ut {
                return None;
            }
            if geo_min_sep_deg > 1.62 {
                return None;
            }

            let tt_g = ut_to_tt_jd(global_max_jd);
            let m_g = moon_ephemeris(tt_g);
            let s_g = sun_ephemeris(tt_g);
            let pi_diff = (m_g.horizontal_parallax_deg - 8.794 / 3600.0).max(0.5);
            let gamma = geo_min_sep_deg.to_radians().sin() / pi_diff.to_radians().sin();
            let sun_r_g = s_g.angular_diameter_arcsec / 120.0;
            let moon_r_g = m_g.angular_diameter_arcsec / 120.0;
            let global_limit_deg = pi_diff + (sun_r_g + moon_r_g) / 60.0;
            if geo_min_sep_deg > global_limit_deg {
                return None;
            }

            let moon_r_subsolar = moon_r_g / (1.0 - (EARTH_RADIUS_KM / m_g.distance_km) * (1.0 - gamma * gamma).max(0.0).sqrt());
            let (global_type, global_type_ja) = if gamma.abs() > 0.9972 {
                ("partial", "部分日食")
            } else if moon_r_g >= sun_r_g * 1.001 {
                ("total", "皆既日食")
            } else if moon_r_subsolar >= sun_r_g {
                ("hybrid", "金環皆既日食")
            } else {
                ("annular", "金環日食")
            };

            // Local topocentric circumstances at observer location
            let topo_sep_arcmin = |t: f64| -> f64 {
                let (se, _, _, _) = sun_topo_pos_arcmin(t, loc);
                let (me, _, _, _, _) = moon_topo_pos_arcmin(t, loc);
                angular_distance_deg(se, me) * 60.0
            };

            // Coarse scan every 8 minutes across [-0.30, +0.30] days around global max
            let mut best_t = global_max_jd;
            let mut best_d = f64::INFINITY;
            for step in -54..=54 {
                let t = global_max_jd + f64::from(step) / 180.0;
                let d = topo_sep_arcmin(t);
                if d < best_d {
                    best_d = d;
                    best_t = t;
                }
            }
            let (local_max_jd, local_min_sep) =
                golden_extremum_jd(best_t - 0.015, best_t + 0.015, false, topo_sep_arcmin);

            let (sun_max_eq, max_sun_az, max_sun_alt, sun_r_max) =
                sun_topo_pos_arcmin(local_max_jd, loc);
            let (_, _, _, moon_r_max, _) = moon_topo_pos_arcmin(local_max_jd, loc);
            let raw_mag = (sun_r_max + moon_r_max - local_min_sep) / (2.0 * sun_r_max);

            let margin_at = |t: f64| -> f64 {
                let (se, _, _, sr) = sun_topo_pos_arcmin(t, loc);
                let (me, _, _, mr, _) = moon_topo_pos_arcmin(t, loc);
                angular_distance_deg(se, me) * 60.0 - (sr + mr)
            };

            let mut start_jd_ut = None;
            let mut end_jd_ut = None;
            let mut visible_locally = false;
            if raw_mag > 0.0 {
                let mut t_a = local_max_jd - 0.14;
                while t_a < local_max_jd {
                    let t_b = (t_a + 0.01).min(local_max_jd);
                    if margin_at(t_a) > 0.0 && margin_at(t_b) <= 0.0 {
                        start_jd_ut = Some(bisect_root(t_a, t_b, margin_at));
                        break;
                    }
                    t_a = t_b;
                }
                let mut t_a2 = local_max_jd;
                let t_lim = local_max_jd + 0.14;
                while t_a2 < t_lim {
                    let t_b2 = (t_a2 + 0.01).min(t_lim);
                    if margin_at(t_a2) <= 0.0 && margin_at(t_b2) > 0.0 {
                        end_jd_ut = Some(bisect_root(t_a2, t_b2, margin_at));
                        break;
                    }
                    t_a2 = t_b2;
                }
                let alt_start = start_jd_ut.map(|t| sun_topo_pos_arcmin(t, loc).2).unwrap_or(-90.0);
                let alt_end = end_jd_ut.map(|t| sun_topo_pos_arcmin(t, loc).2).unwrap_or(-90.0);
                visible_locally = max_sun_alt > -0.8 || alt_start > -0.8 || alt_end > -0.8;
            }

            let local_mag = raw_mag.max(0.0);
            let (local_type, local_type_ja) = if !visible_locally {
                ("not_visible", "観測地で見えない")
            } else if local_min_sep <= (moon_r_max - sun_r_max) && moon_r_max >= sun_r_max {
                ("total", "皆既日食")
            } else if local_min_sep <= (sun_r_max - moon_r_max) && moon_r_max < sun_r_max {
                ("annular", "金環日食")
            } else {
                ("partial", "部分日食")
            };

            let first_contact_pa_deg = start_jd_ut.map(|t1| {
                let (se, _, _, _) = sun_topo_pos_arcmin(t1, loc);
                let (me, _, _, _, _) = moon_topo_pos_arcmin(t1, loc);
                let (dx, dy) = tangent_offset_arcmin(me, se);
                wrap_deg_360(dx.atan2(dy).to_degrees())
            });

            // Sample continuous path across [c1, c4] (or around global max if invisible)
            let p_start = start_jd_ut.unwrap_or(local_max_jd - 0.07);
            let p_end = end_jd_ut.unwrap_or(local_max_jd + 0.07);
            let mut path_samples = Vec::with_capacity(21);
            for i in 0..=20 {
                let t = p_start + (p_end - p_start) * (f64::from(i) / 20.0);
                let (se, saz, salt, sr) = sun_topo_pos_arcmin(t, loc);
                let (me, _, _, mr, _) = moon_topo_pos_arcmin(t, loc);
                let (dx, dy) = tangent_offset_arcmin(me, se);
                let sep = dx.hypot(dy);
                let mag = ((sr + mr - sep) / (2.0 * sr)).max(0.0);
                path_samples.push(SolarEclipseSample {
                    jd_ut: t,
                    sun_az_deg: saz,
                    sun_alt_deg: salt,
                    moon_dx_arcmin: dx,
                    moon_dy_arcmin: dy,
                    local_mag: mag,
                    sun_radius_arcmin: sr,
                    moon_radius_arcmin: mr,
                });
            }

            let obscuration = if local_type == "total" {
                100.0
            } else if local_mag <= 0.0 {
                0.0
            } else {
                (local_mag * 100.0).min(100.0)
            };

            Some(SolarEclipseEvent {
                global_type: global_type.into(),
                global_type_ja: global_type_ja.into(),
                local_type: local_type.into(),
                local_type_ja: local_type_ja.into(),
                visible_locally,
                global_max_jd_ut: global_max_jd,
                local_max_jd_ut: local_max_jd,
                start_jd_ut,
                end_jd_ut,
                local_magnitude: local_mag,
                max_sun_alt_deg: max_sun_alt,
                max_sun_az_deg: max_sun_az,
                first_contact_pa_deg,
                max_obscuration_pct: obscuration,
                ra_deg: sun_max_eq.ra_deg,
                dec_deg: sun_max_eq.dec_deg,
                path_samples,
            })
        })
        .collect();

    events.sort_by(|a, b| a.global_max_jd_ut.total_cmp(&b.global_max_jd_ut));
    events
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LunarEclipseSample {
    pub jd_ut: f64,
    pub dx_arcmin: f64,
    pub dy_arcmin: f64,
    pub moon_radius_arcmin: f64,
    pub umbra_radius_arcmin: f64,
    pub penumbra_radius_arcmin: f64,
    pub moon_alt_deg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LunarEclipseEvent {
    pub eclipse_type: String,
    pub eclipse_type_ja: String,
    pub visible_locally: bool,
    pub max_jd_ut: f64,
    pub p1_jd_ut: Option<f64>,
    pub u1_jd_ut: Option<f64>,
    pub u2_jd_ut: Option<f64>,
    pub u3_jd_ut: Option<f64>,
    pub u4_jd_ut: Option<f64>,
    pub p4_jd_ut: Option<f64>,
    pub umbral_magnitude: f64,
    pub penumbral_magnitude: f64,
    pub umbra_radius_arcmin: f64,
    pub penumbra_radius_arcmin: f64,
    pub moon_radius_arcmin: f64,
    pub max_moon_alt_deg: f64,
    pub max_moon_az_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub path_samples: Vec<LunarEclipseSample>,
}

/// Search lunar eclipses over `[start_jd_ut, end_jd_ut]` with contacts, shadow geometry, and local visibility.
pub fn search_lunar_eclipses(
    start_jd_ut: f64,
    end_jd_ut: f64,
    loc: &ObserverLocation,
) -> Vec<LunarEclipseEvent> {
    if end_jd_ut <= start_jd_ut {
        return Vec::new();
    }
    let find_full_moon_near = |approx: f64| -> f64 {
        let mut jd_tt = ut_to_tt_jd(approx);
        for _ in 0..8 {
            let diff = wrap_deg_180(
                moon_apparent_ecliptic_lon_deg(jd_tt) - sun_apparent_ecliptic_lon_deg(jd_tt) - 180.0,
            );
            jd_tt -= diff * (SYNODIC_MONTH / 360.0);
            if diff.abs() < 1e-6 {
                break;
            }
        }
        crate::engine::time::tt_to_ut_jd(jd_tt)
    };

    let mut full_moons = Vec::new();
    let mut probe = find_full_moon_near(start_jd_ut - 15.0);
    while probe <= end_jd_ut + 15.0 {
        let exact_fm = find_full_moon_near(probe);
        if full_moons.last().map(|&prev: &f64| (exact_fm - prev).abs() > 15.0).unwrap_or(true) {
            full_moons.push(exact_fm);
        }
        probe = exact_fm + SYNODIC_MONTH;
    }

    let mut events: Vec<LunarEclipseEvent> = full_moons
        .into_par_iter()
        .filter_map(|fm_jd| {
            let shadow_geom_at = |t: f64| -> (f64, f64, f64, f64, f64, f64, Equatorial) {
                let tt = ut_to_tt_jd(t);
                let sun = sun_ephemeris(tt);
                let moon = moon_ephemeris(tt);
                let anti_sun = Equatorial {
                    ra_deg: wrap_deg_360(sun.eq_apparent.ra_deg + 180.0),
                    dec_deg: -sun.eq_apparent.dec_deg,
                };
                let (dx, dy) = tangent_offset_arcmin(moon.eq_apparent, anti_sun);
                let sep = dx.hypot(dy);
                let pi_m = moon.horizontal_parallax_deg * 60.0;
                let pi_s = 8.794 / 60.0;
                let s_s = sun.angular_diameter_arcsec / 120.0;
                let s_m = moon.angular_diameter_arcsec / 120.0;
                let r_pen = 1.02 * (pi_m + pi_s + s_s);
                let r_umb = 1.02 * (pi_m + pi_s - s_s);
                (sep, dx, dy, s_m, r_umb, r_pen, moon.eq_apparent)
            };

            let (max_jd, min_sep) = golden_extremum_jd(fm_jd - 0.25, fm_jd + 0.25, false, |t| {
                shadow_geom_at(t).0
            });
            if max_jd < start_jd_ut || max_jd > end_jd_ut {
                return None;
            }
            let (_, _, _, s_m, r_umb, r_pen, moon_eq) = shadow_geom_at(max_jd);
            if min_sep >= r_pen + s_m {
                return None;
            }

            let penumbral_mag = (r_pen + s_m - min_sep) / (2.0 * s_m);
            let umbral_mag = (r_umb + s_m - min_sep) / (2.0 * s_m);
            let (eclipse_type, eclipse_type_ja) = if umbral_mag >= 1.0 {
                ("total", "皆既月食")
            } else if umbral_mag > 0.0 {
                ("partial", "部分月食")
            } else {
                ("penumbral", "半影月食")
            };

            let find_contacts = |threshold_fn: fn(f64, f64, f64) -> f64| -> (Option<f64>, Option<f64>) {
                let mut left = None;
                let mut right = None;
                let f = |t: f64| -> f64 {
                    let (sep, _, _, sm, ru, rp, _) = shadow_geom_at(t);
                    sep - threshold_fn(sm, ru, rp)
                };
                if f(max_jd) > 0.0 {
                    return (None, None);
                }
                let mut ta = max_jd - 0.24;
                while ta < max_jd {
                    let tb = (ta + 0.01).min(max_jd);
                    if f(ta) > 0.0 && f(tb) <= 0.0 {
                        left = Some(bisect_root(ta, tb, f));
                        break;
                    }
                    ta = tb;
                }
                let mut tc = max_jd;
                while tc < max_jd + 0.24 {
                    let td = (tc + 0.01).min(max_jd + 0.24);
                    if f(tc) <= 0.0 && f(td) > 0.0 {
                        right = Some(bisect_root(tc, td, f));
                        break;
                    }
                    tc = td;
                }
                (left, right)
            };

            let (p1, p4) = find_contacts(|sm, _ru, rp| rp + sm);
            let (u1, u4) = if umbral_mag > 0.0 {
                find_contacts(|sm, ru, _rp| ru + sm)
            } else {
                (None, None)
            };
            let (u2, u3) = if umbral_mag >= 1.0 {
                find_contacts(|sm, ru, _rp| ru - sm)
            } else {
                (None, None)
            };

            let (_, max_az, max_alt, _, _) = moon_topo_pos_arcmin(max_jd, loc);
            let span_a = p1.unwrap_or(max_jd - 0.12);
            let span_b = p4.unwrap_or(max_jd + 0.12);
            let mut path_samples = Vec::with_capacity(25);
            let mut visible_locally = false;
            for i in 0..=24 {
                let t = span_a + (span_b - span_a) * (f64::from(i) / 24.0);
                let (_, dx, dy, sm, ru, rp, _) = shadow_geom_at(t);
                let (_, _, m_alt, _, _) = moon_topo_pos_arcmin(t, loc);
                if m_alt > -0.5 {
                    visible_locally = true;
                }
                path_samples.push(LunarEclipseSample {
                    jd_ut: t,
                    dx_arcmin: dx,
                    dy_arcmin: dy,
                    moon_radius_arcmin: sm,
                    umbra_radius_arcmin: ru,
                    penumbra_radius_arcmin: rp,
                    moon_alt_deg: m_alt,
                });
            }

            Some(LunarEclipseEvent {
                eclipse_type: eclipse_type.into(),
                eclipse_type_ja: eclipse_type_ja.into(),
                visible_locally,
                max_jd_ut: max_jd,
                p1_jd_ut: p1,
                u1_jd_ut: u1,
                u2_jd_ut: u2,
                u3_jd_ut: u3,
                u4_jd_ut: u4,
                p4_jd_ut: p4,
                umbral_magnitude: umbral_mag.max(0.0),
                penumbral_magnitude: penumbral_mag.max(0.0),
                umbra_radius_arcmin: r_umb,
                penumbra_radius_arcmin: r_pen,
                moon_radius_arcmin: s_m,
                max_moon_alt_deg: max_alt,
                max_moon_az_deg: max_az,
                ra_deg: moon_eq.ra_deg,
                dec_deg: moon_eq.dec_deg,
                path_samples,
            })
        })
        .collect();

    events.sort_by(|a, b| a.max_jd_ut.total_cmp(&b.max_jd_ut));
    events
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransitChordSample {
    pub jd_ut: f64,
    pub dx_arcmin: f64,
    pub dy_arcmin: f64,
    pub sun_alt_deg: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlanetaryTransitEvent {
    pub planet_id: String,
    pub planet_name_ja: String,
    pub visible_locally: bool,
    pub c1_jd_ut: Option<f64>,
    pub max_jd_ut: f64,
    pub c4_jd_ut: Option<f64>,
    pub min_sep_arcmin: f64,
    pub sun_radius_arcmin: f64,
    pub planet_radius_arcsec: f64,
    pub max_sun_alt_deg: f64,
    pub ra_deg: f64,
    pub dec_deg: f64,
    pub path_samples: Vec<TransitChordSample>,
}

/// Search Mercury and Venus solar transits over `[start_jd_ut, end_jd_ut]`.
pub fn search_planetary_transits(
    start_jd_ut: f64,
    end_jd_ut: f64,
    loc: &ObserverLocation,
) -> Vec<PlanetaryTransitEvent> {
    let mut events = Vec::new();
    for planet in [Planet::Mercury, Planet::Venus] {
        let inf_conjs = search_planetary_phenomena(start_jd_ut, end_jd_ut, Some(planet))
            .into_iter()
            .filter(|ev| ev.kind == "inferior_conjunction")
            .collect::<Vec<_>>();

        for conj in inf_conjs {
            let sep_arcmin_at = |t: f64| -> f64 {
                let tt = ut_to_tt_jd(t);
                let p = planet_ephemeris(planet, tt);
                let s = sun_ephemeris(tt);
                angular_distance_deg(p.eq_apparent, s.eq_apparent) * 60.0
            };
            let (max_jd, min_sep) =
                golden_extremum_jd(conj.jd_ut - 0.8, conj.jd_ut + 0.8, false, sep_arcmin_at);
            let tt_max = ut_to_tt_jd(max_jd);
            let sun = sun_ephemeris(tt_max);
            let p_eph = planet_ephemeris(planet, tt_max);
            let sun_r = sun.angular_diameter_arcsec / 120.0;
            let p_r_arcmin = p_eph.angular_diameter_arcsec / 120.0;

            if min_sep >= sun_r + p_r_arcmin {
                continue;
            }

            let margin = |t: f64| -> f64 {
                let tt = ut_to_tt_jd(t);
                let s = sun_ephemeris(tt);
                let p = planet_ephemeris(planet, tt);
                angular_distance_deg(p.eq_apparent, s.eq_apparent) * 60.0
                    - (s.angular_diameter_arcsec + p.angular_diameter_arcsec) / 120.0
            };
            let c1 = (margin(max_jd - 0.35) > 0.0 && margin(max_jd) <= 0.0)
                .then(|| bisect_root(max_jd - 0.35, max_jd, margin));
            let c4 = (margin(max_jd) <= 0.0 && margin(max_jd + 0.35) > 0.0)
                .then(|| bisect_root(max_jd, max_jd + 0.35, margin));

            let span_a = c1.unwrap_or(max_jd - 0.14);
            let span_b = c4.unwrap_or(max_jd + 0.14);
            let mut path_samples = Vec::with_capacity(19);
            let mut visible_locally = false;
            for i in 0..=18 {
                let t = span_a + (span_b - span_a) * (f64::from(i) / 18.0);
                let tt = ut_to_tt_jd(t);
                let p = planet_ephemeris(planet, tt);
                let s = sun_ephemeris(tt);
                let (dx, dy) = tangent_offset_arcmin(p.eq_apparent, s.eq_apparent);
                let (_, _, s_alt, _) = sun_topo_pos_arcmin(t, loc);
                if s_alt > -0.5 {
                    visible_locally = true;
                }
                path_samples.push(TransitChordSample {
                    jd_ut: t,
                    dx_arcmin: dx,
                    dy_arcmin: dy,
                    sun_alt_deg: s_alt,
                });
            }

            let (_, _, max_sun_alt, _) = sun_topo_pos_arcmin(max_jd, loc);
            events.push(PlanetaryTransitEvent {
                planet_id: planet_id_str(planet).into(),
                planet_name_ja: planet.name_ja().into(),
                visible_locally,
                c1_jd_ut: c1,
                max_jd_ut: max_jd,
                c4_jd_ut: c4,
                min_sep_arcmin: min_sep,
                sun_radius_arcmin: sun_r,
                planet_radius_arcsec: p_eph.angular_diameter_arcsec * 0.5,
                max_sun_alt_deg: max_sun_alt,
                ra_deg: sun.eq_apparent.ra_deg,
                dec_deg: sun.eq_apparent.dec_deg,
                path_samples,
            });
        }
    }
    events.sort_by(|a, b| a.max_jd_ut.total_cmp(&b.max_jd_ut));
    events
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LunarOccultationEvent {
    pub target_kind: String,
    pub target_id: String,
    pub target_name_ja: String,
    pub mag: f64,
    pub immersion_jd_ut: f64,
    pub max_jd_ut: f64,
    pub emersion_jd_ut: f64,
    pub min_sep_arcmin: f64,
    pub moon_alt_deg: f64,
    pub moon_az_deg: f64,
    pub moon_illum_pct: f64,
    pub sun_alt_deg: f64,
    pub dark_limb_immersion: bool,
    pub ra_deg: f64,
    pub dec_deg: f64,
}

#[derive(Clone)]
enum OccTarget {
    Planet(Planet),
    Fixed {
        kind: &'static str,
        id: String,
        name_ja: String,
        mag: f64,
        eq_j2000: Equatorial,
    },
}

/// Search topocentric lunar occultations of planets, bright stars (`<= mag_limit`), and Messier objects
/// over `[start_jd_ut, end_jd_ut]` from `loc`.
pub fn search_lunar_occultations(
    start_jd_ut: f64,
    end_jd_ut: f64,
    mag_limit: f64,
    loc: &ObserverLocation,
    store: &CatalogStore,
) -> Vec<LunarOccultationEvent> {
    if end_jd_ut <= start_jd_ut {
        return Vec::new();
    }
    let mut ja_by_hip = std::collections::HashMap::with_capacity(store.star_guides.len());
    for g in &store.star_guides {
        ja_by_hip.insert(g.hip, g.name_ja.as_str());
    }

    let mut targets: Vec<OccTarget> = Planet::ALL.iter().copied().map(OccTarget::Planet).collect();

    for s in &store.stars.stars {
        if f64::from(s.mag) > mag_limit {
            continue;
        }
        let eq = Equatorial {
            ra_deg: wrap_deg_360(f64::from(s.ra_rad).to_degrees()),
            dec_deg: f64::from(s.dec_rad).to_degrees(),
        };
        if equatorial_to_ecliptic(eq, OBLIQUITY_J2000_DEG).lat_deg.abs() > 6.8 {
            continue;
        }
        let proper = store.stars.proper_name(s);
        let bayer = store.stars.bayer(s);
        let con = store.stars.constellation_code(s).unwrap_or("");
        let name_ja = (s.hip > 0)
            .then(|| ja_by_hip.get(&s.hip).copied())
            .flatten()
            .map(str::to_owned)
            .unwrap_or_else(|| {
                if !proper.is_empty() {
                    proper.to_owned()
                } else if !bayer.is_empty() {
                    format!("{bayer} {con}")
                } else {
                    format!("HIP {}", s.hip)
                }
            });
        targets.push(OccTarget::Fixed {
            kind: "star",
            id: if s.hip > 0 {
                format!("HIP {}", s.hip)
            } else {
                format!("STAR {}", s.id)
            },
            name_ja,
            mag: f64::from(s.mag),
            eq_j2000: eq,
        });
    }

    for d in &store.dsos {
        if d.messier.is_none() {
            continue;
        }
        let eq = Equatorial {
            ra_deg: d.ra_deg,
            dec_deg: d.dec_deg,
        };
        if equatorial_to_ecliptic(eq, OBLIQUITY_J2000_DEG).lat_deg.abs() > 6.8 {
            continue;
        }
        let mid = d.messier.map(|m| format!("M{m}")).unwrap_or_else(|| d.id.clone());
        let name_ja = d
            .name_ja
            .as_ref()
            .map(|j| format!("{mid} {j}"))
            .unwrap_or_else(|| format!("{mid} {}", d.name_en));
        targets.push(OccTarget::Fixed {
            kind: "dso",
            id: mid,
            name_ja,
            mag: f64::from(d.mag.unwrap_or(6.0)),
            eq_j2000: eq,
        });
    }

    // Precompute hourly topocentric Moon table once in parallel
    let step_h = 1.0_f64;
    let total_h = (((end_jd_ut - start_jd_ut) * 24.0 / step_h).ceil() as usize).max(2);
    struct MoonHour {
        jd_ut: f64,
        eq: Equatorial,
        alt: f64,
    }
    let moon_grid: Vec<MoonHour> = (0..=total_h)
        .into_par_iter()
        .map(|h| {
            let jd = (start_jd_ut + f64::from(h as u32) * step_h / 24.0).min(end_jd_ut);
            let (eq, _, alt, _, _) = moon_topo_pos_arcmin(jd, loc);
            MoonHour { jd_ut: jd, eq, alt }
        })
        .collect();

    let mid_tt = ut_to_tt_jd(0.5 * (start_jd_ut + end_jd_ut));
    let nut_mid = nutation(mid_tt);

    let mut out: Vec<LunarOccultationEvent> = targets
        .into_par_iter()
        .flat_map_iter(|target| {
            let mut found = Vec::new();
            let eval_target_at = |t: f64| -> (Equatorial, f64, &str, &str, String) {
                match &target {
                    OccTarget::Planet(p) => {
                        let tt = ut_to_tt_jd(t);
                        let eph = planet_ephemeris(*p, tt);
                        let topo = geocentric_to_topocentric(
                            eph.eq_apparent,
                            eph.geo_au,
                            loc.lat_deg,
                            loc.alt_m,
                            last_deg(t, loc.lon_deg),
                        );
                        (topo, eph.visual_magnitude, "planet", planet_id_str(*p), p.name_ja().to_owned())
                    }
                    OccTarget::Fixed { kind, id, name_ja, mag, eq_j2000 } => {
                        let eq_app = apply_nutation_to_equatorial(
                            precess_j2000_to_date(*eq_j2000, mid_tt),
                            &nut_mid,
                        );
                        (eq_app, *mag, kind, id.as_str(), name_ja.clone())
                    }
                }
            };

            let fixed_app = match &target {
                OccTarget::Fixed { eq_j2000, .. } => Some(apply_nutation_to_equatorial(
                    precess_j2000_to_date(*eq_j2000, mid_tt),
                    &nut_mid,
                )),
                OccTarget::Planet(_) => None,
            };

            let mut cooldown_until = start_jd_ut - 1.0;
            for i in 1..(moon_grid.len() - 1) {
                if moon_grid[i].jd_ut < cooldown_until || moon_grid[i].alt < -3.5 {
                    continue;
                }
                let sep_c = match fixed_app {
                    Some(eq) => {
                        if (moon_grid[i].eq.dec_deg - eq.dec_deg).abs() > 1.3 {
                            continue;
                        }
                        angular_distance_deg(moon_grid[i].eq, eq)
                    }
                    None => angular_distance_deg(moon_grid[i].eq, eval_target_at(moon_grid[i].jd_ut).0),
                };
                if sep_c > 0.9 {
                    continue;
                }
                let sep_m = angular_distance_deg(
                    moon_grid[i - 1].eq,
                    fixed_app.unwrap_or_else(|| eval_target_at(moon_grid[i - 1].jd_ut).0),
                );
                let sep_p = angular_distance_deg(
                    moon_grid[i + 1].eq,
                    fixed_app.unwrap_or_else(|| eval_target_at(moon_grid[i + 1].jd_ut).0),
                );
                if sep_c <= sep_m && sep_c < sep_p {
                    let sep_diff_arcmin = |t: f64| -> (f64, f64, f64, f64, f64) {
                        let (me, _, m_alt, m_r, illum) = moon_topo_pos_arcmin(t, loc);
                        let eq_t = fixed_app.unwrap_or_else(|| eval_target_at(t).0);
                        let sep_am = angular_distance_deg(me, eq_t) * 60.0;
                        (sep_am, m_r, m_alt, illum, sep_am - m_r)
                    };

                    let (max_jd, min_sep_am) = golden_extremum_jd(
                        moon_grid[i - 1].jd_ut,
                        moon_grid[i + 1].jd_ut,
                        false,
                        |t| sep_diff_arcmin(t).0,
                    );
                    let (_, m_r_max, m_alt_max, illum_max, _) = sep_diff_arcmin(max_jd);
                    if min_sep_am < m_r_max && m_alt_max > -0.5 {
                        let margin_fn = |t: f64| sep_diff_arcmin(t).4;
                        let imm_jd = if margin_fn(max_jd - 0.04) > 0.0 {
                            bisect_root(max_jd - 0.04, max_jd, margin_fn)
                        } else {
                            max_jd - 0.02
                        };
                        let eme_jd = if margin_fn(max_jd + 0.04) > 0.0 {
                            bisect_root(max_jd, max_jd + 0.04, margin_fn)
                        } else {
                            max_jd + 0.02
                        };

                        let (eq_t, t_mag, t_kind, t_id, t_name) = eval_target_at(max_jd);
                        let (_, moon_az_max, _, _, _) = moon_topo_pos_arcmin(max_jd, loc);
                        let (_, _, sun_alt_max, _) = sun_topo_pos_arcmin(max_jd, loc);

                        // Skip dim star occultations in bright daylight
                        if sun_alt_max > -2.0 && t_mag > 0.5 && t_kind != "planet" {
                            continue;
                        }

                        let tt_m = ut_to_tt_jd(max_jd);
                        let waxing = wrap_deg_360(
                            moon_apparent_ecliptic_lon_deg(tt_m) - sun_apparent_ecliptic_lon_deg(tt_m),
                        ) < 180.0;

                        found.push(LunarOccultationEvent {
                            target_kind: t_kind.to_owned(),
                            target_id: t_id.to_owned(),
                            target_name_ja: t_name,
                            mag: t_mag,
                            immersion_jd_ut: imm_jd,
                            max_jd_ut: max_jd,
                            emersion_jd_ut: eme_jd,
                            min_sep_arcmin: min_sep_am,
                            moon_alt_deg: m_alt_max,
                            moon_az_deg: moon_az_max,
                            moon_illum_pct: illum_max * 100.0,
                            sun_alt_deg: sun_alt_max,
                            dark_limb_immersion: waxing,
                            ra_deg: eq_t.ra_deg,
                            dec_deg: eq_t.dec_deg,
                        });
                        cooldown_until = eme_jd + 0.2;
                    }
                }
            }
            found
        })
        .collect();

    out.sort_by(|a, b| a.max_jd_ut.total_cmp(&b.max_jd_ut));
    out
}

#[cfg(test)]
mod tests {
    use crate::engine::catalog::resolve_assets_dir;
    use crate::engine::time::{jd_to_ymd_hms, ymd_hms_to_jd};

    use super::*;

    #[test]
    fn planetary_phenomena_2026_real_dates() {
        let start = ymd_hms_to_jd(2026, 1, 1, 0, 0, 0.0);
        let end = ymd_hms_to_jd(2026, 12, 31, 23, 59, 0.0);
        let events = search_planetary_phenomena(start, end, None);
        assert!(events.len() >= 15);

        // Jupiter opposition on ~2026-01-10
        let jup_opp = events
            .iter()
            .find(|e| e.planet_id == "jupiter" && e.kind == "opposition")
            .expect("Jupiter opposition in Jan 2026");
        let (jy, jm, jd, _, _, _) = jd_to_ymd_hms(jup_opp.jd_ut);
        assert_eq!((jy, jm), (2026, 1));
        assert!((9..=11).contains(&jd), "Jup opp day={jd}");

        // Saturn opposition in early Oct 2026
        let sat_opp = events
            .iter()
            .find(|e| e.planet_id == "saturn" && e.kind == "opposition")
            .expect("Saturn opposition in Oct 2026");
        let (sy, sm, _, _, _, _) = jd_to_ymd_hms(sat_opp.jd_ut);
        assert_eq!((sy, sm), (2026, 10));

        // Venus greatest eastern elongation in Aug 2026
        let ven_e = events
            .iter()
            .find(|e| e.planet_id == "venus" && e.kind == "greatest_eastern_elongation")
            .expect("Venus greatest eastern elongation in Aug 2026");
        let (vy, vm, _, _, _, _) = jd_to_ymd_hms(ven_e.jd_ut);
        assert_eq!((vy, vm), (2026, 8));
    }

    #[test]
    fn conjunctions_and_star_approaches_work() {
        let dir = resolve_assets_dir(None).expect("assets dir");
        let store = CatalogStore::load_from_dir(&dir).expect("catalog load");
        let start = ymd_hms_to_jd(2026, 1, 1, 0, 0, 0.0);
        let end = ymd_hms_to_jd(2026, 12, 31, 23, 59, 0.0);

        let pp = search_planet_planet_conjunctions(start, end, 3.0, false);
        assert!(!pp.is_empty(), "expected 2026 planet-planet conjunctions <= 3°");
        for e in &pp {
            assert!(e.separation_deg <= 3.0);
        }

        let ps = search_planet_star_conjunctions(start, end, 5.0, None, &store);
        assert!(!ps.is_empty(), "expected 2026 planet-bright star approaches <= 5°");
    }

    #[test]
    fn solar_and_lunar_eclipses_2026_to_2035() {
        let start = ymd_hms_to_jd(2026, 1, 1, 0, 0, 0.0);
        let end = ymd_hms_to_jd(2035, 12, 31, 23, 59, 0.0);
        let solar = search_solar_eclipses(start, end, &ObserverLocation::AKASHI);
        assert!(solar.len() >= 18, "expected >= 18 global solar eclipses 2026-2035, got {}", solar.len());

        // 2026-08-12 Total solar eclipse (Europe/Arctic)
        let aug2026 = solar.iter().find(|e| {
            let (y, m, d, _, _, _) = jd_to_ymd_hms(e.global_max_jd_ut);
            y == 2026 && m == 8 && (11..=13).contains(&d)
        }).expect("2026-08-12 solar eclipse");
        assert_eq!(aug2026.global_type, "total");

        // 2030-06-01 Annular solar eclipse (Hokkaido annular / Akashi deep partial)
        let jun2030 = solar.iter().find(|e| {
            let (y, m, d, _, _, _) = jd_to_ymd_hms(e.global_max_jd_ut);
            y == 2030 && m == 6 && d == 1
        }).expect("2030-06-01 solar eclipse");
        assert_eq!(jun2030.global_type, "annular");
        assert!(jun2030.visible_locally);
        assert!(jun2030.local_magnitude > 0.7);

        // 2035-09-02 Total solar eclipse (Honshu/Tokyo total, Akashi very deep partial)
        let sep2035 = solar.iter().find(|e| {
            let (y, m, d, _, _, _) = jd_to_ymd_hms(e.global_max_jd_ut);
            y == 2035 && m == 9 && d == 2
        }).expect("2035-09-02 solar eclipse");
        assert_eq!(sep2035.global_type, "total");
        assert!(sep2035.visible_locally);
        assert!(sep2035.local_magnitude > 0.9);

        // 2026-03-03 Total lunar eclipse visible from Akashi!
        let lunar = search_lunar_eclipses(start, end, &ObserverLocation::AKASHI);
        let mar2026 = lunar.iter().find(|e| {
            let (y, m, d, _, _, _) = jd_to_ymd_hms(e.max_jd_ut + 9.0 / 24.0);
            y == 2026 && m == 3 && d == 3
        }).expect("2026-03-03 lunar eclipse");
        assert_eq!(mar2026.eclipse_type, "total");
        assert!(mar2026.visible_locally);
        assert!(mar2026.umbral_magnitude > 1.0);
    }

    #[test]
    fn mercury_transit_2032_and_lunar_occultations_2026() {
        // 2032-11-13 Mercury transit
        let transits = search_planetary_transits(
            ymd_hms_to_jd(2030, 1, 1, 0, 0, 0.0),
            ymd_hms_to_jd(2035, 12, 31, 0, 0, 0.0),
            &ObserverLocation::AKASHI,
        );
        let nov2032 = transits.iter().find(|t| {
            let (y, m, d, _, _, _) = jd_to_ymd_hms(t.max_jd_ut);
            t.planet_id == "mercury" && y == 2032 && m == 11 && d == 13
        }).expect("2032-11-13 Mercury transit");
        assert!(nov2032.c1_jd_ut.is_some() && nov2032.c4_jd_ut.is_some());

        let dir = resolve_assets_dir(None).expect("assets dir");
        let store = CatalogStore::load_from_dir(&dir).expect("catalog load");
        let occs = search_lunar_occultations(
            ymd_hms_to_jd(2026, 1, 1, 0, 0, 0.0),
            ymd_hms_to_jd(2026, 12, 31, 23, 59, 0.0),
            4.5,
            &ObserverLocation::AKASHI,
            &store,
        );
        assert!(!occs.is_empty(), "expected bright occultations in 2026 from Akashi");
    }
}
