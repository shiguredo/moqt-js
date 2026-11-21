/**
 * 公開済み Track registry と SUBSCRIBE_TRACKS のデータ面
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * publisher は受信 SUBSCRIBE_TRACKS の Track Namespace Prefix と
 * TRACK_PROPERTY_FILTER に一致する Track へ PUBLISH を返す。受信 PUBLISH の
 * subscriber 側処理 (src/session/incomingPublish.ts) とは逆方向であり、
 * ここでは Session が publisher としての状態だけを扱う。
 *
 * - 公開済み Track の registry (`Session.publishedTracks`) の登録・解除
 * - 受信 SUBSCRIBE_TRACKS への一致判定と結果 PUBLISH の送信
 * - 複数 PUBLISH subscription への Object / Datagram の fan-out
 * - PUBLISH_SKIPPED の送信と再 PUBLISH の抑止
 *
 * 同じ Full Track Name を複数回 Session.publish した場合は 1 つの
 * PublishedTrackState を共有する。Track Alias は subscription ごとに別の値を
 * 割り当て、既存の publisherStreams / publisherSendQueues (Track Alias キー) を
 * subscription ごとの配信状態の分離にそのまま使う。
 */

import type { Publisher, PublisherImpl, SendDatagramParams, SendObjectParams } from "../publisher";
import type { Parameter } from "../message/parameter";
import type { Property } from "../properties";
import { MessageParameterType, MessageType, PublishDoneStatusCode } from "../message/types";
import { encodePublishSkippedPayload } from "../message/namespace";
import {
  createTrackNamespace,
  decodeLocationFilterParameter,
  encodeTrackName,
} from "../message/parameter";
import { encodeVarint } from "../varint";
import { trackPropertyFiltersMatch } from "../filter";
import { fullTrackNameKey } from "../fullTrackName";
import { RequestError } from "../error";
import type { BidiSessionInternal } from "./bidi";
import type { IncomingTracksSubscriptionState, PublishedTrackState } from "./types";
import { requestsPublishFromSubscribeTracks, type RequestsSessionInternal } from "./requests";
import { matchNamespacePrefix } from "./params";

/**
 * SUBSCRIBE_TRACKS から結果 PUBLISH へコピーする Parameter Type
 *
 * draft-ietf-moq-transport-23 §9.8 (PUBLISH) の明示一覧のうち、§3.6.2 が
 * subscription の初期条件として結果 PUBLISH に載せるとするものである。
 * - AUTHORIZATION_TOKEN は §9.19.2 の MUST NOT によりコピーしない
 * - PAUSED は subscription.paused から送信時に組み立てる
 * - Range Filters / TRACK_PROPERTY_FILTER は送信時の評価にだけ使い、PUBLISH には載せない
 * - INCLUDE_PROPERTIES は PUBLISH の parameter ではなく、Track Properties の
 *   空 / 非空に反映する (§9.19.22)
 * - FILL_PARAMETERS は載せない。結果 PUBLISH の FILL_PARAMETERS は publisher に
 *   fill fetch ストリームを開く義務を負わせる (§3.4) が、結果 PUBLISH の送信経路は
 *   アプリの Session.publish の経路であり、fill fetch ストリームを送る実装を持たない。
 *   約束を果たせない parameter を載せないための制限である (docs にも記載する)。
 */
const PUBLISH_COPYABLE_PARAMETER_TYPES: ReadonlySet<number> = new Set([
  MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
  MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
  MessageParameterType.SUBSCRIBER_PRIORITY,
  MessageParameterType.LOCATION_FILTER,
  MessageParameterType.GROUP_ORDER,
]);

/**
 * PublisherImpl の registry キーから PublishedTrackState を引く
 *
 * PublisherImpl は登録時に registry のキーを保持する。未登録の Publisher
 * (テストが直接組み立てたものや、PUBLISH のフレーミング前に失敗したもの) は
 * null を返し、後始末を no-op にする。
 */
function publishedTracksFindState(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
): PublishedTrackState | undefined {
  const key = publisher.getPublishedTrackKey();
  if (key === null) {
    return undefined;
  }
  return session.publishedTracks.get(key);
}

