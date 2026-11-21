/**
 * MOQT Publisher
 * draft-ietf-moq-transport-23 Section 3 (Publishing and Receiving Tracks)
 *
 * publisher 層は送信の失敗を error コールバックで通知する担い手である。
 */

import { ObjectStatus, PublishDoneStatusCode, type Location } from "./message/types";
import type { LocationFilter, RangeFilterSpec } from "./message/parameter";
import {
  objectMatchesFilter,
  rangeFiltersMatch,
  resolveFilter,
  type RangeFilterValues,
  type ResolvedFilter,
} from "./filter";
import { compareLocations, mergeRangeFilters } from "./session/params";
import { ProtocolViolationError } from "./error";
import type { FullTrackNameKey } from "./fullTrackName";
import { mergeDeliveryTimeoutObjectProperties, type Property } from "./properties";
import { MAX_VARINT } from "./varint";
import { validateObjectStatus } from "./dataStream/moqtObject";

/**
 * publisher 層が error コールバックで通知した error の印
 *
 * 事前検証 (guard / status / 委譲先の検証) の違反は publisher 層が通知してから
 * 返値を reject する。呼び出し側が同じ失敗を通知し直すと 1 件の失敗で 2 回通知に
 * なるため、この印で「publisher 層がこの失敗の通知責任を果たした」ことを示し、
 * 呼び出し側が通知の要否を判定する。
 * error は参照で比較するため WeakSet で保持する (通知済みの error が解放されれば
 * 印も一緒に消える)。
 */
const publisherNotifiedErrors = new WeakSet<object>();

/**
 * Internal: error が publisher 層の通知済みかどうかを返す (高レベル API からのみ使う)
 *
 * PublisherImpl.handleError が通知した error だけが真になる。印は参照で比較するため、
 * 同じ内容でも別インスタンスなら偽である。この判定関数と印のコレクションは publisher 層の
 * 内部契約に留める (パッケージ公開 API には含めない)。
 * 引数を unknown で受けるのは throw される値が Error に限らないためである。WeakSet.has は
 * object 以外を受け取れない (型) ため、typeof / null で絞ってから判定する。
 * 通知を伴わない失敗 (closed の同期 throw、接続失敗、同期 throw の伝搬) は偽になり、
 * 呼び出し側が従来どおり 1 回通知する。
 */
export function isErrorNotifiedByPublisher(error: unknown): boolean {
  return typeof error === "object" && error !== null && publisherNotifiedErrors.has(error);
}

/**
 * Publisher state
 */
export type PublisherState = "active" | "closed";

/**
 * Parameters for sending an object
 */
export interface SendObjectParams {
  /**
   * Group ID
   *
   * draft-ietf-moq-transport-23 §11.3.1:
   * 仕様上は 0〜2^64-1 の varint だが、公開 API は number のため精度を保証
   * できる安全整数の範囲 (0〜2^53-1) を対応範囲とする。2^53 以上の値は
   * Number.isInteger が true でも double の丸めで意図と異なる値になり得るため
   * 使用しないこと (範囲外は送信前に fail-fast で拒否される)。
   */
  groupId: number;
  /**
   * Object ID
   *
   * draft-ietf-moq-transport-23 §11.3.1:
   * Group ID と同じく number の安全整数の範囲 (0〜2^53-1) を対応範囲とする。
   */
  objectId: number;
  payload: Uint8Array;
  /**
   * Object Properties の生バイト列 (Key-Value-Pairs、delta encoding)
   *
   * 生バイト経路では CODEC_STRING (0x11) の意味検証 (空文字列・孤立サロゲート) を
   * 行わない。LOC の意味付きで CODEC_STRING を載せる場合は
   * encodeVideoProperties / encodeAudioProperties で組み立てたバイト列を渡すこと。
   *
   * draft-ietf-moq-transport-23 §11.1.2:
   * "Object Properties" は Key-Value-Pairs (Figure 4) のバイト列として運ばれる。
   */
  properties?: Uint8Array;
  /**
   * Publisher Priority (0-255)
   *
   * draft-ietf-moq-transport-23 §5.1.1:
   * "A single subgroup or datagram has a single publisher priority."
   * Subgroup では、この値は新しい Subgroup (moqt-js の実装では新しい Group) を
   * 開く最初の sendObject で Subgroup Header に固定される。その値は Track 全体で
   * 共有され、同じ Track の他の PUBLISH subscription へ fan-out されるときも
   * 同じ Priority を使う (§7.1 / §12.1 の Malformed Track 条件)。同一 Subgroup の
   * 2 件目以降で指定した値は wire に載らず無視される。Object ごとに優先度を
   * 変える場合は sendDatagram を使うか、Group を切り替えて新しい Subgroup を
   * 開くこと。Range Filter の PRIORITY_FILTER も wire と同じく、2 件目以降は
   * Subgroup を開いた最初の値で評価する。
   */
  priority?: number;
  /**
   * オブジェクトステータス
   * draft-ietf-moq-transport-23 §11.1.1
   *
   * - NORMAL (0x0): 通常のオブジェクト（デフォルト）
   * - END_OF_GROUP (0x3): グループの終端。payload は空でなければならない
   * - END_OF_TRACK (0x4): トラックの終端。payload は空でなければならない。
   *   END_OF_TRACK の定義上、以降の object は存在しないため同一トラックへの
   *   後続 sendObject() を送らないこと (同節の EOT 定義による解釈であり、
   *   明示の MUST 文はない)
   */
  status?: ObjectStatus;
  /**
   * Object Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 10.2 / Section 5.2
   *
   * subgroup 先頭オブジェクトの Object Property として送信される。
   * 先頭以外で指定すると throw する。
   */
  deliveryTimeout?: bigint;
  /**
   * Subgroup Delivery Timeout（ミリ秒）
   * draft-ietf-moq-transport-23 Section 10.1 / Section 5.2
   *
   * subgroup 先頭オブジェクトの Object Property として送信される。
   * 先頭以外で指定すると throw する。
   */
  subgroupDeliveryTimeout?: bigint;
  /**
   * この Object が Subgroup の最後であるかどうか
   *
   * draft-ietf-moq-transport-23 §11.3.2 (Closing Subgroup Streams):
   * "If a sender has delivered all objects in a Subgroup to the QUIC stream,
   * except any Objects with Locations smaller than the subscription's Start
   * Location, it MUST close the stream with a FIN."
   *
   * true のときは Object の書き込み完了後に Subgroup を FIN で閉じる。Subgroup に載せる
   * Object が残っていないことを送信側が知っている場合に使う (catalog は 1 Group に
   * 1 Object だけを載せるため、常にこれに当たる)。閉じた Group への後続の `sendObject()`
   * は error 通知になり、返値の Promise は解決する (paused 中は
   * 送信前に見送られるため通知も出ない)。FIN の完了がタイムアウトして RESET に
   * 切り替わった場合は「渡し切っていない」ため、同じ Group へ再び送信できる (§11.3.2)。
   *
   * 送信が見送られた場合 (paused 中、または購読の Location Filter / Range Filter の
   * 範囲外) は閉じない。その Group の Subgroup が既に開いていれば省略として記録され、
   * 後の Group 切り替えで RESET になる (§11.3.2)。
   *
   * `sendDatagram()` の `endOfGroup` とは別のものである。あちらは Datagram の wire で
   * Group の最後を示すビット (§11.2.1)、こちらは Subgroup の終端を FIN で示す
   * (§11.3.2)。同じ値でも意味が違うため、同じパラメータオブジェクトを使い回さないこと。
   */
  endOfSubgroup?: boolean;
}

/**
 * Parameters for sending a datagram
 * draft-ietf-moq-transport-23 Section 11.2 (Datagrams)
 */
export interface SendDatagramParams {
  /**
   * Group ID
   *
   * draft-ietf-moq-transport-23 §11.2.1:
   * number の安全整数の範囲 (0〜2^53-1) を対応範囲とする (§11.3.1 と同じ制約)。
   */
  groupId: number;
  /**
   * Object ID
   *
   * draft-ietf-moq-transport-23 §11.2.1:
   * Group ID と同じく number の安全整数の範囲 (0〜2^53-1) を対応範囲とする。
   */
  objectId: number;
  payload: Uint8Array;
  /**
   * Object Properties の生バイト列 (Key-Value-Pairs、delta encoding)
   *
   * 生バイト経路では CODEC_STRING (0x11) の意味検証 (空文字列・孤立サロゲート) を
   * 行わない。LOC の意味付きで CODEC_STRING を載せる場合は
   * encodeVideoProperties / encodeAudioProperties で組み立てたバイト列を渡すこと。
   *
   * draft-ietf-moq-transport-23 §11.2:
   * Datagram でも Object Properties は Key-Value-Pairs (Figure 4) のバイト列として運ばれる。
   */
  properties?: Uint8Array;
  /**
   * Publisher Priority (0-255)
   * draft-ietf-moq-transport-23 §5.1.1: Datagram は 1 つで 1 つの priority を持つ。
   *
   * 省略時は wire に Priority フィールドを載せない (§11.2.1 の DEFAULT_PRIORITY)。
   * 省略した Datagram は購読の既定の Publisher Priority 128 を継承するため
   * (§10.4)、購読の PRIORITY_FILTER (§3.3.2) も 128 として評価する。
   */
  priority?: number;
  /**
   * このオブジェクトがグループの最後かどうか
   *
   * draft-ietf-moq-transport-23 §11.2.1: Datagram Type の END_OF_GROUP ビット (0x02) を
   * 立て、「同じ Group ID でより大きい Object ID が存在しない」ことを示す。
   * 空の payload では Normal Status の明示が必要なため、true は指定できない。
   * `sendObject()` の `endOfSubgroup` (§11.3.2 の FIN) とは別のものである。
   */
  endOfGroup?: boolean;
}

/**
 * Internal: Track 全体で共有する Subgroup の値
 *
 * draft-ietf-moq-transport-23 §7.1 (Caching Relays) / §12.1 (Malformed Tracks):
 * 同じ Track の同じ (Group, Object) を複数の PUBLISH subscription へ送るとき、
 * Subgroup ID・Publisher Priority・Delivery Mode が subscription 間で食い違うと、
 * 受信側はその Track を Malformed として扱う。
 * Subgroup ID と Publisher Priority は Subgroup Header で固定される (§11.3.1)。
 * そのため、Track で最初に Subgroup を開いた subscription の値を 1 つだけ保持し、
 * 同じ Track の全 subscription が参照する。値が確定するのは、いずれかの
 * subscription がその Group の Object を実際に送信した時点である
 * (全 subscription のフィルタで見送られた Object は Subgroup を開かない)。
 *
 * セッションの公開済み Track registry (PublishedTrackState) が 1 つ持ち、
 * その Track に属する PublisherImpl は同じオブジェクトを参照する。
 * registry を使わない低レベルな PublisherImpl は null のまま、自分だけの
 * 状態 (currentSubgroupGroupId 等) で従来どおり動く。
 */
