import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import { OPTIONAL_EXPECTED_VERSION_PARAM } from "./types";

export function buildDriftDescriptor(wiring: DescriptorWiring) {
  const { repo, drift } = wiring;
  const events = repo.listDriftEvents();
  const items: ItemDescriptor[] = events.map((event) => ({
    id: event.id,
    props: event,
    summary: `${event.severity}: ${event.summary}`,
    actions:
      event.status === "open"
        ? {
            acknowledge: action(
              {
                resolution: {
                  type: "string",
                  description: "Optional note about how this drift signal was handled.",
                  optional: true,
                },
                expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
              },
              async ({ resolution, expected_version }) =>
                drift.acknowledgeEvent({
                  event_id: event.id,
                  resolution: typeof resolution === "string" ? resolution : undefined,
                  expected_version:
                    typeof expected_version === "number" ? expected_version : undefined,
                }),
              {
                label: "Acknowledge Drift",
                description: "Mark this drift event as acknowledged after handling it.",
                estimate: "instant",
              },
            ),
          }
        : undefined,
    meta: {
      salience: event.status === "open" && event.severity === "blocking" ? 0.95 : 0.55,
      urgency: event.status === "open" && event.severity === "blocking" ? "high" : "medium",
    },
  }));

  return {
    type: "collection",
    props: {
      ...drift.describe(),
      count: items.length,
      open: events.filter((event) => event.status === "open").length,
      blocking_open: events.filter(
        (event) => event.status === "open" && event.severity === "blocking",
      ).length,
    },
    summary: `Drift events (${items.length}).`,
    items,
    meta: {
      salience: events.some((event) => event.status === "open" && event.severity === "blocking")
        ? 0.95
        : 0.45,
    },
  };
}
