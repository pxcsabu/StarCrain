//! Astronomical edge-case verification suite (Phase 9).
//! Covers polar regions, BCE historical epochs, International Date Line,
//! leap years & Gregorian reform, high-latitude midnight sun / polar night,
//! and binary IPC payload packing for stars & DSOs.

use crate::commands::sky::{build_sky_dso_bytes, build_sky_star_bytes};
use crate::engine::catalog::{CatalogStore, resolve_assets_dir};
use crate::engine::comet_db::default_satellites;
use crate::engine::coords::{Equatorial, Horizontal, equatorial_to_horizontal};
use crate::engine::ephemeris::{moon_ephemeris, sun_ephemeris};
use crate::engine::precession::precess_j2000_to_date;
use crate::engine::projection::{
    ProjectionMode, ProjectionParams, project_horizontal, unproject_screen,
};
use crate::engine::rise_set::{ObserverLocation, RiseSetStatus, moon_rise_set, sun_rise_set};
use crate::engine::satellite::propagate_satellite_at;
use crate::engine::sky_color::{SkyColorInput, compute_sky_palette};
use crate::engine::time::{
    calendar_to_jd, delta_t_seconds, jd_to_ymd_hms, last_deg, lst_deg, ut_to_tt_jd, ymd_hms_to_jd,
};

#[test]
fn polar_regions_north_and_south_pole_stability() {
    let poles = [
        ObserverLocation {
            lat_deg: 89.95,
            lon_deg: 0.0,
            alt_m: 10.0,
            tz_offset_min: 0,
        },
        ObserverLocation {
            lat_deg: -89.95,
            lon_deg: 0.0,
            alt_m: 2835.0, // Amundsen-Scott elevation
            tz_offset_min: 0,
        },
    ];

    let jd_june = ymd_hms_to_jd(2026, 6, 21, 12, 0, 0.0);
    let jd_dec = ymd_hms_to_jd(2026, 12, 21, 12, 0, 0.0);
    let sats = default_satellites();

    // June solstice: North Pole always day (Circumpolar), South Pole always night (NeverRises)
    let np_june = sun_rise_set(&poles[0], 2026, 6, 21);
    let sp_june = sun_rise_set(&poles[1], 2026, 6, 21);
    assert_eq!(np_june.status, RiseSetStatus::Circumpolar);
    assert_eq!(sp_june.status, RiseSetStatus::NeverRises);

    // December solstice flips poles
    let np_dec = sun_rise_set(&poles[0], 2026, 12, 21);
    let sp_dec = sun_rise_set(&poles[1], 2026, 12, 21);
    assert_eq!(np_dec.status, RiseSetStatus::NeverRises);
    assert_eq!(sp_dec.status, RiseSetStatus::Circumpolar);

    for (idx, pole) in poles.iter().enumerate() {
        for jd in [jd_june, jd_dec] {
            let sid = last_deg(jd, pole.lon_deg);
            assert!(sid.is_finite());

            let polaris = Equatorial {
                ra_deg: 37.95,
                dec_deg: 89.26,
            };
            let hor = equatorial_to_horizontal(polaris, pole.lat_deg, sid);
            assert!(hor.az_deg.is_finite() && hor.alt_deg.is_finite());
            if idx == 0 {
                assert!(hor.alt_deg > 88.0, "Polaris near zenith at North Pole");
            } else {
                assert!(hor.alt_deg < -88.0, "Polaris near nadir at South Pole");
            }

            let moon_rs = moon_rise_set(pole, 2026, 6, 21);
            assert!(matches!(
                moon_rs.status,
                RiseSetStatus::Normal | RiseSetStatus::Circumpolar | RiseSetStatus::NeverRises
            ));

            let pal = compute_sky_palette(&SkyColorInput {
                sun_alt_deg: if idx == 0 { 23.0 } else { -23.0 },
                sun_az_deg: 180.0,
                moon_alt_deg: -10.0,
                moon_az_deg: 90.0,
                moon_illuminated_fraction: 0.5,
                limiting_mag: 6.5,
                realism_level: 3,
                night_vision: false,
            });
            assert!(pal.star_visibility_factor.is_finite());

            let params = ProjectionParams {
                mode: ProjectionMode::FreeDirection,
                center_az_deg: 180.0,
                center_alt_deg: 45.0,
                ..Default::default()
            };
            let pt = project_horizontal(
                Horizontal {
                    az_deg: 180.0,
                    alt_deg: 45.0,
                },
                &params,
            )
            .expect("pole projection");
            assert!(pt.visible && pt.x.is_finite() && pt.y.is_finite());
            let inv = unproject_screen(pt.x, pt.y, &params, pole.lat_deg, sid)
                .expect("pole unprojection");
            assert!(inv.ra_deg.is_some() && inv.dec_deg.is_some());
        }

        // SGP4 satellite propagation remains finite even at pole coordinates
        let iss_pos = propagate_satellite_at(&sats[0], jd_june, pole, true).expect("iss at pole");
        assert!(iss_pos.az_deg.is_finite() && iss_pos.alt_deg.is_finite());
    }
}

