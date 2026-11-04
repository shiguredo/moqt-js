/**
 * MOQT Session の純粋関数群
 *
 * WebTransport や SessionImpl の状態に依存しない、入出力が明確な関数。
 * PBT (Property-Based Testing) の対象。
 */

import { FetchHeaderType } from "../dataStream";
import type { FetchRequestRange } from "../fetcher";
import type {
  Parameter,
  Location,
  LocationFilter,
  AuthorizationToken,
  RangeFilterSpec,
} from "../message";
import type {
  PublishOptions,
  SubscribeOptions,
  SubscribeTracksOptions,
  FetchOptions,
  FillRequestOptions,
  TrackStatusOptions,
} from "./publicTypes";
import {
  createTrackNamespace,
  MessageParameterType,
  GroupOrder,
  encodeAuthorizationToken,
  encodeFillParameters,
  encodeLocationFilterParameter,
  encodeRangeFilter,
  encodeUint8ParameterValue,
  validatePausedValue,
  getParameterLocationValue,
  isNextObjectLocationFilter,
  validateLocationFilterEndGroup,
} from "../message";
import { MAX_VARINT, decodeVarint, encodeVarint } from "../varint";
import { TrackPropertyId, generateGreaseProperty, type Property } from "../properties";
import { LOCPropertyId } from "../loc";
import { InvalidFilterError, ProtocolViolationError, SessionErrorCode } from "../error";

// ============================================================================
// 値域検証ヘルパー
// ============================================================================

/**
 * 値が 0 以上であることを検証する
 * draft-ietf-moq-transport-22 §9.20.4, §9.20.6, §9.20.16, §9.20.19, §10.1, §10.2
 */
export function validateNonNegative(value: bigint, name: string): void {
  if (value < 0n) {
    throw new Error(`${name} must not be negative: ${value}`);
  }
}

/**
 * Range Filter を区別するキーを生成する
 *
 * 同一型 (0x25–0x29) で SetID / Property Type が異なるエントリは
 * draft-ietf-moq-transport-22 §3.3.2 の「MAY appear multiple times」に従い
 * 別エントリとして扱う。マージ・反映・検証の各経路で同一のキーを使い、
 * 結果の一致を構造的に保証する。
 */
export function rangeFilterKey(spec: RangeFilterSpec): string {
  if ("remove" in spec) {
    // remove エントリはマージ結果に保存されない (型単位の削除) が、
    // 型の網羅性のための分岐
    return `${spec.type}:remove`;
  }
  return `${spec.type}:${spec.setId}:${spec.propertyType ?? ""}`;
}

/**
 * Range Filter パラメータの「削除・置換・不変」マージ
 *
 * draft-ietf-moq-transport-22 §3.3.2 (Range Filters):
 * "In REQUEST_UPDATE, Length of 0 removes the filter; non-zero replaces
 *  it entirely. If a filter parameter is omitted from REQUEST_UPDATE,
 *  it is unchanged." に従う:
 * - update に remove (Length=0): 当該パラメータ型 (0x25–0x29) 全体を削除
 * - update に非 remove エントリ: 当該パラメータ型全体を置換 (他の型は不変)
 * - update に現れない型: 不変
 *
 * 同一型の複数エントリ (異なる SetID / Property Type) は MAY appear multiple
 * times に従い保持される。同一 update 内で同型の remove と非 remove が
 * 混在する場合、最終効果は置換 (非 remove 優先) になる (仕様では挙動が
 * 定義されていないため、既存挙動を維持する)。
 * 送信前検証 (MAX_FILTER_RANGES) とフィルタ状態の反映
 * (SubscriberImpl.setRangeFilters 等) の両経路で同一実装を共有し、
 * 結果の一致を構造的に保証する。
 */
export function mergeRangeFilters(
  current: RangeFilterSpec[],
  update: RangeFilterSpec[],
): RangeFilterSpec[] {
  // 現在のフィルタを保持し、update で指定された型のみ削除・置換する
  const next = new Map<string, RangeFilterSpec>();
  for (const spec of current) {
    next.set(rangeFilterKey(spec), spec);
  }

  // remove エントリと非 remove エントリを分離する。
  // 非 remove エントリに出現する型は「置換」のため、既存の同型エントリを
  // すべて削除してから、非 remove エントリをまとめて追加する (1 件ずつ
  // 全削除すると同型の複数エントリが最後の 1 件以外すべて失われるため)。
  const removedTypes = new Set<string>();
  const replaceSpecs: RangeFilterSpec[] = [];
  for (const spec of update) {
    if ("remove" in spec) {
      removedTypes.add(spec.type);
    } else {
      replaceSpecs.push(spec);
    }
  }

  // Length=0 の削除: 当該パラメータ型全体 (全 SetID / Property Type) を削除
  for (const type of removedTypes) {
    for (const key of next.keys()) {
      if (key.startsWith(`${type}:`)) {
        next.delete(key);
      }
    }
  }

  // 非ゼロ Length の置換: 当該パラメータ型全体を置き換える
  for (const spec of replaceSpecs) {
    for (const key of next.keys()) {
      if (key.startsWith(`${spec.type}:`)) {
        next.delete(key);
      }
    }
  }
  for (const spec of replaceSpecs) {
    next.set(rangeFilterKey(spec), spec);
  }

  return [...next.values()];
}

/**
 * 購読単位で数える Range Filter の一覧を組み立てる
 *
 * draft-ietf-moq-transport-22 §9.1.6 の MAX_FILTER_RANGES は "a given
 * subscription or fetch" の Ranges 合計を制限する。fill 内側の Range Filter も
 * 同じ購読に載るため合算する。§9.20.15 は FILL_PARAMETERS の内側を独立した
 * parameter scope と定めるが、これは §9.20 の重複検査のための限定であり
 * (「Parameters inside it are not considered to appear in the enclosing message
 * for the purposes of Section 9.20」)、§9.1.6 の購読単位の合算からは除外されない。
 * fill を別予算と読む余地はあるが、REQUEST_UPDATE の
 * 送信検証 (src/session/bidi.ts の bidiSendRequestUpdate) と受信側の数え上げ
 * (同 countIncomingRangeFilterRanges) が同じく合算する保守側の扱いであり、
 * それに揃える。SUBSCRIBE / SUBSCRIBE_TRACKS の初回送信はこの関数で合算する。
 * REQUEST_UPDATE は現在のフィルタと in-flight の更新も合算するため、この関数を
 * 使わず bidiSendRequestUpdate 側で組み立てる。
 *
 * @param rangeFilters - 購読本体の Range Filter
 * @param fill - fill 要求 (fill 内側の Range Filter を含む)
 */
export function collectSubscriptionRangeFilters(
  rangeFilters: RangeFilterSpec[] | undefined,
  fill: FillRequestOptions | undefined,
): RangeFilterSpec[] {
  return [...(rangeFilters ?? []), ...(fill?.rangeFilters ?? [])];
}

/**
 * ピアの MAX_FILTER_RANGES に対して Range Filter の送信が許可されるかを検証する
 *
 * draft-ietf-moq-transport-22 §9.1.6 (MAX FILTER RANGES):
 * "The default value is 0, so if not specified, the peer MUST NOT send
 *  any such filter parameters. If this limit is exceeded, an endpoint
 *  MUST reject this with REQUEST_ERROR with error code INVALID_FILTER."
 *
 * moqt-js はクライアントのため、送信前に throw して不正なワイヤを防ぐ。
 * REQUEST_UPDATE の削除 (Length=0) は Ranges を消費しないため除外する。
 *
 * @param rangeFilters - 送信する Range Filter 指定
 * @param peerMaxFilterRanges - ピアの MAX_FILTER_RANGES (0 = 送信禁止)
 * @param contextName - エラーメッセージ用のコンテキスト名
 */