/**
 * 受信 SUBSCRIBE_TRACKS の既定認可に使う一致判定
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * publisher は namespace 購読を認可しなければならない (MUST)。認可コールバックが
 * 無い場合の既定は「prefix が active な PUBLISH_NAMESPACE または公開済み Track に
 * 一致すれば受理」である。0 フィールドの prefix は publisher の全 Track 購読を
 * 意味するため、公開済み Track または active な PUBLISH_NAMESPACE が 1 つ以上
 * あれば一致する (matchNamespacePrefix は空 prefix で常に一致する)。
 *
 * @param namespacePrefix - 受信 SUBSCRIBE_TRACKS の Track Namespace Prefix
 * @returns 一致する Track / namespace がある場合 true
 */
export function publishedTracksHasMatch(
  session: BidiSessionInternal,
  namespacePrefix: string[],
): boolean {
  for (const track of session.publishedTracks.values()) {
    if (matchNamespacePrefix(track.namespace, namespacePrefix) !== null) {
      return true;
    }
  }
  // PUBLISH_NAMESPACE で広告済みの namespace も、その namespace が active な間は
  // 将来公開される Track の購読対象になる (§3.6 / §7.7)。
  for (const publication of session.namespacePublications.values()) {
    if (publication.state !== "active") {
      continue;
    }
    if (matchNamespacePrefix(publication.namespace, namespacePrefix) !== null) {
      return true;
    }
  }
  return false;
}

/**
 * アプリが publish した PublisherImpl を公開済み Track registry に登録する
 *
 * 同じ Full Track Name を複数回 Session.publish した場合は既存の
 * PublishedTrackState を共有し、Publisher の集合に追加する。Track Properties は
 * 最初の公開時のもの (PUBLISH に載せたもの) を TRACK_PROPERTY_FILTER の評価に使う。
 *
 * draft-ietf-moq-transport-23 §3.6.3 (Skipped Tracks):
 * アプリがその Track を新たに公開した時点で、その公開単位について
 * PUBLISH_SKIPPED の抑止を解除する (PUBLISH_SKIPPED は単一の PUBLISH に
 * scoped される)。そのため、登録時に active な受信 SUBSCRIBE_TRACKS の
 * publishSkipped からこの Full Track Name を消す。
 *
 * 登録後、既に受理済みの受信 SUBSCRIBE_TRACKS のうち一致する要求へ結果 PUBLISH を
 * 送る (§3.6: 受理時と、その後に公開された Track の両方が対象)。
 */
export function publishedTracksRegisterPublisher(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
  namespace: string[],
  trackName: string,
  trackProperties: Property[],
): PublishedTrackState {
  const key = fullTrackNameKey(namespace, trackName);
  let track = session.publishedTracks.get(key);
  if (track === undefined) {
    track = {
      key,
      // §2.4.1: prefix の照合にも、TextEncoder が送る Unicode 文字列を使う。
      namespace: namespace.map((field) => field.toWellFormed()),
      trackName: trackName.toWellFormed(),
      trackProperties: [...trackProperties],
      // draft-ietf-moq-transport-23 §7.1 / §12.1:
      // 同じ Track の同じ (Group, Object) は、どの PUBLISH subscription へ送るときも
      // 同じ Subgroup ID / Publisher Priority で送る。Track で最初に Subgroup を
      // 開いた値を 1 つだけ持ち、全 subscription が同じオブジェクトを参照する。
      sharedSubgroup: {
        groupId: null,
        subgroupId: null,
        publisherPriority: null,
        firstObjectId: null,
      },
      sharedLargestLocation: { largest: null },
      publishers: new Set(),
      subscriptions: new Set(),
    };
    session.publishedTracks.set(key, track);
  }
  track.publishers.add(publisher);
  publisher.setPublishedTrackContext(key, "app");
  publisher.setSharedSubgroupState(track.sharedSubgroup);
  publisher.setSharedLargestLocation(track.sharedLargestLocation);
  publisher.setTrackProperties(track.trackProperties);

  for (const subscription of session.incomingTracksSubscriptions.values()) {
    if (subscription.state !== "active") {
      continue;
    }
    subscription.publishSkipped.delete(key);
    publishedTracksPublishTrackIfMatching(session, subscription, track);
  }
  return track;
}

