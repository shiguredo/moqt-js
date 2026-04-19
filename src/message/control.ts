/**
 * MOQT Control Message
 * draft-ietf-moq-transport-17 Section 9 (Control Messages)
 *
 * 制御ストリーム (SETUP / GOAWAY) および request stream
 * (SUBSCRIBE / PUBLISH / FETCH / PUBLISH_NAMESPACE /
 * SUBSCRIBE_NAMESPACE / TRACK_STATUS とその応答) 上で流れる全ての
 * MOQT 制御メッセージを統合した discriminated union。
 * `type` フィールドの MessageType 値で判別する。
 */

import type { Fetch, FetchOk } from "./fetch";
import type {
  Namespace,
  NamespaceDone,
  PublishBlocked,
  PublishNamespace,
  SubscribeNamespace,
} from "./namespace";
import type { Publish, PublishDone, PublishOk } from "./publish";
import type { Goaway, RequestError, RequestOk } from "./session";
import type { Setup } from "./setup";
import type { RequestUpdate, Subscribe, SubscribeOk } from "./subscribe";
import type { TrackStatus } from "./trackstatus";

/**
 * MOQT Control Message
 */
export type ControlMessage =
  | Setup
  | Goaway
  | Subscribe
  | SubscribeOk
  | Publish
  | PublishOk
  | PublishDone
  | RequestUpdate
  | RequestOk
  | RequestError
  | Fetch
  | FetchOk
  | PublishNamespace
  | SubscribeNamespace
  | Namespace
  | NamespaceDone
  | PublishBlocked
  | TrackStatus;
