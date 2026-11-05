/**
 * C4M DevTools のアクションの表示
 *
 * draft-ietf-moq-transport-23 §A.7 の draft-17 の項目にあるとおり、
 * CLIENT_SETUP と SERVER_SETUP は 1 つの SETUP メッセージに統合された。
 * draft-ietf-moq-c4m-02 Table 1 のアクションも SETUP (1) だけを持つ。
 *
 * 画面では C4M 02 Table 1 の表示名をそのまま使う。表示名はすべて異なるため、
 * 複数の claim アクションを 1 つの表示名へまとめる処理は持たない。
 */

import { C4M } from "moqt-js";

/** 画面で扱う 1 つのアクション (表示名と claim のアクション) */
interface NamedAction {
  /** 表示名 (例: "SETUP") */
  name: string;
  /** claim のアクション */
  action: C4M.MoqtAction;
}

/**
 * 表示用のアクションの一覧
 *
 * `C4M.MOQT_ACTIONS` の順を保ち、各アクションの表示名を付ける。
 * draft-ietf-moq-c4m-02 Table 1 の表示名はすべて異なる。
 */
export const NAMED_ACTIONS: readonly NamedAction[] = C4M.MOQT_ACTIONS.map((action) => ({
  name: C4M.moqtActionName(action),
  action,
}));

/**
 * 表示名に対応する claim のアクションを返す (表に無ければ undefined)
 */
function actionFromDisplayName(name: string): C4M.MoqtAction | undefined {
  return NAMED_ACTIONS.find((candidate) => candidate.name === name)?.action;
}

/**
 * 表示名のアクションがトークンで許可されているかどうかを返す
 *
 * C4M 02 Table 1 の表示名は claim のアクションと 1 対 1 に対応するため、
 * 単一の action だけで認可を判定する。
 */
export function isActionAllowedByName(
  claims: C4M.CatClaims,
  name: string,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): boolean {
  const action = actionFromDisplayName(name);
  if (action === undefined) {
    return false;
  }
  return C4M.authorizeCatClaims(claims, action, namespace, trackName);
}

/**
 * claim のアクション番号を表示名にする (表に無い値は数値のまま)
 */
export function actionDisplayName(action: number): string {
  const key = C4M.moqtActionFromKey(action);
  return key === undefined ? String(action) : C4M.moqtActionName(key);
}

/**
 * claim のアクション番号の一覧を表示名にする (同じ表示名は 1 つにまとめる)
 */
export function actionDisplayNames(actions: readonly number[]): string[] {
  return [...new Set(actions.map((action) => actionDisplayName(action)))];
}