#[test]
fn bce_historical_dates_roundtrip_and_ephemeris() {
    // Astronomical year numbering: 0 = 1 BCE, -44 = 45 BCE
    let samples = [(-44, 3, 15), (-2000, 7, 1), (-5000, 12, 21)];
    for (year, month, day) in samples {
        let jd = calendar_to_jd(year, month, f64::from(day) + 0.5);
        assert!(jd.is_finite());
        let (ry, rm, rd, rh, rmin, _rs) = jd_to_ymd_hms(jd);
        assert_eq!((ry, rm, rd, rh, rmin), (year, month, day, 12, 0));

        let dt = delta_t_seconds(f64::from(year));
        assert!(dt.is_finite() && dt > 0.0, "Delta T at year {year} = {dt}");

        let jd_tt = ut_to_tt_jd(jd);
        let star_j2000 = Equatorial {
            ra_deg: 101.287,
            dec_deg: -16.716,
        }; // Sirius
        let prec = precess_j2000_to_date(star_j2000, jd_tt);
        assert!(prec.ra_deg.is_finite() && prec.dec_deg.is_finite());
        assert!(prec.dec_deg >= -90.0 && prec.dec_deg <= 90.0);

        let sun = sun_ephemeris(jd_tt);
        let moon = moon_ephemeris(jd_tt);
        assert!(sun.eq_apparent.ra_deg.is_finite() && sun.eq_apparent.dec_deg.is_finite());
        assert!(moon.eq_apparent.ra_deg.is_finite() && moon.eq_apparent.dec_deg.is_finite());
        assert!(moon.illuminated_fraction >= 0.0 && moon.illuminated_fraction <= 1.0);
    }
}

#[test]
fn international_date_line_crossings() {
    let zones = [
        ObserverLocation {
            lat_deg: -17.7,
            lon_deg: 179.9,
            alt_m: 10.0,
            tz_offset_min: 720, // Fiji / UTC+12
        },
        ObserverLocation {
            lat_deg: -17.7,
            lon_deg: -179.9,
            alt_m: 10.0,
            tz_offset_min: -720, // Baker / UTC-12
        },
        ObserverLocation {
            lat_deg: 1.87,
            lon_deg: -157.36, // Kiritimati geographically west, politically UTC+14
            alt_m: 5.0,
            tz_offset_min: 840,
        },
    ];

    let jd = ymd_hms_to_jd(2026, 3, 20, 23, 55, 0.0);
    for loc in zones {
        let lst = lst_deg(jd, loc.lon_deg);
        assert!((0.0..360.0).contains(&lst));

        let local_jd = jd + f64::from(loc.tz_offset_min) / 1440.0;
        let (y, m, d, hh, mm, _) = jd_to_ymd_hms(local_jd);
        assert!(y >= 2026 && (1..=12).contains(&m) && (1..=31).contains(&d));
        assert!(hh < 24 && mm < 60);

        let sr = sun_rise_set(&loc, 2026, 3, 21);
        let mr = moon_rise_set(&loc, 2026, 3, 21);
        assert_eq!(sr.status, RiseSetStatus::Normal);
        assert!(sr.rise_jd_ut.is_some() && sr.set_jd_ut.is_some());
        assert!(matches!(
            mr.status,
            RiseSetStatus::Normal | RiseSetStatus::Circumpolar | RiseSetStatus::NeverRises
        ));
    }
}