export interface SharedSubgroupState {
  /** 最後に Subgroup を開いた Group ID (まだ 1 件も送っていない場合は null) */
  groupId: bigint | null;
  /** その Group の Subgroup ID (まだ 1 件も送っていない場合は null) */
  subgroupId: bigint | null;
  /** その Subgroup の Publisher Priority (まだ 1 件も送っていない場合は null) */
  publisherPriority: number | null;
  /** その Subgroup で最初に送った Object ID (まだ 1 件も送っていない場合は null) */
  firstObjectId: bigint | null;
}

/** §3.1.4: 同じ Track の購読で共有する、公開済み Object の最大位置。 */
export interface SharedLargestLocation {
  largest: Location | null;
}

/**
 * Internal: 送信する Object に使う Subgroup の確定値
 *
 * draft-ietf-moq-transport-23 §11.3.1 (Subgroup Header):
 * Subgroup ID / Publisher Priority は Subgroup を開くときに Header へ固定する。
 * `firstObject` は FIRST_OBJECT ビット (0x40) であり、「この Subgroup の
 * ストリームの先頭 Object が、その Subgroup で最初に publish された Object か」を表す。
 * 途中から購読を始めた subscription のストリームは Subgroup の先頭 Object から
 * 始まらないため false になる。
 */
export interface ResolvedSubgroup {
  groupId: bigint;
  objectId: bigint;
  subgroupId: bigint;
  publisherPriority: number;
  firstObject: boolean;
}

/**
 * Internal: 送信経路の内部で Subgroup の確定値を載せる SendObjectParams
 *
 * 公開 API の `Publisher.sendObject` が受け取るのは SendObjectParams である。
 * `sendObjectToSubscription` が、Track 共通の Subgroup の値を確定してから
 * この型にして `onSendObject` (セッションの送信処理) へ渡す。
 * 公開 API の利用者は `resolvedSubgroup` を指定しない。
 */
export type SendObjectParamsInternal = SendObjectParams & {
  /**
   * Internal: Track 共通の Subgroup の確定値
   *
   * 省略された場合 (低レベル API から内部送信関数を直接呼ぶ場合) は、
   * 従来どおりその Object を先頭にした Subgroup を開く。
   */
  resolvedSubgroup?: ResolvedSubgroup;
  /** 型付き Timeout を合成済みの Object Properties。フィルタ判定と送信で共有する。 */
  preparedProperties?: Uint8Array;
  /** 送信キューへ入れる時点で検証した購読フィルタの世代。 */
  sendFilterRevision?: number;
  /** キュー投入後に見送った終端 Object の予約を取り消す。 */
  onOmitted?: () => void;
};

/**
 * PUBLISH_STATE_NOTIFY で購読者へ通知する購読状態
 * draft-ietf-moq-transport-23 Section 9.10 (PUBLISH_STATE_NOTIFY)
 *
 * 「A PUBLISH_STATE_NOTIFY carries the parameters whose values have changed.
 *  If a parameter is not present, its value is unchanged.」ため、現在値から
 * 変化した値のみを指定する。省略したフィールドは通知に載せない。
 */
export interface PublishStateNotifyOptions {
  /**
   * 通知する PAUSED パラメータの値 (購読が paused かどうか)
   * draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter)
   *
   * wire の PAUSED と同じ意味で、true = paused (1)、false = unpaused (0)。
   * 「When sent in PUBLISH_STATE_NOTIFY, it reports whether the subscription is
   *  paused at the publisher.」現在値と同じ値では通知しない。送信できた場合は
   * この値を publisher の paused 状態として反映する (購読者が受け取る値と
   * publisher が実際に配信する状態を一致させるため)。
   */
  paused?: boolean;

  /**
   * 通知する Location Filter
   * draft-ietf-moq-transport-23 Section 9.19.9 (LOCATION FILTER Parameter)
   *
   * 「When sent in PUBLISH_STATE_NOTIFY, it reports the Location Filter now in
   *  effect at the publisher.」現在値と等価な値では通知しない。送信できた場合は
   * この値を publisher の Location Filter として反映する (購読者が受け取る値と
   * publisher が実際に適用する値を一致させるため。相対指定は送信時点の
   * Largest Object で解決する。Section 3.3.1)。
   * Section 9.10 の MUST NOT「A publisher MUST NOT use PUBLISH_STATE_NOTIFY to
   *  change the value of a subscriber controlled subscription parameter unless
   *  the subscriber requested the change.」に従い、購読者が REQUEST_UPDATE で
   * 要求していない値は指定しないこと。
   */
  filter?: LocationFilter;
}

/**
 * Publisher interface
 */
export interface Publisher {
  readonly state: PublisherState;
  /**
   * 購読が paused かどうか
   * draft-ietf-moq-transport-23 Section 9.19.18 (PAUSED Parameter) / §3.1.1
   *
   * wire の PAUSED と同じ意味で、true = paused (1)、false = unpaused (0)。
   * PUBLISH 送信時の options.paused (省略時は false = unpaused) を初期値として返す。
   * PUBLISH_OK は EXPIRES のみを運び paused を変更しない。
   * - true (1): paused。オブジェクトを送らない
   * - false (0): paused でない。オブジェクトを送る
   *
   * REQUEST_UPDATE で状態が変更された場合、onPausedChange が呼ばれる。
   * PUBLISH 送信時の初期設定と REQUEST_UPDATE 受信時による変化でも呼ばれる。
   * notifyStateChange で通知した値の反映でも呼ばれる。
   */
  readonly paused: boolean;
  /**
   * Subgroup ストリームでオブジェクトを送信する
   *
   * 戻り値は object が WebTransport stream に書き込まれて完了した時点で resolve する Promise。
   * Catalog のように「relay に届いてキャッシュされてから後続 subscriber が参照する」必要がある
   * オブジェクトは await することで、書き込み完了後に return できる。
   * リアルタイムの音声・映像フレームのように落としても良い (もしくは後続のオブジェクトで上書きされる)
   * ものは fire-and-forget で良いので、戻り値を `void` で破棄して構わない。
   *
   * 範囲外の Group / Object ID は fail-fast で error 通知 + 返値の reject になる
   * (fire-and-forget でも `.catch` するか error 通知で処理すること)。
   * その他の送信失敗 (書き込み失敗等) は error 通知のみで返値は resolve する。
   * 範囲外・非整数の priority も fail-fast で error 通知 + 返値の reject になる。
   * status / payload の組み合わせ違反と END_OF_TRACK 送信後の呼び出しも
   * fail-fast で error 通知 + 返値の reject になる
   * (組み合わせ規則は draft-ietf-moq-transport-23 §11.1.1 / §11.1.2、
   * END_OF_TRACK 後は §11.1.2 の EOT 定義による解釈)。
   * END_OF_GROUP を送信済みの Group への後続送信も同じ扱いになる
   * (§11.1.2 の END_OF_GROUP の定義による解釈)。
   *
   * 返値が reject する経路は必ず error 通知を伴う (1 件の失敗につき通知は 1 回)。
   * reject を受けた呼び出し側は通知し直さなくてよい。
   *
   * Publisher が終了処理中または closed の場合は検証の前に同期 throw する (sendDatagram と同じ契約。
   * 返値は Promise だが reject ではなく throw になる)。
   *
   * 購読の Location Filter の範囲外 Object は送信せず、error 通知もなく
   * 解決済みの Promise<void> を返す (draft-ietf-moq-transport-23 §3.3.1)。
   * 購読の Range Filters (§3.3.2) を通過しない Object も同じ扱いになる
   * (§3.3.3 の「The publisher MUST forward only objects that pass all filters」)。
   *
   * sendObject() で最初に送った Object の Delivery Mode は Subgroup になる
   * (draft-ietf-moq-transport-23 §2.1.1: Original Publisher が最初の送信方法で
   * 決める)。送信していない Object の Delivery Mode は確立しない。
   */
  sendObject(params: SendObjectParams): Promise<void>;
  /**
   * Datagram でオブジェクトを送信する
   * draft-ietf-moq-transport-23 Section 11.2 (Datagrams)
   *
   * 注意: Datagram は信頼性がなく、順序も保証されない
   *
   * draft-ietf-moq-transport-23 §2.1.1 (Delivery Mode):
   * Object の Delivery Mode (Subgroup か Datagram か) は Original Publisher が
   * 最初の送信方法で決める。Datagram で送る Object は Delivery Mode が Datagram に
   * なる。subscription では、Object をその Delivery Mode に従って送らなければ
   * ならない (MUST)。
   * 確立後と異なる Delivery Mode で受け取った Object は malformed track として
   * 扱われる (§12.1)。Fetch では Delivery Mode が適用されない (§3.2.1)。
   *
   * draft-ietf-moq-transport-23 §2.1:
   * Group または Track の中で Subgroup と Datagram の両方を使える。混在できるのは
   * Object 単位であり、同じ Object を両方の方式で送ることはできない。
   * 範囲外の Group / Object ID は error 通知 + throw する
   * (セッションは閉じない)。Publisher が終了処理中または closed の場合は検証の前に同期 throw する。
   * 範囲外・非整数の priority も error 通知 + throw になる。
   * END_OF_TRACK / END_OF_GROUP 送信後の呼び出しも error 通知 + throw になる
   * (§11.1.2 の EOT / END_OF_GROUP の定義による解釈)。
   * 購読の Location Filter の範囲外 Datagram は送信せず、何もせず return する
   * (draft-ietf-moq-transport-23 §3.3.1)。購読の Range Filters (§3.3.2) を
   * 通過しない Datagram も送信しない (§3.3.3)。Datagram は Subgroup を持たない
   * ため SUBGROUP_FILTER は不通過になり、Priority を省略した Datagram は
   * 既定の Publisher Priority 128 として PRIORITY_FILTER を評価する (§10.4)。
   * 返値は Datagram の送信 (WebTransport の datagram writer への write) の完了で
   * resolve する。送信の失敗は従来どおり `onError` へ通知し、返値は reject しない
   * (fire-and-forget で呼ぶ利用者を壊さない)。停止時に末尾の datagram を書き終えた
   * ことを確かめてから PUBLISH_DONE を送る用途で待てるようにする。
   */
  sendDatagram(params: SendDatagramParams): Promise<void>;
  /**
   * 開いている Subgroup を、Object を送らずに閉じる
   * draft-ietf-moq-transport-23 Section 11.3.2 (Closing Subgroup Streams)
   *
   * 送信を止める時点で「その Subgroup に続く Object は無い」と分かったときに使う。
   * `sendObject()` の `endOfSubgroup` は「送信する Object が Subgroup の最後である」ことを
   * 示す経路であり、Object を送らずに閉じることはできない。
   *
   * 開いている Subgroup が無い場合や、Publisher が終了処理中または `"closed"` の
   * 場合は何もせず解決する。停止の後始末から呼ばれる経路があるため例外も投げない。
   *
   * Group の途中でも FIN で閉じてよい。Object ID は送信する時点で払い出すため、送らな
   * かったフレームは wire 上の Object として存在せず、「渡し切っていない」状態にならない
   * (§11.3.2 の RESET が要るのは、見送った Object を残したまま閉じる場合である)。
   *
   * FIN と RESET は §11.3.2 の判定に従う。見送った Object がある Subgroup は RESET に
   * なる。送信キューに載せ、キュー済みの送信が終わってから閉じる。FIN の完了は待たない
   * (`done()` が完了を待つ)。`writer.close()` が失敗・タイムアウトした場合は RESET に
   * 切り替わる (これは通知しない。§11.3.2 の MUST を満たす側へ倒すだけである)。
   * 返値の Promise は reject せず、内部コールバックの失敗は error 通知になる。
   * 閉じた後に同じ Group へ `sendObject()` すると error 通知になる。
   */
  closeSubgroup(): Promise<void>;
  /**
   * 購読状態の変化を PUBLISH_STATE_NOTIFY で購読者へ通知する
   * draft-ietf-moq-transport-23 §9.10 (PUBLISH_STATE_NOTIFY)
   *
   * subscriber 発の REQUEST_UPDATE への応答ではなく、publisher 側の理由で
   * 購読状態が変化したことを片方向で通知する。購読者は REQUEST_OK /
   * REQUEST_ERROR を返さないため、返値は送信の完了のみを表す。
   * 通知に載せるパラメータは許可された LARGEST_OBJECT (既知時は §9.19.17 の
   * MUST により必須) / PAUSED / LOCATION_FILTER のみであり、現在値から
   * 変化していないパラメータは載せない。載せるパラメータが無い場合は
   * 送信せず resolve する (重複送信の抑止)。
   * 送信できた変更のみ paused 状態 / Location Filter として反映する。
   * 並行した通知は呼び出し順に処理する。
   *
   * 購読が終了処理中または終了済みの場合は送信せず resolve する。
   * 送信できない場合 (ストリーム終了等) は
   * reject する。セッションは閉じない。
   *
   * paused: true を通知した場合、購読者が REQUEST_UPDATE で PAUSED=0 を送る
   * まで Object を送信しない (Section 9.8 の PUBLISH 時の PAUSED=1 と同じ扱い。
   * 送信の抑止は paused 状態を参照する sendObject / sendDatagram が行う)。
   */
  notifyStateChange(options?: PublishStateNotifyOptions): Promise<void>;
  /**
   * パブリッシングを終了し、PUBLISH_DONE を送信してストリームを閉じる
   * draft-ietf-moq-transport-23 §9.9 (PUBLISH_DONE) / §12.4 (Publish Done Codes)
   *
   * status を省略した場合は従来どおり TRACK_ENDED (0x2) を送る。
   * 指定できるのは購読の正常終了として送信できる TRACK_ENDED と、
   * 認可トークンの期限切れを通知する EXPIRED_AUTH_TOKEN (0x7) のみである。
   * それ以外の値は PUBLISH_DONE の status として送信できず、状態変更や
   * 送信より前に throw する。
   *
   * 呼び出し時点で新規送信の受け付けを止め、受理済みの送信を処理してから終了する。
   * 並行して呼ばれた場合も PUBLISH_DONE は 1 回だけ送信され、
   * 2 回目の呼び出しは 1 回目の完了まで待つ。
   * セッションが閉じられた後は PUBLISH_DONE を送信せず即 resolve する。
   */
  done(status?: PublishDoneStatusCode): Promise<void>;
}

