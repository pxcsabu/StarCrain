# StarCrane — License & Open Data / Third-Party Attributions

Copyright (c) 2026 StarCrane Developers.
Licensed under the MIT License (application code).

---

## 1. Open Astronomical Data Sources

StarCrane bundles offline astronomical catalogs derived from the following primary public datasets and scientific sources:

1. **HYG Database v4.1** (Star Catalog)
   - Source: https://github.com/astronexus/HYG-Database
   - License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)
   - Contents: ~120,000 stars (Hipparcos, Yale Bright Star, Gliese) with J2000 coordinates, magnitudes, B-V color indices, proper motions, and radial distances.

2. **OpenNGC & Messier Catalog** (Deep Sky Objects)
   - Source: https://github.com/mattiaverga/OpenNGC
   - License: Creative Commons Attribution-ShareAlike 4.0 International (CC BY-SA 4.0)
   - Contents: All 110 Messier objects and ~13,000 NGC/IC galaxies, nebulae, and clusters.

3. **d3-celestial** (Constellation Lines, IAU Boundaries, Milky Way Polygons, Asterisms)
   - Source: https://github.com/ofrohn/d3-celestial
   - License: BSD 3-Clause License
   - Contents: 88 constellation line figures, IAU constellation boundaries, multi-level Milky Way polygons, and traditional asterisms.

4. **IAU Meteor Data Center (MDC)**
   - Reference meteor shower radiant, drift, velocity, and solar longitude parameters.

5. **General Catalogue of Variable Stars (GCVS)**
   - Reference parameters for bright variable stars.

6. **Solar System Scope Textures**
   - Source: https://www.solarsystemscope.com/textures/
   - License: Creative Commons Attribution 4.0 International (CC BY 4.0)
   - Contents: 2K planetary surface, Moon, Sun, and ring textures bundled under `public/textures/planets/`.

7. **NASA / ESA / ESO / NOIRLab Public Imagery**
   - License: Public Domain / Creative Commons Attribution 4.0 International (CC BY 4.0)
   - Contents: Deep-sky and planetary photography bundled under `public/photos/`.

8. **Japan & World Map Coastline Data**
   - **dataofjapan/land** (`https://github.com/dataofjapan/land`) — MIT License (47 Japanese prefectures GeoJSON).
   - **Natural Earth 110m Land** (`https://www.naturalearthdata.com/`) — Public Domain (world continent coastline vectors).

---

## 2. Whitelisted Optional Online Data Services

When Online Sync is explicitly enabled by the user (disabled when `offlineMode` is active), StarCrane restricts HTTPS traffic solely to these three official endpoints:

- **IAU Minor Planet Center (`https://minorplanetcenter.net/`)**: `Soft00Cmt.txt` comet orbital elements.
- **CelesTrak (`https://celestrak.org/`)**: Active satellite and space station TLE groups (`stations`, `visual`, `weather`).
- **Open-Meteo (`https://api.open-meteo.com/`)**: Weather & cloud-cover forecast data (CC BY 4.0).

---

## 3. Core Open-Source Libraries & Frameworks

### Rust Backend
- `tauri` / `tauri-plugin-dialog` / `tauri-plugin-fs` / `tauri-plugin-updater` / `tauri-plugin-process` (Apache-2.0 / MIT)
- `vsop87` (MIT / Apache-2.0) — Planetary ephemeris calculations
- `sgp4` (MIT / Apache-2.0) — Two-Line Element orbital propagation
- `rusqlite` with bundled SQLite (MIT / Public Domain)
- `reqwest` with `rustls` (Apache-2.0 / MIT)
- `chrono`, `rayon`, `serde`, `serde_json`, `thiserror` (Apache-2.0 / MIT)

### Frontend & UI
- `react`, `react-dom`, `typescript`, `vite` (MIT)
- `three`, `@types/three` (MIT)
- `zustand`, `tailwindcss`, `lucide-react`, `radix-ui`, `clsx`, `tailwind-merge`, `class-variance-authority` (MIT / ISC / Apache-2.0)
