import { formatBitrate } from "./logFormatters";

/**
 * catalog の値を表示用の文字列にする
 *
 * catalog の値は JSON の値である (draft-ietf-moq-msf-01 §5.1)。数値と文字列はそのまま
 * 出し、bitrate だけは単位を付けた既存の表記 (utils/logFormatters.ts の formatBitrate) に
 * する。配列 (depends) とオブジェクト (authInfo) は JSON の表記のまま出す。`String()` で
 * は `audio,video` や `[object Object]` になり、送っている値が読めなくなる。
 *
 * Catalog パネル (components/CatalogTracks.tsx) と接続設定の Tracks カード
 * (components/TrackDeclaration.tsx) が同じ関数を使い、同じ値が違う書式で出ないようにする。
 *
 * @param key - catalog のキー。bitrate だけ書式を変えるため受け取る
 * @param value - catalog の値
 */
export function formatCatalogValue(key: string, value: unknown): string {
  if (key === "bitrate" && typeof value === "number") {
    return formatBitrate(value);
  }
  // 配列とオブジェクトは中身が見える形で出す。null は JSON でも "null" のため String() と
  // 同じ結果になり、ここで分ける必要は無い
  if (value !== null && typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}