/**
 * status / payload の組み合わせを検証する
 *
 * draft-ietf-moq-transport-23 §11.1.1:
 * 非 NORMAL ステータスは空 payload でなければならない。
 * draft-ietf-moq-transport-23 §11.1.2:
 * 非 NORMAL ステータスの Object に properties があってはならない。
 * `status` 省略は NORMAL とみなす。
 *
 * @throws ProtocolViolationError 未定義の Status または Status と payload の矛盾
 */
function validateSendStatusPayload(params: SendObjectParams): void {
  const status = params.status ?? ObjectStatus.NORMAL;
  validateObjectStatus(status);
  if (status === ObjectStatus.NORMAL) {
    return;
  }
  const payloadSize = params.payload.byteLength;
  const propertiesSize = params.properties?.byteLength ?? 0;
  if (payloadSize > 0 || propertiesSize > 0) {
    throw new ProtocolViolationError(
      `invalid status with payload: status ${status} requires empty payload without properties, got payload ${payloadSize} bytes and properties ${propertiesSize} bytes`,
    );
  }
  if (params.deliveryTimeout !== undefined || params.subgroupDeliveryTimeout !== undefined) {
    throw new ProtocolViolationError("properties on non-Normal status object");
  }
}

/**
 * Internal Publisher implementation
 */
export class PublisherImpl implements Publisher {
  private publisherState: PublisherState = "active";
  // draft-ietf-moq-transport-23 §9.19.18 (PAUSED Parameter):
  // 購読が paused かどうか (true = paused / false = unpaused)。wire の値と
  // 同じ意味で保持し、境界での反転は行わない。
  private publisherPaused = false;
  // 未指定の場合は明示的に undefined を代入する (呼び出し側は `?.` で呼ぶ) ため
  // `| undefined` を付ける
  private readonly errorCallback?: ((error: Error) => void) | undefined;
  private readonly pausedChangeCallback?: ((paused: boolean) => void) | undefined;
  private readonly requestId: bigint;
  private readonly trackAlias: bigint;

  // 公開済み Track registry (Session.publishedTracks) との紐付け。
  // 同じ Full Track Name を複数回 publish した場合、各 PublisherImpl は同じ
  // PublishedTrackState を共有するため、registry を引くキーを保持する。
  // 未登録の Publisher (テストが直接組み立てたもの等) は null のままにする。
  private publishedTrackKey: FullTrackNameKey | null = null;
  private publishedTrackOrigin: "app" | "subscribe-tracks" | null = null;

  // draft-ietf-moq-transport-23 Section 9.9 (PUBLISH_DONE):
  // PUBLISH_DONE の Stream Count 用カウンター
  private dataStreamCount = 0n;

  // §11.3.2: 購読内で未送信のまま残った Object を Group ごとに保持する。
  private omittedSubgroupObjects: Map<bigint, Set<bigint>> | undefined;

  // draft-ietf-moq-transport-23 §11.1.1:
  // END_OF_TRACK 送信済みか。sendObject / sendDatagram で共有し、
  // 記録後の両 API 呼び出しを拒否する。
  private endOfTrackSent = false;
  // draft-ietf-moq-transport-23 §11.1.1 / §11.3.2:
  // END_OF_GROUP status を送信した Group。同一 Group への後続送信は拒否する
  // (Group の終端を宣言済みのため)。購読終了で null に戻す。
  // 公開 API の groupId は number (安全整数) のため number で保持する。
  private endOfGroupSentGroupId: number | null = null;

  // registry に属する Publisher は同じ Track の状態を共有する。
  private largestLocationState: SharedLargestLocation = { largest: null };

  // draft-ietf-moq-transport-23 §3.3.1 (Location Filters) / §3.4 (Fill Semantics):
  // REQUEST_UPDATE で受信した購読の Location Filter を、受理時点の
  // LARGEST_OBJECT で解決した状態で保持する (相対指定を後から再解決しない。
  // SubscriberImpl.resolveLocationFilter と同じ規則)。
  // 用途は 2 つ。fill 範囲は「FILL_PARAMETERS 内の LOCATION_FILTER、省略時は
  // 購読の Location Filter」で決まるためその評価に使い、送信 Object は
  // §3.3.1 の publisher MUST「A publisher MUST NOT send objects from outside the
  // requested range.」に従い範囲外を送信しない (subscription-delivered の定義は §3.1)。
  // 未受信時は undefined (フィルタなし = トラック全体)。
  private subscriptionLocationFilter: ResolvedFilter | undefined;
  // draft-ietf-moq-transport-23 §3.3.1 / §9.19.9:
  // 解決前の生の Location Filter。subscriptionLocationFilter は解決時点の
  // LARGEST_OBJECT に依存するため、同じ内容の再設定を避ける等価判定
  // (isSameLocationFilter) には生の値が要る。未受信時は undefined。
  private publisherLocationFilter: LocationFilter | undefined;

  // draft-ietf-moq-transport-23 §3.3.2 (Range Filters) / §3.3.3 (Combining Filters):
  // REQUEST_UPDATE で受信した購読の Range Filters。空配列はフィルタなし。
  // §3.3.3 の "The publisher MUST forward only objects that pass all filters." に
  // 従い、sendObject / sendDatagram で通過判定を行う。削除・置換・不変の適用は
  // SubscriberImpl と同じ mergeRangeFilters に集約する。
  private subscriptionRangeFilters: RangeFilterSpec[] = [];
  // transport-23 §3.3.2: Track 条件と Object 条件を同じ SetID で評価するため保持する。
  private publisherTrackProperties: readonly Property[] = [];
  private sendFilterRevision = 0;

  // draft-ietf-moq-transport-23 §11.3.1 (Subgroup Header):
  // 送信中の Subgroup の識別値。Subgroup ID と Publisher Priority は Subgroup Header
  // で固定され、Range Filter の SUBGROUP_FILTER / PRIORITY_FILTER を 2 件目以降の
  // Object でも wire と同じ値で評価するために保持する。
  // 同じ Track の他の subscription へ fan-out されるときは、Track 共通の値
  // (sharedSubgroupState) を使うため、この値は「この subscription が開いている
  // ストリームの値」を表す。Subgroup を開いていない間は null。
  private currentSubgroupGroupId: bigint | null = null;
  private currentSubgroupId: bigint | null = null;
  private currentSubgroupPublisherPriority: number | null = null;

