import type { AlertPayload, AlertType } from "./match.js";

export interface AlertEnvelope {
  alert_id: string;
  user_id: string;
  item_id: number;
  alert_type: AlertType;
  payload: AlertPayload;
}

export interface AlertSender {
  /**
   * Deliver an alert. Resolves on success; throws on failure.
   * The dispatcher records `delivered_at` only when this resolves.
   * The real Telegram sender is wired up in p1-006.
   */
  send(envelope: AlertEnvelope): Promise<void>;
}

/**
 * In-memory stub used until the real Telegram sender lands in p1-006.
 * Captures every successful delivery so the dispatcher tests can assert
 * that `delivered_at` is populated synchronously on the happy path.
 */
export class InMemoryAlertSender implements AlertSender {
  readonly delivered: AlertEnvelope[] = [];

  async send(envelope: AlertEnvelope): Promise<void> {
    this.delivered.push(envelope);
  }
}
