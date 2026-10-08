import type { CatalogTrack } from "moqt-js";
import { formatCatalogValue } from "../utils/catalogValue";

interface TrackDeclarationProps {
  /** 表示するトラックの宣言。広告しないトラックは null */
  track: CatalogTrack | null;
  /** 既に上の入力欄 / 選択欄で値を見せているキー。行にしない */
  controlKeys: readonly string[];
  /** 行の data-testid に使う接頭辞 (例: "audio-track") */
  testIdPrefix: string;
}

/**
 * catalog に載るトラックの宣言を接続設定の Tracks カードに出す
 *
 * 配信で送る catalog の値 (draft-ietf-moq-msf-01 §5.1) を、下の Audio / Video / Catalog
 * カードの設定に追随して 1 行ずつ出す。値は配信と同じ `buildPublisherTrackDeclarations` が
 * 組み立てたものを渡すため、画面と送る内容がずれない。
 *
 * キーは catalog のキーをそのまま出し、送信後の catalog を出す Catalog パネルと同じ名前で
 * 読めるようにする (Tracks カードの上の欄が値を持たない `packaging` / `isLive` / `bitrate`
 * などが対象)。トラック名 / role / codec / eventType は上の入力欄と選択欄が担うため、
 * `controlKeys` で外す。
 *
 * 広告しないトラック (入力が None など) は宣言が存在しないため何も描かない。なぜ広告しない
 * かは、上の Advertised の行が出す。
 */
export function TrackDeclaration({ track, controlKeys, testIdPrefix }: TrackDeclarationProps) {
  if (track === null) {
    return null;
  }
  // 並びは宣言を組み立てた順のままにする (catalog のキーの並びと揃えるため並べ替えない)
  const entries = Object.entries(track).filter(([key]) => !controlKeys.includes(key));
  return (
    <div
      class="mt-1 pt-2 border-t border-slate-200 space-y-0.5"
      data-testid={`${testIdPrefix}-declaration`}
    >
      {entries.map(([key, value]) => (
        <div key={key} class="flex gap-2 text-xs">
          {/* 値が変わっても位置が動かないよう、キーの幅は接続設定の他の行と同じ幅に固定する。
              単位は付けず catalog の生の値を出す。長い値 (depends / authInfo) は折り返す。
              data-testid は値を持つ要素に付ける (Advertised の行と同じ扱い) */}
          <span class="w-24 shrink-0 text-slate-500">{key}</span>
          <span class="text-slate-700 break-all" data-testid={`${testIdPrefix}-${key}`}>
            {formatCatalogValue(key, value)}
          </span>
        </div>
      ))}
    </div>
  );
}