export function validateRangeFilterLimits(
  rangeFilters: RangeFilterSpec[] | undefined,
  peerMaxFilterRanges: number,
  contextName: string,
): void {
  if (rangeFilters === undefined || rangeFilters.length === 0) {
    return;
  }
  if (peerMaxFilterRanges === 0) {
    throw new Error(
      `cannot send range filters in ${contextName}: peer MAX_FILTER_RANGES is 0 (not advertised)`,
    );
  }
  const totalRanges = rangeFilters.reduce(
    (sum, f) => sum + ("ranges" in f ? f.ranges.length : 0),
    0,
  );
  if (totalRanges > peerMaxFilterRanges) {
    throw new Error(
      `cannot send range filters in ${contextName}: total ranges ${totalRanges} exceeds peer MAX_FILTER_RANGES ${peerMaxFilterRanges}`,
    );
  }
}

/**
 * Range Filter 送信ガードを検証する
 *
 * draft-ietf-moq-transport-22 §3.3.2 (Range Filters):
 * - 削除 (Length=0) は REQUEST_UPDATE のみに定義される (§3.3.2「In REQUEST_UPDATE,
 *   Length can be 0 to remove a filter parameter」)。他メッセージでの指定は
 *   仕様未定義のため送信前に throw する
 * - TRACK_PROPERTY_FILTER (0x29) は SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ
 *   許可される。他メッセージでの指定は §9.19.1 により対向が INVALID_PARAMETER
 *   でセッションを閉じる実害があるため、送信前に throw する
 * - 同一組み合わせ (Type, SetID, [Property Type]) の重複は in any message で
 *   MUST 拒否 (INVALID_FILTER)。Length=0 の削除エントリは SetID / Property Type
 *   を持たないため重複判定の対象外
 *
 * この関数はメッセージ種別ごとの許可を options で切り替える純関数であり、
 * MAX_FILTER_RANGES ガード (validateRangeFilterLimits) とは別に呼び出す。
 *
 * @param rangeFilters - 送信する Range Filter 指定
 * @param contextName - エラーメッセージ用のコンテキスト名
 * @param options - メッセージごとの許可設定
 * @param options.allowRemove - 削除 (Length=0) を許可するか (REQUEST_UPDATE のみ true)
 * @param options.allowTrackProperty - TRACK_PROPERTY_FILTER (0x29) を許可するか
 *                                    (SUBSCRIBE_TRACKS のみ true)
 */
export function validateRangeFilterSpecs(
  rangeFilters: RangeFilterSpec[] | undefined,
  contextName: string,
  options: { allowRemove: boolean; allowTrackProperty: boolean },
): void {
  if (rangeFilters === undefined || rangeFilters.length === 0) {
    return;
  }

  const seenCombinations = new Set<string>();
  for (const spec of rangeFilters) {
    // TRACK_PROPERTY_FILTER (0x29) は SUBSCRIBE_TRACKS / その REQUEST_UPDATE のみ (§3.3.2)。
    // 削除エントリ (Length=0) でも 0x29 は載せられないため、削除チェックより先に判定する。
    if (spec.type === "trackProperty" && !options.allowTrackProperty) {
      throw new Error(
        `cannot send TRACK_PROPERTY_FILTER in ${contextName}: only allowed in SUBSCRIBE_TRACKS`,
      );
    }

    // 削除 (Length=0) は REQUEST_UPDATE のみ (§3.3.2)
    if ("remove" in spec) {
      if (!options.allowRemove) {
        throw new Error(
          `cannot remove range filters in ${contextName}: remove is only allowed in REQUEST_UPDATE`,
        );
      }
      // 削除エントリは SetID / Property Type を持たないため重複判定の対象外
      continue;
    }

    // 同一組み合わせ (Type, SetID, [Property Type]) の重複は MUST 拒否 (§3.3.2)
    // RangeFilterRemove は continue 済みのため、ここでは RangeFilterParam に絞られる。
    // キーはマージ・反映と共通の rangeFilterKey を使う。
    const combinationKey = rangeFilterKey(spec);
    if (seenCombinations.has(combinationKey)) {
      throw new Error(`duplicate range filter combination in ${contextName}: ${combinationKey}`);
    }
    seenCombinations.add(combinationKey);
  }
}

/**
 * DEFAULT PUBLISHER PRIORITY の値域 (0-255) を検証する
 * draft-ietf-moq-transport-22 §10.4:
 * 「The value is from 0 to 255 and lower numbers get higher priority.
 *  Priorities above 255 are invalid.」
 */
const DEFAULT_PUBLISHER_PRIORITY_MIN = 0;
const DEFAULT_PUBLISHER_PRIORITY_MAX = 255;

// ============================================================================
// Track Namespace 送信検証
// ============================================================================

/**
 * 送信前に Track Namespace が送信できる値かを検証する
 *
 * draft-ietf-moq-transport-22 §8.7 (Track Namespace Structure) / §2.4.1:
 * Track Namespace は 0〜32 フィールドで、各フィールドは 1 バイト以上、合計は 4,096 バイト
 * 以下 (違反した値を受信したピアは INVALID_TRACK_NAMESPACE または
 * FIELD_LENGTH_EXCEEDED でセッションを閉じる)。判定は送信時のエンコードと同じ
 * createTrackNamespace に任せ、規則を 2 か所に持たない。
 *
 * draft-ietf-moq-transport-22 §2.4.3 (Reserved Namespaces):
 * "MOQT reserves all Track Namespace values whose first tuple field
 *  begins with a period (0x2e, .). These namespaces MUST NOT be used
 *  unless their meaning is defined through IANA registration."
 * また先頭フィールドが "." 単体の namespace は "MUST NOT be used for any purpose"。
 *
 * draft-ietf-moq-transport-22 §6.5 (Session-Level Tracks and Namespaces):
 * "The Application MUST NOT publish tracks or namespaces whose first field
 *  is .session."
 * "A request with a Track Namespace whose first field is .session and an
 *  empty Track Name MUST be rejected with DOES_NOT_EXIST."
 *
 * moqt-js はクライアント実装であり IANA 登録済みの予約 namespace を定義しないため、
 * 先頭フィールドが "." で始まるすべての namespace (".session" 含む) を送信対象として
 * 拒否する。拒否は送信前の同期 throw であり、アプリケーションの入力ミスとして
 * セッションは閉じない (プロトコル違反ではない)。
 *
 * Full Track Name (Track Namespace と Track Name の合計) の 4,096 バイト上限は Track Name を
 * 含めて判定するため、Request の送信時に validateFullTrackName が検証する。
 *
 * @param namespace - 送信対象の Track Namespace
 * @param trackName - Track Name。namespace スコープ外のリクエスト (SUBSCRIBE_NAMESPACE /
 *                    SUBSCRIBE_TRACKS / PUBLISH_NAMESPACE) では省略する
 * @throws Error §8.7 の構造の制約 (33 フィールド以上 / 空のフィールド / 4,096 バイト超) /
 *   予約 namespace / session-level namespace (§6.5) の場合
 */
export function validateTrackNamespaceForSend(
  namespace: readonly string[],
  trackName?: string,
): void {
  // draft-ietf-moq-transport-22 §8.7 (Track Namespace Structure) / §2.4.1:
  // Track Namespace は 0〜32 フィールドで、各フィールドは 1 バイト以上、合計は 4,096 バイト
  // 以下。違反した値は仕様準拠のピアがセッションを閉じるため、送信側で fail-fast で拒否する
  // (受信したワイヤの違反ではないため ProtocolViolationError は使わない)。判定は送信時の
  // エンコード (createTrackNamespace → assertTrackNamespaceTuple) と同じ実装を使う。
  createTrackNamespace(namespace);
  if (namespace.length === 0) {
    return;
  }
  const first = namespace[0];
  if (first === undefined) {
    // 上の namespace.length === 0 の検証により到達しない (型を絞るためのガード)
    return;
  }
  if (!first.startsWith(".")) {
    return;
  }
  if (first === ".") {
    // §2.4.3: 先頭フィールドが "." 単体の namespace は IANA 登録でも使えず
    // "MUST NOT be used for any purpose" (先頭が "." で始まる他の値とは扱いが異なる)
    throw new Error('track namespace "." must not be used for any purpose (DOES_NOT_EXIST)');
  }
  if (first === ".session") {
    if (trackName === "") {
      throw new Error(
        "track with .session namespace and empty track name does not exist (DOES_NOT_EXIST)",
      );
    }
    throw new Error(
      "session-level namespace .session is reserved for the MOQT implementation (MUST NOT be used by applications)",
    );
  }
  throw new Error(
    `reserved namespace prefix ${first} is not allowed (MUST NOT be used without IANA registration)`,
  );
}