  // draft-ietf-moq-transport-23 §7.1 / §12.1:
  // 同じ Track の同じ (Group, Object) を複数の subscription へ送るとき、
  // Subgroup ID と Publisher Priority を一致させるための Track 共通の状態。
  // セッションの公開済み Track registry が持つオブジェクトを、その Track の全
  // PublisherImpl が共有する。registry を使わない低レベルな PublisherImpl は
  // null のまま、currentSubgroup* だけを使って動く。
  private sharedSubgroupState: SharedSubgroupState | null = null;

  // セッションが利用する内部コールバック
  // セッションは未指定のコールバックを明示的に undefined で代入するため `| undefined` を付ける
  goawayCallback?: ((newSessionUri: string) => void) | undefined;
  /**
   * NEW_GROUP_REQUEST を受けたときのアプリのコールバック (PublishCallbacks.onNewGroupRequest)
   *
   * セッションが PUBLISH の送信時に設定する。handleNewGroupRequest が条件を満たしたときに呼ぶ。
   */
  newGroupRequestCallback?: ((newGroupRequest: bigint) => void) | undefined;
  /**
   * PUBLISH の Track Properties で DYNAMIC_GROUPS=1 を広告したか
   *
   * draft-ietf-moq-transport-23 §10.6 (DYNAMIC GROUPS)。セッションが PUBLISH の送信時に
   * PublishOptions.dynamicGroups から設定する。
   */
  dynamicGroups = false;
  /**
   * 内部: セッションの送信処理
   *
   * 引数は Subgroup の確定値を載せた内部型である。`sendObjectToSubscription` が
   * 確定値を載せてから呼ぶため、セッション側は Header の種別
   * (FIRST_OBJ_EXT / EXPLICIT_EXT) と Priority をその値から決められる。
   */
  onSendObject?: (params: SendObjectParamsInternal) => Promise<void>;
  /**
   * 同じ Track の他の PUBLISH subscription へ Object を配信する (セッション内部)
   *
   * draft-ietf-moq-transport-23 §3.1 (Subscriptions):
   * 同じ Track に複数の concurrent subscription がある場合、publisher は
   * Object が各 subscription のフィルタに一致すれば購読ごとに 1 回ずつ送る。
   * このコールバックは自分の subscription への送信を終えた後に呼ばれ、
   * 他の subscription への評価と送信はセッション側 (publishedTracks) が行う。
   * アプリが `Session.publish` した Publisher にだけ設定する。派生 subscription
   * (受信 SUBSCRIBE_TRACKS 由来) は自分自身にしか送らないため設定しない。
   */
  onSendObjectFanOut?: (params: SendObjectParams) => void;
  onSendDatagram?: (params: SendDatagramParams) => Promise<void> | void;
  /**
   * 同じ Track の他の PUBLISH subscription へ Datagram を配信する (セッション内部)
   *
   * draft-ietf-moq-transport-23 §3.1 / §11.2:
   * onSendObjectFanOut と同じ役割を Datagram で担う。Datagram は Subgroup を
   * 持たないため、購読ごとの Range Filter 評価はセッション側が行う。
   */
  onSendDatagramFanOut?: (params: SendDatagramParams) => void;
  onDoneInternal?: (status: PublishDoneStatusCode) => Promise<void>;
  /**
   * 開いている Subgroup を閉じる (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-23 §11.3.2:
   * 閉じ方 (FIN / RESET) の判定とストリームの後始末はセッション側が行う。
   * onSendObject / onDoneInternal と同じ役割分担である
   */
  onCloseSubgroup?: () => Promise<void>;
  /**
   * PUBLISH_STATE_NOTIFY の送信 (セッション内部コールバック)
   *
   * draft-ietf-moq-transport-23 §9.10:
   * 送信内容の組み立て (変化したパラメータの選別と購読状態への反映) は
   * セッション側が行う。onSendObject / onSendDatagram と同じ役割分担である。
   */
  onNotifyStateChange?: (options: PublishStateNotifyOptions) => Promise<void>;
  // 通知と購読者からの更新を、同じ双方向ストリームに書く順序で反映する。
  private stateChangeTail: Promise<void> | undefined;
  private cancelStateChangeDrain: (() => void) | undefined;

  /**
   * 進行中の done() の Promise
   *
   * draft-ietf-moq-transport-23 §9.9:
   * 「A publisher sends a PUBLISH_DONE message as the final message before
   *  closing the subscription's bidi stream」の枠組みに反する二重 PUBLISH_DONE
   * 送信を防ぐため、並行 done() 呼び出しでは進行中の Promise を再利用する。
   * 二重送信は、2 回目の publishSendPublishDone が既に閉じた writer への
   * write / close を試行して close 失敗の INTERNAL_ERROR 昇格でセッション
   * を閉じる経路にもなる。
   */
  private donePromise: Promise<void> | null = null;
  // 共有 writer は FIFO なので、この購読の最後の write で先行分も待てる。
  private lastDatagramWrite: Promise<void> | undefined;
  private cancelDatagramDrain: (() => void) | undefined;

  constructor(
    // namespace / trackName は PublisherImpl では使用しない。
    // 呼び出し側の引数順を変えないため引数自体は残す。
    _namespace: string[],
    _trackName: string,
    requestId: bigint,
    trackAlias: bigint,
    onError?: (error: Error) => void,
    onPausedChange?: (paused: boolean) => void,
  ) {
    this.requestId = requestId;
    this.trackAlias = trackAlias;
    this.errorCallback = onError;
    this.pausedChangeCallback = onPausedChange;
  }

  get state(): PublisherState {
    return this.publisherState;
  }

  get paused(): boolean {
    return this.publisherPaused;
  }

  getRequestId(): bigint {
    return this.requestId;
  }

  getTrackAlias(): bigint {
    return this.trackAlias;
  }

  /**
   * Internal: 公開済み Track registry との紐付けを設定する (セッションからのみ呼ぶ)
   *
   * 同じ Full Track Name に対して複数の PublisherImpl が存在し得るため、
   * 各 PublisherImpl が registry のキーを保持する。origin はその PublisherImpl が
   * アプリの Session.publish 由来か、受信 SUBSCRIBE_TRACKS への結果 PUBLISH 由来かを
   * 表し、終了時の後始末 (最後のアプリ Publisher かの判定) に使う。
   */
  setPublishedTrackContext(key: FullTrackNameKey, origin: "app" | "subscribe-tracks"): void {
    this.publishedTrackKey = key;
    this.publishedTrackOrigin = origin;
  }

  /**
   * Internal: Track 共通の Subgroup 状態を設定する (セッションからのみ呼ぶ)
   *
   * draft-ietf-moq-transport-23 §7.1 / §12.1:
   * 同じ Track の同じ (Group, Object) は、どの PUBLISH subscription へ送るときも
   * 同じ Subgroup ID / Publisher Priority で送らなければならない。セッションは
   * 公開済み Track registry の PublishedTrackState が持つ 1 つの
   * SharedSubgroupState を、その Track の全 PublisherImpl へ設定する。
   * 同じオブジェクトを共有することで、fan-out 元と各 subscription が同じ値を
   * 読み書きできる。
   */
  setSharedSubgroupState(state: SharedSubgroupState): void {
    this.sharedSubgroupState = state;
  }

  /** 購読の確立前に、公開 Track の Largest Object を参照する。 */
  setSharedLargestLocation(state: SharedLargestLocation): void {
    this.largestLocationState = state;
  }

  /**
   * Internal: 公開済み Track registry のキーを返す (セッションからのみ呼ぶ)
   *
   * 未登録の場合は null。registry の解除 (done / peer cancel / PUBLISH_ERROR) で
   * どのエントリを操作するかを決めるために使う。
   */
  getPublishedTrackKey(): FullTrackNameKey | null {
    return this.publishedTrackKey;
  }

  /**
   * Internal: この Publisher の由来を返す (セッションからのみ呼ぶ)
   *
   * "app" はアプリの Session.publish 由来、"subscribe-tracks" は受信
   * SUBSCRIBE_TRACKS への結果 PUBLISH 由来である。未登録の場合は null。
   */
  getPublishedTrackOrigin(): "app" | "subscribe-tracks" | null {
    return this.publishedTrackOrigin;
  }

  /**
   * §3.1.4 / §9.19.17: この Track で公開済みの最大 Location を返す。
   * 未送信の Track は null を返す。
   */
  getLargestLocation(): Location | null {
    return this.largestLocationState.largest;
  }

  /**
   * Internal: 購読の Location Filter を設定する (セッションからのみ呼ぶ)
   *
   * draft-ietf-moq-transport-23 §9.5:
   * 「If a parameter previously set on the request is not present in
   *  REQUEST_UPDATE, its value remains unchanged.」に従い、REQUEST_UPDATE に
   * LOCATION_FILTER が含まれる場合のみ呼ぶ (省略時は従来値を保持する)。
   * 相対指定は設定時点の LARGEST_OBJECT で解決して固定する (§3.3.1。
   * SubscriberImpl と同じ規則)。解決結果は fill 範囲の評価 (§3.4) で使う。
   */
  setLocationFilter(filter: LocationFilter, largestLocation = this.getLargestLocation()): void {
    this.publisherLocationFilter = filter;
    this.subscriptionLocationFilter = resolveFilter(filter, largestLocation);
    this.sendFilterRevision++;
  }

  /**
   * Internal: 設定されている生の Location Filter を取得する (セッションからのみ呼ぶ)
   *
   * 解決済みの subscriptionLocationFilter は解決時点の LARGEST_OBJECT に
   * 依存するため、同じ内容の再設定を避ける等価判定 (isSameLocationFilter) には
   * 使えない。SubscriberImpl.getLocationFilter と同じ役割である。
   */
  getLocationFilter(): LocationFilter | undefined {
    return this.publisherLocationFilter;
  }

  /**
   * Internal: 購読の Range Filters を設定する (セッションからのみ呼ぶ)
   *
   * draft-ietf-moq-transport-23 §3.3.2 (Range Filters):
   * "In REQUEST_UPDATE, Length of 0 removes the filter; non-zero replaces it
   *  entirely. If a filter parameter is omitted from REQUEST_UPDATE, it is
   *  unchanged."
   * 削除・置換・不変の適用は SubscriberImpl.setRangeFilters と同じ純関数
   * mergeRangeFilters に集約する。SUBSCRIBE の初期フィルタ (省略時は
   * フィルタなし) にも同じ規則で使える。
   * moqt-js はクライアント専用で受信 SUBSCRIBE 経路を持たないため、現時点で
   * セッションが呼ぶのは REQUEST_UPDATE の受理時のみである。
   */
  setRangeFilters(filters: RangeFilterSpec[]): void {
    this.replaceRangeFilters(mergeRangeFilters(this.subscriptionRangeFilters, filters));
  }

