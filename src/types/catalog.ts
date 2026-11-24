export interface CatalogLoadBreakdown {
  stars_ms: number;
  dso_ms: number;
  constellations_ms: number;
  milky_way_ms: number;
  locations_ms: number;
  meteors_ms: number;
  variables_ms: number;
  mythology_ms: number;
  star_guides_ms: number;
}

export interface CatalogStatus {
  total_load_ms: number;
  within_budget_100ms: boolean;
  star_count: number;
  dso_count: number;
  messier_count: number;
  constellation_count: number;
  asterism_count: number;
  milky_way_levels: number;
  location_count: number;
  meteor_shower_count: number;
  variable_star_count: number;
  constellation_myth_count: number;
  star_guide_count: number;
  default_location_name: string;
  assets_root: string;
  breakdown: CatalogLoadBreakdown;
}