// ============================================================================
// PUBLISH 用
// ============================================================================

/**
 * 純粋関数: PUBLISH の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-22 Section 9.20
 */
export function buildPublishParameters(options?: PublishOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // EXPIRES (0x08) - draft-ietf-moq-transport-22 Section 9.20.16 (EXPIRES Parameter)
  if (options?.expires !== undefined) {
    validateNonNegative(options.expires, "EXPIRES");
    parameters.push({
      type: MessageParameterType.EXPIRES,
      value: encodeVarint(options.expires),
    });
  }

  // PAUSED (0x11) - draft-ietf-moq-transport-23 Section 9.19.18 (PAUSED Parameter)
  // 既定値は 0 (unpaused) のため、明示的に true (1 = paused) のときだけ送信する。
  // draft-22 の FORWARD (0x10) は 1 = 転送するだったため、値の意味が反転している。
  if (options?.paused === true) {
    parameters.push({
      type: MessageParameterType.PAUSED,
      value: encodeUint8ParameterValue(1, "PAUSED"),
    });
  }

  // AUTHORIZATION TOKEN (0x03) - draft-ietf-moq-transport-22 Section 9.20.2
  // draft-ietf-moq-msf-01 §11.4.3: publisher は track に紐づくトークンを PUBLISH に MUST 付与
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  return parameters;
}

/**
 * 純粋関数: PUBLISH の Track Properties を構築する
 *
 * draft-ietf-moq-transport-22 Section 10.1-10.6
 *
 * @param options - PUBLISH オプション
 * @param grease - true のとき GREASE Property（§13）を 1 つ追加する。既定（未指定 / false）では追加しない。
 */
export function buildPublishTrackProperties(
  options?: PublishOptions,
  grease?: boolean,
): Property[] {
  const trackProperties: Property[] = [];

  // OBJECT_DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-22 Section 10.2 (OBJECT_DELIVERY_TIMEOUT)
  if (options?.deliveryTimeout !== undefined) {
    validateNonNegative(options.deliveryTimeout, "OBJECT_DELIVERY_TIMEOUT");
    trackProperties.push({
      id: TrackPropertyId.OBJECT_DELIVERY_TIMEOUT,
      value: options.deliveryTimeout,
    });
  }

  // SUBGROUP_DELIVERY_TIMEOUT (0x06) - draft-ietf-moq-transport-22 Section 10.1 (SUBGROUP_DELIVERY_TIMEOUT)
  if (options?.subgroupDeliveryTimeout !== undefined) {
    validateNonNegative(options.subgroupDeliveryTimeout, "SUBGROUP_DELIVERY_TIMEOUT");
    trackProperties.push({
      id: TrackPropertyId.SUBGROUP_DELIVERY_TIMEOUT,
      value: options.subgroupDeliveryTimeout,
    });
  }

  // MAX_CACHE_DURATION (0x04) - draft-ietf-moq-transport-22 Section 10.3 (MAX CACHE DURATION)
  if (options?.maxCacheDuration !== undefined) {
    validateNonNegative(options.maxCacheDuration, "MAX_CACHE_DURATION");
    trackProperties.push({
      id: TrackPropertyId.MAX_CACHE_DURATION,
      value: options.maxCacheDuration,
    });
  }

  // DEFAULT_PUBLISHER_PRIORITY (0x0e) - draft-ietf-moq-transport-22 Section 10.4 (DEFAULT PUBLISHER PRIORITY)
  if (options?.publisherPriority !== undefined) {
    if (
      options.publisherPriority < DEFAULT_PUBLISHER_PRIORITY_MIN ||
      options.publisherPriority > DEFAULT_PUBLISHER_PRIORITY_MAX
    ) {
      throw new Error(
        `DEFAULT_PUBLISHER_PRIORITY must be in range ${DEFAULT_PUBLISHER_PRIORITY_MIN}-${DEFAULT_PUBLISHER_PRIORITY_MAX}: ${options.publisherPriority}`,
      );
    }
    trackProperties.push({
      id: TrackPropertyId.DEFAULT_PUBLISHER_PRIORITY,
      value: BigInt(options.publisherPriority),
    });
  }

  // DEFAULT_PUBLISHER_GROUP_ORDER (0x22) - draft-ietf-moq-transport-22 Section 10.5 (DEFAULT PUBLISHER GROUP ORDER)
  if (options?.groupOrder !== undefined) {
    if (options.groupOrder !== "Ascending" && options.groupOrder !== "Descending") {
      throw new Error(
        `DEFAULT_PUBLISHER_GROUP_ORDER must be "Ascending" or "Descending": ${options.groupOrder as string}`,
      );
    }
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01n : 0x02n;
    trackProperties.push({
      id: TrackPropertyId.DEFAULT_PUBLISHER_GROUP_ORDER,
      value: groupOrderValue,
    });
  }

  // DYNAMIC_GROUPS (0x30) - draft-ietf-moq-transport-22 Section 10.6 (DYNAMIC GROUPS)
  if (options?.dynamicGroups === true) {
    trackProperties.push({
      id: TrackPropertyId.DYNAMIC_GROUPS,
      value: 1n,
    });
  }

  // LOC TIMESCALE (0x08) - draft-ietf-moq-loc-04 Table 1 (Scope: Track, Object)
  // 偶数 ID のため value 形式。Track 初期化時に広告し Object 単位の冗長送信を削減する。
  if (options?.locTimescale !== undefined) {
    validateNonNegative(options.locTimescale, "LOC TIMESCALE");
    trackProperties.push({
      id: LOCPropertyId.TIMESCALE,
      value: options.locTimescale,
    });
  }

  // LOC VIDEO_CONFIG (0x0D) - draft-ietf-moq-loc-04 Table 1 (Scope: Track, Object)
  // 奇数 ID のため data 形式。
  if (options?.locVideoConfig !== undefined) {
    trackProperties.push({
      id: LOCPropertyId.VIDEO_CONFIG,
      data: options.locVideoConfig,
    });
  }

  // LOC AUDIO_CONFIG (0x0F) - draft-ietf-moq-loc-04 Table 1 (Scope: Track, Object)
  // 奇数 ID のため data 形式。
  if (options?.locAudioConfig !== undefined) {
    trackProperties.push({
      id: LOCPropertyId.AUDIO_CONFIG,
      data: options.locAudioConfig,
    });
  }

  // GREASE Property - draft-ietf-moq-transport-22 §13 (Grease)
  // opt-in 時、0x7f * N + 0x9D パターンの予約値を 1 つ追加する。対向が未知の Property を
  // gracefully に扱えることを保証する。encodeProperties の delta encoding / 昇順ソートは
  // GREASE Property も他 Property と同様に扱うだけで壊れない。
  if (grease === true) {
    trackProperties.push(generateGreaseProperty());
  }

  return trackProperties;
}

// ============================================================================
// SUBSCRIBE 用
// ============================================================================

/**
 * 純粋関数: Range Filter 指定を Message Parameter 配列に変換する
 *
 * draft-ietf-moq-transport-22 Section 8.6 (Range Filter Structure):
 * SUBSCRIBE / SUBSCRIBE_TRACKS / REQUEST_UPDATE で共通のワイヤ形式。
 *
 * @param rangeFilters - Range Filter 指定（追加または削除）
 */