  /** 上限を検証済みの購読フィルタ全体を反映する。 */
  replaceRangeFilters(filters: RangeFilterSpec[]): void {
    this.subscriptionRangeFilters = filters;
    this.sendFilterRevision++;
  }

  /** 内部: 公開 Track の Properties を保持する。ワイヤでの省略とは独立して設定する。 */
  setTrackProperties(properties: readonly Property[]): void {
    this.publisherTrackProperties = [...properties];
    this.sendFilterRevision++;
  }

  /** 内部: REQUEST_UPDATE による送信中 Subgroup の再評価にも同じ Track 条件を使う。 */
  getTrackProperties(): readonly Property[] {
    return this.publisherTrackProperties;
  }

  getSendFilterRevision(): number {
    return this.sendFilterRevision;
  }

  /**
   * §3.3.1〜3.3.3: 送信待ちの間に更新されたフィルタを、送信する Subgroup の値で評価する。
   */
  matchesSubgroupSendFilters(
    objectProperties: Uint8Array | undefined,
    subgroup: ResolvedSubgroup,
    checkedRevision: number | undefined,
  ): boolean {
    if (checkedRevision === this.sendFilterRevision) return true;

    const filter = this.subscriptionLocationFilter;
    if (
      filter !== undefined &&
      !objectMatchesFilter({ group: subgroup.groupId, object: subgroup.objectId }, filter)
    ) {
      return false;
    }
    return this.matchesSubgroupRangeFilters(objectProperties, subgroup);
  }

  /**
   * Internal: 現在の Range Filters を取得する (セッションからのみ呼ぶ)
   *
   * §11.3.2 の RESET 判定 (REQUEST_UPDATE で Range Filter を狭めたときに、
   * 送信中の Subgroup の次の Object が不通過になるか) で使う。内部配列の参照を
   * 覗かせず、コピーを返す (要素オブジェクトと ranges 配列は参照共有のため、
   * 要素を mutate しないこと)。
   */
  getRangeFilters(): RangeFilterSpec[] {
    return [...this.subscriptionRangeFilters];
  }

  /**
   * Internal: 送信中の Subgroup の Range Filter 評価値を取得する (セッションからのみ呼ぶ)
   *
   * draft-ietf-moq-transport-23 §11.3.1 (Subgroup Header):
   * Subgroup ID と Publisher Priority は Subgroup Header で固定される。
   * そのため 2 件目以降の Object の評価値は、この subscription が開いている
   * Subgroup の値になる。途中から購読を始めた subscription の値は、Track 共通の
   * Subgroup ID に追従する (EXPLICIT_EXT で明示した値)。
   * §11.3.2 の RESET 判定で「次に送る Object」の評価に使う。
   * まだ Subgroup を開いていない場合は undefined。
   */
  getCurrentSubgroupRangeFilterValues():
    | { groupId: bigint; subgroupId: bigint; publisherPriority: number }
    | undefined {
    if (
      this.currentSubgroupGroupId === null ||
      this.currentSubgroupId === null ||
      this.currentSubgroupPublisherPriority === null
    ) {
      return undefined;
    }
    return {
      groupId: this.currentSubgroupGroupId,
      subgroupId: this.currentSubgroupId,
      publisherPriority: this.currentSubgroupPublisherPriority,
    };
  }

  /**
   * Internal: 受信した NEW_GROUP_REQUEST をアプリへ知らせる (セッションからのみ呼ぶ)
   *
   * draft-ietf-moq-transport-23 §9.19.19 (NEW GROUP REQUEST Parameter):
   * "When an Original Publisher that supports dynamic Groups receives a NEW_GROUP_REQUEST
   *  with a value of 0 or a value larger than the current Group, it SHOULD end the current
   *  Group and begin a new Group as soon as practical."
   * "If the original publisher does not support dynamic Groups, it ignores the parameter"
   *
   * - DYNAMIC_GROUPS を広告していなければ知らせない
   * - 現在の Group は送った最大の Location の Group である。値が 0 (要求した側が Group を
   *   知らない) か、現在の Group より大きいときだけ知らせる。現在の Group 以下の値は、
   *   新しい Group が既に始まっていることを表す
   * - まだ何も送っていなければ、どの値でも知らせる
   *
   * 新しい Group をいつ始めるか (次のキーフレームなど) はアプリが決める。
   *
   * @returns アプリへ知らせたら true
   */
  handleNewGroupRequest(newGroupRequest: bigint): boolean {
    if (!this.dynamicGroups) {
      return false;
    }
    const currentGroup = this.getLargestLocation()?.group;
    if (newGroupRequest !== 0n && currentGroup !== undefined && newGroupRequest <= currentGroup) {
      return false;
    }
    this.newGroupRequestCallback?.(newGroupRequest);
    return true;
  }

  /**
   * Internal: 解決済みの購読 Location Filter を取得する (セッションからのみ呼ぶ)
   */
  getResolvedLocationFilter(): ResolvedFilter | undefined {
    return this.subscriptionLocationFilter;
  }

  /**
   * §3.1.4 / §8.2: WebTransport が Object の書き込みを受理した時点で最大位置を更新する。
   * 最初のバイトが送出された時刻はブラウザの API から取得できないため、
   * 成功した write() を公開の境界に使う。
   */
  recordPublishedLocation(group: bigint, object: bigint): void {
    const largest = this.largestLocationState.largest;
    if (
      largest === null ||
      group > largest.group ||
      (group === largest.group && object > largest.object)
    ) {
      this.largestLocationState.largest = { group, object };
    }
  }

  /**
   * 送信対象の Location が購読の Location Filter の範囲外かどうかを返す
   *
   * draft-ietf-moq-transport-23 §3.3.1 (Location Filters):
   * 「A publisher MUST NOT send objects from outside the
   *  requested range.」
   * subscription-delivered の定義は §3.1 (Subscriptions) にある。
   * フィルタ未保持 (undefined) は全 Object 通過。groupId / objectId は number の
   * ため、非整数・負値を除いてから
   * bigint 化する。非整数・負値は既存の送信経路の fail-fast に委ね、
   * フィルタ判定はスキップする。
   */
  private isOutsideLocationFilter(groupId: number, objectId: number): boolean {
    const filter = this.subscriptionLocationFilter;
    if (filter === undefined) {
      return false;
    }
    if (!Number.isInteger(groupId) || !Number.isInteger(objectId)) {
      return false;
    }
    if (groupId < 0 || objectId < 0) {
      return false;
    }
    return !objectMatchesFilter({ group: BigInt(groupId), object: BigInt(objectId) }, filter);
  }

  /**
   * 送信対象の Object が購読の Range Filters を通過しないかを返す
   *
   * draft-ietf-moq-transport-23 §3.3.2 (Range Filters) / §3.3.3 (Combining Filters):
   * "The publisher MUST forward only objects that pass all filters."
   * Location Filter と同じく、判定できない値 (非整数・負値・不正な priority) は
   * 既存の送信経路の fail-fast に委ねてフィルタ判定を行わない。
   *
   * Subgroup の 2 件目以降は Subgroup Header で固定された Subgroup ID /
   * Publisher Priority を使う (§11.3.1)。Datagram は Subgroup ID を持たないため
   * SUBGROUP_FILTER は不通過になる。Priority を省略した Datagram は既定の
   * Publisher Priority 128 を評価値にする (§10.4)。
   *
   * @param values - 評価値 (評価できない場合は null)
   * @returns Range Filters を通過しない場合 true
   */
  private isOutsideRangeFilters(values: RangeFilterValues | null): boolean {
    if (values === null || this.subscriptionRangeFilters.length === 0) {
      return false;
    }
    return !rangeFiltersMatch(this.subscriptionRangeFilters, {
      ...values,
      trackProperties: this.publisherTrackProperties,
    });
  }

  /**
   * 送信する Object に使う Subgroup の値を決める
   *
   * draft-ietf-moq-transport-23 §11.3.1 (Subgroup Header):
   * Subgroup ID と Publisher Priority は、Subgroup を開くときに Header へ固定する。
   * 同じ Group の続きはこの subscription が開いている Subgroup の値を使い、
   * まだその Group で送っていなければ Track 共通の値を使う。Track でもまだ
   * その Group の Subgroup を開いていなければ、この Object を先頭にして
   * Subgroup ID = Object ID、Publisher Priority = 指定値または 128 で開く。
   *
   * draft-ietf-moq-transport-23 §2.2 (Subgroups) / §11.3.1:
   * FIRST_OBJECT ビットは「その Subgroup のストリームの先頭 Object が、その
   * Subgroup で最初に publish された Object か」を表す。Track 共通の値として
   * 最初に送った Object ID (firstObjectId) と、これから送る Object ID を比べて決める。
   * 途中から購読を始めた subscription は false になる。
   *
   * @returns 確定値。ID / priority が不正で評価できない場合は null
   */
  private resolveSubgroupForObject(params: SendObjectParams): ResolvedSubgroup | null {
    if (!Number.isInteger(params.groupId) || !Number.isInteger(params.objectId)) {
      return null;
    }
    if (params.groupId < 0 || params.objectId < 0) {
      return null;
    }
    const groupId = BigInt(params.groupId);
    const objectId = BigInt(params.objectId);

    // この subscription が既に同じ Group の Subgroup を開いている場合は、
    // そのストリームの Header で固定済みの値を変えられない。
    if (
      this.currentSubgroupGroupId === groupId &&
      this.currentSubgroupId !== null &&
      this.currentSubgroupPublisherPriority !== null
    ) {
      return {
        groupId,
        objectId,
        subgroupId: this.currentSubgroupId,
        publisherPriority: this.currentSubgroupPublisherPriority,
        firstObject: false,
      };
    }

    // Track 共通の値があれば、その Subgroup の途中から参加する。
    // §11.3.1 の SUBGROUP_ID_MODE 0b01 (Subgroup ID = 先頭 Object ID) は
    // 「そのストリームの先頭 Object」の ID になるため、先頭 Object が Subgroup を
    // 開いた Object と違う場合は使えない。その場合は 0b10 (明示) で送る。
    const shared = this.sharedSubgroupState;
    if (
      shared !== null &&
      shared.groupId === groupId &&
      shared.subgroupId !== null &&
      shared.publisherPriority !== null &&
      shared.firstObjectId !== null
    ) {
      return {
        groupId,
        objectId,
        subgroupId: shared.subgroupId,
        publisherPriority: shared.publisherPriority,
        // このストリームの先頭 Object が Subgroup で最初に publish された Object と
        // 同じときだけ FIRST_OBJECT ビットを立てられる (§2.2)。
        firstObject: shared.firstObjectId === objectId,
      };
    }

    // この Object が Track でその Group の Subgroup を開く。
    const publisherPriority = params.priority ?? 128;
    if (!Number.isInteger(publisherPriority) || publisherPriority < 0 || publisherPriority > 255) {
      // 不正 priority は publishSendObject の fail-fast に委ねる
      return null;
    }
    return {
      groupId,
      objectId,
      subgroupId: objectId,
      publisherPriority,
      firstObject: true,
    };
  }

