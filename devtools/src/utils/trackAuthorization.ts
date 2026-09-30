import type { AuthorizationToken, CatalogTrack } from "moqt-js";

/**
 * トラックの購読オプションに載せる Authorization Token を組み立てる
 *
 * draft-ietf-moq-msf-01 §5.2.42 / §11.4.1: track の `authInfo` は認可が必要であるシグナル。
 * §11.4.3: track に紐づくトークンは、そのトラックに関係する AUTHORIZATION TOKEN パラメータを
 * 受け付けるすべての制御メッセージ (SUBSCRIBE / FETCH / REQUEST_UPDATE) へ MUST 付与する
 * (SETUP に載せていても免除されない)。
 *
 * moqt-js が SETUP に載せたトークン (`Session.setupAuthorizationToken`。MOQT URI の
 * msf fragment の c4m から解決したもの、または手入力の Authorization Token) をそのまま使う。
 *
 * catalog トラックは `authInfo` を知る前に購読するため、この関数ではなく
 * `session.setupAuthorizationToken` を直接使う (moqt-js の createMediaSubscriber と同じ規則)。
 *
 * @param track catalog の track (track を解決できない場合は undefined)
 * @param setupAuthorizationToken moqt-js が SETUP に載せたトークン
 * @returns 購読オプションへ展開するオブジェクト。付与しない場合は空のオブジェクト
 *   (exactOptionalPropertyTypes では optional なフィールドに undefined を渡せないため)
 */
export function subscribeAuthorizationTokenOptions(
  track: CatalogTrack | undefined,
  setupAuthorizationToken: AuthorizationToken | undefined,
): { authorizationToken?: AuthorizationToken } {
  if (setupAuthorizationToken === undefined) {
    return {};
  }
  // authInfo が無い track は認可が不要なため付与しない
  if (track?.authInfo === undefined || Object.keys(track.authInfo).length === 0) {
    return {};
  }
  return { authorizationToken: setupAuthorizationToken };
}

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
