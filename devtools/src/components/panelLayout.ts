/**
 * Publisher と Subscriber のパネルで共通にする配置
 *
 * 2 つのパネルは横に並べる。項目の高さや並びがパネルで違うと、下の項目の位置が
 * そろわず見づらい。状態のメッセージの行、1 行の項目の行、ボタンの行の順に並べ、
 * 1 行の項目の行 (Publisher は Forward State、Subscriber は NEW_GROUP_REQUEST) は
 * 同じ高さの枠で描く。その下は Catalog → Audio → Video → Messages → Statistics の
 * 順に両パネルを揃える
 */

/** 映像より上に置く 1 行の項目の枠。高さを固定し、中身で高さが変わらないようにする */
export const PANEL_OPTION_ROW_CLASS =
  "mb-4 h-9 px-4 rounded-lg text-sm bg-slate-100 text-slate-600 flex items-center gap-6 truncate";
