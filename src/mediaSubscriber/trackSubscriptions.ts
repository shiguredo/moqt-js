/**
 * 音声と映像のトラック購読
 *
 * トラックの SUBSCRIBE 発行、購読ハンドルの保持、解除の順序をまとめる。購読の作法
 * (authInfo に応じた Authorization Token の解決、RENDEZVOUS_TIMEOUT の引き回し、
 * exactOptionalPropertyTypes の下でのオプションの組み立て、解除の順序) を 1 か所に
 * 置くことで、ライブラリの `MediaSubscriberImpl` と devtools の購読経路が同じ手順を
 * 使える。
 *
 * 受信した Object をどう扱うか (復号・再生・統計) は呼び出し側がコールバックで決める。
 * このクラスは Session との往復とハンドルの寿命だけを持ち、メディアの意味を持たない。
 */

import type { MoqtObject } from "../dataStream";
import type { AuthorizationToken } from "../message";
import type { AuthInfo } from "../msf";
import type {
  PublishDoneInfo,
  Session,
  SubgroupStreamEnd,
  SubscribeCallbacks,
  SubscribeOptions,
} from "../session";
import type { Subscriber } from "../subscriber";

/** トラック購読で呼び出し側が受けるコールバック */
export interface TrackSubscriptionCallbacks {
  /** Subgroup で受信した Object */
  object: (object: MoqtObject) => void;
  /** Datagram で受信した Object (音声のみ) */
  datagram?: (object: MoqtObject) => void;
  /** Subgroup の stream の終わり (映像の復号順の制御に使う) */
  subgroupEnd?: (end: SubgroupStreamEnd) => void;
  /** PUBLISH_DONE による購読の終了 */
  end: (publishDone: PublishDoneInfo) => void;
  /** 購読の失敗 */
  error: (error: Error) => void;
  /** リクエストストリームの GOAWAY */
  goaway: (newSessionUri: string) => void;
}

/** トラック購読の設定 */
export interface TrackSubscriptionSettings {
  /** catalog の track が持つ認可情報 (未指定なら認可不要) */
  readonly authInfo: AuthInfo | undefined;
  /** authInfo から Authorization Token を解決する利用者のコールバック */
  readonly getAuthorizationToken?:
    | ((
        authInfo: AuthInfo,
      ) => AuthorizationToken | undefined | Promise<AuthorizationToken | undefined>)
    | undefined;
  /** SETUP に載せた Authorization Token (authInfo がありコールバックが無いときに使う) */
  readonly setupAuthorizationToken?: AuthorizationToken | undefined;
  /** SUBSCRIBE に載せる RENDEZVOUS_TIMEOUT (ミリ秒、未指定は載せない) */
  readonly rendezvousTimeout?: bigint | undefined;
  /**
   * SUBSCRIBE の発行直前に呼ぶ検査
   *
   * 認可トークンの解決は await を挟むため、その間に解放が先行し得る。トークンを解決した
   * 後・SUBSCRIBE を発行する前に呼び、解放が先行していれば呼び出し側が throw する。
   */
  readonly assertNotDisposed?: (() => void) | undefined;
}

/**
 * authInfo に応じた Authorization Token を解決する
 *
 * draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track には、その track に関係する
 * AUTHORIZATION TOKEN パラメータを受け付けるすべての制御メッセージへ MUST 付与する。
 * 優先順位は次のとおりである。
 *
 * 1. authInfo が無い / 空なら認可不要として undefined
 * 2. 利用者の `getAuthorizationToken` があればその戻り値 (無い場合はエラー)
 * 3. SETUP に載せたトークンがあればそれ (§11.4.2)
 * 4. どれも無ければエラー (認可が必要なのに手段が無い)
 *
 * @param authInfo - catalog の track が持つ認可情報
 * @param getAuthorizationToken - authInfo からトークンを解決する利用者のコールバック
 * @param setupAuthorizationToken - SETUP に載せたトークン
 * @returns 付与するトークン (認可不要なら undefined)
 * @throws authInfo がありトークンを解決できない場合
 */
export async function resolveAuthorizationToken(
  authInfo: AuthInfo | undefined,
  getAuthorizationToken?: (
    authInfo: AuthInfo,
  ) => AuthorizationToken | undefined | Promise<AuthorizationToken | undefined>,
  setupAuthorizationToken?: AuthorizationToken,
): Promise<AuthorizationToken | undefined> {
  if (!authInfo || Object.keys(authInfo).length === 0) {
    // 認可不要
    return undefined;
  }
  if (getAuthorizationToken) {
    const token = await getAuthorizationToken(authInfo);
    if (!token) {
      throw new Error("track requires authorization but getAuthorizationToken returned no token");
    }
    return token;
  }
  if (setupAuthorizationToken) {
    // SETUP に載せたトークンをそのまま使う (§11.4.3)
    return setupAuthorizationToken;
  }
  throw new Error(
    "track requires authorization (authInfo present) but no getAuthorizationToken callback was provided",
  );
}