/**
 * PUBLISH_OK (REQUEST_OK) を受けて確立した subscription を registry に追加する
 *
 * draft-ietf-moq-transport-23 §3.6 / §6.3:
 * 結果 PUBLISH の PUBLISH_OK を受けるまで購読は確立しないため、Object / Datagram の
 * fan-out 対象には PUBLISH_OK を受けてから加える。アプリの Publisher も同じ経路を
 * 通る (publishSendObject は PUBLISH_OK 後にしか呼べない)。
 *
 * registry から Track が既に削除されている場合は何もしない (Track 終了後の
 * PUBLISH_OK は、結果 PUBLISH の送信側が PUBLISH_DONE で閉じる)。
 */
export function publishedTracksOnSubscriptionEstablished(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
): void {
  const track = publishedTracksFindState(session, publisher);
  if (track === undefined) {
    return;
  }
  track.subscriptions.add(publisher);
}

/**
 * PUBLISH が確立できなかったときの registry 後始末
 *
 * draft-ietf-moq-transport-23 §5.1 / §9.5.2:
 * PUBLISH_ERROR (REQUEST_ERROR) や送信失敗で確立できなかった subscription は
 * 以後その Track の購読として扱わない。アプリの Publisher が PUBLISH_ERROR で
 * 終了し、その Full Track Name の Publisher が 1 つも残らなくなった場合は、
 * 既に確立している SUBSCRIBE_TRACKS 由来の subscription にも PUBLISH_DONE
 * (TRACK_ENDED) を送り、registry から Track を削除する。
 */
export function publishedTracksOnPublishFailure(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
): void {
  const track = publishedTracksFindState(session, publisher);
  if (track === undefined) {
    return;
  }
  track.subscriptions.delete(publisher);
  if (publisher.getPublishedTrackOrigin() !== "app") {
    return;
  }
  track.publishers.delete(publisher);
  if (track.publishers.size === 0) {
    void publishedTracksCloseTrack(session, track);
  }
}

/**
 * subscription の正常終了 (Publisher.done / REQUEST_UPDATE 失敗) の registry 後始末
 *
 * draft-ietf-moq-transport-23 §3.1.1 / §3.6:
 * - アプリの Publisher.done() は、その Publisher の PUBLISH subscription だけを
 *   閉じる。同じ Track の他の Publisher が残っている間は registry を維持する。
 * - その Full Track Name の最後の Publisher が終了したら、SUBSCRIBE_TRACKS 由来の
 *   subscription にも PUBLISH_DONE (TRACK_ENDED) を送り、registry から削除する。
 * - 派生 subscription の終了は、その subscription だけを registry から外す。
 *
 * PUBLISH_DONE の送信後に呼ぶ (publishSendPublishDone が requestStreams と
 * publishers を削除済みのため、ここでは registry の Sets だけを操作する)。
 */
export async function publishedTracksOnSubscriptionDone(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
): Promise<void> {
  const track = publishedTracksFindState(session, publisher);
  if (track === undefined) {
    return;
  }
  track.subscriptions.delete(publisher);

  if (publisher.getPublishedTrackOrigin() === "app") {
    track.publishers.delete(publisher);
    if (track.publishers.size > 0) {
      return;
    }
  } else if (track.publishers.size > 0) {
    return;
  }
  await publishedTracksCloseTrack(session, track);
}

/**
 * peer cancel (STOP_SENDING / RESET_STREAM) を受けた subscription の registry 後始末
 *
 * draft-ietf-moq-transport-23 §3.1.2:
 * peer のキャンセルはその subscription だけを閉じ、同じ Track の他の subscription は
 * 維持する。アプリの Publisher の subscription がキャンセルされた場合も、その
 * Full Track Name の最後の Publisher が終了したものとして扱う (§3.6)。
 * PUBLISH_DONE は peer が購読をキャンセル済みのため送らない
 * (bidi の handlePublishPeerCancel がストリームを reset する)。
 */
