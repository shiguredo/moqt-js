/**
 * AudioMeter / VideoCard の見出しで共通にするクラス
 *
 * 項目 (peak / rms / fps など) はラベルの下に値を置き、縦に積む。ラベルと値が 1 対 1 で
 * 対応し、横に並べたときに崩れないようにする。
 *
 * 値は `font-mono` の桁数 (`ch`) で幅を固定する。値の文字数で幅が変わると並び全体が
 * 動き、値が更新されるたびに画面が揺れる。`tabular-nums` は `font-mono` が使えない
 * 環境でも桁の幅を揃えるために付ける
 */

/** 見出し行。カード名と項目 (ラベル + 値) を横に並べる */
export const METER_HEADER_CLASS = "flex flex-wrap items-baseline gap-x-4 gap-y-1 mb-1.5";

/** カード名 (Audio / Video) */
export const METER_TITLE_CLASS = "text-xs font-semibold text-slate-600 uppercase tracking-wide";

/** 1 つの項目。ラベルの下に値を置く */
export const METER_FIELD_CLASS = "flex flex-col gap-0.5";

/** 項目のラベル */
export const METER_LABEL_CLASS = "text-[10px] uppercase tracking-wide text-slate-400";

/** 項目の値。幅は呼び出し側が `w-[11ch]` などで固定する */
// `whitespace-pre`: 数値の左を空白で埋めた文字列 (formatDbfs / formatAudioLevel) を
// そのまま描く。nowrap では先頭の空白が潰され、桁数で単位の位置が動く
export const METER_VALUE_CLASS =
  "inline-block overflow-hidden whitespace-pre font-mono text-xs font-semibold tabular-nums text-slate-800";