#[test]
fn leap_years_and_gregorian_reform_continuity() {
    // 2000 IS a leap year (divisible by 400)
    assert!(
        (calendar_to_jd(2000, 2, 29.0) - calendar_to_jd(2000, 2, 28.0) - 1.0).abs() < 1e-12
    );
    assert!(
        (calendar_to_jd(2000, 3, 1.0) - calendar_to_jd(2000, 2, 29.0) - 1.0).abs() < 1e-12
    );

    // 1900 is NOT a leap year (divisible by 100, not 400)
    assert!(
        (calendar_to_jd(1900, 3, 1.0) - calendar_to_jd(1900, 2, 28.0) - 1.0).abs() < 1e-12
    );

    // 2024 & 2028 ARE leap years
    assert!(
        (calendar_to_jd(2024, 3, 1.0) - calendar_to_jd(2024, 2, 29.0) - 1.0).abs() < 1e-12
    );
    assert!(
        (calendar_to_jd(2028, 3, 1.0) - calendar_to_jd(2028, 2, 29.0) - 1.0).abs() < 1e-12
    );

    // Gregorian calendar reform: day directly after 1582-10-04 is 1582-10-15
    assert!(
        (calendar_to_jd(1582, 10, 15.0) - calendar_to_jd(1582, 10, 4.0) - 1.0).abs() < 1e-12
    );
    let (y, m, d, _, _, _) = jd_to_ymd_hms(calendar_to_jd(1582, 10, 4.0) + 1.0);
    assert_eq!((y, m, d), (1582, 10, 15));
}

#[test]
fn high_latitude_midnight_sun_and_polar_night() {
    let tromso = ObserverLocation {
        lat_deg: 69.6492,
        lon_deg: 18.9553,
        alt_m: 10.0,
        tz_offset_min: 120,
    };
    let syowa = ObserverLocation {
        lat_deg: -69.004,
        lon_deg: 39.582,
        alt_m: 29.0,
        tz_offset_min: 180,
    };

    assert_eq!(
        sun_rise_set(&tromso, 2026, 6, 21).status,
        RiseSetStatus::Circumpolar
    );
    assert_eq!(
        sun_rise_set(&tromso, 2026, 12, 21).status,
        RiseSetStatus::NeverRises
    );

    assert_eq!(
        sun_rise_set(&syowa, 2026, 6, 21).status,
        RiseSetStatus::NeverRises
    );
    assert_eq!(
        sun_rise_set(&syowa, 2026, 12, 21).status,
        RiseSetStatus::Circumpolar
    );
}

#[test]
fn binary_ipc_buffers_pack_all_stars_and_dsos() {
    let assets_dir = resolve_assets_dir(None).expect("assets dir");
    let store = CatalogStore::load_from_dir(&assets_dir).expect("catalog load");

    let star_bytes = build_sky_star_bytes(&store);
    assert_eq!(star_bytes.len(), store.stars.stars.len() * 20);
    assert!(store.stars.stars.len() >= 100_000);

    let dso_bytes = build_sky_dso_bytes(&store);
    assert_eq!(dso_bytes.len(), store.dsos.len() * 28);
    assert!(store.dsos.len() >= 10_000);

    // Check first packed DSO entry is M1 (Messier 1) and unit vector norm == 1.0
    let read_f32 = |offset: usize| -> f32 {
        f32::from_le_bytes(dso_bytes[offset..offset + 4].try_into().unwrap())
    };
    let x = read_f32(0);
    let y = read_f32(4);
    let z = read_f32(8);
    let norm = (x * x + y * y + z * z).sqrt();
    assert!((norm - 1.0).abs() < 1e-4, "DSO unit vector norm={norm}");
    assert_eq!(read_f32(24), 1.0, "Messier 1 must be packed first");
}
