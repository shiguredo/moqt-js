/**
 * MOQT Full Track Name
 * draft-ietf-moq-transport-21 Section 2.4.1 (Track Naming)
 */

/**
 * Full Track Name の比較キー
 *
 * fullTrackNameKey が生成する長さ付きキー専用の型である。生の Full Track Name
 * (`/` などで連結した文字列) を比較キーとして渡す取り違えを型で検出するため、
 * string に brand を付ける。比較キーは `!==` による等値比較と Set / Map の
 * キーとしてのみ使うため、brand を付けても比較の実装は変わらない。
 */
export type FullTrackNameKey = string & { readonly __brand: "FullTrackNameKey" };

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
export function fullTrackNameKey(
  trackNamespace: readonly string[],
  trackName: string,
): FullTrackNameKey {
  // Track Namespace の各フィールドの後ろに Track Name を並べ、同じ規則で
  // 長さ付きにする (Track Name が空文字列でも "0:" として境界が残る)。
  const fields = [...trackNamespace, trackName];
  // brand は型のみで実行時表現を持たないため、生成はここで 1 回だけ行う
  return fields.map((field) => `${field.length}:${field}`).join("|") as FullTrackNameKey;
}

// Full Track Name の文字列表現に使う UTF-8 エンコーダ (プロトコルのワイヤ表現と
// 同じバイト列にする)
const fullTrackNameEncoder = new TextEncoder();

/**
 * Track Namespace Field / Track Name の 1 セグメントをエスケープする
 *
 * draft-ietf-moq-transport-21 §8.8:
 * バイト a-z / A-Z / 0-9 / _ (0x5f) はそのまま、それ以外のバイトは "." に続けて
 * 小文字 16 進 2 桁で表す。プロトコルは文字列をバイト列として扱うため、UTF-8 の
 * バイトごとにエスケープする。
 */
function escapeFullTrackNameSegment(value: string): string {
  let escaped = "";
  for (const byte of fullTrackNameEncoder.encode(value)) {
    const isUnreserved =
      (byte >= 0x30 && byte <= 0x39) ||
      (byte >= 0x41 && byte <= 0x5a) ||
      (byte >= 0x61 && byte <= 0x7a) ||
      byte === 0x5f;
    if (isUnreserved) {
      escaped += String.fromCharCode(byte);
    } else {
      escaped += `.${byte.toString(16).padStart(2, "0")}`;
    }
  }
  return escaped;
}

/**
 * Track Namespace の文字列表現を組み立てる
 *
 * draft-ietf-moq-transport-21 §8.8 (Representing Namespace and Track Names):
 * Full Track Name の文字列表現は、Track Namespace の各フィールドを "-" で並べ、
 * Track Name を "--" でつなぐ。この関数は前半 (Track Namespace まで) を
 * 組み立てる。namespace 単体をログ等へ出すときに使う。各フィールドのバイトは
 * escapeFullTrackNameSegment の規則でエスケープする。
 *
 * Track Namespace Field は §8.7 が 1 バイト以上を MUST とするため、空の
 * フィールドは区切りと区別できず Error にする。
 *
 * @throws Error 空の Track Namespace Field を渡したとき
 */
export function formatTrackNamespace(trackNamespace: readonly string[]): string {
  const namespaceSegments: string[] = [];
  for (const [index, field] of trackNamespace.entries()) {
    if (field.length === 0) {
      throw new Error(
        `track namespace field at index ${index} must not be empty per draft-ietf-moq-transport-21 §8.7`,
      );
    }
    namespaceSegments.push(escapeFullTrackNameSegment(field));
  }
  return namespaceSegments.join("-");
}

/**
 * Full Track Name の文字列表現を組み立てる
 *
 * draft-ietf-moq-transport-21 §8.8 (Representing Namespace and Track Names):
 * ログ等の用途で推奨される形式として、Track Namespace の各フィールドを "-" で
 * 並べ、Track Name を "--" でつなぐ。Track Namespace の部分は
 * formatTrackNamespace が組み立て、Track Name のバイトは
 * escapeFullTrackNameSegment の規則でエスケープする。draft-ietf-moq-msf-01
 * §11.1.2 は同じ形式を MSF fragment の namespace-name 文字列に使う
 * (`parseMsfFragmentValue` が parse 側)。
 *
 * "/" などの区切りで連結した文字列と違い、この表現は namespace のフィールド
 * 境界と Track Name の境界が一意に読める (fullTrackNameKey の doc コメントが
 * 挙げる曖昧さが無い)。
 *
 * Track Name は §8.7 が空を許すため、空でも描画する。
 *
 * @throws Error 空の Track Namespace Field を渡したとき
 */
export function formatFullTrackName(trackNamespace: readonly string[], trackName: string): string {
  return `${formatTrackNamespace(trackNamespace)}--${escapeFullTrackNameSegment(trackName)}`;
}
