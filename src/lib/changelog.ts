export type ChangelogKind = "initial" | "feature" | "fix";

export interface ChangelogRelease {
  version: string;
  date: string;
  kind: ChangelogKind;
  title: string;
  items: string[];
}

export const CHANGELOG_ENTRIES: ChangelogRelease[] = [
  {
    version: "0.2.1",
    date: "2026-11-25",
    kind: "fix",
    title: "アップデート時のチェンジリスト表示対応",
    items: [
      "アップデート通知バナーおよび設定画面「アプリ更新」に、新バージョンのチェンジリストを表示するようにしました",
      "アップデート後の起動時に変更内容の案内を表示し、設定画面から過去の更新履歴も閲覧できるようになりました",
      "GitHub Release 本文にも該当バージョンの変更内容を自動反映するようにしました",
    ],
  },
  {
    version: "0.2.0",
    date: "2026-11-25",
    kind: "feature",
    title: "全天実写サーベイ・月面ラベル・土星の衛星・オフライン保存機能",
    items: [
      "全天実写サーベイ（HiPS / DSS2 カラー・高精細・2MASS 赤外）のシームレス拡大表示を追加",
      "月面クレーター・海ラベル表示（星図ズーム連動および「惑星の形」ツール）を追加",
      "土星の衛星シミュレーター（8衛星・傾いた環の表現・波動曲線・タイタン最大離角予報）を追加",
      "星・天体詳細の画像が比率によって見切れていた問題を修正し、全体表示・拡大プレビューに対応",
      "オフライン環境向けの HiPS 全天/視野事前保存と天体位置スナップショット保存・復元機能を追加",
    ],
  },
  {
    version: "0.1.1",
    date: "2026-11-25",
    kind: "fix",
    title: "数値入力と3D太陽系の不具合修正",
    items: [
      "時刻などの数値入力欄で数字を消すと勝手に 0 が入り「050」のようになる不具合を修正",
      "3D太陽系シミュレーターが初期起動・切替時に読み込まれない不具合を修正",
    ],
  },
  {
    version: "0.1.0",
    date: "2026-11-25",
    kind: "initial",
    title: "StarCrane 初回リリース",
    items: [
      "プラネタリウム星図（約12万恒星・1.3万DSO・9種投影法・165Hz滑らか描画）",
      "惑星ツール・ガリレオ衛星・日月食検索・彗星/人工衛星軌道・3D太陽系を搭載",
      "Windows 自動アップデートおよび Android アプリ内 APK 更新に対応",
    ],
  },
];

export function normalizeVersionString(version: string | null | undefined): string {
  if (!version) return "";
  return version.trim().replace(/^[vV]/, "").split(/[+\s]/)[0] ?? "";
}

export function findChangelogEntry(version: string | null | undefined): ChangelogRelease | null {
  const norm = normalizeVersionString(version);
  if (!norm) return null;
  return CHANGELOG_ENTRIES.find((e) => e.version === norm) ?? null;
}

/**
 * Parse changelog bullet lines from raw GitHub / updater release notes, ignoring generic
 * boilerplate and headings, and falling back to bundled CHANGELOG_ENTRIES if empty.
 */
export function parseReleaseNotesLines(
  rawNotes: string | null | undefined,
  fallbackVersion?: string | null,
): string[] {
  if (rawNotes) {
    const cleaned = rawNotes
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => {
        if (!line) return false;
        if (/^#{1,6}\s*/.test(line)) return false;
        if (line.includes("自動アップデート対応リリースです")) return false;
        return true;
      })
      .map((line) => line.replace(/^[-*•・]\s*/, "").trim())
      .filter(Boolean);
    if (cleaned.length > 0) {
      return cleaned;
    }
  }
  return findChangelogEntry(fallbackVersion)?.items ?? [];
}