export async function publishedTracksOnPeerCancel(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
): Promise<void> {
  const track = publishedTracksFindState(session, publisher);
  if (track === undefined) {
    return;
  }
  track.subscriptions.delete(publisher);
  if (publisher.getPublishedTrackOrigin() !== "app") {
    return;
  }
  track.publishers.delete(publisher);
  if (track.publishers.size === 0) {
    await publishedTracksCloseTrack(session, track);
  }
}

/**
 * Track の最後のアプリ Publisher が終了したときの後始末
 *
 * registry から Track を削除し、SUBSCRIBE_TRACKS 由来の subscription に
 * PUBLISH_DONE (TRACK_ENDED) を送る。データストリームの FIN を待ってから
 * PUBLISH_DONE を送る (draft-ietf-moq-transport-23 §9.9: PUBLISH_DONE は
 * 開いたストリームをすべて閉じた後に送る MUST)。
 */
async function publishedTracksCloseTrack(
  session: BidiSessionInternal,
  track: PublishedTrackState,
): Promise<void> {
  const { key } = track;
  if (session.publishedTracks.get(key) === track) {
    session.publishedTracks.delete(key);
  }

  const closes: Promise<void>[] = [];
  for (const subscription of track.subscriptions) {
    track.subscriptions.delete(subscription);
    if (subscription.getPublishedTrackOrigin() === "subscribe-tracks") {
      closes.push(publishedTracksCloseDerivedSubscription(session, subscription));
    }
  }
  await Promise.all(closes);
}

/**
 * 派生 subscription (SUBSCRIBE_TRACKS 由来) を PUBLISH_DONE (TRACK_ENDED) で閉じる
 *
 * draft-ietf-moq-transport-23 §9.9 / §12.4:
 * 通常終了は TRACK_ENDED を使う。Track 終了時はアプリの Publisher.done() と違い、
 * データストリームの FIN 完了を待ってから PUBLISH_DONE を送る。
 * セッション終了済みの場合は送信を試行せず closed にする (writer は transport
 * 終了で閉じる)。
 */
async function publishedTracksCloseDerivedSubscription(
  session: BidiSessionInternal,
  publisher: PublisherImpl,
): Promise<void> {
  if (publisher.state === "closed") {
    return;
  }
  if (session.sessionState === "closed") {
    publisher.markClosed();
    return;
  }
  try {
    // done() / REQUEST_UPDATE 失敗と同じ donePromise 排他を通す。ピア起点の
    // REQUEST_UPDATE 失敗と同時に Track 終了が起きても PUBLISH_DONE は 1 回だけ
    // 送られ、データストリームの FIN 完了を待ってから送信される (§9.9)。
    await publisher.terminate(PublishDoneStatusCode.TRACK_ENDED);
  } catch {
    // ストリームが既に閉じている等の失敗は、Track 終了の後始末を止めない
  } finally {
    publisher.markClosed();
  }
}

/**
 * 受理済みの受信 SUBSCRIBE_TRACKS へ、一致する公開済み Track の PUBLISH を送る
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * 受理時点で既に公開されている Track が対象である。その後に公開される Track は
 * publishedTracksRegisterPublisher が送る。既にこの要求から PUBLISH した Track と
 * PUBLISH_SKIPPED を送った Track には送らない (§9.5.2 / §3.6.3)。
 *
 * 送信は detached で行う (応答 REQUEST_OK の処理を待たせない)。
 */
export function publishedTracksOnSubscriptionAccepted(
  session: BidiSessionInternal,
  subscription: IncomingTracksSubscriptionState,
): void {
  if (subscription.state !== "active") {
    return;
  }
  publishedTracksPublishMatches(session, subscription);
}