/**
 * 音声と映像のトラック購読
 *
 * 購読の確立に成功したハンドルだけを保持する。購読が確立する前の失敗ではハンドルが
 * 無いため、解除は何もしない (start の巻き戻しで解除する対象が無いことと同じ)。
 *
 * 解除の順序は音声 → 映像で固定する。catalog の購読は `CatalogSubscription` が持つため、
 * 呼び出し側が catalog → 音声 → 映像の順に解除する。順序を 1 か所に置くことで、
 * 停止経路と Map からの削除経路で順序が食い違わないようにする。
 */
export class TrackSubscriptions {
  private audio: Subscriber | null = null;
  private video: Subscriber | null = null;

  /** 音声トラックの購読ハンドル (未購読なら null) */
  get audioSubscriber(): Subscriber | null {
    return this.audio;
  }

  /** 映像トラックの購読ハンドル (未購読なら null) */
  get videoSubscriber(): Subscriber | null {
    return this.video;
  }

  /**
   * 音声トラックを subscribe する
   *
   * @param session - 接続済みの Session
   * @param namespace - 購読する namespace
   * @param trackName - 購読するトラック名
   * @param callbacks - 受信と終了のコールバック
   * @param settings - 認可と RENDEZVOUS_TIMEOUT の設定
   * @returns 確立した購読ハンドル
   * @throws 認可トークンを解決できない場合、または SUBSCRIBE が失敗した場合
   */
  async subscribeAudio(
    session: Session,
    namespace: string[],
    trackName: string,
    callbacks: TrackSubscriptionCallbacks,
    settings: TrackSubscriptionSettings,
  ): Promise<Subscriber> {
    const subscriber = await this.subscribe(session, namespace, trackName, callbacks, settings);
    this.audio = subscriber;
    return subscriber;
  }

  /**
   * 映像トラックを subscribe する
   *
   * @param session - 接続済みの Session
   * @param namespace - 購読する namespace
   * @param trackName - 購読するトラック名
   * @param callbacks - 受信と終了のコールバック
   * @param settings - 認可と RENDEZVOUS_TIMEOUT の設定
   * @returns 確立した購読ハンドル
   * @throws 認可トークンを解決できない場合、または SUBSCRIBE が失敗した場合
   */
  async subscribeVideo(
    session: Session,
    namespace: string[],
    trackName: string,
    callbacks: TrackSubscriptionCallbacks,
    settings: TrackSubscriptionSettings,
  ): Promise<Subscriber> {
    const subscriber = await this.subscribe(session, namespace, trackName, callbacks, settings);
    this.video = subscriber;
    return subscriber;
  }

  /**
   * 音声と映像の購読を解除する
   *
   * 購読が "active" のものだけを解除する (start の巻き戻しでは購読が確立しているが
   * MediaSubscriber の state は "subscribing" のままである)。片方の解除が失敗しても
   * もう片方を解除し、最初の失敗を投げる (後始末を止めない)。
   *
   * @throws 解除に失敗した場合 (最初の失敗)
   */
  async unsubscribeAll(): Promise<void> {
    let firstFailure: Error | null = null;

    const audio = this.audio;
    this.audio = null;
    if (audio !== null && audio.state === "active") {
      try {
        await audio.unsubscribe();
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }

    const video = this.video;
    this.video = null;
    if (video !== null && video.state === "active") {
      try {
        await video.unsubscribe();
      } catch (error) {
        firstFailure ??= error instanceof Error ? error : new Error(String(error));
      }
    }

    if (firstFailure !== null) {
      throw firstFailure;
    }
  }

  /**
   * 1 つのトラックを subscribe する
   *
   * Authorization Token の解決と SUBSCRIBE オプションの組み立てを 1 か所にまとめる。
   * exactOptionalPropertyTypes の下では optional な値に undefined を渡せないため、
   * 値がある場合だけオプションへ載せる。
   */
  private async subscribe(
    session: Session,
    namespace: string[],
    trackName: string,
    callbacks: TrackSubscriptionCallbacks,
    settings: TrackSubscriptionSettings,
  ): Promise<Subscriber> {
    // draft-ietf-moq-msf-01 §11.4.3: authInfo を持つ track にはトークンを MUST 付与
    const authorizationToken = await resolveAuthorizationToken(
      settings.authInfo,
      settings.getAuthorizationToken,
      settings.setupAuthorizationToken,
    );

    // トークンの解決は await を挟む。その間に解放が先行していれば SUBSCRIBE を出さない
    settings.assertNotDisposed?.();

    const subscribeCallbacks: SubscribeCallbacks = {
      object: callbacks.object,
      end: callbacks.end,
      error: callbacks.error,
      goaway: callbacks.goaway,
      ...(callbacks.datagram === undefined ? {} : { datagram: callbacks.datagram }),
      ...(callbacks.subgroupEnd === undefined ? {} : { subgroupEnd: callbacks.subgroupEnd }),
    };

    const subscribeOptions: SubscribeOptions = {
      ...(authorizationToken === undefined ? {} : { authorizationToken }),
      ...(settings.rendezvousTimeout === undefined
        ? {}
        : { rendezvousTimeout: settings.rendezvousTimeout }),
    };

    return session.subscribe(namespace, trackName, subscribeCallbacks, subscribeOptions);
  }
}