  /**
   * Object の Range Filter 評価値を組み立てる
   *
   * draft-ietf-moq-transport-23 §3.3.2 / §3.3.3:
   * Subgroup ID と Publisher Priority は、実際に wire へ載せる Subgroup の値で
   * 評価する (§11.3.1 で Header に固定される値)。値の決定は
   * resolveSubgroupForObject に集約する。
   *
   * @returns 評価値。Subgroup を決められない (ID が不正等) 場合は null
   */
  private resolveRangeFilterValuesForObject(
    objectProperties: Uint8Array | undefined,
    subgroup: ResolvedSubgroup | null,
  ): RangeFilterValues | null {
    if (subgroup === null) {
      return null;
    }
    return {
      subgroupId: subgroup.subgroupId,
      objectId: subgroup.objectId,
      publisherPriority: subgroup.publisherPriority,
      ...(objectProperties !== undefined ? { objectProperties } : {}),
    };
  }

  private matchesSubgroupRangeFilters(
    objectProperties: Uint8Array | undefined,
    subgroup: ResolvedSubgroup | null,
  ): boolean {
    return (
      this.subscriptionRangeFilters.length === 0 ||
      !this.isOutsideRangeFilters(
        this.resolveRangeFilterValuesForObject(objectProperties, subgroup),
      )
    );
  }

  /**
   * sendDatagram の Range Filter 評価値を組み立てる
   *
   * Datagram は Subgroup ID を持たないため subgroupId を載せない
   * (SUBGROUP_FILTER は不通過になる)。Priority を省略した Datagram は wire に
   * Priority フィールドを持たないが、既定の Publisher Priority 128 を継承する
   * (§10.4) ため、評価値には 128 を載せる。
   *
   * @returns 評価値。ID / priority が不正で評価できない場合は null
   */
  private resolveRangeFilterValuesForDatagram(
    params: SendDatagramParams,
  ): RangeFilterValues | null {
    if (!Number.isInteger(params.groupId) || !Number.isInteger(params.objectId)) {
      return null;
    }
    if (params.groupId < 0 || params.objectId < 0) {
      return null;
    }
    const publisherPriority = params.priority ?? 128;
    if (!Number.isInteger(publisherPriority) || publisherPriority < 0 || publisherPriority > 255) {
      // 不正 priority は publishSendDatagram の fail-fast に委ねる
      return null;
    }
    return {
      objectId: BigInt(params.objectId),
      publisherPriority,
      ...(params.properties !== undefined ? { objectProperties: params.properties } : {}),
    };
  }

  /**
   * 送信を受け付けた Object で、Subgroup の識別値を記録する
   *
   * この subscription の状態 (currentSubgroup*) には、実際に送る Subgroup の値を
   * そのまま記録する (Range Filter の評価と §11.3.2 の RESET 判定が使う)。
   * Track 共通の状態 (sharedSubgroupState) は、まだその Group の Subgroup を
   * 開いていなければ、この Object を先頭として記録する。既に同じ Group の値が
   * ある場合は、同じ Subgroup に参加するだけなので変えない。
   *
   * フィルタで見送った Object は Subgroup を開かないため呼ばない。
   */
  private recordCurrentSubgroup(subgroup: ResolvedSubgroup): void {
    this.currentSubgroupGroupId = subgroup.groupId;
    this.currentSubgroupId = subgroup.subgroupId;
    this.currentSubgroupPublisherPriority = subgroup.publisherPriority;

    const shared = this.sharedSubgroupState;
    if (shared !== null && shared.groupId !== subgroup.groupId) {
      shared.groupId = subgroup.groupId;
      shared.subgroupId = subgroup.subgroupId;
      shared.publisherPriority = subgroup.publisherPriority;
      shared.firstObjectId = subgroup.objectId;
    }
  }

  incrementDataStreamCount(): void {
    this.dataStreamCount++;
  }

  getDataStreamCount(): bigint {
    return this.dataStreamCount;
  }

  /**
   * §11.3.2: ストリームを開く前の見送りも購読に記録する。
   * 購読の Start Location より前の Object は、FIN の判断に必要な配信対象から除外される。
   */
  recordOmittedSubgroupObject({
    groupId,
    objectId,
  }: Pick<SendObjectParams, "groupId" | "objectId">): void {
    if (!Number.isInteger(groupId) || !Number.isInteger(objectId) || groupId < 0 || objectId < 0) {
      return;
    }
    const group = BigInt(groupId);
    const object = BigInt(objectId);
    if (group > MAX_VARINT || object > MAX_VARINT) return;
    const start = this.subscriptionLocationFilter?.start;
    if (start !== undefined && compareLocations({ group, object }, start) < 0) return;

    const groups = this.getOmittedSubgroupObjects();
    let objects = groups.get(group);
    if (objects === undefined) {
      objects = new Set();
      groups.set(group, objects);
    }
    objects.add(object);
  }

  /** 再開後に同じ Object の書き込みを完了した時点で、見送りの記録を解消する。 */
  recordWrittenSubgroupObject(groupId: bigint, objectId: bigint): void {
    const groups = this.omittedSubgroupObjects;
    if (groups === undefined) return;
    const objects = groups.get(groupId);
    if (objects?.delete(objectId) && objects.size === 0) groups.delete(groupId);
  }

  /** 開いているストリームは、購読の終了後も閉じるまで見送り履歴を参照する。 */
  getSubgroupOmissions(): ReadonlyMap<bigint, ReadonlySet<bigint>> {
    return this.getOmittedSubgroupObjects();
  }

  private getOmittedSubgroupObjects(): Map<bigint, Set<bigint>> {
    this.omittedSubgroupObjects ??= new Map();
    return this.omittedSubgroupObjects;
  }

  /**
   * Object / Datagram の送信前ガード
   *
   * draft-ietf-moq-transport-23 §3.1.1 (Pausing Subscriptions):
   * "An Established subscription is either paused or not paused.  The publisher
   *  does not send Objects on a paused subscription, and does send them when it
   *  is not paused.  Control messages, such as PUBLISH_DONE (Section 9.9), are
   *  sent regardless of whether the subscription is paused."
   * subscription が paused の間は送信せず、LARGEST_OBJECT の記録や END_OF_TRACK の
   * 記録も行わない (送信していない Object を記録しない)。
   * END_OF_TRACK 送信後の後続送信は禁止する。ライフサイクル状態の検証を
   * パラメータ形状より先に行う。
   *
   * @param kind - エラーメッセージに使う送信種別
   * @returns 送信してよければ null、paused で送信しない場合は "skip"、
   *          違反の場合は ProtocolViolationError (error コールバック通知済み)
   */
  private guardSend(
    kind: "object" | "datagram",
    groupId: number,
  ): ProtocolViolationError | "skip" | null {
    if (this.publisherState === "closed") {
      throw new Error("Publisher is closed");
    }
    // §9.9: キューに受理済みの Object は送信を続け、新規の送信だけを拒否する。
    if (this.donePromise !== null) {
      throw new Error("Publisher is closing");
    }
    if (this.publisherPaused) {
      return "skip";
    }
    if (this.endOfTrackSent) {
      const violation = new ProtocolViolationError(
        `cannot send ${kind} after END_OF_TRACK was sent`,
      );
      this.handleError(violation);
      return violation;
    }
    // draft-ietf-moq-transport-23 §11.1.1 (Object Status):
    // END_OF_GROUP は Group の最終 Object を宣言するため、同じ Group へ後続の
    // Object / Datagram を送ることはできない (別の Group への送信は妨げない)。
    if (this.endOfGroupSentGroupId !== null && groupId === this.endOfGroupSentGroupId) {
      const violation = new ProtocolViolationError(
        `cannot send ${kind} after END_OF_GROUP was sent for group ${groupId}`,
      );
      this.handleError(violation);
      return violation;
    }
    return null;
  }

  /**
   * Send an object on this track
   *
   * draft-ietf-moq-transport-23 §3.1 (Subscriptions):
   * 同じ Track に複数 subscription がある場合、購読ごとに 1 回ずつ送る。
   * このメソッドは自分の subscription への送信を行った後、セッションが設定した
   * fan-out コールバック (onSendObjectFanOut) で他の subscription へ配信する。
   * fan-out の失敗は自分の送信の結果を変えない (購読ごとの独立した失敗として扱う)。
   *
   * 戻り値は object が WebTransport stream に書き込み完了した時点で resolve する Promise。
   * Catalog のように relay 到達を保証してから後続処理に進めたい場合は await する。
   * リアルタイムフレームのように落としても良い場合は `void` で破棄して構わない。
   *
   * 事前検証 (guard / status) の違反は自分で error 通知してから返値の reject になる。
   * guard 違反は END_OF_TRACK 送信後と END_OF_GROUP 送信済み Group への送信である
   * (組み合わせ規則は draft-ietf-moq-transport-23 §11.1.1 / §11.1.2、
   * END_OF_TRACK 後と END_OF_GROUP 済み Group は §11.1.2 の各定義による解釈)。
   * 委譲先 (onSendObject) の ID / priority 検証も自分で error 通知してから reject する。
   * どちらの経路も reject は必ず通知を伴うため、呼び出し側は通知し直さなくてよい。
   *
   * Publisher が終了処理中または closed の場合は検証の前に同期 throw する (sendDatagram と同じ契約。
   * 返値は Promise だが reject ではなく throw になる。この経路は通知を伴わない)。
   *
   * 購読の Location Filter の範囲外 Object は送信せず、解決済みの
   * Promise<void> を返す (§3.3.1)。購読の Range Filters を通過しない Object も
   * 同じ扱いになる (§3.3.2 / §3.3.3)。Start Location 以降の見送りを記録し、
   * 未送信の Object が残る Subgroup は RESET で閉じる (§11.3.2)。
   */
  sendObject(params: SendObjectParams): Promise<void> {
    // 自分の subscription への送信を先に評価・実行する。評価の途中で同期 throw
    // (closed 等) した場合は fan-out しない (他の subscription にも同じ違反を
    // 通知しない)。
    const result = this.sendObjectToSubscription(params);
    if (this.publishedTrackOrigin === "app" && this.onSendObjectFanOut !== undefined) {
      try {
        this.onSendObjectFanOut(params);
      } catch {
        // fan-out の同期失敗は購読ごとの失敗であり、自分の送信結果を変えない
        // (個々の subscription の送信失敗は publishSendObject が handleError で通知する)
      }
    }
    return result;
  }

