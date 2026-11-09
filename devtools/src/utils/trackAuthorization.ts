import type { AuthorizationToken } from "moqt-js";

// 購読 (SUBSCRIBE / FETCH) のトークンの組み立てはライブラリの共有実装
// (src/mediaSubscriber/trackSubscriptions.ts の resolveAuthorizationToken / subscribeTrack) が
// 持つ。本モジュールは publisher の PUBLISH / PUBLISH_NAMESPACE だけを扱う
/**
 * PUBLISH / PUBLISH_NAMESPACE に載せる Authorization Token を組み立てる
 *
 * draft-ietf-moq-msf-01 §11.4.3: track に紐づくトークンは、そのトラックに関係する
 * AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与する。
 * publisher は PUBLISH と PUBLISH_NAMESPACE が対象であり、SETUP に載せたトークンを
 * そのまま使う (subscriber 側と違い authInfo のような事前のシグナルは無い)。
 *
 * @param setupAuthorizationToken moqt-js が SETUP に載せたトークン
 * @returns PUBLISH オプションへ展開するオブジェクト。付与しない場合は空のオブジェクト
 *   (exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため)
 */
export function publishAuthorizationTokenOptions(
  setupAuthorizationToken: AuthorizationToken | undefined,
): { authorizationToken?: AuthorizationToken } {
  if (setupAuthorizationToken === undefined) {
    return {};
  }
  return { authorizationToken: setupAuthorizationToken };
}
