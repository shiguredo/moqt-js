/**
 * Publisher と Subscriber のパネルで共通にする配置
 *
 * 2 つのパネルは横に並べる。項目の高さや並びがパネルで違うと、下の項目の位置が
 * そろわず見づらい。状態のメッセージの行、項目の行、ボタンの行の順に並べ、
 * 項目の行 (Publisher は paused 状態、Subscriber は購読の設定と購読中の操作) は
 * 同じ高さの枠で描く。その下は Catalog → Audio → Video → Messages → Statistics の
 * 順に両パネルを揃える
 */

/**
 * 映像より上に置く項目の枠。高さを固定し、中身で高さが変わらないようにする
 *
 * 項目の中身は見出し (どの操作で効くか) と操作の 2 段にする。2 段でも高さが
 * 固定になるように、見出しの高さと操作の高さの和より大きい値にする
 */
export const PANEL_OPTION_ROW_CLASS =
  "mb-4 h-11 px-4 rounded-lg text-sm bg-slate-100 text-slate-600 flex items-center gap-6 truncate";

/** 項目の見出し (SUBSCRIBE / REQUEST_UPDATE など)。操作の上に置く */
export const PANEL_OPTION_CAPTION_CLASS =
  "text-[10px] leading-none font-medium uppercase tracking-wide text-slate-400";
