/**
 * MOQT Full Track Name
 * draft-ietf-moq-transport-21 Section 2.4.1 (Track Naming)
 */

/**
 * Full Track Name の比較キーを生成する
 *
 * draft-ietf-moq-transport-21 §2.4.1:
 * Track は Track Namespace (0〜32 個の Track Namespace Field) と Track Name の
 * 組で識別され、比較はバイト列の完全一致で行う。moqt-js は Track Namespace
 * Field と Track Name を JS 文字列で保持するため、`/` などの区切り文字で連結
 * すると異なる Full Track Name が同じ文字列になる (例: namespace ["a"] +
 * trackName "b/c" と namespace ["a","b"] + trackName "c" はどちらも "a/b/c")。
 * 各フィールドを長さ付き (`${length}:${value}`) にして連結し、フィールド境界が
 * 一意に定まる比較キーにする。先頭の ":" までが長さ、続く length 文字が値、
 * その次が "|" または終端という手順で一意に復号できるため、異なるフィールド列が
 * 同じキーになることはない (値に "|" や ":" が含まれても境界は崩れない)。
 *
 * 戻り値は同一性判定専用であり、Full Track Name そのものではない。表示・ログ・
 * プロトコル上の値として使わず、比較は完全一致でのみ行う。長さには JS 文字列の
 * length (UTF-16 コードユニット数) を使う。キーは等値比較にしか使わないため、
 * バイト列長ではなく文字列長で境界が一意になればよい。
 */
export function fullTrackNameKey(trackNamespace: readonly string[], trackName: string): string {
  // Track Namespace の各フィールドの後ろに Track Name を並べ、同じ規則で
  // 長さ付きにする (Track Name が空文字列でも "0:" として境界が残る)。
  const fields = [...trackNamespace, trackName];
  return fields.map((field) => `${field.length}:${field}`).join("|");
}
