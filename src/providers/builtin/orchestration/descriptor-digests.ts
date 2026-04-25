import { action, type ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";
import { type DigestCadence, OPTIONAL_EXPECTED_VERSION_PARAM } from "./types";

function normalizeCadence(value: unknown): DigestCadence {
  switch (value) {
    case "on_milestone":
    case "on_escalation":
    case "daily":
    case "continuous":
    case "final":
      return value;
    default:
      return "manual";
  }
}

export function buildDigestsDescriptor(wiring: DescriptorWiring) {
  const { repo, digests } = wiring;
  const digestList = repo.listDigests();
  const deliveryList = repo.listDigestDeliveries();
  const pendingDeliveries = deliveryList.filter((delivery) => delivery.status === "pending");
  const deliveryConfig = digests.describeDelivery();
  const items: ItemDescriptor[] = digestList.map((digest) => ({
    id: digest.id,
    props: digest,
    summary: `${digest.status}: ${digest.headline[0] ?? digest.id}`,
    actions: digest.delivery.delivery_id
      ? {
          mark_delivery_delivered: action(
            {
              expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
            },
            async ({ expected_version }) =>
              digests.markDeliveryDelivered({
                delivery_id: digest.delivery.delivery_id as string,
                expected_version:
                  typeof expected_version === "number" ? expected_version : undefined,
              }),
            {
              label: "Mark Delivered",
              description: "Mark this digest's pending push-delivery record as delivered.",
              estimate: "instant",
            },
          ),
        }
      : undefined,
    meta: {
      salience: digest.status === "blocked" || digest.status === "at_risk" ? 0.85 : 0.45,
      urgency: digest.status === "blocked" || digest.status === "at_risk" ? "high" : "low",
    },
  }));

  return {
    type: "collection",
    props: {
      count: items.length,
      latest_digest_id: digestList.at(-1)?.id,
      latest_status: digestList.at(-1)?.status,
      delivery_count: deliveryList.length,
      pending_delivery_count: pendingDeliveries.length,
      latest_delivery_id: deliveryList.at(-1)?.id,
      delivery: deliveryConfig,
      policy: digests.describePolicy(),
      pending_deliveries: pendingDeliveries.map((delivery) => ({
        id: delivery.id,
        digest_id: delivery.digest_id,
        reasons: delivery.reasons,
        channel: delivery.channel,
        attempt_count: delivery.attempt_count ?? 0,
        last_attempt_at: delivery.last_attempt_at,
        last_error: delivery.last_error,
        created_at: delivery.created_at,
      })),
    },
    summary: `Orchestration digests (${items.length}).`,
    actions: {
      generate_digest: action(
        {
          cadence: {
            type: "string",
            description:
              "Digest cadence: manual, on_milestone, on_escalation, daily, continuous, or final.",
            enum: ["manual", "on_milestone", "on_escalation", "daily", "continuous", "final"],
            optional: true,
          },
        },
        async ({ cadence }) => digests.generateDigest({ cadence: normalizeCadence(cadence) }),
        {
          label: "Generate Digest",
          description: "Generate and persist a typed docs/12 orchestration digest.",
          estimate: "instant",
        },
      ),
      mark_digest_delivery_delivered: action(
        {
          delivery_id: "string",
          expected_version: OPTIONAL_EXPECTED_VERSION_PARAM,
        },
        async ({ delivery_id, expected_version }) =>
          digests.markDeliveryDelivered({
            delivery_id: delivery_id as string,
            expected_version: typeof expected_version === "number" ? expected_version : undefined,
          }),
        {
          label: "Mark Digest Delivered",
          description: "Mark a pending digest push-delivery record as delivered.",
          estimate: "instant",
        },
      ),
      deliver_pending_digests: action(
        {
          channel: {
            type: "string",
            description: "Optional delivery channel to dispatch. Defaults to all pending channels.",
            optional: true,
          },
          limit: {
            type: "number",
            description: "Optional maximum number of pending deliveries to attempt.",
            optional: true,
          },
        },
        async ({ channel, limit }) =>
          digests.deliverPendingDigests({
            channel: typeof channel === "string" ? channel : undefined,
            limit: typeof limit === "number" ? limit : undefined,
          }),
        {
          label: "Deliver Pending Digests",
          description:
            "Dispatch pending digest push-delivery records through configured transports.",
          estimate: "instant",
        },
      ),
    },
    items,
    meta: {
      salience:
        digestList.at(-1)?.status === "blocked" || digestList.at(-1)?.status === "at_risk"
          ? 0.85
          : 0.45,
    },
  };
}
