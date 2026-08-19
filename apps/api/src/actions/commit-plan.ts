/**
 * What "go ahead" actually does.
 *
 * Three real effects, none of which need the user to log in (docs/PLAN.md §4.3):
 *
 *   A  the plan is persisted to a permanent, shareable URL
 *   B  an .ics file is generated — calendar integration with no OAuth scope
 *   C  future notifications are scheduled at the plan's own milestone times
 *
 * C is the one that earns the gate. Approving means the system will act later,
 * on its own, without the user present. That is a genuinely consequential
 * capability, and it is the honest justification for stopping to ask.
 *
 * Booking and payment stay simulated and are labelled as such in the UI. An
 * approval gate guarding a console.log would be theatre; these are real writes.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CommitPlanInputSchema, CommitPlanOutputSchema } from '@lifepilot/shared';
import type { CommitPlanInput, CommitPlanOutput } from '@lifepilot/shared';
import { dataDir, optionalEnv } from '../config/env.js';
import { runOnce, savePlan, scheduleNotification } from '../memory/approvals.js';
import { createEvents } from '../integrations/google-calendar.js';

/** Short, URL-safe, and readable aloud — these end up in a shareable link. */
function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

/**
 * Commits a plan.
 *
 * `idempotencyKey` is supplied by the caller and derived from the approval that
 * authorised this, so a double-click, a retry, or a replay after restart all
 * collapse onto one execution.
 */
export async function commitPlan(
  rawInput: CommitPlanInput,
  idempotencyKey: string,
): Promise<CommitPlanOutput> {
  const input = CommitPlanInputSchema.parse(rawInput);

  const { result, alreadyExecuted } = await runOnce(
    idempotencyKey,
    'commit_plan',
    input.userId,
    async (): Promise<Omit<CommitPlanOutput, 'alreadyCommitted'>> => {
      const planId = shortId();
      const baseUrl = optionalEnv('PUBLIC_BASE_URL', 'http://localhost:8080');

      // A — durable, addressable, outward-facing.
      await savePlan(planId, input.userId, input.title, input.body);

      // B — a calendar file rather than a Calendar API write. calendar.events is
      // a Google sensitive scope: an unverified app shows a security warning and
      // is capped at 100 users for the project's lifetime, which fails the "a
      // stranger with a link completes the flow" requirement outright.
      const icsPath = input.milestones.length > 0 ? await writeIcs(planId, input) : null;

      // C — the autonomous part. Delivery is drained by POST /tick, because a
      // free-tier host sleeps and in-process timers would silently never fire.
      let scheduled = 0;
      for (const milestone of input.milestones) {
        const dueAt = new Date(milestone.at);
        if (Number.isNaN(dueAt.getTime())) continue; // skip unparseable, never guess

        await scheduleNotification({
          // Deterministic: re-running with the same plan and milestone cannot
          // create a duplicate reminder.
          id: `${planId}:${scheduled}`,
          planId,
          userId: input.userId,
          title: milestone.title,
          body: milestone.note ?? null,
          dueAt,
        });
        scheduled += 1;
      }

      // D — only when the user explicitly connected Google. Never throws: a
      // calendar failure must not undo a plan that is already saved, so the
      // count of what actually landed is reported instead.
      const calendarResult = await createEvents(
        input.userId,
        input.milestones
          .map((milestone, index) => ({
            title: milestone.title,
            startsAt: new Date(milestone.at),
            description: milestone.note ?? null,
            idempotencyId: `${planId}${index}`,
          }))
          .filter((event) => !Number.isNaN(event.startsAt.getTime())),
      );

      return {
        planId,
        url: `${baseUrl}/plan/${planId}`,
        icsPath,
        scheduledNotifications: scheduled,
        calendarEventsCreated: calendarResult.created,
      };
    },
  );

  return CommitPlanOutputSchema.parse({ ...result, alreadyCommitted: alreadyExecuted });
}

/**
 * Writes an RFC 5545 calendar file.
 *
 * Hand-built rather than pulled from a library: the format is small, and the
 * fussy parts are escaping and CRLF line endings, which a dependency would not
 * save us from understanding anyway.
 */
async function writeIcs(planId: string, input: CommitPlanInput): Promise<string> {
  const stamp = (date: Date): string => `${date.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;

  // Commas, semicolons, backslashes and newlines are all significant in ICS.
  const escape = (value: string): string =>
    value.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');

  const now = new Date();
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//LifePilot//EN',
    'CALSCALE:GREGORIAN',
  ];

  const milestones = CommitPlanInputSchema.parse(input).milestones;
  milestones.forEach((milestone, index) => {
    const at = new Date(milestone.at);
    if (Number.isNaN(at.getTime())) return;
    lines.push(
      'BEGIN:VEVENT',
      `UID:${planId}-${index}@lifepilot`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART:${stamp(at)}`,
      `SUMMARY:${escape(milestone.title)}`,
      ...(milestone.note ? [`DESCRIPTION:${escape(milestone.note)}`] : []),
      'END:VEVENT',
    );
  });

  lines.push('END:VCALENDAR');

  const dir = path.join(dataDir, 'plans');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${planId}.ics`);
  // CRLF is required by the spec, not a Windows artefact.
  await writeFile(file, `${lines.join('\r\n')}\r\n`, 'utf8');
  return file;
}