/**
 * 受理済みの受信 SUBSCRIBE_TRACKS に一致する全公開済み Track の PUBLISH を送る
 *
 * 一致判定は「Track Namespace Prefix に一致」かつ「TRACK_PROPERTY_FILTER を通過」
 * である (draft-ietf-moq-transport-23 §3.6.1 / §3.3.2)。フィルタを通らない Track には
 * PUBLISH も PUBLISH_SKIPPED も送らない。
 */
function publishedTracksPublishMatches(
  session: BidiSessionInternal,
  subscription: IncomingTracksSubscriptionState,
): void {
  if (subscription.state !== "active") {
    return;
  }
  // 送信中に registry が変化し得るため、値の配列にしてから走査する
  const tracks = [...session.publishedTracks.values()];
  for (const track of tracks) {
    publishedTracksPublishTrackIfMatching(session, subscription, track);
  }
}

/**
 * 1 つの公開済み Track が要求に一致すれば、結果 PUBLISH を送る
 *
 * draft-ietf-moq-transport-23 §3.6 (Subscribing to Tracks by Prefix):
 * - 要求ごとに新しい PUBLISH を送る (既存 PUBLISH を再利用しない)
 * - 新しい Request ID と Track Alias を採番し、SUBSCRIBE_TRACKS_ID を載せる
 * - 同じ要求から同じ Track を再 PUBLISH しない (§9.5.2)
 * - 送信できなかった場合は PUBLISH_SKIPPED を送り、次にアプリがその Track を
 *   公開するまで PUBLISH を送らない (§3.6.3)
 */
function publishedTracksPublishTrackIfMatching(
  session: BidiSessionInternal,
  subscription: IncomingTracksSubscriptionState,
  track: PublishedTrackState,
): void {
  if (subscription.state !== "active") {
    return;
  }
  // 新規公開や prefix 更新の再照合では、登録時に作った比較キーを再利用する。
  const { key } = track;
  if (subscription.publishedTracks.has(key)) {
    return;
  }
  if (subscription.publishSkipped.has(key)) {
    return;
  }
  if (matchNamespacePrefix(track.namespace, subscription.namespacePrefix) === null) {
    return;
  }
  // draft-ietf-moq-transport-23 §3.6.1 / §3.3.2:
  // TRACK_PROPERTY_FILTER を通過しない Track には PUBLISH も PUBLISH_SKIPPED も送らない。
  if (!trackPropertyFiltersMatch(subscription.rangeFilters, track.trackProperties)) {
    return;
  }

  const trackProperties = publishedTracksResolveTrackProperties(subscription, track);
  const extraParameters = publishedTracksBuildPublishParameters(subscription);
  // §9.5.2: 同じ SUBSCRIBE_TRACKS で既に PUBLISH した Track を再 PUBLISH しては
  // ならない。送信を開始した時点で記録する (応答待ちの間に再送しない)。
  subscription.publishedTracks.add(key);

  const requestSession = session as unknown as RequestsSessionInternal;
  try {
    const promise = requestsPublishFromSubscribeTracks(
      requestSession,
      track.namespace,
      track.trackName,
      {
        // §9.8 / §9.19.18: PAUSED は結果 PUBLISH の初期状態として載せる。
        // false のときは既定値 0 と同じなので parameter を省略する。
        publishOptions: { paused: subscription.paused },
        extraParameters,
        trackProperties,
        onCreated: (publisher) => {
          publisher.setPublishedTrackContext(key, "subscribe-tracks");
          // 結果 PUBLISH の購読は、同じ Track の他の subscription と Subgroup ID /
          // Publisher Priority を共有する (§7.1 / §12.1)。Group の途中から
          // 確立した場合は、Track 共通の Subgroup ID を EXPLICIT で使う。
          publisher.setSharedSubgroupState(track.sharedSubgroup);
          publisher.setSharedLargestLocation(track.sharedLargestLocation);
          // INCLUDE_PROPERTIES=0 で PUBLISH から省略しても、送信条件には元の値を使う。
          publisher.setTrackProperties(track.trackProperties);
          publishedTracksApplySubscriptionFilters(publisher, subscription);
        },
      },
    );
    // draft-ietf-moq-transport-23 §3.6:
    // 結果 PUBLISH の送信を開始した時点で統計へ加算する。PUBLISH_SKIPPED に
    // なった場合は加算しない (送信したのは PUBLISH ではない)。
    session.statsSubscribeTracksPublishSent++;
    promise.then(
      (resolved: Publisher) => {
        // PUBLISH_OK より先に Track が終了した場合は、確立した購読を
        // PUBLISH_DONE (TRACK_ENDED) で閉じる。
        const publisher = resolved as PublisherImpl;
        const current = session.publishedTracks.get(key);
        if (current === undefined || current !== track) {
          void publishedTracksCloseDerivedSubscription(session, publisher);
          return;
        }
        current.subscriptions.add(publisher);
      },
      (error: unknown) => {
        // draft-ietf-moq-transport-23 §3.6.3:
        // 結果 PUBLISH を送れなかった場合は PUBLISH_SKIPPED を送る。
        // ピアが REQUEST_ERROR で拒否した場合は PUBLISH 自体は送信済みであり、
        // PUBLISH_SKIPPED の対象ではない。再 PUBLISH もしない (§9.5.2)。
        if (error instanceof RequestError) {
          return;
        }
        if (session.sessionState === "closed") {
          return;
        }
        subscription.publishedTracks.delete(key);
        publishedTrackSendSkipped(session, subscription, track.namespace, track.trackName);
      },
    );
  } catch {
    // フレーミングなどの同期失敗。PUBLISH は送れていないため PUBLISH_SKIPPED を
    // 送り、publishSkipped に記録して次の公開まで再試行しない (§3.6.3)。
    subscription.publishedTracks.delete(key);
    publishedTrackSendSkipped(session, subscription, track.namespace, track.trackName);
  }
}

