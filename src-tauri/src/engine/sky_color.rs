//! Physically-inspired twilight, moonlight, and light-pollution sky colors (Phase 2).

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub const fn new(r: u8, g: u8, b: u8) -> Self {
        Self { r, g, b }
    }

    pub fn to_hex(self) -> String {
        format!("#{:02x}{:02x}{:02x}", self.r, self.g, self.b)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SkyColorInput {
    pub sun_alt_deg: f64,
    pub sun_az_deg: f64,
    pub moon_alt_deg: f64,
    pub moon_az_deg: f64,
    pub moon_illuminated_fraction: f64,
    pub limiting_mag: f64,
    pub realism_level: u8,
    pub night_vision: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SkyPalette {
    pub zenith: Rgb,
    pub mid_sky: Rgb,
    pub horizon: Rgb,
    pub sun_glow: Rgb,
    pub sun_glow_strength: f64,
    pub anti_solar_glow: Rgb,
    pub anti_solar_strength: f64,
    pub moonlight_glow: Rgb,
    pub moonlight_strength: f64,
    pub light_pollution: Rgb,
    pub light_pollution_strength: f64,
    pub ground: Rgb,
    pub horizon_line: Rgb,
    pub star_visibility_factor: f64,
    pub estimated_bortle: u8,
}

#[inline]
fn clamp01(v: f64) -> f64 {
    v.clamp(0.0, 1.0)
}

#[inline]
fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
    if (edge1 - edge0).abs() < 1e-12 {
        return if x >= edge1 { 1.0 } else { 0.0 };
    }
    let t = clamp01((x - edge0) / (edge1 - edge0));
    t * t * (3.0 - 2.0 * t)
}

#[inline]
fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * clamp01(t)
}

#[inline]
fn lerp_rgb(a: Rgb, b: Rgb, t: f64) -> Rgb {
    let u = clamp01(t);
    Rgb {
        r: (f64::from(a.r) + (f64::from(b.r) - f64::from(a.r)) * u)
            .round()
            .clamp(0.0, 255.0) as u8,
        g: (f64::from(a.g) + (f64::from(b.g) - f64::from(a.g)) * u)
            .round()
            .clamp(0.0, 255.0) as u8,
        b: (f64::from(a.b) + (f64::from(b.b) - f64::from(a.b)) * u)
            .round()
            .clamp(0.0, 255.0) as u8,
    }
}

#[inline]
fn estimate_bortle(limiting_mag: f64) -> u8 {
    if limiting_mag >= 7.1 {
        1
    } else if limiting_mag >= 6.6 {
        2
    } else if limiting_mag >= 6.1 {
        3
    } else if limiting_mag >= 5.6 {
        4
    } else if limiting_mag >= 5.1 {
        5
    } else if limiting_mag >= 4.6 {
        6
    } else if limiting_mag >= 4.0 {
        7
    } else if limiting_mag >= 3.3 {
        8
    } else {
        9
    }
}

#[inline]
fn to_night_vision_red(c: Rgb) -> Rgb {
    let luma = 0.299 * f64::from(c.r) + 0.587 * f64::from(c.g) + 0.114 * f64::from(c.b);
    let r = (luma * 0.85).round().clamp(0.0, 210.0) as u8;
    Rgb::new(r, 0, 0)
}

fn apply_night_vision(mut p: SkyPalette) -> SkyPalette {
    p.zenith = to_night_vision_red(p.zenith);
    p.mid_sky = to_night_vision_red(p.mid_sky);
    p.horizon = to_night_vision_red(p.horizon);
    p.sun_glow = to_night_vision_red(p.sun_glow);
    p.anti_solar_glow = to_night_vision_red(p.anti_solar_glow);
    p.moonlight_glow = to_night_vision_red(p.moonlight_glow);
    p.light_pollution = to_night_vision_red(p.light_pollution);
    p.ground = to_night_vision_red(p.ground);
    p.horizon_line = to_night_vision_red(p.horizon_line);
    p
}

