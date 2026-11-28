pub mod commands;
pub mod engine;

use tauri::Manager;

use crate::engine::catalog::{CatalogStore, resolve_assets_dir};
use crate::engine::comet_db::CometDb;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
                app.handle().plugin(tauri_plugin_process::init())?;
            }
            let resource_dir = app.path().resource_dir().ok();
            let store = match resolve_assets_dir(resource_dir.as_deref()) {
                Ok(assets_dir) => CatalogStore::load_from_dir(&assets_dir),
                Err(_) => CatalogStore::load_embedded(),
            }
            .map_err(Box::<dyn std::error::Error>::from)?;
            let status = store.status();
            println!(
                "[StarCrane] Loaded all catalogs in {:.2} ms (stars={}, dsos={}, messier={}, constellations={}, locations={})",
                status.total_load_ms,
                status.star_count,
                status.dso_count,
                status.messier_count,
                status.constellation_count,
                status.location_count
            );
            app.manage(store);

            let comet_db = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("{e}"))
                .and_then(|dir| CometDb::open_file(&dir.join("starcrane.db")))
                .unwrap_or_else(|err| {
                    eprintln!("[StarCrane] Falling back to in-memory CometDb: {err}");
                    CometDb::open_in_memory().expect("in-memory CometDb")
                });
            app.manage(comet_db);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::sky::get_catalog_status,
            commands::sky::get_sky_star_buffer,
            commands::sky::get_sky_dso_buffer,
            commands::sky::get_proper_motion_star_buffer,
            commands::sky::get_reprojected_star_buffer,
            commands::sky::get_sky_static_assets,
            commands::sky::compute_sky_frame,
            commands::sky::pick_sky_object,
            commands::sky::resolve_sky_object_by_index,
            commands::sky::get_day_special_times,
            commands::sky::get_object_details,
            commands::sky::search_sky_objects,
            commands::sky::find_nearby_objects,
            commands::calendar::get_observation_dashboard,
            commands::calendar::get_moon_calendar,
            commands::events::get_meteor_showers_for_year,
            commands::events::search_solar_eclipses_cmd,
            commands::events::search_lunar_eclipses_cmd,
            commands::events::search_planetary_transits_cmd,
            commands::events::search_lunar_occultations_cmd,
            commands::planets::get_planets_overview,
            commands::planets::get_planet_appearance,
            commands::planets::get_planet_track,
            commands::planets::get_inner_planet_sun_offset,
            commands::planets::get_magnitude_curve,
            commands::planets::search_planet_phenomena_cmd,
            commands::planets::search_conjunctions_cmd,
            commands::planets::get_galilean_moons_view,
            commands::planets::get_saturn_moons_view,
            commands::planets::get_solar_system_3d_state,
            commands::tools::list_comets_cmd,
            commands::tools::upsert_comet_cmd,
            commands::tools::set_comet_enabled_cmd,
            commands::tools::delete_comet_cmd,
            commands::tools::import_comets_json_cmd,
            commands::tools::export_comets_json_cmd,
            commands::tools::reset_default_comets_cmd,
            commands::tools::calc_julian_day_cmd,
            commands::tools::calc_sidereal_ha_cmd,
            commands::tools::calc_elapsed_time_cmd,
            commands::tools::calc_angular_distance_cmd,
            commands::tools::calc_altitude_times_cmd,
            commands::tools::calc_epoch_convert_cmd,
            commands::tools::list_satellites_positions_cmd,
            commands::tools::predict_satellite_passes_cmd,
            commands::tools::import_tle_text_cmd,
            commands::tools::set_satellite_enabled_cmd,
            commands::tools::delete_satellite_cmd,
            commands::tools::reset_default_satellites_cmd,
            commands::tools::get_iss_earth_view_cmd,
            commands::tools::get_tonight_best_objects_cmd,
            commands::tools::list_observation_logs_cmd,
            commands::tools::upsert_observation_log_cmd,
            commands::tools::delete_observation_log_cmd,
            commands::tools::get_polar_alignment_cmd,
            commands::online::sync_mpc_comets_cmd,
            commands::online::sync_celestrak_tle_cmd,
            commands::online::fetch_open_meteo_weather_cmd,
            commands::online::fetch_space_weather_cmd,
            commands::offline_cache::fetch_cached_survey_tile_cmd,
            commands::offline_cache::fetch_cached_object_photo_cmd,
            commands::offline_cache::prefetch_hips_tiles_cmd,
            commands::offline_cache::get_offline_cache_stats_cmd,
            commands::offline_cache::clear_offline_cache_cmd,
            commands::offline_cache::save_offline_snapshot_cmd,
            commands::offline_cache::list_offline_snapshots_cmd,
            commands::offline_cache::load_offline_snapshot_cmd,
            commands::offline_cache::delete_offline_snapshot_cmd,
            commands::updater::check_android_update_cmd,
            commands::updater::download_android_update_apk_cmd
        ])
        .run(tauri::generate_context!())
        .expect("error while running StarCrane Tauri application");
}