/**
 * 受信 SUBSCRIBE_TRACKS の INCLUDE_PROPERTIES を結果 PUBLISH の Track Properties に反映する
 *
 * draft-ietf-moq-transport-23 §9.19.22 (INCLUDE_PROPERTIES Parameter):
 * INCLUDE_PROPERTIES は PUBLISH の parameter ではなく、0 のときに結果 PUBLISH の
 * Track Properties を空にする。省略時は既定 1 のため、公開済み Track の
 * Track Properties をそのまま載せる。
 */
function publishedTracksResolveTrackProperties(
  subscription: IncomingTracksSubscriptionState,
  track: PublishedTrackState,
): Property[] {
  const includeProperties = subscription.parameters.find(
    (parameter) => parameter.type === MessageParameterType.INCLUDE_PROPERTIES,
  );
  if (includeProperties === undefined) {
    return [...track.trackProperties];
  }
  return includeProperties.value[0] === 0 ? [] : [...track.trackProperties];
}

/**
 * 結果 PUBLISH に載せる追加 parameter を組み立てる
 *
 * draft-ietf-moq-transport-23 §3.6.2 / §9.8 / §9.19.21:
 * - §9.8 の PUBLISH 許可一覧のうち、subscription の初期条件になる parameter だけを
 *   SUBSCRIBE_TRACKS から引き継ぐ
 * - AUTHORIZATION_TOKEN はコピーしない (§9.19.2 の MUST NOT)
 * - Range Filters / TRACK_PROPERTY_FILTER / INCLUDE_PROPERTIES は載せない
 * - FILL_PARAMETERS は載せない。fill fetch ストリームを送る実装が無く、
 *   §3.4 の fill の約束を果たせないためである (PUBLISH_COPYABLE_PARAMETER_TYPES 参照)
 * - PAUSED は subscription.paused から buildPublishParameters が組み立てる
 * - SUBSCRIBE_TRACKS_ID に受信 SUBSCRIBE_TRACKS の Request ID を載せる
 */
