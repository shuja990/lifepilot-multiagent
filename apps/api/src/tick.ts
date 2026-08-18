/**
 * The scheduler drain.
 *
 *   npm run tick
 *
 * Phase 7 exposes this as POST /tick, called by a GitHub Actions cron.
 *
 * Why an external trigger rather than setTimeout or node-cron: the free tier of
 * every candidate host sleeps after a period of inactivity, so an in-process
 * timer does not fire late — it does not fire at all, silently, and the feature
 * that justifies the whole approval gate quietly stops existing. An external
 * ping both drives the schedule and wakes the host, so one mechanism solves
 * both problems.
 *
 * This drains a BACKLOG rather than assuming it runs on time. GitHub Actions
 * cron is best-effort and can lag by minutes, so "everything due up to now" is
 * the only correct query.
 */
import { claimDueNotifications, closeApprovalStore } from './memory/approvals.js';

export interface DeliveryResult {
  id: string;
  userId: string;
  title: string;
  delivered: boolean;
  channel: string;
}

/**
 * Delivers one notification.
 *
 * Web Push delivery arrives in Phase 7, once the frontend exists to register a
 * subscription — there is nowhere to push to until a browser has opted in.
 * Until then this records the delivery, which is deliberately the durable
 * evidence anyway: iOS Safari only delivers Web Push to installed PWAs, so the
 * plan page must be able to show "sent" without depending on push at all.
 */
async function deliver(notification: {
  id: string;
  userId: string;
  title: string;
  body: string | null;
}): Promise<DeliveryResult> {
  console.log(
    `[notify] ${notification.userId} :: ${notification.title}` +
      (notification.body ? ` — ${notification.body}` : ''),
  );
  return {
    id: notification.id,
    userId: notification.userId,
    title: notification.title,
    delivered: true,
    channel: 'log',
  };
}

/**
 * Claims and delivers everything due.
 *
 * Claiming happens in a single UPDATE ... RETURNING with SKIP LOCKED, so two
 * ticks overlapping — which a lagging cron makes likely — cannot both deliver
 * the same reminder.
 */
export async function runTick(now = new Date()): Promise<DeliveryResult[]> {
  const due = await claimDueNotifications(now);
  const results: DeliveryResult[] = [];
  for (const notification of due) {
    results.push(await deliver(notification));
  }
  return results;
}

// Run directly: `npm run tick`
if (process.argv[1]?.includes('tick')) {
  runTick()
    .then(async (results) => {
      console.log(`delivered ${results.length} notification(s)`);
      await closeApprovalStore();
      process.exit(0);
    })
    .catch(async (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      await closeApprovalStore();
      process.exit(1);
    });
}
