/**
 * MOQT Full Track Name
 * draft-ietf-moq-transport-22 Section 2.4.1 (Track Naming)
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
 * draft-ietf-moq-transport-22 §2.4.1:
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
 * §8.8 の文字列表現でそのまま書ける byte かどうか
 *
 * draft-ietf-moq-transport-22 §8.8: a-z / A-Z / 0-9 / _ (0x5f) は literal で表し、
 * それ以外の byte は "." に続けて小文字 16 進 2 桁で表す。
 */
function isLiteralByte(byte: number): boolean {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x5f
  );
}

/**
 * Track Namespace Field / Track Name の 1 セグメントをエスケープする
 *
 * draft-ietf-moq-transport-22 §8.8:
 * バイト a-z / A-Z / 0-9 / _ (0x5f) はそのまま、それ以外のバイトは "." に続けて
 * 小文字 16 進 2 桁で表す。プロトコルは文字列をバイト列として扱うため、UTF-8 の
 * バイトごとにエスケープする。
 */
function escapeFullTrackNameSegment(value: string): string {
  let escaped = "";
  for (const byte of fullTrackNameEncoder.encode(value)) {
    if (isLiteralByte(byte)) {
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
 * draft-ietf-moq-transport-22 §8.8 (Representing Namespace and Track Names):
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
        `track namespace field at index ${index} must not be empty per draft-ietf-moq-transport-22 §8.7`,
      );
    }
    namespaceSegments.push(escapeFullTrackNameSegment(field));
  }
  return namespaceSegments.join("-");
}

/**
 * Full Track Name の文字列表現を組み立てる
 *
 * draft-ietf-moq-transport-22 §8.8 (Representing Namespace and Track Names):
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

/**
 * Track Namespace Field / Track Name の 1 セグメントを解析する
 *
 * draft-ietf-moq-transport-22 §8.8: literal は a-z / A-Z / 0-9 / _ (0x5f) に限られ、
 * それ以外の byte は "." に続けて小文字 16 進 2 桁で書く。literal で書ける byte を
 * hex で書いた場合 (".61" など) も拒否する (§8.8 は規則どおりでない名前の解析を
 * MUST reject とする)。復号した byte 列は UTF-8 として解釈する。
 *
 * @param position - エラーメッセージに出す位置 (例: "track namespace field at index 0")
 * @throws Error 予約外の literal 文字 / 小文字 16 進 2 桁でない percent-encoding /
 *   literal で書ける byte の hex 表現 / UTF-8 として読めない byte 列
 */
function parseFullTrackNameSegment(segment: string, position: string): string {
  // literal は 1 byte、"." + 16 進 2 桁は 1 byte として積み、最後にまとめて UTF-8 化する
  const bytes: number[] = [];
  let index = 0;
  while (index < segment.length) {
    const character = segment[index];
    if (character === undefined) {
      // index < segment.length のループ条件により到達しない (型を絞るためのガード)
      throw new Error(`unexpected end of ${position} per draft-ietf-moq-transport-22 §8.8`);
    }
    if (character === ".") {
      if (index + 2 >= segment.length) {
        throw new Error(
          `"." must be followed by two lowercase hexadecimal digits in ${position} per draft-ietf-moq-transport-22 §8.8`,
        );
      }
      const hex = segment.slice(index + 1, index + 3);
      if (!/^[0-9a-f]{2}$/.test(hex)) {
        throw new Error(
          `percent-encoding must use two lowercase hexadecimal digits in ${position}, got ".${hex}" per draft-ietf-moq-transport-22 §8.8`,
        );
      }
      const byte = Number.parseInt(hex, 16);
      if (isLiteralByte(byte)) {
        throw new Error(
          `byte ".${hex}" must be written literally in ${position} because it is in [A-Za-z0-9_] per draft-ietf-moq-transport-22 §8.8`,
        );
      }
      bytes.push(byte);
      index += 3;
    } else if (/[A-Za-z0-9_]/.test(character)) {
      bytes.push(character.charCodeAt(0));
      index += 1;
    } else {
      throw new Error(
        `character "${character}" in ${position} is not in [A-Za-z0-9_] and must be percent-encoded as "." followed by two lowercase hexadecimal digits per draft-ietf-moq-transport-22 §8.8`,
      );
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
  } catch {
    throw new Error(
      `percent-encoded bytes in ${position} are not valid UTF-8 per draft-ietf-moq-transport-22 §8.8`,
    );
  }
}

/**
 * Track Namespace の文字列表現を解析する
 *
 * draft-ietf-moq-transport-22 §8.8 (Representing Namespace and Track Names) が
 * ログ等の用途で RECOMMENDED とする表現 (各フィールドを "-" で並べ、literal で
 * 書けない byte を "." + 小文字 16 進 2 桁で書く) を Track Namespace のフィールド列へ
 * 戻す。formatTrackNamespace の逆変換であり、draft-ietf-moq-msf-01 §11.1.2 の
 * namespace-name 文字列と同じ規則を使う。
 *
 * "/" で連結した文字列と違い、フィールド自身が "-" や "/" を含んでもエスケープで
 * 区別できるため、組み立てと解析でフィールド列が変わらない。
 *
 * 空文字列は 0 フィールドの Track Namespace として解析する (formatTrackNamespace([])
 * と同じ)。Track Namespace Field は §8.7 が 1 バイト以上を MUST とするため、空の
 * フィールドは区切りと区別できず Error にする。
 *
 * @throws Error 空の Track Namespace Field / §8.8 の規則に合わない文字列
 */
export function parseTrackNamespace(value: string): string[] {
  if (value.length === 0) {
    return [];
  }
  return value.split("-").map((field, index) => {
    if (field.length === 0) {
      throw new Error(
        `track namespace field at index ${index} must not be empty per draft-ietf-moq-transport-22 §8.7`,
      );
    }
    return parseFullTrackNameSegment(field, `track namespace field at index ${index}`);
  });
}