function publishedTracksBuildPublishParameters(
  subscription: IncomingTracksSubscriptionState,
): Parameter[] {
  const parameters: Parameter[] = [];
  for (const parameter of subscription.parameters) {
    if (!PUBLISH_COPYABLE_PARAMETER_TYPES.has(parameter.type)) {
      continue;
    }
    // 受信時の値をそのまま使う。Message Parameter の Value のエンコーディングは
    // メッセージ種別ではなく Parameter Type ごとに定義されている (§9.19)。
    parameters.push({ type: parameter.type, value: parameter.value });
  }
  parameters.push({
    type: MessageParameterType.SUBSCRIBE_TRACKS_ID,
    value: encodeVarint(subscription.requestId),
  });
  return parameters;
}

/**
 * 派生 subscription の PublisherImpl に購読ごとの送信条件を反映する
 *
 * draft-ietf-moq-transport-23 §3.3.1 / §3.3.2:
 * LOCATION_FILTER は送信 Object の範囲、Range Filters は Object の通過判定に使う。
 * どちらも結果 PUBLISH の parameter ではなく、送信時の評価にだけ使う。
 */
function publishedTracksApplySubscriptionFilters(
  publisher: PublisherImpl,
  subscription: IncomingTracksSubscriptionState,
): void {
  const locationFilterParameter = subscription.parameters.find(
    (parameter) => parameter.type === MessageParameterType.LOCATION_FILTER,
  );
  if (locationFilterParameter !== undefined) {
    try {
      publisher.setLocationFilter(decodeLocationFilterParameter(locationFilterParameter));
    } catch {
      // 受信側で検証済みの値である。ここで decode できなければ、フィルタ無しとして
      // 送信を継続する (受信経路のエラー処理を重複させない)。
    }
  }
  // REQUEST_UPDATE で削除されたフィルタ (Length=0) は適用しない。
  const activeFilters = subscription.rangeFilters.filter((spec) => !("remove" in spec));
  publisher.setRangeFilters(activeFilters);
}

/**
 * PUBLISH_SKIPPED を応答ストリームへ送る
 *
 * draft-ietf-moq-transport-23 §3.6.3 (Skipped Tracks) / §9.18 (PUBLISH_SKIPPED):
 * 双方向ストリームを確保できないなど PUBLISH を送れない場合、SUBSCRIBE_TRACKS の
 * 応答ストリームへ PUBLISH_SKIPPED を送る。Track Namespace Suffix は要求の
 * Track Namespace Prefix を除いた部分である。prefix に一致しない Track には
 * 何も送らない。
 *
 * 送った Full Track Name は subscription.publishSkipped に記録し、アプリがその
 * Track を新たに公開するまで PUBLISH を送らない (§3.6.3 の MUST NOT)。
 * 応答送信はベストエフォートであり、フレーミング / write の失敗は黙殺する
 * (既存の応答送信と同じ扱い)。送信キューに入った時点で再 PUBLISH を抑止する。
 */
export function publishedTrackSendSkipped(
  session: BidiSessionInternal,
  subscription: IncomingTracksSubscriptionState,
  namespace: string[],
  trackName: string,
): void {
  if (subscription.state !== "active") {
    return;
  }
  if (session.sessionState === "closed") {
    return;
  }
  const key = fullTrackNameKey(namespace, trackName);
  // 既に PUBLISH を送った Track には送らない (PUBLISH_SKIPPED は PUBLISH の代替)。
  if (subscription.publishedTracks.has(key)) {
    return;
  }
  if (subscription.publishSkipped.has(key)) {
    return;
  }
  const suffix = matchNamespacePrefix(
    namespace,
    subscription.responseNamespacePrefix ?? subscription.namespacePrefix,
  );
  if (suffix === null) {
    return;
  }
  const controlWriter = session.controlWriter;
  if (controlWriter === undefined) {
    return;
  }

  let payload: Uint8Array;
  let message: Uint8Array;
  try {
    payload = encodePublishSkippedPayload({
      type: MessageType.PUBLISH_SKIPPED,
      trackNamespaceSuffix: createTrackNamespace(suffix),
      trackName: encodeTrackName(trackName),
    });
    message = controlWriter.encode(MessageType.PUBLISH_SKIPPED, payload);
  } catch {
    // フレーミングできない場合は送れない (ベストエフォート)
    return;
  }

  try {
    // REQUEST_OK 直後の再照合でも、先にキューに入れた通知と PUBLISH を重ねない。
    const writing = subscription.writer.write(message);
    subscription.publishSkipped.add(key);
    void writing.then(
      () => {
        session.statsPublishSkipped++;
      },
      () => {
        subscription.publishSkipped.delete(key);
      },
    );
  } catch {
    // 応答ストリームが既に閉じている場合は無視する
  }
  try {
    session.emitDebug("send", MessageType.PUBLISH_SKIPPED, payload, {
      requestId: subscription.requestId.toString(),
      trackNamespaceSuffix: suffix,
      trackName,
    });
  } catch {
    // アプリの debug コールバック例外は無視する
  }
}

