import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import { Calculator, Compass, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NumberInput } from "@/components/ui/number-input";
import { localYmdHmsToJdUt, nowUtcJd, useSkyStore } from "@/store/skyStore";
import type {
  CalcAltTimeResult,
  CalcAngDistResult,
  CalcElapsedResult,
  CalcEpochConvertResult,
  CalcJdResult,
  CalcSiderealResult,
} from "@/types/sky";

type CalcTab = "jd" | "sidereal" | "elapsed" | "angdist" | "alttime" | "epoch";

function jdToLocalParts(jdUt: number, tzMin: number) {
  const jd = jdUt + tzMin / 1440;
  const z = Math.floor(jd + 0.5);
  const f = jd + 0.5 - z;
  let a = z;
  if (z >= 2299161) {
    const alpha = Math.floor((z - 1867216.25) / 36524.25);
    a = z + 1 + alpha - Math.floor(alpha / 4);
  }
  const b = a + 1524;
  const c = Math.floor((b - 122.1) / 365.25);
  const d = Math.floor(365.25 * c);
  const e = Math.floor((b - d) / 30.6001);
  const day = b - d - Math.floor(30.6001 * e);
  const month = e < 14 ? e - 1 : e - 13;
  const year = month > 2 ? c - 4716 : c - 4715;
  const totalSec = f * 86400;
  const hour = Math.floor(totalSec / 3600) % 24;
  const minute = Math.floor((totalSec % 3600) / 60);
  const second = Math.round((totalSec % 60) * 10) / 10;
  return { year, month, day, hour, minute, second: second >= 60 ? 59.9 : second };
}

