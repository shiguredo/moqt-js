/**
 * C4M DevTools のアクションの表示
 *
 * draft-17 は CLIENT_SETUP と SERVER_SETUP を 1 つの SETUP メッセージに統合し、
 * claim も draft-ietf-moq-c4m-02 Table 1 で SETUP (1) に統一された。
 * 画面では同じ表示名のアクションを 1 つにまとめ、認可判定はいずれかが許可されていれば
 * 許可とする。
 */

import { C4M } from "moqt-js";

/** 画面で扱うアクション (MOQT のメッセージ名でまとめたもの) */
export interface ActionGroup {
  /** 表示名 (例: "SETUP") */
  name: string;
  /** この表示に対応する claim のアクション (同じ表示名のアクションをまとめたもの) */
  actions: readonly C4M.MoqtAction[];
}

/**
 * 表示用のアクションの一覧
 *
 * `C4M.MOQT_ACTIONS` の順を保ち、同じ表示名のアクションは 1 つにまとめる。
 */
export const ACTION_GROUPS: readonly ActionGroup[] = buildActionGroups();

function buildActionGroups(): ActionGroup[] {
  const byName = new Map<string, C4M.MoqtAction[]>();
  for (const action of C4M.MOQT_ACTIONS) {
    const name = C4M.moqtActionName(action);
    const actions = byName.get(name);
    if (actions === undefined) {
      byName.set(name, [action]);
      continue;
    }
    actions.push(action);
  }
  return [...byName.entries()].map(([name, actions]) => ({ name, actions }));
}

/**
 * 表示名のアクションがトークンで許可されているかどうかを返す
 *
 * SETUP のように複数の claim アクションに対応する表示は、どれか 1 つでも許可されていれば
 * 許可とする。
 */
export function isActionAllowedByName(
  claims: C4M.CatClaims,
  name: string,
  namespace: Uint8Array[],
  trackName: Uint8Array,
): boolean {
  const group = ACTION_GROUPS.find((candidate) => candidate.name === name);
  if (group === undefined) {
    return false;
  }
  return group.actions.some((action) =>
    C4M.authorizeCatClaims(claims, action, namespace, trackName),
  );
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