/// Sample continuous solar atmospheric backdrop colors at solar altitude `sun_alt_deg`
/// for dark-adapted / rural air (`limiting_mag ≈ 6.5`).
fn base_solar_sky(sun_alt_deg: f64) -> (Rgb, Rgb, Rgb, Rgb, Rgb) {
    // Keyframes ordered from deep night (-24°) up to high noon (+65°):
    // (alt, zenith, mid_sky, horizon, ground, horizon_line)
    const STOPS: [(f64, Rgb, Rgb, Rgb, Rgb, Rgb); 7] = [
        (
            -20.0,
            Rgb::new(3, 6, 15),
            Rgb::new(5, 11, 24),
            Rgb::new(10, 18, 36),
            Rgb::new(3, 5, 11),
            Rgb::new(28, 42, 68),
        ),
        (
            -12.0,
            Rgb::new(5, 12, 30),
            Rgb::new(11, 24, 54),
            Rgb::new(24, 44, 82),
            Rgb::new(4, 7, 14),
            Rgb::new(42, 64, 98),
        ),
        (
            -6.0,
            Rgb::new(10, 28, 72),
            Rgb::new(22, 54, 110),
            Rgb::new(62, 74, 114),
            Rgb::new(7, 11, 18),
            Rgb::new(92, 96, 126),
        ),
        (
            -1.0,
            Rgb::new(16, 48, 118),
            Rgb::new(40, 88, 158),
            Rgb::new(152, 112, 98),
            Rgb::new(12, 16, 22),
            Rgb::new(168, 128, 108),
        ),
        (
            5.0,
            Rgb::new(20, 72, 158),
            Rgb::new(50, 118, 198),
            Rgb::new(164, 186, 210),
            Rgb::new(19, 26, 20),
            Rgb::new(146, 174, 198),
        ),
        (
            18.0,
            Rgb::new(26, 92, 186),
            Rgb::new(62, 134, 218),
            Rgb::new(152, 196, 234),
            Rgb::new(25, 36, 25),
            Rgb::new(132, 178, 214),
        ),
        (
            60.0,
            Rgb::new(31, 98, 199),
            Rgb::new(69, 147, 227),
            Rgb::new(170, 208, 240),
            Rgb::new(30, 44, 29),
            Rgb::new(148, 192, 224),
        ),
    ];

    if sun_alt_deg <= STOPS[0].0 {
        let s = STOPS[0];
        return (s.1, s.2, s.3, s.4, s.5);
    }
    for w in STOPS.windows(2) {
        let a = w[0];
        let b = w[1];
        if sun_alt_deg <= b.0 {
            let t = smoothstep(a.0, b.0, sun_alt_deg);
            return (
                lerp_rgb(a.1, b.1, t),
                lerp_rgb(a.2, b.2, t),
                lerp_rgb(a.3, b.3, t),
                lerp_rgb(a.4, b.4, t),
                lerp_rgb(a.5, b.5, t),
            );
        }
    }
    let last = STOPS[STOPS.len() - 1];
    (last.1, last.2, last.3, last.4, last.5)
}

