/** Which messages this page has had from the outbox. */
export function createTakenMail(_cap = 5000) {
  return {
    isCopy: (_id: string, _body: string): boolean => false,
    handled: (_id: string, _body: string): void => {},
    restored: (_id: string): void => {},
  }
}
