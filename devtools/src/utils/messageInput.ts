/**
 * メッセージ入力の Enter 判定
 *
 * Enter で送信してよいかを返す。日本語入力 (IME) の変換中は送信しない。変換の確定にも
 * Enter を使うため、区別しないと変換しただけで送信されてしまう。変換中は
 * `KeyboardEvent.isComposing` が true になる
 */
export function shouldSendOnEnter(event: Pick<KeyboardEvent, "key" | "isComposing">): boolean {
  return event.key === "Enter" && !event.isComposing;
}