/**
 * 同じ Track の他の PUBLISH subscription へ Object を fan-out する
 *
 * draft-ietf-moq-transport-23 §3.1 (Subscriptions):
 * "The publisher MUST send the object once per subscription if it matches the
 *  filters of that subscription."
 * 呼び出した PublisherImpl 自身への送信は完了している前提であり、他の
 * subscription だけを対象にする。各 subscription の paused / Location Filter /
 * Range Filters の評価と状態更新は PublisherImpl.sendObjectToSubscription が行う
 * (公開 API の sendObject と同じ経路を使い、購読ごとに独立した失敗として扱う)。
 *
 * draft-ietf-moq-transport-23 §7.1 / §12.1:
 * 同じ (Group, Object) を異なる Subgroup ID / Publisher Priority で送ってはならない。
 * そのため、Track 共通の Subgroup の値 (PublishedTrackState.sharedSubgroup) を
 * fan-out 元と各 subscription が共有する。fan-out 元がその Group で最初に送った
 * 値が Track 共通の値になり、Group の途中から確立した subscription は同じ値を
 * EXPLICIT で使う (PublisherImpl.resolveSubgroupForObject)。
 */
export function publishedTracksFanOutObject(
  session: BidiSessionInternal,
  source: PublisherImpl,
  params: SendObjectParams,
  providedAtMs: number,
): void {
  const track = publishedTracksFindState(session, source);
  if (track === undefined) {
    return;
  }
  for (const subscription of track.subscriptions) {
    if (subscription === source || subscription.state === "closed") {
      continue;
    }
    try {
      const result = subscription.sendObjectToSubscription(params, providedAtMs);
      // 購読ごとの送信失敗は publishSendObject が handleError で通知する。
      // 返値の reject を未処理にしない (呼び出し元の sendObject の結果は変えない)。
      void result.catch(() => {});
    } catch {
      // 走査中に閉じた subscription 等。他の subscription への配信は継続する。
    }
  }
}

/**
 * 同じ Track の他の PUBLISH subscription へ Datagram を fan-out する
 *
 * draft-ietf-moq-transport-23 §3.1 / §11.2:
 * Datagram も subscription ごとに 1 回ずつ送る。Datagram は Subgroup を持たないため
 * SUBGROUP_FILTER は不通過になり、Priority を省略した Datagram は既定の
 * Publisher Priority 128 として評価される (§10.4)。
 *
 * draft-ietf-moq-transport-23 §7.1:
 * 同じ Object を異なる Delivery Mode / Priority で送っても Malformed になる。
 * fan-out は同じ SendDatagramParams を全 subscription へ渡すため、Delivery Mode は
 * Datagram のまま、Priority も同じ値になる (購読ごとに書き換えないこと)。
 */
export function publishedTracksFanOutDatagram(
  session: BidiSessionInternal,
  source: PublisherImpl,
  params: SendDatagramParams,
  providedAtMs: number,
): void {
  const track = publishedTracksFindState(session, source);
  if (track === undefined) {
    return;
  }
  for (const subscription of track.subscriptions) {
    if (subscription === source || subscription.state === "closed") {
      continue;
    }
    try {
      const result = subscription.sendDatagramToSubscription(params, providedAtMs);
      void result.catch(() => {});
    } catch {
      // 走査中に閉じた subscription 等。他の subscription への配信は継続する。
    }
  }
}
