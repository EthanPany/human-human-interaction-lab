/** Incoming text from a person. `from` is their phone number (or Apple ID email). */
export type IncomingText = { from: string; text: string };

/** Anything that can receive and send texts: Photon iMessage, the terminal, tests. */
export interface Transport {
  readonly name: string;
  /** Start delivering incoming texts to the handler. Resolves once listening. */
  start(onText: (msg: IncomingText) => Promise<void>): Promise<void>;
  /** Send a text to a phone number, starting a conversation if needed. */
  send(to: string, text: string): Promise<void>;
}