export function buildRangeFilterParameters(rangeFilters: RangeFilterSpec[]): Parameter[] {
  const parameters: Parameter[] = [];
  for (const spec of rangeFilters) {
    const paramType = rangeFilterTypeToParamType(spec.type);
    parameters.push({
      type: paramType,
      value: encodeRangeFilter(spec),
    });
  }
  return parameters;
}

/**
 * 純粋関数: FILL_PARAMETERS の内側 Parameters 列を構築する
 *
 * draft-ietf-moq-transport-22 §9.20.15 Table 7:
 * 内側に載せられるのは FILL_TIMEOUT / SUBSCRIBER_PRIORITY / LOCATION_FILTER /
 * GROUP_ORDER / Range Filters (0x25-0x28) のみ。TRACK_PROPERTY_FILTER は
 * SUBSCRIBE_TRACKS 専用のため fill では許可しない。Range Filter の除去
 * (Length=0) は一回限りの fill 要求に意味を持たないため許可しない
 * (内側 LOCATION_FILTER は Type 0x00 も送信でき、fill 範囲の解釈は
 * 受信側の規則に従う)。
 *
 * @param fill - fill 要求内容
 * @param context - 外側メッセージ種別 (検証メッセージ用)
 */
export function buildFillParameters(
  fill: FillRequestOptions,
  context: "SUBSCRIBE" | "SUBSCRIBE_TRACKS" | "REQUEST_UPDATE",
): Parameter[] {
  const inner: Parameter[] = [];

  // FILL_TIMEOUT (0x0A) - draft-ietf-moq-transport-22 Section 9.20.5
  if (fill.fillTimeout !== undefined) {
    validateNonNegative(fill.fillTimeout, "FILL_TIMEOUT");
    inner.push({
      type: MessageParameterType.FILL_TIMEOUT,
      value: encodeVarint(fill.fillTimeout),
    });
  }

  // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-22 Section 9.20.7 (uint8)
  if (fill.subscriberPriority !== undefined) {
    inner.push({
      type: MessageParameterType.SUBSCRIBER_PRIORITY,
      value: encodeUint8ParameterValue(fill.subscriberPriority, "SUBSCRIBER_PRIORITY"),
    });
  }

  // LOCATION_FILTER (0x21) - draft-ietf-moq-transport-22 Section 9.20.9
  // End Group 超過は encodeLocationFilterParameter が InvalidFilterError で拒否する
  if (fill.filter !== undefined) {
    inner.push(encodeLocationFilterParameter(fill.filter));
  }

  // GROUP_ORDER (0x22) - draft-ietf-moq-transport-22 Section 9.20.8 (uint8)
  if (fill.groupOrder !== undefined) {
    if (fill.groupOrder !== "Ascending" && fill.groupOrder !== "Descending") {
      throw new Error(
        `GROUP_ORDER must be "Ascending" or "Descending": ${fill.groupOrder as string}`,
      );
    }
    const groupOrderValue = fill.groupOrder === "Ascending" ? 0x01 : 0x02;
    inner.push({
      type: MessageParameterType.GROUP_ORDER,
      value: encodeUint8ParameterValue(groupOrderValue, "GROUP_ORDER"),
    });
  }

  // Range Filters (0x25–0x28) - draft-ietf-moq-transport-22 Section 3.3.2
  if (fill.rangeFilters !== undefined) {
    validateRangeFilterSpecs(fill.rangeFilters, context, {
      allowRemove: false,
      allowTrackProperty: false,
    });
    inner.push(...buildRangeFilterParameters(fill.rangeFilters));
  }

  return inner;
}

/**
 * fill fetch ストリームのデコードに使う Group Order を解決する
 *
 * draft-ietf-moq-transport-22 §3.4 / §9.20.15:
 * FILL_PARAMETERS 内の GROUP_ORDER が無ければ subscription の指定、
 * どちらも無ければ Ascending。両省略時に publisher preference を使う規定は
 * あるが、クライアント側は対向の既定値を知り得ないため Ascending に倒す
 * (FETCH の既定値と同一。既知の制限)。
 */
export function resolveFillGroupOrder(
  fillGroupOrder: "Ascending" | "Descending" | undefined,
  subscriptionGroupOrder: "Ascending" | "Descending" | undefined,
): GroupOrder {
  const resolved = fillGroupOrder ?? subscriptionGroupOrder;
  return resolved === "Descending" ? GroupOrder.DESCENDING : GroupOrder.ASCENDING;
}

/**
 * 純粋関数: INCLUDE_PROPERTIES Message Parameter を構築する
 *
 * draft-ietf-moq-transport-22 Section 9.20.21 (INCLUDE_PROPERTIES Parameter):
 * Parameter Type 0x35、uint8。true は 1、false は 0。
 * 省略時 (undefined) は送らない (デフォルト 1 と同等)。
 */
export function buildIncludePropertiesParameter(includeProperties?: boolean): Parameter[] {
  if (includeProperties === undefined) {
    return [];
  }
  return [
    {
      type: MessageParameterType.INCLUDE_PROPERTIES,
      value: encodeUint8ParameterValue(includeProperties ? 1 : 0, "INCLUDE_PROPERTIES"),
    },
  ];
}

/**
 * 純粋関数: SUBSCRIBE の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-23 §9.19 (Control Message Parameters)
 */