  /**
   * Internal: 自分自身の PUBLISH subscription にだけ Object を送信する
   *
   * draft-ietf-moq-transport-23 §3.1 / §3.3.1 / §3.3.2 / §11.3.2:
   * paused / Location Filter / Range Filters の評価と、END_OF_TRACK・
   * END_OF_GROUP・省略の記録をこの 1 か所に集約する。
   * 公開 API の sendObject と、同じ Track の他の subscription への fan-out
   * (publishedTracks) の両方がこのメソッドを使う。fan-out から呼ばれた場合は
   * onSendObjectFanOut を再帰的に呼ばないよう、公開 API を経由しない。
   */
  sendObjectToSubscription(params: SendObjectParams): Promise<void> {
    // 戻り値は通常経路と同じ Promise<void> とし、呼び出し側の await を壊さない。
    const guard = this.guardSend("object", params.groupId);
    if (guard === "skip") {
      // draft-ietf-moq-transport-23 §11.3.2: paused 中に送信しなかった Object が
      // ある Subgroup は、閉じる時に FIN ではなく RESET が必要になる。
      this.recordOmittedSubgroupObject(params);
      return Promise.resolve();
    }
    if (guard !== null) {
      return Promise.reject(guard);
    }

    // draft-ietf-moq-transport-23 §11.1.1:
    // status / payload 規則は委譲前 (queue 登録前) に検証する。
    // 違反は通知して返値の Promise を reject する (解決しない)。
    try {
      validateSendStatusPayload(params);
    } catch (error) {
      const rejection = error instanceof Error ? error : new Error(String(error));
      this.handleError(rejection);
      return Promise.reject(rejection);
    }

    // draft-ietf-moq-transport-23 §3.3.1:
    // 購読の Location Filter の範囲外 Object は送信しない (paused と
    // 同様に送信も LARGEST_OBJECT の記録もしない。範囲外は正常なフィルタ動作であり
    // error 通知は行わない)。
    // §11.3.2: Start Location より前を除き、見送った Object を記録する。
    if (this.isOutsideLocationFilter(params.groupId, params.objectId)) {
      this.recordOmittedSubgroupObject(params);
      return Promise.resolve();
    }

    // draft-ietf-moq-transport-23 §3.3.2 / §3.3.3:
    // 購読の Range Filters を通過しない Object は送信しない。Location Filter の
    // 範囲外と同じ扱いであり、LARGEST_OBJECT の記録も error 通知も行わない。
    // 見送った Object が残る Subgroup を閉じる場合は RESET が必要 (§11.3.2)。
    // 評価値は実際に wire へ載せる Subgroup の値 (§11.3.1) であり、Track 共通の
    // 値を使うかどうかは resolveSubgroupForObject が決める。
    const subgroup = this.resolveSubgroupForObject(params);
    let preparedProperties: Uint8Array | undefined;
    if (params.deliveryTimeout !== undefined || params.subgroupDeliveryTimeout !== undefined) {
      try {
        preparedProperties = mergeDeliveryTimeoutObjectProperties(
          params.properties,
          params.deliveryTimeout,
          params.subgroupDeliveryTimeout,
        );
      } catch (error) {
        // 送信キュー内のエンコードエラーと同じく、購読へ通知して送信を見送る。
        this.handleError(error instanceof Error ? error : new Error(String(error)));
        return Promise.resolve();
      }
    }
    if (!this.matchesSubgroupRangeFilters(preparedProperties ?? params.properties, subgroup)) {
      this.recordOmittedSubgroupObject(params);
      return Promise.resolve();
    }
    // 送信を受け付けた Object で Subgroup Header の識別値を確定する。
    // フィルタで見送った Object は Subgroup を開かないため、ここでは更新しない。
    if (subgroup !== null) {
      this.recordCurrentSubgroup(subgroup);
    }
    // Subgroup の確定値をセッションの送信処理へ渡す。Header の種別
    // (FIRST_OBJ_EXT / EXPLICIT_EXT) と Publisher Priority はこの値で決まる。
    const internalParams: SendObjectParamsInternal = {
      ...params,
      ...(subgroup === null ? {} : { resolvedSubgroup: subgroup }),
      sendFilterRevision: this.sendFilterRevision,
    };
    if (preparedProperties !== undefined) internalParams.preparedProperties = preparedProperties;

    const isEndOfTrack = (params.status ?? ObjectStatus.NORMAL) === ObjectStatus.END_OF_TRACK;
    // draft-ietf-moq-transport-23 §11.1.1 (Object Status):
    // END_OF_GROUP は Group の最終 Object を宣言するため、同一 Group への後続送信は
    // guardSend で拒否する。受理した Group ID はここで記録する。
    const isEndOfGroup = (params.status ?? ObjectStatus.NORMAL) === ObjectStatus.END_OF_GROUP;
    if (!this.onSendObject) {
      // 委譲先がなくても END_OF_TRACK / END_OF_GROUP の意味論は保つ
      if (isEndOfTrack) {
        this.endOfTrackSent = true;
      }
      if (isEndOfGroup) {
        this.endOfGroupSentGroupId = params.groupId;
      }
      return Promise.resolve();
    }

    // 未 await の連続呼び出しを防ぐため終端を予約してから委譲する。
    // キュー投入後にフィルタを通過しなかった場合も、予約を解除して再送を許す。
    if (isEndOfTrack) {
      this.endOfTrackSent = true;
      const clearEndOfTrack = () => {
        this.endOfTrackSent = false;
      };
      internalParams.onOmitted = clearEndOfTrack;
      let result: Promise<void>;
      try {
        result = this.onSendObject(internalParams);
      } catch (error) {
        clearEndOfTrack();
        throw error;
      }
      void result.catch(clearEndOfTrack);
      return result;
    }

    // END_OF_GROUP も受け付け時に記録する (未 await の連続呼び出しを塞ぐ)。
    // 委譲先の同期 throw・非同期 reject 時は記録を取り消して再送できる。
    if (isEndOfGroup) {
      this.endOfGroupSentGroupId = params.groupId;
      const clearEndOfGroup = () => {
        if (this.endOfGroupSentGroupId === params.groupId) this.endOfGroupSentGroupId = null;
      };
      internalParams.onOmitted = clearEndOfGroup;
      let result: Promise<void>;
      try {
        result = this.onSendObject(internalParams);
      } catch (error) {
        clearEndOfGroup();
        throw error;
      }
      void result.catch(clearEndOfGroup);
      return result;
    }
    return this.onSendObject(internalParams);
  }

  /**
   * Send a datagram on this track
   * draft-ietf-moq-transport-23 Section 11.2 (Datagrams)
   *
   * 自分の subscription への送信を行った後、セッションが設定した fan-out
   * コールバック (onSendDatagramFanOut) で同じ Track の他の subscription へ
   * 配信する (§3.1)。fan-out の失敗は自分の送信の結果を変えない。
   *
   * 事前検証 (guard) の違反は自分で error 通知してから throw になる。
   * guard 違反は END_OF_TRACK 送信後と END_OF_GROUP 送信済み Group への送信である
   * (§11.1.2 の EOT / END_OF_GROUP の各定義による解釈。END_OF_GROUP 済みの判定は
   * sendObject が END_OF_GROUP を受理した Group による。Datagram 自身の
   * endOfGroup は記録しないため、後続の送信は妨げない)。
   * paused (subscription が paused) の間は送信せず、通知もなく return する
   * (§3.1.1)。
   * Publisher が終了処理中または closed の場合は検証の前に同期 throw する (通知は行わない)。
   * 委譲先 (onSendDatagram) の ID / priority 検証も自分で error 通知してから throw する。
   * 購読の Location Filter / Range Filters を通過しない Datagram は送信しない
   * (§3.3.1 / §3.3.2 / §3.3.3)。
   */
  sendDatagram(params: SendDatagramParams): Promise<void> {
    // 評価 (guard) で同期 throw した場合は fan-out しない。
    const result = this.sendDatagramToSubscription(params);
    if (this.publishedTrackOrigin === "app" && this.onSendDatagramFanOut !== undefined) {
      try {
        this.onSendDatagramFanOut(params);
      } catch {
        // fan-out の同期失敗は購読ごとの失敗であり、自分の送信結果を変えない
      }
    }
    return result;
  }

  /**
   * Internal: 自分自身の PUBLISH subscription にだけ Datagram を送信する
   *
   * draft-ietf-moq-transport-23 §11.2:
   * paused / Location Filter / Range Filters の評価をこの 1 か所に集約する。
   * 公開 API の sendDatagram と、同じ Track の他の
   * subscription への fan-out (publishedTracks) の両方がこのメソッドを使う。
   */
  sendDatagramToSubscription(params: SendDatagramParams): Promise<void> {
    const guard = this.guardSend("datagram", params.groupId);
    if (guard === "skip") {
      return Promise.resolve();
    }
    if (guard !== null) {
      throw guard;
    }

    // §11.1.1 / §11.2.1: 空の Datagram には STATUS が必要で、END_OF_GROUP とは併用できない。
    if (params.payload.byteLength === 0 && params.endOfGroup === true) {
      const error = new ProtocolViolationError("empty datagram cannot set END_OF_GROUP");
      this.handleError(error);
      throw error;
    }

    // draft-ietf-moq-transport-23 §3.3.1:
    // 購読の Location Filter の範囲外 Datagram は送信しない。
    if (this.isOutsideLocationFilter(params.groupId, params.objectId)) {
      return Promise.resolve();
    }

    // draft-ietf-moq-transport-23 §3.3.2 / §3.3.3:
    // 購読の Range Filters を通過しない Datagram は送信しない。
    // Datagram の見送りは Subgroup の履歴に記録しない (§11.3.2)。
    if (this.isOutsideRangeFilters(this.resolveRangeFilterValuesForDatagram(params))) {
      return Promise.resolve();
    }

    if (this.onSendDatagram) {
      // 同期 throw は従来どおり呼び出し側へ流す (検証違反の契約を変えない)
      return Promise.resolve(this.onSendDatagram(params));
    }
    return Promise.resolve();
  }

