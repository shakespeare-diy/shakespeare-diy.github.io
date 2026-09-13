import type { NostrEvent, NRelay } from '@nostrify/nostrify';

/** How long one relay is given to accept an event. */
const PUBLISH_TIMEOUT_MS = 10_000;

/** A relay that refused an event, and the sentence it refused with. */
export interface RelayRejection {
  url: string;
  /** The relay's own `OK false` message, or whatever went wrong instead. */
  reason: string;
}

/** Which relays took an event and which did not. */
export interface PublishOutcome {
  accepted: string[];
  rejected: RelayRejection[];
}

/** A pool that can be narrowed to a single relay, which is all this needs. */
export interface RelayPool {
  group(urls: string[]): NRelay;
}

/**
 * Publish to every relay, and report what each one said.
 *
 * Nostrify's pool publishes with `Promise.any`, which resolves as soon as one
 * relay accepts and discards every other answer — including the rejections.
 * A deploy to five relays that only one accepted is reported as a success
 * indistinguishable from a deploy all five took, and the reason the other four
 * refused is received and thrown away.
 *
 * That is not a hypothetical difference. Of 102 manifests published this way in
 * one session, one relay held all of them and another held none, and nothing
 * anywhere said so.
 *
 * One acceptance is still a success — the event exists, and a gateway reading
 * any relay that has it will find it — so this throws only when nobody took it.
 * The rest is reported rather than raised, because a site published to four
 * relays out of five is working, and a deploy that failed over it would be
 * wrong about something the user can see.
 */
export async function publishToRelays(
  pool: RelayPool,
  event: NostrEvent,
  relayUrls: string[],
  signal?: AbortSignal,
): Promise<PublishOutcome> {
  if (!relayUrls.length) {
    throw new Error('No relays are configured to publish to.');
  }

  const results = await Promise.allSettled(
    relayUrls.map((url) =>
      // One relay per group, so a rejection can be attributed to the relay that
      // made it. The pool shares the underlying connections either way.
      pool.group([url]).event(event, {
        signal: signal ?? AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
      }),
    ),
  );

  const accepted: string[] = [];
  const rejected: RelayRejection[] = [];

  results.forEach((result, index) => {
    const url = relayUrls[index];
    if (result.status === 'fulfilled') {
      accepted.push(url);
    } else {
      rejected.push({ url, reason: describe(result.reason) });
    }
  });

  if (!accepted.length) {
    throw new Error(
      `No relay accepted this event. ${rejected.map((r) => `${host(r.url)}: ${r.reason}`).join('; ')}`,
    );
  }

  return { accepted, rejected };
}

/**
 * A relay's refusal, in whatever form it arrived.
 *
 * Read by shape rather than by `instanceof`, because a timeout arrives as a
 * `DOMException`, which is not an `Error` everywhere — and mistaking one for an
 * object with nothing to say turns "this relay never answered" into "this relay
 * refused", which are different facts about different things.
 */
function describe(reason: unknown): string {
  if (typeof reason === 'string' && reason) return reason;
  if (typeof reason !== 'object' || reason === null) return 'refused without saying why';

  const { name, message } = reason as { name?: unknown; message?: unknown };

  // An abort is our own deadline, not a verdict from the relay.
  if (name === 'AbortError' || name === 'TimeoutError') return 'no answer before the timeout';

  if (typeof message === 'string' && message) return message;
  return typeof name === 'string' && name ? name : 'refused without saying why';
}

/** The hostname of a relay URL, for a message somebody has to read. */
export function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** How many event ids are asked about in one filter. */
const COVERAGE_BATCH = 100;

/** How long one relay is given to say what it has. */
const COVERAGE_TIMEOUT_MS = 8_000;

/** Which of a set of events one relay holds. */
export interface RelayCoverage {
  url: string;
  /** Ids the relay answered with. */
  present: Set<string>;
  /** Set when the relay could not be asked at all, as opposed to answering "none". */
  error?: string;
}

/**
 * Ask each relay which of these events it already has.
 *
 * A relay that cannot be reached is reported as an error rather than as holding
 * nothing, because the two call for opposite responses: one is a relay to send
 * to, the other is a relay to try again later.
 */
export async function checkRelayCoverage(
  pool: RelayPool,
  relayUrls: string[],
  eventIds: string[],
  signal?: AbortSignal,
): Promise<RelayCoverage[]> {
  const batches: string[][] = [];
  for (let i = 0; i < eventIds.length; i += COVERAGE_BATCH) {
    batches.push(eventIds.slice(i, i + COVERAGE_BATCH));
  }

  return await Promise.all(
    relayUrls.map(async (url): Promise<RelayCoverage> => {
      const present = new Set<string>();

      try {
        for (const ids of batches) {
          const found = await pool.group([url]).query([{ ids, limit: ids.length }], {
            signal: signal ?? AbortSignal.timeout(COVERAGE_TIMEOUT_MS),
          });
          for (const event of found) present.add(event.id);
        }
      } catch (error) {
        return { url, present, error: describe(error) };
      }

      return { url, present };
    }),
  );
}

/** What forwarding a set of events to the relays missing them achieved. */
export interface ForwardResult {
  /** Relay URL to the number of events it took that it did not have. */
  filled: Map<string, number>;
  /** Relay URL to why it would not take them, from the first refusal. */
  refused: Map<string, string>;
}

/**
 * Send events to the relays that do not have them, exactly as they are.
 *
 * The same events, ids and signatures unchanged, so this needs no signer and
 * can be run as many times as it takes: a relay that already has one answers
 * `duplicate:` and nothing happens. Publishing to five relays and having one
 * take it is a success that leaves four gaps, and this is how the gaps close
 * without anyone re-signing a hundred manifests.
 *
 * It is also the only way to read why a relay refused in the first place: the
 * refusal is thrown away at publish time, and asking again is how you hear it.
 */
export async function forwardMissing(
  pool: RelayPool,
  coverage: RelayCoverage[],
  events: NostrEvent[],
  signal?: AbortSignal,
): Promise<ForwardResult> {
  const filled = new Map<string, number>();
  const refused = new Map<string, string>();

  for (const relay of coverage) {
    if (relay.error) {
      refused.set(relay.url, relay.error);
      continue;
    }

    const missing = events.filter((event) => !relay.present.has(event.id));
    if (!missing.length) continue;

    let count = 0;
    for (const event of missing) {
      try {
        await pool.group([relay.url]).event(event, {
          signal: signal ?? AbortSignal.timeout(PUBLISH_TIMEOUT_MS),
        });
        count++;
      } catch (error) {
        // One reason per relay: a relay refusing the first of ninety-seven
        // will refuse the rest for the same reason, and ninety-seven copies of
        // one sentence is not more information.
        if (!refused.has(relay.url)) refused.set(relay.url, describe(error));
        break;
      }
    }

    if (count) filled.set(relay.url, count);
  }

  return { filled, refused };
}
