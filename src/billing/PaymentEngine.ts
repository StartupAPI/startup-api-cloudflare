export abstract class PaymentEngine {
  abstract charge(accountId: string, amount: number, currency: string): Promise<boolean>;
  abstract setupRecurring(accountId: string, planSlug: string, scheduleIdx: number): Promise<void>;
  abstract cancelRecurring(accountId: string): Promise<void>;
}

export class MockPaymentEngine extends PaymentEngine {
  async charge(accountId: string, amount: number, currency: string): Promise<boolean> {
    console.log(`[MockPaymentEngine] Charging ${accountId} ${amount} ${currency}`);
    return true;
  }

  async setupRecurring(accountId: string, planSlug: string, scheduleIdx: number): Promise<void> {
    console.log(`[MockPaymentEngine] Setup recurring for ${accountId} on plan ${planSlug} schedule ${scheduleIdx}`);
  }

  async cancelRecurring(accountId: string): Promise<void> {
    console.log(`[MockPaymentEngine] Cancel recurring for ${accountId}`);
  }
}
