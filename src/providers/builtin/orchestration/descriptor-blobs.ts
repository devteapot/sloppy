import type { ItemDescriptor } from "@slop-ai/server";

import type { DescriptorWiring } from "./descriptor-wiring";

export function buildBlobsDescriptor(wiring: DescriptorWiring) {
  const ids = wiring.repo.listBlobIds();
  const items: ItemDescriptor[] = ids.map((id) => ({
    id,
    props: {
      id: id.replace(/\.txt$/, ""),
      path: wiring.repo.blobPath(id.replace(/\.txt$/, "")),
    },
    summary: id,
    meta: {
      salience: 0.25,
    },
  }));

  return {
    type: "collection",
    props: {
      count: items.length,
    },
    summary: `Evidence blobs (${items.length}).`,
    items,
  };
}
