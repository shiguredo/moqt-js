/**
 * MOQT Session プロトコル状態機械 (sans-I/O)
 * draft-ietf-moq-transport-17 Section 3 (Sessions)
 *
 * I/O を持たない純粋な状態機械。
 *
 * - 入力: handleControl / handleRequest / handleStreamMessage / tick / close
 * - 出力: nextEvent で SessionEvent を取り出す
 * - I/O 層は sendControl / sendRequest / sendOnStream イベントを
 *   WebTransport への書き込みに翻訳する
 *
 * 現在 Phase 2 時点では SETUP ハンドシェイクのみを実装する。
 * 他のメッセージは後続 Phase で段階的に追加する。
 */

import { SessionError, SessionErrorCode } from "../error";
import { MessageType, type Setup } from "../message";
import type { ControlMessage } from "../message/control";
import type { Role, SessionEvent, SessionState, Transport } from "./types";

/**
 * MOQT Session プロトコル状態機械
 */
export class SessionProtocol {
  private readonly _role: Role;
  private readonly _transport: Transport;
  private _state: SessionState;
  private readonly _localSetup: Setup;
  private _peerSetup: Setup | null;
  private readonly _events: SessionEvent[];

  private constructor(role: Role, transport: Transport, setup: Setup) {
    this._role = role;
    this._transport = transport;
    this._state = "setup";
    this._localSetup = setup;
    this._peerSetup = null;
    this._events = [{ type: "sendControl", message: setup }];
  }

  /**
   * Client セッションを作成する
   * draft-ietf-moq-transport-17 Section 9.4 (SETUP)
   *
   * 作成時点で自側 SETUP の sendControl イベントを積み、"setup" 状態にする。
   */
  static createClient(transport: Transport, setup: Setup): SessionProtocol {
    return new SessionProtocol("client", transport, setup);
  }

  /** 現在のセッション状態 */
  get state(): SessionState {
    return this._state;
  }

  /** エンドポイントの役割 */
  get role(): Role {
    return this._role;
  }

  /** 下位トランスポート種別 */
  get transport(): Transport {
    return this._transport;
  }

  /** 自側 SETUP (診断用、改変禁止) */
  get localSetup(): Setup {
    return this._localSetup;
  }

  /** 相手側 SETUP (受信済みの場合) */
  get peerSetup(): Setup | null {
    return this._peerSetup;
  }

  /**
   * 次の SessionEvent を取り出す
   *
   * 呼び出し側は undefined が返るまで繰り返し呼び出して I/O 層と同期する。
   * closeSession を取り出したタイミングで "closing" → "closed" に遷移する。
   */
  nextEvent(): SessionEvent | undefined {
    const event = this._events.shift();
    if (event !== undefined && event.type === "closeSession" && this._state === "closing") {
      this._state = "closed";
    }
    return event;
  }

  /**
   * 制御ストリーム (SETUP / GOAWAY) 上のメッセージを受信する
   * draft-ietf-moq-transport-17 Section 9.4, 9.5
   *
   * SETUP / GOAWAY 以外は PROTOCOL_VIOLATION でクローズする。
   * クローズ処理中 / クローズ済みでは何もしない (no-op)。
   * GOAWAY の処理は Phase 8 で実装する。
   */
  handleControl(msg: ControlMessage): void {
    if (this._state === "closing" || this._state === "closed") {
      return;
    }
    if (msg.type === MessageType.SETUP) {
      this.handlePeerSetup(msg);
      return;
    }
    this.fail(
      new SessionError("unsupported control stream message", SessionErrorCode.PROTOCOL_VIOLATION),
    );
  }

  /**
   * 外部時計からの時刻更新を受け取る (sans-I/O)
   *
   * sans-I/O 制約のため session はタイマーを持たず、外部時計だけが時刻源となる。
   * Phase 2 時点では何も行わない。Phase 8 で GOAWAY deadline 判定を実装する。
   */
  // biome-ignore lint/suspicious/noEmptyBlockStatements: Phase 8 で実装する
  tick(_nowMs: number): void {}

  /**
   * セッションを明示的にクローズする
   * draft-ietf-moq-transport-17 Section 14.5.1 (Session Termination Error Codes)
   *
   * 既に "closing" / "closed" の場合は何もしない。
   */
  close(code: SessionErrorCode, reason: string): void {
    this.fail(new SessionError(reason, code));
  }

  private handlePeerSetup(setup: Setup): void {
    // draft §9.4: SETUP は各エンドポイントから 1 回のみ
    if (this._peerSetup !== null) {
      this.fail(new SessionError("duplicate SETUP received", SessionErrorCode.PROTOCOL_VIOLATION));
      return;
    }
    this._peerSetup = setup;
    this._state = "established";
    this._events.push({ type: "established" });
  }

  private fail(error: SessionError): void {
    if (this._state === "closing" || this._state === "closed") {
      return;
    }
    this._state = "closing";
    this._events.push({ type: "closeSession", error });
  }
}
