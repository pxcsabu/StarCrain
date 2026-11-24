import { invoke, isTauri } from "@tauri-apps/api/core";
import { Calendar, Compass, Eye, MapPin, Search, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSkyStore } from "@/store/skyStore";
import { useThemeStore } from "@/store/themeStore";
import { PROJECTION_META, type SearchResultItem } from "@/types/sky";

interface PaletteItem {
  key: string;
  title: string;
  subtitle: string;
  badge: string;
  run: () => void;
}

function parseDateTimeCommand(raw: string): [number, number, number, number, number, number] | null {
  const m = raw
    .trim()
    .match(/^(-?\d{1,5})[-/](\d{1,2})[-/](\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = m[4] ? Number(m[4]) : 21;
  const mi = m[5] ? Number(m[5]) : 0;
  const s = m[6] ? Number(m[6]) : 0;
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  return [y, mo, d, h, mi, s];
}

export function CommandPalette() {
  const open = useSkyStore((s) => s.commandPaletteOpen);
  const setOpen = useSkyStore((s) => s.setCommandPaletteOpen);
  const jdUt = useSkyStore((s) => s.jdUt);
  const location = useSkyStore((s) => s.location);
  const refractionEnabled = useSkyStore((s) => s.refractionEnabled);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResultItem[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 10);
    }
  }, [open]);

  useEffect(() => {
    if (!open || !isTauri()) {
      setResults([]);
      return;
    }
    const q = query.trim();
    const timer = setTimeout(async () => {
      try {
        const res = await invoke<SearchResultItem[]>("search_sky_objects", {
          req: {
            query: q,
            category: "all",
            mag_max: null,
            ra_min_h: null,
            ra_max_h: null,
            only_variables: false,
            jd_ut: jdUt,
            lat_deg: location.lat_deg,
            lon_deg: location.lon_deg,
            refraction: refractionEnabled,
            limit: 12,
          },
        });
        setResults(res);
      } catch {
        setResults([]);
      }
    }, 60);
    return () => clearTimeout(timer);
  }, [open, query, jdUt, location, refractionEnabled]);

  const items = useMemo<PaletteItem[]>(() => {
    const q = query.trim();
    const ql = q.toLowerCase();
    const st = useSkyStore.getState();
    const out: PaletteItem[] = [];

    const parsedDt = parseDateTimeCommand(q);
    if (parsedDt) {
      const [y, mo, d, hh, mm, ss] = parsedDt;
      out.push({
        key: "jump-dt",
        title: `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")} へ時刻設定`,
        subtitle: "指定日時へジャンプ",
        badge: "日時",
        run: () => {
          st.jumpToYmdHms(y, mo, d, hh, mm, ss);
          setOpen(false);
        },
      });
    }

    for (const r of results) {
      out.push({
        key: `obj-${r.kind}-${r.id}-${r.name_en}`,
        title: r.name_ja,
        subtitle: `${r.obj_type}${r.mag != null ? ` · ${r.mag.toFixed(1)}等` : ""} · 高度 ${r.alt_deg.toFixed(1)}° (${r.extra})`,
        badge: r.id,
        run: () => {
          if (r.kind === "constellation") {
            st.centerOnSkyCoords(r.ra_deg, r.dec_deg, r.az_deg, r.alt_deg);
          } else {
            st.selectObject(
              {
                kind: r.kind,
                id: r.id,
                name_ja: r.name_ja,
                name_en: r.name_en,
                constellation: r.constellation,
                mag: r.mag,
                ra_deg: r.ra_deg,
                dec_deg: r.dec_deg,
                az_deg: r.az_deg,
                alt_deg: r.alt_deg,
                dist_text: r.extra,
                angular_sep_deg: 0,
                extra_info: r.obj_type,
              },
              true,
            );
          }
          setOpen(false);
        },
      });
    }

    const actions: PaletteItem[] = [
      {
        key: "act-obs",
        title: "当日の観測データダッシュボード",
        subtitle: "日の出/入・薄明・月齢・旧暦・今夜の惑星",
        badge: "パネル",
        run: () => {
          st.setActivePanel("observation");
          setOpen(false);
        },
      },
      {
        key: "act-moon-cal",
        title: "月齢カレンダーを開く",
        subtitle: "月ごとの満ち欠け・旧暦・六曜・祝日",
        badge: "パネル",
        run: () => {
          st.setActivePanel("moon_calendar");
          setOpen(false);
        },
      },
      {
        key: "act-meteors",
        title: "流星群ガイド & 出現アニメを開く",
        subtitle: "年間主要21+流星群・極大月齢条件・放射点",
        badge: "パネル",
        run: () => {
          st.setActivePanel("meteors");
          setOpen(false);
        },
      },
      {
        key: "act-planets",
        title: "惑星解析ツール群 & ガリレオ衛星",
        subtitle: "衝合/接近検索・形状・経路・光度曲線・大赤斑正中",
        badge: "パネル",
        run: () => {
          st.setActivePanel("planets");
          setOpen(false);
        },
      },
      {
        key: "act-solar3d",
        title: "3D太陽系シミュレーターを開く",
        subtitle: "Three.js 全惑星・準惑星・彗星の3D軌道＆星図同期",
        badge: "3D",
        run: () => {
          st.setActivePanel("solar3d");
          setOpen(false);
        },
      },
      {
        key: "act-eclipses",
        title: "食現象検索 (日食・月食・日面通過・星食)",
        subtitle: "2026〜2035年 日食・月食・水星日面通過・星食シミュレーション",
        badge: "現象",
        run: () => {
          st.setActivePanel("eclipses");
          setOpen(false);
        },
      },
      {
        key: "act-comets",
        title: "彗星・人工衛星 / ISS 追跡 (SQLite & SGP4)",
        subtitle: "MPC彗星同期・CelesTrak TLE同期・パス予報・光度曲線即時反映",
        badge: "パネル",
        run: () => {
          st.setActivePanel("comets");
          setOpen(false);
        },
      },
      {
        key: "act-fov",
        title: "視野角 (FOV) オーバーレイを開く",
        subtitle: "カメラセンサー・望遠鏡アイピース・双眼鏡・テルラドサークル＆回転角",
        badge: "パネル",
        run: () => {
          st.setActivePanel("fov");
          setOpen(false);
        },
      },
      {
        key: "act-print",
        title: "星図印刷 & PNG/SVG/PDF出力を開く",
        subtitle: "A4/B5レイアウト・白地黒星/グレースケール・高解像度PNG/SVG/PDF",
        badge: "出力",
        run: () => {
          st.setActivePanel("print");
          setOpen(false);
        },
      },
      {
        key: "act-altitude-graph",
        title: "今夜の高度グラフ・観測プランナーを開く",
        subtitle: "複数天体の夜間高度曲線・薄明帯・月高度・南中時刻を比較",
        badge: "パネル",
        run: () => {
          st.setActivePanel("altitude_graph");
          setOpen(false);
        },
      },
      {
        key: "act-toggle-meteors",
        title: "ライブ流れ星エフェクト ON / OFF",
        subtitle: "季節流星群ZHR＆散在流星＋火球流星痕アニメーション切替",
        badge: "演出",
        run: () => {
          st.setMeteorAnimationEnabled(!st.meteorAnimationEnabled);
          setOpen(false);
        },
      },
      {
        key: "act-toggle-zoom-tex",
        title: "拡大天体テクスチャ（星雲・銀河・月面・惑星）ON / OFF",
        subtitle: "ズームイン時にM31/M42/M45・月の海・土星の環・木星縞を表示",
        badge: "演出",
        run: () => {
          st.toggleLayer("zoomTextures");
          setOpen(false);
        },
      },
      {
        key: "act-settings",
        title: "環境設定・セキュリティ・ライセンスを開く",
        subtitle: "起動動作・音・初期観測地・単位系・プロファイル保存/復元・オープンデータライセンス",
        badge: "設定",
        run: () => {
          st.setActivePanel("settings");
          setOpen(false);
        },
      },
      {
        key: "act-variables",
        title: "変光星検索・GCVSガイドを開く",
        subtitle: "星座・星名・極大光度での絞込＆プラネタリウムジャンプ",
        badge: "パネル",
        run: () => {
          st.setActivePanel("variables");
          setOpen(false);
        },
      },
      {
        key: "act-encyclopedia",
        title: "星座の解説と神話・恒星図鑑を開く",
        subtitle: "全88星座の解説・見つけ方・神話・主要恒星解説＆連動",
        badge: "図鑑",
        run: () => {
          st.setActivePanel("encyclopedia");
          setOpen(false);
        },
      },
      {
        key: "act-calculator",
        title: "天文計算機 (全9機能) を開く",
        subtitle: "JD/MJD・恒星時/時角・経過日数・角距離・指定高度時刻・B1950↔J2000",
        badge: "計算",
        run: () => {
          st.setActivePanel("calculator");
          setOpen(false);
        },
      },
      {
        key: "act-clock",
        title: "時計・時報＆観測タイマーを開く",
        subtitle: "秒針アナログ時計・地方恒星時・時報・露出タイマー・アラーム",
        badge: "時計",
        run: () => {
          st.setActivePanel("clock");
          setOpen(false);
        },
      },
      {
        key: "act-now",
        title: "現在時刻へ戻す (今)",
        subtitle: "システムの現在時刻に同期",
        badge: "日時",
        run: () => {
          st.setNow();
          setOpen(false);
        },
      },
      {
        key: "act-nv",
        title: "ナイトビジョン（赤色暗順応モード）切替",
        subtitle: "暗順応保護の深紅テーマ",
        badge: "テーマ",
        run: () => {
          const cur = useThemeStore.getState().theme;
          const next = cur === "night-vision" ? "dark" : "night-vision";
          useThemeStore.getState().setTheme(next);
          void st.refreshFrame(next === "night-vision");
          setOpen(false);
        },
      },
      {
        key: "act-prec",
        title: "過去・未来モード（歳差＋極軸図示）",
        subtitle: "±1万5千年の北極星移動を再現",
        badge: "モード",
        run: () => {
          st.setViewMode("precession");
          setOpen(false);
        },
      },
      {
        key: "act-mars",
        title: "別の惑星モード：火星の空を見る",
        subtitle: "火星表面から地球や空を眺める",
        badge: "惑星視点",
        run: () => {
          st.setObserverBody("Mars");
          setOpen(false);
        },
      },
      {
        key: "act-acen",
        title: "別の恒星モード：ケンタウルス座α星から見る",
        subtitle: "3D視差移動・カシオペヤ座の太陽",
        badge: "恒星視点",
        run: () => {
          st.setOriginStarHip(71683);
          setOpen(false);
        },
      },
      ...PROJECTION_META.map((m) => ({
        key: `proj-${m.mode}`,
        title: `図法：${m.labelJa}`,
        subtitle: m.descriptionJa,
        badge: "図法",
        run: () => {
          st.setProjectionMode(m.mode);
          setOpen(false);
        },
      })),
    ];

    for (const act of actions) {
      if (!ql || act.title.toLowerCase().includes(ql) || act.subtitle.toLowerCase().includes(ql) || act.badge.toLowerCase().includes(ql)) {
        out.push(act);
      }
    }

    return out.slice(0, 18);
  }, [query, results, setOpen]);

  useEffect(() => {
    setActiveIndex(0);
  }, [items.length]);

  if (!open) return null;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i + 1) % items.length : 0));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (items.length ? (i - 1 + items.length) % items.length : 0));
    } else if (e.key === "Enter" && items[activeIndex]) {
      e.preventDefault();
      items[activeIndex].run();
    } else if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/45 px-3 pt-16 backdrop-blur-sm sm:pt-20"
      onClick={() => setOpen(false)}
    >
      <div
        className="liquid-glass-sheet w-full max-w-xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-[var(--glass-border)] px-4 py-3">
          <Search className="h-4 w-4 text-[var(--accent-primary)]" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="天体・星座・日時・機能を検索"
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] outline-none"
          />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded p-1 text-[var(--text-secondary)] hover:bg-[var(--bg-surface-elevated)]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-96 overflow-y-auto p-2">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-[var(--text-secondary)]">
              一致する天体・コマンドが見つかりません
            </div>
          ) : (
            items.map((item, idx) => (
              <button
                key={item.key}
                type="button"
                onClick={item.run}
                onMouseEnter={() => setActiveIndex(idx)}
                className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                  idx === activeIndex
                    ? "bg-[var(--accent-primary)]/15 text-[var(--text-primary)]"
                    : "text-[var(--text-primary)] hover:bg-[var(--bg-surface-elevated)]"
                }`}
              >
                <div className="flex items-center gap-2.5 overflow-hidden">
                  {item.badge === "日時" ? (
                    <Calendar className="h-4 w-4 shrink-0 text-[var(--accent-secondary)]" />
                  ) : item.badge === "図法" ? (
                    <Compass className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                  ) : item.badge === "テーマ" ? (
                    <Eye className="h-4 w-4 shrink-0 text-[var(--status-danger)]" />
                  ) : item.badge === "惑星視点" ? (
                    <MapPin className="h-4 w-4 shrink-0 text-[var(--accent-secondary)]" />
                  ) : (
                    <Sparkles className="h-4 w-4 shrink-0 text-[var(--accent-primary)]" />
                  )}
                  <div className="truncate">
                    <div className="truncate text-xs font-semibold">{item.title}</div>
                    <div className="truncate text-[11px] text-[var(--text-secondary)]">{item.subtitle}</div>
                  </div>
                </div>
                <span className="shrink-0 rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1.5 py-0.5 font-mono-num text-[10px] text-[var(--text-secondary)]">
                  {item.badge}
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