  /**
   * 開いている Subgroup を、Object を送らずに閉じる (契約はインタフェースの JSDoc を参照)
   *
   * 終了処理中・closed の場合と、内部コールバックが未設定の場合は
   * 何もしない。返値は reject せず、内部コールバックの失敗 (同期 throw を含む) は
   * error 通知に変換する (呼び出し側は `void` で呼ぶ)
   */
  closeSubgroup(): Promise<void> {
    if (
      this.publisherState === "closed" ||
      this.donePromise !== null ||
      this.onCloseSubgroup === undefined
    ) {
      return Promise.resolve();
    }
    try {
      return this.onCloseSubgroup().catch((error: unknown) => {
        // error コールバック (アプリの onError) が throw しても返値は reject させない
        // (呼び出し側は void で呼ぶため、未処理の rejection になる)
        try {
          this.handleError(error instanceof Error ? error : new Error(String(error)));
        } catch {
          // 通知の失敗を伝える経路がこれ以上無いため握る
        }
      });
    } catch (error) {
      // 同期 throw も error 通知に変換する (呼び出し側は void で呼ぶため、
      // そのまま外へ流すと未処理の例外になる)
      this.handleError(error instanceof Error ? error : new Error(String(error)));
      return Promise.resolve();
    }
  }

  /**
   * 購読状態の変化を PUBLISH_STATE_NOTIFY で購読者へ通知する
   *
   * draft-ietf-moq-transport-23 §9.10 (PUBLISH_STATE_NOTIFY):
   * 「A publisher sends PUBLISH_STATE_NOTIFY on a subscription's bidirectional
   *  stream to notify the subscriber that the state of the subscription has
   *  changed for a reason other than a subscriber sent REQUEST_UPDATE.」
   * moqt-js は購読状態を自力で変化させない (paused は PUBLISH 送信時の
   * 指定と REQUEST_UPDATE 受信、Location Filter は REQUEST_UPDATE 受信で
   * 変わる) ため、アプリが変化後の値を指定して呼ぶ明示 API とする。
   *
   * 送信の成否は返値の Promise で表す。fire-and-forget で呼んでも reject が
   * unhandled rejection にならないよう、キューは返却値にも失敗時の処理を登録する。
   */
  notifyStateChange(options?: PublishStateNotifyOptions): Promise<void> {
    if (this.publisherState === "closed" || this.donePromise !== null) {
      return Promise.resolve();
    }
    const notify = this.onNotifyStateChange;
    const paused = options?.paused;
    const filter = options?.filter;
    if (notify === undefined || (paused === undefined && filter === undefined)) {
      return Promise.resolve();
    }
    // 順番待ちの間に呼び出し元が書き換えても、呼び出した時点の値を使う。
    const change: PublishStateNotifyOptions = {
      ...(paused === undefined ? {} : { paused }),
      ...(filter === undefined ? {} : { filter: { ...filter } }),
    };
    return this.enqueueStateChange(() => notify.call(this, change));
  }

  /** 購読状態の比較から反映までを直列化する。終了開始後は新しい変更を受け付けない。 */
  enqueueStateChange<T>(change: () => Promise<T>): Promise<T | undefined> {
    if (this.publisherState === "closed" || this.donePromise !== null) {
      return Promise.resolve(undefined);
    }

    const result = (this.stateChangeTail ?? Promise.resolve()).then(() =>
      this.publisherState === "closed" ? undefined : change(),
    );
    // 失敗はその呼び出しへ返し、後続の変更は処理する。返値にも reject ハンドラーが付く。
    const complete = () => {
      if (this.stateChangeTail === tail) this.stateChangeTail = undefined;
    };
    const tail = result.then(complete, complete);
    this.stateChangeTail = tail;
    return result;
  }

  /**
   * Handle error
   *
   * 通知した error に印を付け、呼び出し側が同じ失敗を通知し直さないようにする
   * (1 件の失敗で 2 回通知になるのを防ぐ)。印を付けるだけで通知の回数は変えず、
   * error コールバックが未指定でも印は付く (高レベル API が作る publisher には
   * 必ず error コールバックが配線されるため、印付きは利用者への通知済みでもある)。
   * 印を理由にここで通知を抑止しないこと。抑止するのは呼び出し側 (高レベル API の
   * start 失敗の通知) だけである。
   */
  handleError(error: Error): void {
    publisherNotifiedErrors.add(error);
    this.errorCallback?.(error);
  }

  /**
   * Internal: paused 状態を設定する (called by session)
   * draft-ietf-moq-transport-23 Section 9.19.18 (PAUSED Parameter)
   *
   * REQUEST_UPDATE で受信した PAUSED パラメータを反映する。
   * PUBLISH 送信時の options.paused による初期設定でも呼ぶ。
   * PUBLISH_OK は EXPIRES のみを運び PAUSED を反映しない。
   * 引数は wire の PAUSED と同じ意味 (true = paused) で、反転は行わない。
   * 状態が変化した場合、onPausedChange コールバックを呼ぶ。
   */
  setPaused(paused: boolean): void {
    const previousState = this.publisherPaused;
    this.publisherPaused = paused;
    if (previousState !== paused) {
      this.pausedChangeCallback?.(paused);
    }
  }

  /**
   * Signal that publishing is done
   *
   * 並行呼び出しでは、進行中の done() の Promise を再利用して二重の
   * PUBLISH_DONE 送信を防ぐ。done() の resolve は「PUBLISH_DONE 送信完了まで
   * 待つ」意味論を維持するため、2 回目の呼び出しも 1 回目の完了を待つ。
   * ただしセッション終了後は PUBLISH_DONE を送信せずに resolve する
   * (publishSendPublishDone の sessionState ガード)。
   * 完了 (成功・失敗) 後はガードをリセットする。成功時は publisherState が
   * "closed" になり以後の done() は早期 return するため再試行は起きず、
   * 失敗時は以後の done() で再試行を許す (reject 後も publisherState が
   * "active" のままの意味論を維持する)。
   */
  done(status: PublishDoneStatusCode = PublishDoneStatusCode.TRACK_ENDED): Promise<void> {
    // draft-ietf-moq-transport-23 §12.4: アプリが PUBLISH_DONE で送れる status を
    // TRACK_ENDED (正常終了) と EXPIRED_AUTH_TOKEN (認可トークン期限切れ) に限る。
    // 許可外の値は状態変更や PUBLISH_DONE 送信より前に拒否する。
    if (
      status !== PublishDoneStatusCode.TRACK_ENDED &&
      status !== PublishDoneStatusCode.EXPIRED_AUTH_TOKEN
    ) {
      throw new Error(`unsupported publish done status: 0x${status.toString(16)}`);
    }
    return this.terminate(status);
  }

  /**
   * Internal: PUBLISH_DONE を指定 status で 1 回だけ送信する (セッションからのみ呼ぶ)
   *
   * done() と REQUEST_UPDATE 拒否経路 (UPDATE_FAILED) が同じ donePromise 排他を
   * 通ることで、並行しても PUBLISH_DONE は 1 回だけ送られる。排他を先に取得した
   * 側が勝ち、後着は同じ Promise を await して何もしない (§9.9「PUBLISH_DONE は
   * 最終メッセージ」のため後着が別 status を重ねて送ることはしない)。done() が
   * 先に完了した場合に §9.5.1 の UPDATE_FAILED が送られないのは、購読がアプリ
   * 起点で既に正常終了しているためである。
   */
  async terminate(status: PublishDoneStatusCode): Promise<void> {
    if (this.publisherState === "closed") {
      return;
    }

    if (this.donePromise) {
      return this.donePromise;
    }

    // 終了コールバックが再入しても、実行前に送信の受け付けを止めておく。
    this.donePromise = Promise.resolve().then(() => this.doneInternal(status));
    try {
      await this.donePromise;
    } finally {
      this.donePromise = null;
    }
  }

  /**
   * onDoneInternal (PUBLISH_DONE 送信) を実行してから publisherState を
   * "closed" に遷移する
   */
  private async doneInternal(status: PublishDoneStatusCode): Promise<void> {
    if (this.publisherState === "closed") {
      return;
    }
    const pendingChanges = this.stateChangeTail;
    if (pendingChanges !== undefined) {
      // §9.9: 受理済みの変更を処理してから、最後のメッセージとして PUBLISH_DONE を送る。
      const cancelled = new Promise<void>((resolve) => {
        this.cancelStateChangeDrain = resolve;
      });
      await Promise.race([pendingChanges, cancelled]);
      this.cancelStateChangeDrain = undefined;
      if (this.state === "closed") return;
    }
    if (this.onDoneInternal) {
      await this.onDoneInternal(status);
    }

    this.markClosed();
  }

  /** Internal: この購読について WebTransport に書き込みを依頼した末尾の Datagram を記録する。 */
  recordDatagramWrite(completed: Promise<void>): void {
    this.lastDatagramWrite = completed;
  }

  /** Internal: 末尾の Datagram の write 完了または購読のキャンセルまで待つ。 */
  waitForDatagramWrites(): Promise<void> | undefined {
    if (this.lastDatagramWrite === undefined) {
      return undefined;
    }
    const cancelled = new Promise<void>((resolve) => {
      this.cancelDatagramDrain = resolve;
    });
    return Promise.race([this.lastDatagramWrite, cancelled]).finally(() => {
      this.cancelDatagramDrain = undefined;
    });
  }

  /**
   * Internal: mark as closed (called by session)
   */
  markClosed(): void {
    this.publisherState = "closed";
    this.stateChangeTail = undefined;
    this.cancelStateChangeDrain?.();
    this.cancelStateChangeDrain = undefined;
    this.lastDatagramWrite = undefined;
    this.cancelDatagramDrain?.();
    this.cancelDatagramDrain = undefined;
    this.omittedSubgroupObjects = undefined;
    // 購読終了 (done / peer cancel / セッション終了) では END_OF_GROUP 済みの
    // Group 記録も破棄する。
    this.endOfGroupSentGroupId = null;
    // 開いていた Subgroup の識別値も破棄する (以後の送信はない)。
    this.currentSubgroupGroupId = null;
    this.currentSubgroupId = null;
    this.currentSubgroupPublisherPriority = null;
  }
}