function parseRaFlexible(raw: string): number | null {
  const s = raw.trim();
  const hms = s.match(/^(\d{1,2})\s*[h:\s]\s*(\d{1,2})(?:\s*[m:\s]\s*(\d{1,2}(?:\.\d+)?)s?)?$/i);
  if (hms) {
    const h = Number(hms[1]);
    const m = Number(hms[2]);
    const sec = hms[3] ? Number(hms[3]) : 0;
    if (h >= 0 && h < 24 && m >= 0 && m < 60 && sec >= 0 && sec < 60) {
      return (h + m / 60 + sec / 3600) * 15;
    }
  }
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

function parseDecFlexible(raw: string): number | null {
  const s = raw.trim();
  const dms = s.match(/^([+-]?)(\d{1,2})\s*[°d:\s]\s*(\d{1,2})(?:\s*['m:\s]\s*(\d{1,2}(?:\.\d+)?)"?)?$/i);
  if (dms) {
    const sign = dms[1] === "-" ? -1 : 1;
    const deg = Number(dms[2]);
    const m = Number(dms[3]);
    const sec = dms[4] ? Number(dms[4]) : 0;
    if (deg <= 90 && m < 60 && sec < 60) {
      return sign * (deg + m / 60 + sec / 3600);
    }
  }
  const num = Number(s);
  return Number.isFinite(num) ? num : null;
}

export function AstroCalculator() {
  const jdUt = useSkyStore((s) => s.jdUt);
  const location = useSkyStore((s) => s.location);
  const selectedObject = useSkyStore((s) => s.selectedObject);
  const jumpToJdUt = useSkyStore((s) => s.jumpToJdUt);
  const centerOnSkyCoords = useSkyStore((s) => s.centerOnSkyCoords);
  const setActivePanel = useSkyStore((s) => s.setActivePanel);

  const [tab, setTab] = useState<CalcTab>("jd");

  // 1. JD / MJD state
  const initParts = jdToLocalParts(jdUt, location.tz_offset_min);
  const [jdYear, setJdYear] = useState(initParts.year);
  const [jdMonth, setJdMonth] = useState(initParts.month);
  const [jdDay, setJdDay] = useState(initParts.day);
  const [jdHour, setJdHour] = useState(initParts.hour);
  const [jdMin, setJdMin] = useState(initParts.minute);
  const [jdSec, setJdSec] = useState(Math.round(initParts.second));
  const [jdInput, setJdInput] = useState(jdUt.toFixed(6));
  const [mjdInput, setMjdInput] = useState((jdUt - 2400000.5).toFixed(6));
  const [jdResult, setJdResult] = useState<CalcJdResult | null>(null);

  // 2. LST / HA state
  const [sidJd, setSidJd] = useState(jdUt.toFixed(6));
  const [sidLon, setSidLon] = useState(location.lon_deg.toFixed(4));
  const [sidRaInput, setSidRaInput] = useState(
    selectedObject ? selectedObject.ra_deg.toFixed(4) : "101.287",
  );
  const [sidResult, setSidResult] = useState<CalcSiderealResult | null>(null);

  // 3. Elapsed days / time state
  const [elStartYmd, setElStartYmd] = useState(`${initParts.year}-${String(initParts.month).padStart(2, "0")}-${String(initParts.day).padStart(2, "0")}`);
  const [elStartHm, setElStartHm] = useState(`${String(initParts.hour).padStart(2, "0")}:${String(initParts.minute).padStart(2, "0")}`);
  const [elEndYmd, setElEndYmd] = useState("2026-08-12");
  const [elEndHm, setElEndHm] = useState("18:00");
  const [elOffsetDays, setElOffsetDays] = useState("100");
  const [elResult, setElResult] = useState<CalcElapsedResult | null>(null);

  // 4. Angular distance state
  const [angRa1, setAngRa1] = useState("05h 55m 10s");
  const [angDec1, setAngDec1] = useState("+07° 24' 25\"");
  const [angRa2, setAngRa2] = useState("05h 14m 32s");
  const [angDec2, setAngDec2] = useState("-08° 12' 06\"");
  const [angResult, setAngResult] = useState<CalcAngDistResult | null>(null);

  // 5. Altitude crossing times state
  const [altRa, setAltRa] = useState(selectedObject ? selectedObject.ra_deg.toFixed(4) : "101.2872");
  const [altDec, setAltDec] = useState(selectedObject ? selectedObject.dec_deg.toFixed(4) : "-16.7161");
  const [altTargetDeg, setAltTargetDeg] = useState("20");
  const [altDateStr, setAltDateStr] = useState(
    `${initParts.year}-${String(initParts.month).padStart(2, "0")}-${String(initParts.day).padStart(2, "0")}`,
  );
  const [altResult, setAltResult] = useState<CalcAltTimeResult | null>(null);

  // 6. Epoch / B1950 <-> J2000 conversion state
  const [epMode, setEpMode] = useState<"b1950_to_j2000" | "j2000_to_b1950" | "custom">("b1950_to_j2000");
  const [epRa, setEpRa] = useState("05h 32m 49.0s");
  const [epDec, setEpDec] = useState("-05° 25' 16\"");
  const [epFromYear, setEpFromYear] = useState("1950");
  const [epToYear, setEpToYear] = useState("2050");
  const [epResult, setEpResult] = useState<CalcEpochConvertResult | null>(null);

  const runJdCalc = async (mode: "from_calendar" | "from_jd" | "from_mjd") => {
    if (!isTauri()) return;
    const res = await invoke<CalcJdResult>("calc_julian_day_cmd", {
      req: {
        mode,
        year: Number(jdYear),
        month: Number(jdMonth),
        day: Number(jdDay),
        hour: Number(jdHour),
        minute: Number(jdMin),
        second: Number(jdSec),
        tz_offset_min: location.tz_offset_min,
        jd_ut: Number(jdInput) || jdUt,
        mjd_ut: Number(mjdInput) || jdUt - 2400000.5,
      },
    });
    setJdResult(res);
    setJdInput(res.jd_ut.toFixed(6));
    setMjdInput(res.mjd_ut.toFixed(6));
    const lp = jdToLocalParts(res.jd_ut, location.tz_offset_min);
    setJdYear(lp.year);
    setJdMonth(lp.month);
    setJdDay(lp.day);
    setJdHour(lp.hour);
    setJdMin(lp.minute);
    setJdSec(Math.round(lp.second));
  };

  useEffect(() => {
    if (tab === "jd") {
      void runJdCalc("from_calendar");
    }
  }, [tab]);

  const runSiderealCalc = async () => {
    if (!isTauri()) return;
    const raDeg = parseRaFlexible(sidRaInput);
    if (raDeg === null) return;
    const res = await invoke<CalcSiderealResult>("calc_sidereal_ha_cmd", {
      req: {
        jd_ut: Number(sidJd) || jdUt,
        lon_deg: Number(sidLon) || 0,
        ra_deg: raDeg,
      },
    });
    setSidResult(res);
  };

  useEffect(() => {
    if (tab === "sidereal") void runSiderealCalc();
  }, [tab, sidJd, sidLon, sidRaInput]);

  const runElapsedCalc = async () => {
    if (!isTauri()) return;
    const parseDt = (ymd: string, hm: string): number => {
      const [y, m, d] = ymd.split("-").map(Number);
      const [hh, mm] = hm.split(":").map(Number);
      return localYmdHmsToJdUt(y || 2026, m || 1, d || 1, hh || 0, mm || 0, 0, location.tz_offset_min);
    };
    const res = await invoke<CalcElapsedResult>("calc_elapsed_time_cmd", {
      req: {
        jd_start_ut: parseDt(elStartYmd, elStartHm),
        jd_end_ut: parseDt(elEndYmd, elEndHm),
        offset_days: Number(elOffsetDays) || 0,
        tz_offset_min: location.tz_offset_min,
      },
    });
    setElResult(res);
  };

  useEffect(() => {
    if (tab === "elapsed") void runElapsedCalc();
  }, [tab, elStartYmd, elStartHm, elEndYmd, elEndHm, elOffsetDays, location.tz_offset_min]);

  const runAngDistCalc = async () => {
    if (!isTauri()) return;
    const ra1 = parseRaFlexible(angRa1);
    const dec1 = parseDecFlexible(angDec1);
    const ra2 = parseRaFlexible(angRa2);
    const dec2 = parseDecFlexible(angDec2);
    if (ra1 === null || dec1 === null || ra2 === null || dec2 === null) return;
    const res = await invoke<CalcAngDistResult>("calc_angular_distance_cmd", {
      req: { ra1_deg: ra1, dec1_deg: dec1, ra2_deg: ra2, dec2_deg: dec2 },
    });
    setAngResult(res);
  };

  useEffect(() => {
    if (tab === "angdist") void runAngDistCalc();
  }, [tab, angRa1, angDec1, angRa2, angDec2]);

  const runAltTimeCalc = async () => {
    if (!isTauri()) return;
    const ra = parseRaFlexible(altRa);
    const dec = parseDecFlexible(altDec);
    if (ra === null || dec === null) return;
    const [y, m, d] = altDateStr.split("-").map(Number);
    const res = await invoke<CalcAltTimeResult>("calc_altitude_times_cmd", {
      req: {
        ra_j2000_deg: ra,
        dec_j2000_deg: dec,
        target_alt_deg: Number(altTargetDeg) || 0,
        lat_deg: location.lat_deg,
        lon_deg: location.lon_deg,
        alt_m: location.alt_m,
        tz_offset_min: location.tz_offset_min,
        year: y || 2026,
        month: m || 1,
        day: d || 1,
      },
    });
    setAltResult(res);
  };

  useEffect(() => {
    if (tab === "alttime") void runAltTimeCalc();
  }, [tab, altRa, altDec, altTargetDeg, altDateStr, location]);

  const runEpochCalc = async () => {
    if (!isTauri()) return;
    const ra = parseRaFlexible(epRa);
    const dec = parseDecFlexible(epDec);
    if (ra === null || dec === null) return;
    const res = await invoke<CalcEpochConvertResult>("calc_epoch_convert_cmd", {
      req: {
        ra_deg: ra,
        dec_deg: dec,
        mode: epMode,
        from_epoch_year: Number(epFromYear) || 2000,
        to_epoch_year: Number(epToYear) || 2050,
      },
    });
    setEpResult(res);
  };

  useEffect(() => {
    if (tab === "epoch") void runEpochCalc();
  }, [tab, epMode, epRa, epDec, epFromYear, epToYear]);

  return (
    <aside className="flex h-full w-[28.5rem] max-w-[calc(100vw-5.5rem)] flex-col rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface-glass)] text-[var(--text-primary)] shadow-2xl backdrop-blur-md">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-[var(--border-subtle)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold tracking-tight">
            <Calculator className="h-4 w-4 text-cyan-400" /> 天文計算機 (全9機能統合)
          </h2>
          <p className="text-[11px] text-[var(--text-muted)]">
            JD/MJD ・ LST/時角 ・ 経過日数/時間 ・ 角距離 ・ 指定高度時刻 ・ B1950↔J2000
          </p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={() => setActivePanel(null)}
          title="閉じる"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-1 border-b border-[var(--border-subtle)] px-4 py-2 text-[11px]">
        {(
          [
            { id: "jd", label: "JD / MJD" },
            { id: "sidereal", label: "恒星時・時角" },
            { id: "elapsed", label: "経過日数・時間" },
            { id: "angdist", label: "角距離" },
            { id: "alttime", label: "指定高度→時刻" },
            { id: "epoch", label: "B1950↔J2000" },
          ] as const
        ).map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`rounded-lg px-2.5 py-1 font-medium transition ${
              tab === t.id
                ? "bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                : "bg-[var(--bg-surface)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Body */}
      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3 text-xs">
        {tab === "jd" && (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5">
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-[11px]"
                onClick={() => {
                  const lp = jdToLocalParts(jdUt, location.tz_offset_min);
                  setJdYear(lp.year);
                  setJdMonth(lp.month);
                  setJdDay(lp.day);
                  setJdHour(lp.hour);
                  setJdMin(lp.minute);
                  setJdSec(Math.round(lp.second));
                  setJdInput(jdUt.toFixed(6));
                  setMjdInput((jdUt - 2400000.5).toFixed(6));
                  setTimeout(() => void runJdCalc("from_jd"), 0);
                }}
              >
                <RefreshCw className="h-3 w-3" />
                星図日時に同期
              </Button>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[11px]"
                onClick={() => {
                  const now = nowUtcJd();
                  setJdInput(now.toFixed(6));
                  setMjdInput((now - 2400000.5).toFixed(6));
                  setTimeout(() => void runJdCalc("from_jd"), 0);
                }}
              >
                現在時刻
              </Button>
            </div>

            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="font-semibold text-[var(--text-secondary)]">現地日時 ({location.tz_name}) から計算</div>
              <div className="grid grid-cols-7 gap-1 font-mono-num">
                <label className="col-span-2 space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">年</span>
                  <NumberInput
                    integer
                    value={jdYear}
                    onValueChange={setJdYear}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1.5 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">月</span>
                  <NumberInput
                    integer
                    min={1}
                    max={12}
                    clampOnBlur
                    value={jdMonth}
                    onValueChange={setJdMonth}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">日</span>
                  <NumberInput
                    integer
                    min={1}
                    max={31}
                    clampOnBlur
                    value={jdDay}
                    onValueChange={setJdDay}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">時</span>
                  <NumberInput
                    integer
                    min={0}
                    max={23}
                    clampOnBlur
                    value={jdHour}
                    onValueChange={setJdHour}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">分</span>
                  <NumberInput
                    integer
                    min={0}
                    max={59}
                    clampOnBlur
                    value={jdMin}
                    onValueChange={setJdMin}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">秒</span>
                  <NumberInput
                    integer
                    min={0}
                    max={59}
                    clampOnBlur
                    value={jdSec}
                    onValueChange={setJdSec}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-1 text-[11px]"
                  />
                </label>
              </div>
              <Button type="button" size="sm" className="h-7 w-full text-[11px]" onClick={() => void runJdCalc("from_calendar")}>
                日時 → JD / MJD に変換
              </Button>
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="space-y-1.5">
                <span className="text-[10px] text-[var(--text-muted)]">ユリウス日 (JD UT)</span>
                <input
                  type="text"
                  value={jdInput}
                  onChange={(e) => setJdInput(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 font-mono-num text-[11px]"
                />
                <Button type="button" size="sm" variant="outline" className="h-7 w-full text-[10px]" onClick={() => void runJdCalc("from_jd")}>
                  JD から逆変換
                </Button>
              </div>
              <div className="space-y-1.5">
                <span className="text-[10px] text-[var(--text-muted)]">修正ユリウス日 (MJD)</span>
                <input
                  type="text"
                  value={mjdInput}
                  onChange={(e) => setMjdInput(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 font-mono-num text-[11px]"
                />
                <Button type="button" size="sm" variant="outline" className="h-7 w-full text-[10px]" onClick={() => void runJdCalc("from_mjd")}>
                  MJD から逆変換
                </Button>
              </div>
            </div>

            {jdResult && (
              <div className="space-y-1.5 rounded-xl border border-cyan-500/35 bg-[var(--bg-surface-elevated)] p-3 font-mono-num text-[11px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">ユリウス日 JD(UT):</span>
                  <span className="font-bold text-cyan-300">{jdResult.jd_ut.toFixed(6)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">修正ユリウス日 MJD:</span>
                  <span className="font-bold text-amber-200">{jdResult.mjd_ut.toFixed(6)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">地球時 JD(TT) / ΔT:</span>
                  <span>
                    {jdResult.jd_tt.toFixed(5)} ({jdResult.delta_t_sec.toFixed(2)}秒)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">UTC / 現地時刻:</span>
                  <span>
                    {jdResult.utc_str} / {jdResult.local_str} ({jdResult.weekday_ja})
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">均時差 / J2000世紀:</span>
                  <span>
                    {jdResult.equation_of_time_min >= 0 ? "+" : ""}
                    {jdResult.equation_of_time_min.toFixed(2)}分 / T={jdResult.julian_centuries_j2000.toFixed(6)}
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="mt-1 h-7 w-full gap-1 text-[11px]"
                  onClick={() => jumpToJdUt(jdResult.jd_ut)}
                >
                  <Compass className="h-3.5 w-3.5" />
                  この日時へプラネタリウムを移動
                </Button>
              </div>
            )}
          </div>
        )}

        {tab === "sidereal" && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="flex flex-wrap gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-6 px-2 text-[10px]"
                  onClick={() => {
                    setSidJd(jdUt.toFixed(6));
                    setSidLon(location.lon_deg.toFixed(4));
                  }}
                >
                  星図の日時・経度を取込
                </Button>
                {selectedObject && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => setSidRaInput(selectedObject.ra_deg.toFixed(4))}
                  >
                    選択天体 ({selectedObject.name_ja}) の赤経
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-3 gap-2 font-mono-num">
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">JD (UT)</span>
                  <input
                    type="text"
                    value={sidJd}
                    onChange={(e) => setSidJd(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">東経 (°)</span>
                  <input
                    type="text"
                    value={sidLon}
                    onChange={(e) => setSidLon(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">天体赤経 (度 / h:m:s)</span>
                  <input
                    type="text"
                    value={sidRaInput}
                    onChange={(e) => setSidRaInput(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
              </div>
            </div>

            {sidResult && (
              <div className="space-y-1.5 rounded-xl border border-cyan-500/35 bg-[var(--bg-surface-elevated)] p-3 font-mono-num text-[11px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">グリニッジ平均恒星時 (GMST):</span>
                  <span>
                    {sidResult.gmst_hms} ({sidResult.gmst_deg.toFixed(3)}°)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">グリニッジ視恒星時 (GAST):</span>
                  <span>
                    {sidResult.gast_hms} ({sidResult.gast_deg.toFixed(3)}°)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">地方平均恒星時 (LST):</span>
                  <span className="font-bold text-cyan-300">
                    {sidResult.lst_hms} ({sidResult.lst_deg.toFixed(3)}°)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">地方視恒星時 (LAST):</span>
                  <span className="font-bold text-emerald-300">
                    {sidResult.last_hms} ({sidResult.last_deg.toFixed(3)}°)
                  </span>
                </div>
                <div className="border-t border-[var(--border-subtle)] pt-1.5 flex justify-between">
                  <span className="text-[var(--text-muted)]">時角 H = LAST − α:</span>
                  <span className="font-bold text-amber-200">
                    {sidResult.hour_angle_hms} ({sidResult.hour_angle_deg.toFixed(2)}°)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">南中時刻まで:</span>
                  <span>
                    {sidResult.hours_to_transit >= 0
                      ? `あと ${sidResult.hours_to_transit.toFixed(2)} 時間`
                      : `${Math.abs(sidResult.hours_to_transit).toFixed(2)} 時間前に南中`}
                  </span>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "elapsed" && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3 font-mono-num">
              <div className="space-y-1">
                <span className="text-[10px] text-[var(--text-muted)]">開始日時 ({location.tz_name})</span>
                <input
                  type="date"
                  value={elStartYmd}
                  onChange={(e) => setElStartYmd(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                />
                <input
                  type="time"
                  value={elStartHm}
                  onChange={(e) => setElStartHm(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                />
              </div>
              <div className="space-y-1">
                <span className="text-[10px] text-[var(--text-muted)]">終了日時 ({location.tz_name})</span>
                <input
                  type="date"
                  value={elEndYmd}
                  onChange={(e) => setElEndYmd(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                />
                <input
                  type="time"
                  value={elEndHm}
                  onChange={(e) => setElEndHm(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                />
              </div>
              <label className="col-span-2 space-y-0.5 pt-1">
                <span className="text-[10px] text-[var(--text-muted)]">開始日時に加算/減算する日数 (±日)</span>
                <input
                  type="number"
                  step="0.5"
                  value={elOffsetDays}
                  onChange={(e) => setElOffsetDays(e.target.value)}
                  className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                />
              </label>
            </div>

            {elResult && (
              <div className="space-y-1.5 rounded-xl border border-cyan-500/35 bg-[var(--bg-surface-elevated)] p-3 font-mono-num text-[11px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">経過内訳:</span>
                  <span className="font-bold text-cyan-300">{elResult.breakdown_text}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">経過日数 / 週 / ユリウス年:</span>
                  <span>
                    {elResult.diff_days.toFixed(4)} 日 ({elResult.diff_weeks.toFixed(2)}週 /{" "}
                    {elResult.diff_julian_years.toFixed(4)}年)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">経過時間 (太陽時):</span>
                  <span className="text-amber-200">
                    {elResult.diff_hours.toFixed(3)} 時間 ({elResult.diff_minutes.toFixed(1)}分)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">経過恒星時 (恒星時間換算):</span>
                  <span>{elResult.diff_sidereal_hours.toFixed(4)} 恒星時</span>
                </div>
                <div className="border-t border-[var(--border-subtle)] pt-1.5 flex items-center justify-between gap-2">
                  <span className="text-[var(--text-muted)]">加算後の日時:</span>
                  <span className="text-emerald-300">{elResult.shifted_local_str}</span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 w-full gap-1 text-[11px]"
                  onClick={() => jumpToJdUt(elResult.shifted_jd_ut)}
                >
                  <Compass className="h-3.5 w-3.5" />
                  加算後の日時へ星図を移動
                </Button>
              </div>
            )}
          </div>
        )}

        {tab === "angdist" && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">天体1 ↔ 天体2 の赤道座標 (度 または hms/dms)</span>
                {selectedObject && (
                  <div className="flex gap-1">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => {
                        setAngRa1(selectedObject.ra_deg.toFixed(4));
                        setAngDec1(selectedObject.dec_deg.toFixed(4));
                      }}
                    >
                      点1に選択天体
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="h-6 px-2 text-[10px]"
                      onClick={() => {
                        setAngRa2(selectedObject.ra_deg.toFixed(4));
                        setAngDec2(selectedObject.dec_deg.toFixed(4));
                      }}
                    >
                      点2に選択天体
                    </Button>
                  </div>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono-num">
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">点1 赤経 (例: 05h 55m 10s)</span>
                  <input
                    type="text"
                    value={angRa1}
                    onChange={(e) => setAngRa1(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">点1 赤緯 (例: +07° 24' 25")</span>
                  <input
                    type="text"
                    value={angDec1}
                    onChange={(e) => setAngDec1(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">点2 赤経</span>
                  <input
                    type="text"
                    value={angRa2}
                    onChange={(e) => setAngRa2(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">点2 赤緯</span>
                  <input
                    type="text"
                    value={angDec2}
                    onChange={(e) => setAngDec2(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
              </div>
            </div>

            {angResult && (
              <div className="space-y-1.5 rounded-xl border border-cyan-500/35 bg-[var(--bg-surface-elevated)] p-3 font-mono-num text-[11px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">離角 (度):</span>
                  <span className="font-bold text-cyan-300">
                    {angResult.distance_deg.toFixed(5)}° ({angResult.distance_dms})
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">角分 / 角秒:</span>
                  <span>
                    {angResult.distance_arcmin.toFixed(2)}' / {angResult.distance_arcsec.toFixed(1)}"
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">位置角 PA (点1→点2 / 北=0°東=90°):</span>
                  <span className="text-amber-200">{angResult.position_angle_deg.toFixed(2)}°</span>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "alttime" && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold">観測地: {location.name_ja} ({location.lat_deg.toFixed(2)}°N)</span>
                {selectedObject && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="h-6 px-2 text-[10px]"
                    onClick={() => {
                      setAltRa(selectedObject.ra_deg.toFixed(4));
                      setAltDec(selectedObject.dec_deg.toFixed(4));
                    }}
                  >
                    選択天体 ({selectedObject.name_ja})
                  </Button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 font-mono-num">
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">赤経 (J2000)</span>
                  <input
                    type="text"
                    value={altRa}
                    onChange={(e) => setAltRa(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">赤緯 (J2000)</span>
                  <input
                    type="text"
                    value={altDec}
                    onChange={(e) => setAltDec(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">目的高度 h (°)</span>
                  <input
                    type="number"
                    step="1"
                    min={-15}
                    max={89}
                    value={altTargetDeg}
                    onChange={(e) => setAltTargetDeg(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">日付 ({location.tz_name})</span>
                  <input
                    type="date"
                    value={altDateStr}
                    onChange={(e) => setAltDateStr(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
              </div>
            </div>

            {altResult && (
              <div className="space-y-2 rounded-xl border border-cyan-500/35 bg-[var(--bg-surface-elevated)] p-3 font-mono-num text-[11px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">判定:</span>
                  <span className="font-bold text-amber-200">{altResult.status_ja}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">当日の最高 / 最低高度:</span>
                  <span>
                    {altResult.max_alt_deg.toFixed(1)}° / {altResult.min_alt_deg.toFixed(1)}°
                  </span>
                </div>
                <div className="grid grid-cols-3 gap-1.5 pt-1">
                  <div className="rounded bg-[var(--bg-surface)] p-2 text-center">
                    <div className="text-[10px] text-[var(--text-muted)]">昇る時 (東)</div>
                    <div className="text-xs font-bold text-emerald-300">
                      {altResult.rising_local_str ?? "--:--"}
                    </div>
                    {altResult.rising_jd_ut && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="mt-1 h-5 w-full text-[9px]"
                        onClick={() => jumpToJdUt(altResult.rising_jd_ut!)}
                      >
                        星図移動
                      </Button>
                    )}
                  </div>
                  <div className="rounded bg-[var(--bg-surface)] p-2 text-center">
                    <div className="text-[10px] text-[var(--text-muted)]">南中時刻</div>
                    <div className="text-xs font-bold text-sky-300">
                      {altResult.transit_local_str ?? "--:--"}
                    </div>
                    {altResult.transit_jd_ut && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="mt-1 h-5 w-full text-[9px]"
                        onClick={() => jumpToJdUt(altResult.transit_jd_ut!)}
                      >
                        星図移動
                      </Button>
                    )}
                  </div>
                  <div className="rounded bg-[var(--bg-surface)] p-2 text-center">
                    <div className="text-[10px] text-[var(--text-muted)]">沈む時 (西)</div>
                    <div className="text-xs font-bold text-rose-300">
                      {altResult.setting_local_str ?? "--:--"}
                    </div>
                    {altResult.setting_jd_ut && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="mt-1 h-5 w-full text-[9px]"
                        onClick={() => jumpToJdUt(altResult.setting_jd_ut!)}
                      >
                        星図移動
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {tab === "epoch" && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-3">
              <div className="flex flex-wrap gap-1">
                {(
                  [
                    { id: "b1950_to_j2000", label: "B1950.0 → J2000.0" },
                    { id: "j2000_to_b1950", label: "J2000.0 → B1950.0" },
                    { id: "custom", label: "任意元期変換" },
                  ] as const
                ).map((m) => (
                  <button
                    key={m.id}
                    type="button"
                    onClick={() => setEpMode(m.id)}
                    className={`rounded border px-2 py-0.5 text-[10px] font-medium ${
                      epMode === m.id
                        ? "border-[var(--accent-primary)] bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]"
                        : "border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] text-[var(--text-secondary)]"
                    }`}
                  >
                    {m.label}
                  </button>
                ))}
              </div>

              <div className="grid grid-cols-2 gap-2 font-mono-num">
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">入力赤経 (hms または 度)</span>
                  <input
                    type="text"
                    value={epRa}
                    onChange={(e) => setEpRa(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                <label className="space-y-0.5">
                  <span className="text-[10px] text-[var(--text-muted)]">入力赤緯 (dms または 度)</span>
                  <input
                    type="text"
                    value={epDec}
                    onChange={(e) => setEpDec(e.target.value)}
                    className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                  />
                </label>
                {epMode === "custom" && (
                  <>
                    <label className="space-y-0.5">
                      <span className="text-[10px] text-[var(--text-muted)]">元期 From (年)</span>
                      <input
                        type="number"
                        step="1"
                        value={epFromYear}
                        onChange={(e) => setEpFromYear(e.target.value)}
                        className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                      />
                    </label>
                    <label className="space-y-0.5">
                      <span className="text-[10px] text-[var(--text-muted)]">元期 To (年)</span>
                      <input
                        type="number"
                        step="1"
                        value={epToYear}
                        onChange={(e) => setEpToYear(e.target.value)}
                        className="h-7 w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-surface-elevated)] px-2 text-[11px]"
                      />
                    </label>
                  </>
                )}
              </div>
            </div>

            {epResult && (
              <div className="space-y-1.5 rounded-xl border border-cyan-500/35 bg-[var(--bg-surface-elevated)] p-3 font-mono-num text-[11px]">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">変換後 赤経:</span>
                  <span className="font-bold text-cyan-300">
                    {epResult.out_ra_hms} ({epResult.out_ra_deg.toFixed(5)}°)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">変換後 赤緯:</span>
                  <span className="font-bold text-cyan-300">
                    {epResult.out_dec_dms} ({epResult.out_dec_deg.toFixed(5)}°)
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">歳差移動量 (Δα / Δδ):</span>
                  <span>
                    {epResult.delta_ra_arcsec >= 0 ? "+" : ""}
                    {epResult.delta_ra_arcsec.toFixed(2)}" /{" "}
                    {epResult.delta_dec_arcsec >= 0 ? "+" : ""}
                    {epResult.delta_dec_arcsec.toFixed(2)}"
                  </span>
                </div>
                <div className="flex justify-between border-t border-[var(--border-subtle)] pt-1.5">
                  <span className="text-[var(--text-muted)]">黄道座標 (J2000 λ, β):</span>
                  <span>
                    {epResult.ecl_lon_deg.toFixed(3)}°, {epResult.ecl_lat_deg.toFixed(3)}°
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">銀河座標 (l, b):</span>
                  <span>
                    {epResult.gal_l_deg.toFixed(3)}°, {epResult.gal_b_deg.toFixed(3)}°
                  </span>
                </div>
                <Button
                  type="button"
                  size="sm"
                  className="mt-1 h-7 w-full gap-1 text-[11px]"
                  onClick={() => centerOnSkyCoords(epResult.out_ra_deg, epResult.out_dec_deg)}
                >
                  <Compass className="h-3.5 w-3.5" />
                  変換座標をプラネタリウムで表示
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