/// Compute physically-inspired sky background palette from solar, lunar, and light-pollution inputs.
pub fn compute_sky_palette(input: &SkyColorInput) -> SkyPalette {
    let estimated_bortle = estimate_bortle(input.limiting_mag);

    if input.realism_level == 0 {
        let dark = SkyPalette {
            zenith: Rgb::new(4, 7, 17),
            mid_sky: Rgb::new(4, 7, 17),
            horizon: Rgb::new(7, 12, 26),
            sun_glow: Rgb::new(0, 0, 0),
            sun_glow_strength: 0.0,
            anti_solar_glow: Rgb::new(0, 0, 0),
            anti_solar_strength: 0.0,
            moonlight_glow: Rgb::new(0, 0, 0),
            moonlight_strength: 0.0,
            light_pollution: Rgb::new(0, 0, 0),
            light_pollution_strength: 0.0,
            ground: Rgb::new(2, 4, 10),
            horizon_line: Rgb::new(30, 41, 59),
            star_visibility_factor: 1.0,
            estimated_bortle,
        };
        return if input.night_vision {
            apply_night_vision(dark)
        } else {
            dark
        };
    }

    let realism_scale: f64 = match input.realism_level {
        1 => 0.55,
        2 => 1.0,
        _ => 1.22,
    };

    let (mut zenith, mut mid_sky, mut horizon, ground, horizon_line) =
        base_solar_sky(input.sun_alt_deg);

    if input.realism_level == 1 {
        let chart_zen = Rgb::new(4, 7, 17);
        let chart_hor = Rgb::new(8, 14, 30);
        zenith = lerp_rgb(chart_zen, zenith, 0.60);
        mid_sky = lerp_rgb(chart_zen, mid_sky, 0.62);
        horizon = lerp_rgb(chart_hor, horizon, 0.65);
    }

    // Night factor: suppresses moonlight wash during daytime
    let night_factor = 1.0 - smoothstep(-8.0, 6.0, input.sun_alt_deg);

    // Moonlight sky veil & halo
    let moon_illum = clamp01(input.moon_illuminated_fraction).powf(1.55);
    let moon_alt_t = smoothstep(-4.0, 28.0, input.moon_alt_deg);
    let moonlight_strength = clamp01(moon_illum * moon_alt_t * night_factor * realism_scale);
    if moonlight_strength > 0.001 {
        let moon_wash = Rgb::new(22, 34, 62);
        zenith = lerp_rgb(zenith, moon_wash, moonlight_strength * 0.35);
        mid_sky = lerp_rgb(mid_sky, moon_wash, moonlight_strength * 0.45);
        horizon = lerp_rgb(horizon, Rgb::new(34, 48, 78), moonlight_strength * 0.38);
    }

    // Sunrise/sunset directional solar glow (-16°..+14°) & anti-solar Belt of Venus (-8°..+4°)
    let twilight_up = smoothstep(-16.0, -1.5, input.sun_alt_deg);
    let twilight_dn = 1.0 - smoothstep(1.0, 16.0, input.sun_alt_deg);
    let sun_glow_strength = clamp01((twilight_up * twilight_dn) * realism_scale);
    let sun_glow = if input.sun_alt_deg < -4.0 {
        lerp_rgb(Rgb::new(148, 56, 38), Rgb::new(245, 118, 48), smoothstep(-14.0, -4.0, input.sun_alt_deg))
    } else {
        lerp_rgb(Rgb::new(245, 118, 48), Rgb::new(255, 204, 128), smoothstep(-4.0, 8.0, input.sun_alt_deg))
    };

    let venus_up = smoothstep(-9.0, -2.2, input.sun_alt_deg);
    let venus_dn = 1.0 - smoothstep(-1.0, 5.0, input.sun_alt_deg);
    let anti_solar_strength = clamp01((venus_up * venus_dn) * 0.65 * realism_scale);
    let anti_solar_glow = Rgb::new(186, 102, 134);

    // Overall star visibility attenuation in daylight / bright twilight / bright moonlight
    let daylight_fade = smoothstep(-10.0, 5.0, input.sun_alt_deg);
    let moon_fade = 0.16 * moonlight_strength;
    let raw_vis = (1.0 - 0.98 * daylight_fade) * (1.0 - moon_fade);
    let star_visibility_factor = clamp01(lerp(1.0, raw_vis, (realism_scale * 0.85).min(1.0)));

    let palette = SkyPalette {
        zenith,
        mid_sky,
        horizon,
        sun_glow,
        sun_glow_strength,
        anti_solar_glow,
        anti_solar_strength,
        moonlight_glow: Rgb::new(142, 174, 224),
        moonlight_strength,
        light_pollution: Rgb::new(0, 0, 0),
        light_pollution_strength: 0.0,
        ground,
        horizon_line,
        star_visibility_factor,
        estimated_bortle,
    };

    if input.night_vision {
        apply_night_vision(palette)
    } else {
        palette
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn luma(c: Rgb) -> f64 {
        0.299 * f64::from(c.r) + 0.587 * f64::from(c.g) + 0.114 * f64::from(c.b)
    }

    #[test]
    fn daytime_is_blue_and_attenuates_faint_stars() {
        let day = compute_sky_palette(&SkyColorInput {
            sun_alt_deg: 45.0,
            sun_az_deg: 180.0,
            moon_alt_deg: -30.0,
            moon_az_deg: 0.0,
            moon_illuminated_fraction: 0.2,
            limiting_mag: 6.5,
            realism_level: 2,
            night_vision: false,
        });
        assert!(day.zenith.b > day.zenith.r + 100);
        assert!(day.mid_sky.b > day.mid_sky.r);
        assert!(day.star_visibility_factor < 0.2);
    }

    #[test]
    fn sunset_produces_warm_glow_near_horizon() {
        let sunset = compute_sky_palette(&SkyColorInput {
            sun_alt_deg: -2.0,
            sun_az_deg: 270.0,
            moon_alt_deg: -40.0,
            moon_az_deg: 90.0,
            moon_illuminated_fraction: 0.0,
            limiting_mag: 6.5,
            realism_level: 2,
            night_vision: false,
        });
        assert!(sunset.sun_glow_strength > 0.5);
        assert!(sunset.sun_glow.r > sunset.sun_glow.b);
        assert!(sunset.anti_solar_strength > 0.2);
    }

    #[test]
    fn limiting_mag_does_not_tint_sky_and_moonlight_brightens_night() {
        let dark_low_mag = compute_sky_palette(&SkyColorInput {
            sun_alt_deg: -35.0,
            sun_az_deg: 0.0,
            moon_alt_deg: -25.0,
            moon_az_deg: 0.0,
            moon_illuminated_fraction: 0.0,
            limiting_mag: 2.0,
            realism_level: 2,
            night_vision: false,
        });
        let dark_mid_mag = compute_sky_palette(&SkyColorInput {
            sun_alt_deg: -35.0,
            sun_az_deg: 0.0,
            moon_alt_deg: -25.0,
            moon_az_deg: 0.0,
            moon_illuminated_fraction: 0.0,
            limiting_mag: 6.8,
            realism_level: 2,
            night_vision: false,
        });
        let dark_high_mag = compute_sky_palette(&SkyColorInput {
            sun_alt_deg: -35.0,
            sun_az_deg: 0.0,
            moon_alt_deg: -25.0,
            moon_az_deg: 0.0,
            moon_illuminated_fraction: 0.0,
            limiting_mag: 10.5,
            realism_level: 2,
            night_vision: false,
        });
        let full_moon_night = compute_sky_palette(&SkyColorInput {
            sun_alt_deg: -35.0,
            sun_az_deg: 0.0,
            moon_alt_deg: 40.0,
            moon_az_deg: 180.0,
            moon_illuminated_fraction: 1.0,
            limiting_mag: 6.8,
            realism_level: 2,
            night_vision: false,
        });

        assert_eq!(dark_low_mag.zenith, dark_mid_mag.zenith);
        assert_eq!(dark_low_mag.mid_sky, dark_mid_mag.mid_sky);
        assert_eq!(dark_low_mag.horizon, dark_mid_mag.horizon);
        assert_eq!(dark_low_mag.ground, dark_mid_mag.ground);
        assert_eq!(dark_low_mag.horizon_line, dark_mid_mag.horizon_line);
        assert_eq!(dark_mid_mag.zenith, dark_high_mag.zenith);
        assert_eq!(dark_mid_mag.horizon, dark_high_mag.horizon);
        assert_eq!(dark_low_mag.light_pollution_strength, 0.0);
        assert!(full_moon_night.moonlight_strength > 0.6);
        assert!(luma(full_moon_night.mid_sky) > luma(dark_mid_mag.mid_sky));
    }

    #[test]
    fn night_vision_emits_zero_green_or_blue() {
        let p = compute_sky_palette(&SkyColorInput {
            sun_alt_deg: 30.0,
            sun_az_deg: 160.0,
            moon_alt_deg: 20.0,
            moon_az_deg: 200.0,
            moon_illuminated_fraction: 0.9,
            limiting_mag: 4.0,
            realism_level: 3,
            night_vision: true,
        });
        for c in [
            p.zenith,
            p.mid_sky,
            p.horizon,
            p.sun_glow,
            p.anti_solar_glow,
            p.moonlight_glow,
            p.light_pollution,
            p.ground,
            p.horizon_line,
        ] {
            assert_eq!(c.g, 0);
            assert_eq!(c.b, 0);
        }
    }
}