export function buildSubscribeParameters(options?: SubscribeOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // LOCATION_FILTER (0x21) - draft-ietf-moq-transport-23 §9.19.9
  if (options?.filter !== undefined) {
    parameters.push(encodeLocationFilterParameter(options.filter));
  }

  // OBJECT_DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-22 Section 9.20.4
  if (options?.deliveryTimeout !== undefined) {
    validateNonNegative(options.deliveryTimeout, "OBJECT_DELIVERY_TIMEOUT");
    parameters.push({
      type: MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
      value: encodeVarint(options.deliveryTimeout),
    });
  }

  // SUBGROUP_DELIVERY_TIMEOUT (0x06) - draft-ietf-moq-transport-22 Section 9.20.3
  if (options?.subgroupDeliveryTimeout !== undefined) {
    validateNonNegative(options.subgroupDeliveryTimeout, "SUBGROUP_DELIVERY_TIMEOUT");
    parameters.push({
      type: MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
      value: encodeVarint(options.subgroupDeliveryTimeout),
    });
  }

  // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-22 Section 9.20.7 (uint8)
  if (options?.subscriberPriority !== undefined) {
    parameters.push({
      type: MessageParameterType.SUBSCRIBER_PRIORITY,
      value: encodeUint8ParameterValue(options.subscriberPriority, "SUBSCRIBER_PRIORITY"),
    });
  }

  // GROUP_ORDER (0x22) - draft-ietf-moq-transport-22 Section 9.20.8 (uint8)
  if (options?.groupOrder !== undefined) {
    if (options.groupOrder !== "Ascending" && options.groupOrder !== "Descending") {
      throw new Error(
        `GROUP_ORDER must be "Ascending" or "Descending": ${options.groupOrder as string}`,
      );
    }
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01 : 0x02;
    parameters.push({
      type: MessageParameterType.GROUP_ORDER,
      value: encodeUint8ParameterValue(groupOrderValue, "GROUP_ORDER"),
    });
  }

  // NEW_GROUP_REQUEST (0x32) - draft-ietf-moq-transport-22 Section 9.20.19 (varint)
  if (options?.newGroupRequest !== undefined) {
    validateNonNegative(options.newGroupRequest, "NEW_GROUP_REQUEST");
    parameters.push({
      type: MessageParameterType.NEW_GROUP_REQUEST,
      value: encodeVarint(options.newGroupRequest),
    });
  }

  // RENDEZVOUS_TIMEOUT (0x04) - draft-ietf-moq-transport-22 Section 9.20.6
  if (options?.rendezvousTimeout !== undefined) {
    validateNonNegative(options.rendezvousTimeout, "RENDEZVOUS_TIMEOUT");
    parameters.push({
      type: MessageParameterType.RENDEZVOUS_TIMEOUT,
      value: encodeVarint(options.rendezvousTimeout),
    });
  }

  // PAUSED (0x11) - draft-ietf-moq-transport-23 Section 9.19.18 (uint8)
  // 既定値は 0 (unpaused) のため、明示的に true (1 = paused) のときだけ送信する。
  if (options?.paused === true) {
    parameters.push({
      type: MessageParameterType.PAUSED,
      value: encodeUint8ParameterValue(1, "PAUSED"),
    });
  }

  // Range Filters (0x25–0x29) - draft-ietf-moq-transport-22 Section 3.3.2
  // 削除は REQUEST_UPDATE のみ・TRACK_PROPERTY_FILTER は SUBSCRIBE_TRACKS のみ (§3.3.2)
  if (options?.rangeFilters !== undefined) {
    validateRangeFilterSpecs(options.rangeFilters, "SUBSCRIBE", {
      allowRemove: false,
      allowTrackProperty: false,
    });
    parameters.push(...buildRangeFilterParameters(options.rangeFilters));
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-22 Section 9.20.2
  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE に MUST 付与。
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  // FILL_PARAMETERS (0x23) - draft-ietf-moq-transport-22 Section 9.20.15
  // fill fetch ストリームを要求する。旧 Joining FETCH の用途をここに寄せる。
  if (options?.fill !== undefined) {
    parameters.push(encodeFillParameters(buildFillParameters(options.fill, "SUBSCRIBE")));
  }

  // INCLUDE_PROPERTIES (0x35) - draft-ietf-moq-transport-22 Section 9.20.21
  parameters.push(...buildIncludePropertiesParameter(options?.includeProperties));

  return parameters;
}

/**
 * Authorization Token の Message Parameter を構築する
 *
 * draft-ietf-moq-transport-22 §8.9 / §9.1.3 / §9.1.4: 呼び出し側は
 * `SessionImpl.normalizeAuthorizationTokenForSend` (送信経路の正規化) を通した
 * トークンを渡す。SETUP の REGISTER の登録成否に応じて USE_ALIAS / USE_VALUE に
 * 変換済みであり、ここでは変換しない。
 */
export function encodeAuthorizationTokenParameter(token: AuthorizationToken): Parameter {
  return {
    type: MessageParameterType.AUTHORIZATION_TOKEN,
    value: encodeAuthorizationToken(token),
  };
}

/**
 * 純粋関数: FETCH の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-23 §9.11 (FETCH):
 * 取得範囲は LOCATION_FILTER パラメータで指定する (§9.19.9)。省略時は
 * フィルタなし ({0, 0} から Largest Object まで) を要求する。
 * §3.2 により FETCH で使えるのは None (0x00) と絶対指定 (0x02 / 0x03 / 0x04)
 * だけで、相対指定 (0x01) と Next Object (0x05) は送信前に InvalidFilterError で
 * 拒否する。
 */
export function buildFetchParameters(options?: FetchOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // LOCATION_FILTER (0x21) - draft-ietf-moq-transport-23 §9.19.9
  // draft-ietf-moq-transport-23 §3.2: 相対指定 (0x01) は INVALID_RANGE、
  // Next Object (0x05) も既存 Object の範囲を指さないため、FETCH では送信前に
  // 拒否する (resolveFetchRequestRange が同じ検証を行う)。
  if (options?.filter !== undefined) {
    resolveFetchRequestRange(options.filter);
    parameters.push(encodeLocationFilterParameter(options.filter));
  }

  // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-22 §9.20.7
  // (SUBSCRIBER PRIORITY Parameter)
  // "The SUBSCRIBER_PRIORITY parameter (Parameter Type 0x20) is a uint8.  It MAY
  //  appear in a SUBSCRIBE, PUBLISH, FETCH, or REQUEST_UPDATE (for a subscription
  //  or FETCH)."
  if (options?.subscriberPriority !== undefined) {
    parameters.push({
      type: MessageParameterType.SUBSCRIBER_PRIORITY,
      value: encodeUint8ParameterValue(options.subscriberPriority, "SUBSCRIBER_PRIORITY"),
    });
  }

  // GROUP_ORDER (0x22) - draft-ietf-moq-transport-22 §9.20.8
  // (GROUP ORDER Parameter)
  // "The GROUP_ORDER parameter (Parameter Type 0x22) is a uint8.  It MAY appear in
  //  a SUBSCRIBE, PUBLISH, SUBSCRIBE_TRACKS, or FETCH, or inside a FILL_PARAMETERS
  //  parameter (see Section 9.20.15)."
  // FETCH_OK には出現できないため、送信側で指定できるのは要求時のみ
  if (options?.groupOrder !== undefined) {
    if (options.groupOrder !== "Ascending" && options.groupOrder !== "Descending") {
      throw new Error(
        `GROUP_ORDER must be "Ascending" or "Descending": ${options.groupOrder as string}`,
      );
    }
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01 : 0x02;
    parameters.push({
      type: MessageParameterType.GROUP_ORDER,
      value: encodeUint8ParameterValue(groupOrderValue, "GROUP_ORDER"),
    });
  }

  // FILL_TIMEOUT (0x0a) - draft-ietf-moq-transport-22 Section 9.20.5
  if (options?.fillTimeout !== undefined) {
    validateNonNegative(options.fillTimeout, "FILL_TIMEOUT");
    parameters.push({
      type: MessageParameterType.FILL_TIMEOUT,
      value: encodeVarint(options.fillTimeout),
    });
  }

  // Range Filters (0x25–0x28) - draft-ietf-moq-transport-22 Section 3.3.2
  // 削除は REQUEST_UPDATE のみ・TRACK_PROPERTY_FILTER は SUBSCRIBE_TRACKS のみ
  if (options?.rangeFilters !== undefined) {
    validateRangeFilterSpecs(options.rangeFilters, "FETCH", {
      allowRemove: false,
      allowTrackProperty: false,
    });
    parameters.push(...buildRangeFilterParameters(options.rangeFilters));
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-22 Section 9.20.2
  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは FETCH に MUST 付与。
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  // INCLUDE_PROPERTIES (0x35) - draft-ietf-moq-transport-22 Section 9.20.21
  parameters.push(...buildIncludePropertiesParameter(options?.includeProperties));

  return parameters;
}

/**
 * 純粋関数: SUBSCRIBE_NAMESPACE の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-22 Section 9.15 (SUBSCRIBE_NAMESPACE)
 */
export function buildSubscribeNamespaceParameters(options?: {
  authorizationToken?: AuthorizationToken;
}): Parameter[] {
  const parameters: Parameter[] = [];

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-22 Section 9.20.2
  // draft-ietf-moq-msf-01 §11.4.3: track に関連するトークンは SUBSCRIBE_NAMESPACE に MUST 付与。
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  return parameters;
}

/**
 * 純粋関数: SUBSCRIBE_TRACKS のパラメータを構築する
 *
 * draft-ietf-moq-transport-23 §9.17 (SUBSCRIBE_TRACKS):
 * 許可される Parameters のうち、単一 Track 専用の RENDEZVOUS_TIMEOUT /
 * NEW_GROUP_REQUEST を除く型を送る (SubscribeTracksOptions の JSDoc を参照)。
 *
 * draft-ietf-moq-transport-23 §3.6.2 (Parameters on SUBSCRIBE_TRACKS):
 * AUTHORIZATION_TOKEN と TRACK_PROPERTY_FILTER は SUBSCRIBE_TRACKS 自身に適用し、
 * それ以外は結果 PUBLISH の subscription の初期条件になる。AUTHORIZATION_TOKEN は
 * §9.19.2 により結果 PUBLISH へ複製してはならない。
 *
 * draft-ietf-moq-transport-23 §3.6.1 (Filtering SUBSCRIBE_TRACKS):
 * "Range Filters Section 3.3.2 can be used in SUBSCRIBE_TRACKS to filter
 *  Tracks in a namespace using the Track Property Filter."
 */
export function buildSubscribeTracksParameters(options?: SubscribeTracksOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // LOCATION_FILTER (0x21) - draft-ietf-moq-transport-23 §9.19.9
  // End Group 超過は encodeLocationFilterParameter が InvalidFilterError で拒否する
  if (options?.filter !== undefined) {
    parameters.push(encodeLocationFilterParameter(options.filter));
  }

  // OBJECT_DELIVERY_TIMEOUT (0x02) - draft-ietf-moq-transport-23 §9.19.4
  if (options?.deliveryTimeout !== undefined) {
    validateNonNegative(options.deliveryTimeout, "OBJECT_DELIVERY_TIMEOUT");
    parameters.push({
      type: MessageParameterType.OBJECT_DELIVERY_TIMEOUT,
      value: encodeVarint(options.deliveryTimeout),
    });
  }

  // SUBGROUP_DELIVERY_TIMEOUT (0x06) - draft-ietf-moq-transport-23 §9.19.3
  if (options?.subgroupDeliveryTimeout !== undefined) {
    validateNonNegative(options.subgroupDeliveryTimeout, "SUBGROUP_DELIVERY_TIMEOUT");
    parameters.push({
      type: MessageParameterType.SUBGROUP_DELIVERY_TIMEOUT,
      value: encodeVarint(options.subgroupDeliveryTimeout),
    });
  }

  // SUBSCRIBER_PRIORITY (0x20) - draft-ietf-moq-transport-23 §9.19.7 (uint8)
  if (options?.subscriberPriority !== undefined) {
    parameters.push({
      type: MessageParameterType.SUBSCRIBER_PRIORITY,
      value: encodeUint8ParameterValue(options.subscriberPriority, "SUBSCRIBER_PRIORITY"),
    });
  }

  // GROUP_ORDER (0x22) - draft-ietf-moq-transport-22 Section 9.20.8 (uint8)
  if (options?.groupOrder !== undefined) {
    if (options.groupOrder !== "Ascending" && options.groupOrder !== "Descending") {
      throw new Error(
        `GROUP_ORDER must be "Ascending" or "Descending": ${options.groupOrder as string}`,
      );
    }
    const groupOrderValue = options.groupOrder === "Ascending" ? 0x01 : 0x02;
    parameters.push({
      type: MessageParameterType.GROUP_ORDER,
      value: encodeUint8ParameterValue(groupOrderValue, "GROUP_ORDER"),
    });
  }

  // PAUSED (0x11) - draft-ietf-moq-transport-23 Section 9.19.18 (uint8)
  // 既定値は 0 (unpaused) のため、明示的に true (1 = paused) のときだけ送信する。
  if (options?.paused === true) {
    parameters.push({
      type: MessageParameterType.PAUSED,
      value: encodeUint8ParameterValue(1, "PAUSED"),
    });
  }

  // Range Filters (0x25–0x29) - draft-ietf-moq-transport-22 Section 3.3.2 / §3.6.1
  // TRACK_PROPERTY_FILTER は SUBSCRIBE_TRACKS で許可される (§3.3.2)。削除は REQUEST_UPDATE のみ
  if (options?.rangeFilters !== undefined) {
    validateRangeFilterSpecs(options.rangeFilters, "SUBSCRIBE_TRACKS", {
      allowRemove: false,
      allowTrackProperty: true,
    });
    parameters.push(...buildRangeFilterParameters(options.rangeFilters));
  }

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-23 §9.19.2
  // "This Parameter MUST NOT be copied from a SUBSCRIBE_TRACKS to the
  //  resulting PUBLISH message Parameters."
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  // FILL_PARAMETERS (0x23) - draft-ietf-moq-transport-23 §9.19.15
  // 内側の Parameter は §9.19.15 の制限に従う (buildFillParameters が検証する)。
  // fill fetch ストリームの関連付けは受信 PUBLISH 側で行う。
  if (options?.fill !== undefined) {
    parameters.push(encodeFillParameters(buildFillParameters(options.fill, "SUBSCRIBE_TRACKS")));
  }

  // INCLUDE_PROPERTIES (0x35) - draft-ietf-moq-transport-22 Section 9.20.21
  parameters.push(...buildIncludePropertiesParameter(options?.includeProperties));

  return parameters;
}

/**
 * 純粋関数: TRACK_STATUS の Message Parameters を構築する
 *
 * draft-ietf-moq-transport-22 Section 9.20.21 (INCLUDE_PROPERTIES Parameter):
 * 省略時は送らない (デフォルト 1 と同等)。
 */
export function buildTrackStatusParameters(options?: TrackStatusOptions): Parameter[] {
  const parameters: Parameter[] = [];

  // AUTHORIZATION_TOKEN (0x03) - draft-ietf-moq-transport-22 Section 9.20.2
  if (options?.authorizationToken !== undefined) {
    parameters.push(encodeAuthorizationTokenParameter(options.authorizationToken));
  }

  // INCLUDE_PROPERTIES (0x35) - draft-ietf-moq-transport-22 Section 9.20.21
  parameters.push(...buildIncludePropertiesParameter(options?.includeProperties));

  return parameters;
}

// ============================================================================
// パラメータ抽出
// ============================================================================

/**
 * 純粋関数: 応答 / PUBLISH のパラメータから LARGEST_OBJECT を抽出する
 *
 * SUBSCRIBE_OK / PUBLISH / FETCH の成功応答 (REQUEST_OK) で使う。
 * draft-ietf-moq-transport-23 §9.19.17 (LARGEST OBJECT Parameter) / §3.1.4
 * (Largest Object):
 * "Largest Object therefore identifies an Object that can still be arriving."
 * 抽出した値は確定値ではなく、後続のメッセージ (REQUEST_UPDATE_OK /
 * PUBLISH_STATE_NOTIFY / 受信 PUBLISH) でさらに進み得る。
 */
export function extractLargestLocation(parameters: Parameter[]): Location | undefined {
  for (const param of parameters) {
    if (param.type === MessageParameterType.LARGEST_OBJECT) {
      return getParameterLocationValue(param);
    }
  }
  return undefined;
}

/**
 * 純粋関数: パラメータから paused 状態を抽出する
 *
 * draft-ietf-moq-transport-23 Section 9.19.18 (PAUSED Parameter)
 * 0 = unpaused / 1 = paused。PAUSED がない場合は既定値の false (unpaused) を返す。
 * REQUEST_UPDATE / PUBLISH_STATE_NOTIFY での省略は「状態維持」であり、本関数は
 * 存在しない場合を既定値として返すため、呼び出し側は存在判定を別に行うこと。
 *
 * 戻り値は wire の値 (1 = paused) と同じ意味で、反転は行わない。
 */
export function extractPaused(parameters: Parameter[]): boolean {
  for (const param of parameters) {
    if (param.type === MessageParameterType.PAUSED) {
      const pausedValue = param.value[0];
      if (pausedValue === undefined) {
        // PAUSED は uint8 のため値 1 バイトが必ず存在するが、
        // noUncheckedIndexedAccess で型上 undefined を含むため防御する
        throw new ProtocolViolationError(
          "PAUSED parameter is missing its value",
          SessionErrorCode.INVALID_PARAMETER,
        );
      }
      validatePausedValue(pausedValue);
      return pausedValue === 1;
    }
  }
  return false;
}

/**
 * 純粋関数: パラメータ一覧から NEW_GROUP_REQUEST の値を取り出す
 *
 * draft-ietf-moq-transport-22 §9.20.19 (NEW GROUP REQUEST Parameter):
 * "The NEW_GROUP_REQUEST parameter (Parameter Type 0x32) is a varint."
 * 値は varint 1 つである。受信した値は decodeParameters が varint として読んでいるが、
 * 読み切れない値や varint の後ろに余りのある値は INVALID_PARAMETER とする。
 *
 * @returns 値。パラメータが無ければ undefined
 * @throws ProtocolViolationError 値が varint 1 つでない場合
 */
export function extractNewGroupRequest(parameters: Parameter[]): bigint | undefined {
  const param = parameters.find(
    (candidate) => candidate.type === MessageParameterType.NEW_GROUP_REQUEST,
  );
  if (param === undefined) {
    return undefined;
  }
  let value: bigint;
  let consumed: number;
  try {
    [value, consumed] = decodeVarint(param.value);
  } catch {
    throw new ProtocolViolationError(
      `NEW_GROUP_REQUEST parameter is not a varint: ${param.value.length} bytes`,
      SessionErrorCode.INVALID_PARAMETER,
    );
  }
  if (consumed !== param.value.length) {
    throw new ProtocolViolationError(
      `NEW_GROUP_REQUEST parameter has trailing bytes: expected ${consumed} bytes, got ${param.value.length}`,
      SessionErrorCode.INVALID_PARAMETER,
    );
  }
  return value;
}

// ============================================================================
// 検証
// ============================================================================

/**
 * 純粋関数: Location の大小比較
 *
 * draft-ietf-moq-transport-22 §8.2 (Location Structure):
 * "Location A < Location B if:
 *  A.Group < B.Group || (A.Group == B.Group && A.Object < B.Object)"
 *
 * @returns a < b なら負、a == b なら 0、a > b なら正
 */
export function compareLocations(a: Location, b: Location): number {
  if (a.group !== b.group) {
    return a.group < b.group ? -1 : 1;
  }
  if (a.object !== b.object) {
    return a.object < b.object ? -1 : 1;
  }
  return 0;
}

/**
 * FETCH 要求の範囲
 *
 * fetcher.ts の FetchRequestRange を共有する。要求 End Location は Location Filter の
 * 形式で決まり (§9.19.9 Table 6)、開端 (Largest Object まで) の要求では undefined に
 * なる。
 */
export type { FetchRequestRange } from "../fetcher";

/**
 * 純粋関数: FETCH の要求範囲を確定する
 *
 * draft-ietf-moq-transport-23 §3.2 / §9.19.9 (Table 6):
 * - フィルタなし / 0x00 (None): 範囲は {0, 0} から Largest Object まで
 * - 0x02 (Absolute Start): {StartGroup, StartObject} から Largest Object まで
 * - 0x03 (Absolute Start, Group End): End Group 全体
 *   ({StartGroup + EndGroupDelta, 2^64-1})
 * - 0x04 (Absolute Range): {StartGroup + EndGroupDelta, EndObject} まで
 *
 * draft-ietf-moq-transport-23 §3.2:
 * "If the Location filter is relative (see Section 9.19.9), the publisher MUST
 *  return REQUEST_ERROR with error code INVALID_RANGE."
 * 公開送信 API では、応答を待たずに送信前で拒否する必要がある。相対指定 (0x01) は
 * §3.2 が相対 Location Filter の FETCH を INVALID_RANGE と定める。Next Object
 * (0x05) は Largest Object + 1 を指して既存 Object の範囲にならない。このため
 * この関数で InvalidFilterError を throw する。この制約は FETCH の要求にだけ
 * 適用し、共通 codec (encodeLocationFilter) や FILL_PARAMETERS の内側の相対指定
 * (§3.4 / §3.5 が引き続き使う) には適用しない。
 *
 * @returns 確定した要求範囲
 * @throws InvalidFilterError 相対指定 (0x01) / Next Object (0x05) / End Group 超過 /
 *   同一 Group で End Object が Start Object より小さい空範囲
 */
export function resolveFetchRequestRange(filter: LocationFilter | undefined): FetchRequestRange {
  if (filter === undefined || "reset" in filter) {
    // 0x00 (None) とフィルタ省略は同じ範囲 (フィルタなし) を表す
    return { startLocation: { group: 0n, object: 0n }, endLocation: undefined };
  }
  if (isNextObjectLocationFilter(filter)) {
    throw new InvalidFilterError(
      "Next Object location filter cannot be used in FETCH: the range must be absolute",
    );
  }
  if (!("startObject" in filter)) {
    throw new InvalidFilterError(
      "relative location filter cannot be used in FETCH: the publisher returns INVALID_RANGE",
    );
  }
  const startLocation = { group: filter.startGroup, object: filter.startObject };
  if (!("endGroupDelta" in filter)) {
    // 0x02 (Absolute Start): 終端は Largest Object
    return { startLocation, endLocation: undefined };
  }
  // 0x03 / 0x04 は End Group = StartGroup + EndGroupDelta が 2^64-1 を超えると
  // 違反になる (§9.19.9)。encodeLocationFilter と同じ検証を要求範囲の確定時点で
  // 行い、エンコードより前に拒否する
  validateLocationFilterEndGroup(filter.startGroup, filter.endGroupDelta);
  const endGroup = filter.startGroup + filter.endGroupDelta;
  if ("endObject" in filter) {
    // 0x04 (Absolute Range)
    // 同一 Group で End Object が Start Object より小さい範囲は空であり、
    // 応答の終端が要求 Start より前になり得るため送信前に拒否する。
    if (endGroup === startLocation.group && filter.endObject < startLocation.object) {
      throw new InvalidFilterError(
        `FETCH range end ${endGroup}:${filter.endObject} is before start ${startLocation.group}:${startLocation.object}`,
      );
    }
    return { startLocation, endLocation: { group: endGroup, object: filter.endObject } };
  }
  // 0x03 (Absolute Start, Group End): End Object は End Group の最終 Object。
  // 2^64-1 は Group 全体を含む包含上限であり、実在する Object ID ではない
  return { startLocation, endLocation: { group: endGroup, object: MAX_VARINT } };
}

/**
 * FETCH_OK (REQUEST_OK) の応答から確定した終端の解決結果
 *
 * - resolved: 応答がカバーする範囲の inclusive な上端が確定した
 * - protocol-violation: 応答が §3.2 / §9.19.17 の MUST に反する。
 *   code は違反の種類に対応する §12.2 の Session Termination Code である。
 */
export type FetchResponseEndLocationResult =
  | { status: "resolved"; endLocation: Location }
  | { status: "protocol-violation"; reason: string; code: SessionErrorCode };

/**
 * 純粋関数: FETCH の応答がカバーする範囲の終端を確定する
 *
 * draft-ietf-moq-transport-23 §3.2 (Fetch):
 * "If Largest Object is within the requested range, the FETCH response ends at
 *  Largest Object and the publisher MUST include the LARGEST_OBJECT parameter
 *  (Section 9.19.17) in FETCH_OK.  Otherwise, the response ends at the requested
 *  End Location."
 * draft-ietf-moq-transport-23 §9.19.17 (LARGEST_OBJECT Parameter):
 * "If omitted from a message where it is otherwise required, the sending
 *  endpoint has not published or received any Objects in the Track."
 *
 * 開端の要求 (フィルタなし / 0x00 / 0x02) では要求 End Location が Largest Object
 * そのものである (§9.19.9)。そのため LARGEST_OBJECT が必須であり、これが無い
 * 成功応答は必須要素の欠落として MALFORMED_MESSAGE とする。
 * 閉端の要求 (0x03 / 0x04) で LARGEST_OBJECT が無い場合は、応答が要求 End で
 * 終わる (§3.2 の otherwise) ものとして要求 End を採用する。
 * LARGEST_OBJECT が要求 Start より前にある応答は、開端・閉端のどちらでも §3.2 の
 * INVALID_RANGE 対象であり、成功応答としては受理せず、parse 済みメッセージの
 * フィールド値が要求に対して許可されないため INVALID_FIELD とする。
 *
 * LARGEST_OBJECT は §3.1.4 のとおり到着中の Object を指し得る。本関数は応答受理
 * 時点の値で終端を確定し、後続データの最後の実 Object に合わせて書き換えない。
 * protocol-violation を返す応答は、返した code でセッションを閉じる。
 *
 * FILL_PARAMETERS による fill fetch は FETCH 要求ではなく、REQUEST_OK の
 * 成功応答も持たない別経路である (§3.4 / §3.5)。fill の範囲解決は fill 側の
 * 経路で行い、この関数の対象ではない。
 *
 * @param requestRange - 要求範囲 (resolveFetchRequestRange の結果)
 * @param largestObject - 応答の LARGEST_OBJECT。無ければ undefined
 * @returns 確定した終端、またはプロトコル違反の理由
 */
export function resolveFetchResponseEndLocation(
  requestRange: FetchRequestRange,
  largestObject: Location | undefined,
): FetchResponseEndLocationResult {
  if (largestObject === undefined) {
    if (requestRange.endLocation === undefined) {
      const { group, object } = requestRange.startLocation;
      return {
        status: "protocol-violation",
        reason: `FETCH_OK is missing LARGEST_OBJECT required by the open-ended FETCH range from ${group}:${object}`,
        code: SessionErrorCode.MALFORMED_MESSAGE,
      };
    }
    return { status: "resolved", endLocation: requestRange.endLocation };
  }
  // draft-ietf-moq-transport-23 §3.2:
  // "If no Objects have been published for the track or Start Location is
  //  greater than the Largest Object ... the publisher MUST return FETCH_ERROR
  //  with error code INVALID_RANGE."
  // 成功応答で Start より前の LARGEST_OBJECT を返すのは仕様に反するため、
  // 開端・閉端のどちらでもプロトコル違反として扱う。
  if (compareLocations(largestObject, requestRange.startLocation) < 0) {
    const start = requestRange.startLocation;
    return {
      status: "protocol-violation",
      reason: `FETCH_OK LARGEST_OBJECT ${largestObject.group}:${largestObject.object} is before the requested Start Location ${start.group}:${start.object}`,
      code: SessionErrorCode.INVALID_FIELD,
    };
  }
  if (requestRange.endLocation === undefined) {
    // 開端の要求では Largest Object が要求 End そのものである (§9.19.9)
    return { status: "resolved", endLocation: largestObject };
  }
  // 要求範囲内なら Largest Object で終わり、範囲外なら要求 End で終わる (§3.2)。
  // Start より前の Largest Object は上で違反にしているため、ここでは End だけを見る。
  const withinRange = compareLocations(largestObject, requestRange.endLocation) <= 0;
  return {
    status: "resolved",
    endLocation: withinRange ? largestObject : requestRange.endLocation,
  };
}

// ============================================================================
// ストリーム種別判定
// ============================================================================

/**
 * 単方向データストリームの種類
 */
export type IncomingStreamKind = "subgroup" | "fetch" | "unknown";

/**
 * 純粋関数: 単方向ストリームの先頭バイトから種別を判定する
 *
 * draft-ietf-moq-transport-22 Section 6.4.1, Section 11.3.1
 *
 * SUBGROUP_HEADER の type 値範囲: 0x10..0x1F, 0x30..0x3F, 0x50..0x5F, 0x70..0x7F
 *
 * draft-ietf-moq-transport-22 Section 6.4.1:
 * 0b0XX1XXXX のパターンに一致する全範囲を subgroup として判定する。
 * 0x50..0x5F / 0x70..0x7F は FIRST_OBJECT ビット (0x40) が設定された
 * SUBGROUP_HEADER であり、relay 経由でクライアントに配送される場合もある。
 */
export function classifyIncomingStreamType(firstByte: bigint): IncomingStreamKind {
  const streamTypeNum = Number(firstByte);

  if (streamTypeNum === FetchHeaderType) {
    return "fetch";
  }

  if (
    (streamTypeNum >= 0x10 && streamTypeNum <= 0x1f) ||
    (streamTypeNum >= 0x30 && streamTypeNum <= 0x3f) ||
    (streamTypeNum >= 0x50 && streamTypeNum <= 0x5f) ||
    (streamTypeNum >= 0x70 && streamTypeNum <= 0x7f)
  ) {
    return "subgroup";
  }

  return "unknown";
}

// ============================================================================
// Object ID Delta 計算
// ============================================================================

/**
 * 純粋関数: Object ID Delta を計算する
 *
 * draft-ietf-moq-transport-22 Section 11.3.1:
 * "The Object ID Delta + 1 is added to the previous Object ID ...
 *  The Object ID is the Object ID Delta if it's the first Object"
 *
 * @param previousObjectId - 前の Object ID。最初のオブジェクトの場合は負数
 * @param currentObjectId - 現在の Object ID
 */
export function calculateObjectIdDelta(previousObjectId: bigint, currentObjectId: bigint): bigint {
  if (previousObjectId < 0n) {
    return currentObjectId;
  }
  return currentObjectId - previousObjectId - 1n;
}

// ============================================================================
// setTimeout 遅延クランプ
// ============================================================================

// setTimeout の遅延上限 (2^31 - 1 = 2147483647 ms、約 24.8 日)。
// WHATWG HTML 仕様および主要ブラウザは 2^31 - 1 ms を超える遅延を 0 に丸めて
// 即発火するため、この値でクランプする。
const MAX_SETTIMEOUT_DELAY = 2147483647;

/**
 * 純粋関数: bigint のタイムアウト (ms) を setTimeout に安全に渡せる値にクランプする
 *
 * 2^31 - 1 を超える遅延は WHATWG HTML 仕様で 0 に丸められ即発火するため、上限で抑える。
 * GOAWAY タイムアウトには受信した GOAWAY のピア由来の値が渡るため、防御的にクランプする。
 *
 * @param timeout - クランプ対象のタイムアウト (ms)
 */
export function clampTimeoutMs(timeout: bigint): number {
  return Math.min(Number(timeout), MAX_SETTIMEOUT_DELAY);
}

/**
 * Track Namespace が namespacePrefix に前方一致するか判定する
 *
 * draft-ietf-moq-transport-22 §2.4.2 (Namespace Prefix Matching) / §3.6:
 * PUBLISH の trackNamespace が tracksSubscriptions の namespacePrefix に
 * 前方一致する場合、当該 subscription が PUBLISH を受信する対象となる。
 *
 * @param trackNamespace - PUBLISH からデコードした TrackNamespace tuple
 * @param namespacePrefix - SUBSCRIBE_TRACKS で指定した namespacePrefix (string[])
 * @returns 前方一致する場合は namespaceSuffix (string[])、一致しない場合は null
 */
export function matchNamespacePrefix(
  trackNamespace: string[],
  namespacePrefix: string[],
): string[] | null {
  if (namespacePrefix.length > trackNamespace.length) {
    return null;
  }
  for (let i = 0; i < namespacePrefix.length; i++) {
    if (trackNamespace[i] !== namespacePrefix[i]) {
      return null;
    }
  }
  return trackNamespace.slice(namespacePrefix.length);
}

/**
 * Range Filter の type 文字列を MessageParameterType に変換する
 */
function rangeFilterTypeToParamType(
  type: "subgroup" | "objectId" | "priority" | "objectProperty" | "trackProperty",
): number {
  switch (type) {
    case "subgroup":
      return MessageParameterType.SUBGROUP_FILTER;
    case "objectId":
      return MessageParameterType.OBJECTID_FILTER;
    case "priority":
      return MessageParameterType.PRIORITY_FILTER;
    case "objectProperty":
      return MessageParameterType.OBJECT_PROPERTY_FILTER;
    case "trackProperty":
      return MessageParameterType.TRACK_PROPERTY_FILTER;
    default: {
      const _exhaustive: never = type;
      return _exhaustive;
    }
  }
}
