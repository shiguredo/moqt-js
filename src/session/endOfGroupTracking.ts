/**
 * Track Alias 単位の END_OF_GROUP 最終 Object ID 追跡
 *
 * draft-ietf-moq-transport-21 §12.1 (Malformed Track) の条件 4:
 * "An Object is received in a Group whose Object ID is larger than the final
 *  Object in the Group. The final Object in a Group is the Object with Status
 *  END_OF_GROUP, or the last Object before a FIN in a Subgroup which has the
 *  END_OF_GROUP bit set."
 * を判定するために、確定した Group の最終 Object ID を保持する。
 *
 * Group の最終 Object は Subgroup ストリームをまたいで既知になる (同じ Group の
 * 別 Subgroup で END_OF_GROUP の Object を受信した時点で確定する) ため、購読単位
 * ではなく Track Alias と Group ID 単位でセッションに保持する。Subgroup は Full
 * Track Name を直接持たないため、キーは Track Alias と Group ID の 2 段 Map に
 * する。Track Alias の購読が尽きた時点で、その Track Alias のエントリをまとめて
 * 破棄する。
 *
 * 保持件数には上限がある。上限を超えた場合は最も古いエントリから破棄する。破棄した
 * Track Alias / Group では既知の最終 Object ID が無いために §12.1 条件 4 の判定
 * 自体を行わない。そのため多数の Track Alias / Group を扱う購読では、上限を超えた分
 * について条件 4 の超過を検出できなくなるが、検出漏れだけが生じ、誤検出は生まない。
 */

/**
 * 追跡する Track Alias の上限
 *
 * 超過時は最も古い Track Alias のエントリを丸ごと破棄する。
 */
const MAX_TRACKED_TRACK_ALIASES = 1024;

/**
 * 1 つの Track Alias で追跡する Group の上限
 *
 * 超過時はその Track Alias の最も古い Group から破棄する。
 */
const MAX_TRACKED_GROUPS_PER_ALIAS = 1024;

/**
 * Track Alias と Group ID 単位の最終 Object ID 追跡
 *
 * 第 1 段のキーが Track Alias、第 2 段のキーが Group ID、値が Group の最終
 * Object ID である。内側の Map の反復順は Group の初回挿入順であり、上限を
 * 超えたときに最も古い Group から破棄するために使う。
 *
 * 追跡状態の Map そのものを識別するための型エイリアスである。複数の追跡を
 * まとめた record である PriorGapTracking と違い、追加のフィールドは持たない。
 *
 * 保持件数の最悪値は MAX_TRACKED_TRACK_ALIASES × MAX_TRACKED_GROUPS_PER_ALIAS
 * 件 (1,048,576 件) である。上限で破棄した Track Alias / Group では既知の最終
 * Object ID が無いため、§12.1 条件 4 の超過を検出できなくなる (検出漏れのみで
 * 誤検出は生まない)。
 */
export type EndOfGroupTracking = Map<bigint, Map<bigint, bigint>>;

/**
 * Group の最終 Object ID を記録する
 *
 * Track Alias のエントリが無ければ作り、上限を超えていれば最も古い Track Alias の
 * エントリを丸ごと破棄する。Group のエントリが無ければ作り、上限を超えていれば
 * その Track Alias の最も古い Group を破棄する。
 *
 * 破棄ループは新しい Group を挿入するときだけ回す。既存 Group の上書きは
 * Map.set が挿入順を変えないため、他の Group を破棄しなくても件数は増えない
 * (上書きで他の Group を失わない)。
 *
 * 上限で破棄した Track Alias / Group では既知の最終 Object ID が無くなり、
 * §12.1 条件 4 の超過を検出できなくなる。検出漏れだけが生じ、誤検出は生まない。
 * 上限で破棄した Track Alias が後で再登録されても、破棄した Group の履歴は戻らない
 * ため、その Track Alias では破棄した Group の超過を検出できないままになる。
 */
export function recordEndOfGroupFinalObjectId(
  tracking: EndOfGroupTracking,
  trackAlias: bigint,
  groupId: bigint,
  finalObjectId: bigint,
): void {
  let groupsByGroupId = tracking.get(trackAlias);
  if (groupsByGroupId === undefined) {
    // Map の反復順は挿入順であり、先頭が最も古い Track Alias である
    while (tracking.size >= MAX_TRACKED_TRACK_ALIASES) {
      const oldest = tracking.keys().next();
      if (oldest.done === true) {
        break;
      }
      tracking.delete(oldest.value);
    }
    groupsByGroupId = new Map<bigint, bigint>();
    tracking.set(trackAlias, groupsByGroupId);
  }
  if (!groupsByGroupId.has(groupId)) {
    // 内側の Map の反復順も挿入順であり、先頭が最も古い Group である
    while (groupsByGroupId.size >= MAX_TRACKED_GROUPS_PER_ALIAS) {
      const oldest = groupsByGroupId.keys().next();
      if (oldest.done === true) {
        break;
      }
      groupsByGroupId.delete(oldest.value);
    }
  }
  groupsByGroupId.set(groupId, finalObjectId);
}

/**
 * Group の最終 Object ID を取り出す (未登録は undefined)
 *
 * 上限で破棄した Track Alias / Group は未登録として undefined を返す。呼び出し側は
 * undefined のとき §12.1 条件 4 の判定を行わないため、超過を検出できなくなるだけで
 * 誤検出は生まない。
 */
export function getEndOfGroupFinalObjectId(
  tracking: EndOfGroupTracking,
  trackAlias: bigint,
  groupId: bigint,
): bigint | undefined {
  return tracking.get(trackAlias)?.get(groupId);
}

/**
 * Track Alias のエントリを丸ごと破棄する
 *
 * 破棄してよいのは、その Track Alias の購読が 1 つも残っていない時点だけである。
 * 判定は呼び出し側 (bidi 層) が購読の残存を確認して行う。前方一致の全走査と
 * キー文字列の生成を行わず、Track Alias をキーにした 1 操作で Group ごとの
 * エントリもまとめて消える。
 *
 * 破棄した Track Alias では既知の最終 Object ID が無くなり、§12.1 条件 4 の
 * 超過を検出できなくなる (検出漏れのみで誤検出は生まない)。
 */
export function clearEndOfGroupTracking(tracking: EndOfGroupTracking, trackAlias: bigint): void {
  tracking.delete(trackAlias);
}
